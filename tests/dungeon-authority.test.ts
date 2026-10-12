import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTENT } from '../src/shared/content/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { progressOf } from '../src/shared/gameplay/instances.ts'
import { Rng } from '../src/shared/rng.ts'
import { startServer } from '../src/server/index.ts'
import { joinAuthenticatedClient } from './net-fixture.ts'

const SEVEN_BADGES = [
  'badge-code',
  'badge-vision',
  'badge-sound',
  'badge-search',
  'badge-compute',
  'badge-safety',
  'badge-agent',
]

test('dungeon authority regressions: entry map check, per-member badge/alive gates, parallel elite lock, delta settlement, and raid contract replay block', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ap-dungeon-auth-'))
  const srv = await startServer({ port: 0, dataDir: dir, world: null, pvp: null, quiet: true })

  try {
    const p1Lead = createCreature('agi', 100, { rng: new Rng(101) })
    const p1Backup = createCreature('deepseek-v3', 80, { rng: new Rng(102) })
    const p2Lead = createCreature('agi', 100, { rng: new Rng(202) })

    // 1. Connect P1 (7 badges) in origin-home (bedroom) and P2 (0 badges initially) at origin-lab-b1 entry
    const c1 = await joinAuthenticatedClient(srv, {
      name: '队长甲',
      map: 'origin-home',
      x: 4,
      y: 4,
      badges: SEVEN_BADGES,
      party: [p1Lead, p1Backup],
      bag: { 'prompt-ball': 5, 'cache-potion': 4, 'data-shard': 0 },
      money: 5000,
    })

    const c2 = await joinAuthenticatedClient(srv, {
      name: '队员乙',
      map: 'origin-lab-b1',
      x: 13,
      y: 4,
      badges: [],
      party: [p2Lead],
      bag: { 'prompt-ball': 5, 'cache-potion': 2, 'data-shard': 0 },
      money: 5000,
    })

    // 1a. Solo entry from bedroom (origin-home) is rejected with not_at_entry
    let m1 = c1.mark()
    c1.send({ t: 'dungeon.enter', instanceId: 'deepseek-tide', tierId: 'story' })
    const badEntryErr = await c1.waitFor('dungeon.error', undefined, { from: m1 })
    assert.equal(badEntryErr.code, 'not_at_entry')

    // Move P1 to origin-lab-b1 near entry NPC (13, 3)
    c1.send({ t: 'move', map: 'origin-lab-b1', x: 13, y: 4, facing: 'up', moving: false, running: false })

    // 1b. Form party: P1 (7 badges) + P2 (0 badges)
    m1 = c1.mark()
    c1.send({ t: 'party.create' })
    await c1.waitFor('party.update', (u) => u.party !== null, { from: m1 })

    const m2Invite = c2.mark()
    c1.send({ t: 'party.invite', to: c2.selfId })
    await c2.waitFor('party.invited', undefined, { from: m2Invite })

    m1 = c1.mark()
    c2.send({ t: 'party.respond', from: c1.selfId, accept: true })
    await c1.waitFor('party.update', (u) => (u.party?.members.length ?? 0) === 2, { from: m1 })

    m1 = c1.mark()
    c2.send({ t: 'party.ready', ready: true })
    await c1.waitFor('party.update', (u) => Boolean(u.party?.members.every((m) => m.ready)), { from: m1 })

    // 1c. Starting cluster tier when non-leader P2 has 0 badges is rejected with locked
    m1 = c1.mark()
    c1.send({ t: 'party.start', instanceId: 'deepseek-tide', tierId: 'cluster' })
    const tierBypassErr = await c1.waitFor('party.error', undefined, { from: m1 })
    assert.equal(tierBypassErr.code, 'locked')

    // Grant P2 7 badges, but set P2's party HP to 0 (fainted) -> rejected with empty_party
    const p2SaveFainted = structuredClone(srv.authority.getSave(c2.selfId)!)
    p2SaveFainted.badges = [...SEVEN_BADGES]
    p2SaveFainted.party[0].hp = 0
    srv.authority.setSave(c2.selfId, p2SaveFainted, { ref: 'test:p2-fainted' })

    m1 = c1.mark()
    c1.send({ t: 'party.start', instanceId: 'deepseek-tide', tierId: 'cluster' })
    const faintedMemberErr = await c1.waitFor('party.error', undefined, { from: m1 })
    assert.equal(faintedMemberErr.code, 'empty_party')

    // Restore P2's party HP -> party.start succeeds
    const p2SaveReady = structuredClone(srv.authority.getSave(c2.selfId)!)
    p2SaveReady.party[0].hp = p2Lead.hp
    srv.authority.setSave(c2.selfId, p2SaveReady, { ref: 'test:p2-ready' })

    m1 = c1.mark()
    const m2Start = c2.mark()
    c1.send({ t: 'party.start', instanceId: 'deepseek-tide', tierId: 'cluster' })
    const instUpdate1 = await c1.waitFor('dungeon.update', (u) => u.instance !== null, { from: m1 })
    await c2.waitFor('dungeon.update', (u) => u.instance !== null, { from: m2Start })
    assert.equal(instUpdate1.instance?.currentRoom, 'lobby')

    // 2. Move to corridor and test elite battle concurrency, room lock, reservation, and delta/uid settlement
    m1 = c1.mark()
    c1.send({ t: 'dungeon.roomMove', roomId: 'corridor' })
    await c1.waitFor('dungeon.roomChanged', (r) => r.roomId === 'corridor', { from: m1 })

    m1 = c1.mark()
    c1.send({ t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
    const eliteStarted = await c1.waitFor('dungeon.eliteStarted', undefined, { from: m1 })

    // 2a. Duplicate eliteFight by P1 is rejected with busy
    m1 = c1.mark()
    c1.send({ t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
    const dupEliteErr = await c1.waitFor('dungeon.error', undefined, { from: m1 })
    assert.equal(dupEliteErr.code, 'busy')

    // 2b. Parallel eliteFight on the same elite by P2 is rejected with elite_busy
    let m2 = c2.mark()
    c2.send({ t: 'dungeon.eliteFight', eliteId: 'queue-guard' })
    const parallelEliteErr = await c2.waitFor('dungeon.error', undefined, { from: m2 })
    assert.equal(parallelEliteErr.code, 'elite_busy')

    // 2c. Room move during active elite fight is rejected with battle_active
    m2 = c2.mark()
    c2.send({ t: 'dungeon.roomMove', roomId: 'lobby' })
    const roomMoveDuringEliteErr = await c2.waitFor('dungeon.error', undefined, { from: m2 })
    assert.equal(roomMoveDuringEliteErr.code, 'battle_active')

    // 2d. Trade request to P1 while P1 is in dungeon elite battle is rejected with busy (dungeonBusy reservation)
    m2 = c2.mark()
    c2.send({ t: 'trade.request', to: c1.selfId })
    const tradeBusyErr = await c2.waitFor('error', undefined, { from: m2 })
    assert.equal(tradeBusyErr.code, 'busy')

    // 2e. Using an unowned item in elite battle is rejected with item_not_owned
    m1 = c1.mark()
    c1.send({
      t: 'dungeon.eliteAction',
      battleId: eliteStarted.battleId,
      action: { kind: 'item', itemId: CONTENT.quality.capture.masterBall },
    })
    const unownedItemErr = await c1.waitFor('dungeon.error', undefined, { from: m1 })
    assert.equal(unownedItemErr.code, 'item_not_owned')

    // 2f. Simulate concurrent save changes (backup creature moved to box, 3 cache-potions removed) before elite ends:
    // Elite settlement must NOT resurrect boxed creature into party or restore removed bag items
    const midEliteSave = structuredClone(srv.authority.getSave(c1.selfId)!)
    midEliteSave.party = [midEliteSave.party[0]]
    midEliteSave.boxes = [[p1Backup]]
    midEliteSave.bag['cache-potion'] = 1
    srv.authority.setSave(c1.selfId, midEliteSave, { ref: 'test:mid-elite-change' })

    for (let step = 0; step < 20; step++) {
      const prevLen = c1.mark()
      c1.send({
        t: 'dungeon.eliteAction',
        battleId: eliteStarted.battleId,
        action: { kind: 'move', moveIndex: 0 },
      })
      const evOrEnd = await c1.waitFor(
        'dungeon.eliteEvents',
        (e) => e.battleId === eliteStarted.battleId,
        { from: prevLen },
      )
      if (c1.all('dungeon.eliteEnd', prevLen).some((e) => e.battleId === eliteStarted.battleId)) {
        break
      }
      assert.notEqual(evOrEnd.request.kind, 'wait', 'recharge/auto steps must be drained before returning to client')
    }

    const postEliteSave = srv.authority.getSave(c1.selfId)!
    assert.equal(postEliteSave.party.length, 1, 'boxed creature must not be duplicated back into save.party')
    assert.equal(postEliteSave.party[0].uid, p1Lead.uid)
    assert.equal(postEliteSave.boxes[0]?.[0]?.uid, p1Backup.uid)
    assert.equal(postEliteSave.bag['cache-potion'], 1, 'unconsumed pre-battle snapshot items must not overwrite live bag')

    // 3. Activate mechanism and move to boss room to start Raid
    m1 = c1.mark()
    c1.send({ t: 'dungeon.mechanism', mechanismId: 'load-breaker' })
    await c1.waitFor('dungeon.mechanismActivated', undefined, { from: m1 })

    m1 = c1.mark()
    m2 = c2.mark()
    c1.send({ t: 'dungeon.roomMove', roomId: 'boss' })
    const raidStart1 = await c1.waitFor('raid.start', undefined, { from: m1 })
    await c2.waitFor('raid.start', undefined, { from: m2 })
    const raidId = raidStart1.raidId

    // 3a. Room move during active raid is rejected with battle_active
    m1 = c1.mark()
    c1.send({ t: 'dungeon.roomMove', roomId: 'lobby' })
    const roomMoveDuringRaidErr = await c1.waitFor('dungeon.error', undefined, { from: m1 })
    assert.equal(roomMoveDuringRaidErr.code, 'battle_active')

    // 3b. Both players attack until Boss is defeated
    for (let turn = 0; turn < 30; turn++) {
      if (c1.all('raid.end', m1).length > 0) break
      const t1 = c1.mark()
      c1.send({ t: 'raid.action', raidId, action: { kind: 'move', moveIndex: 0 } })
      await c1.waitFor('raid.tick', undefined, { from: t1 })
      if (c1.all('raid.end', m1).length > 0) break
      const t2 = c2.mark()
      c2.send({ t: 'raid.action', raidId, action: { kind: 'move', moveIndex: 0 } })
      await c2.waitFor('raid.tick', undefined, { from: t2 })
    }
    const raidEnd1 = await c1.waitFor('raid.end', undefined, { from: m1 })
    assert.equal(raidEnd1.victory, true)

    // Verify bossWon:deepseek flag is set on both players' saves
    const s1AfterWin = srv.authority.getSave(c1.selfId)!
    const s2AfterWin = srv.authority.getSave(c2.selfId)!
    assert.equal(s1AfterWin.flags['bossWon:deepseek'], true)
    assert.equal(s2AfterWin.flags['bossWon:deepseek'], true)

    // 4. Contract roll binding: P1 rolls once -> succeeds; bumping runSeq on save cannot allow a second roll on the same raidId
    m1 = c1.mark()
    c1.send({ t: 'raid.rollContract', raidId, ballId: 'prompt-ball' })
    const roll1 = await c1.waitFor('raid.contractResult', undefined, { from: m1 })
    assert.equal(roll1.raidId, raidId)

    // Bump runSeq on P1's save as if starting an ordinary boss fight
    const bumpedSave = structuredClone(srv.authority.getSave(c1.selfId)!)
    progressOf(bumpedSave, 'deepseek-tide').runSeq += 5
    srv.authority.setSave(c1.selfId, bumpedSave, { ref: 'test:bump-runseq' })

    m1 = c1.mark()
    c1.send({ t: 'raid.rollContract', raidId, ballId: 'prompt-ball' })
    const replayRollErr = await c1.waitFor('raid.error', undefined, { from: m1 })
    assert.equal(replayRollErr.code, 'already_rolled')

    // 5. Subsequent dungeon entry works cleanly even without an explicit prior dungeon.leave
    m1 = c1.mark()
    c1.send({ t: 'dungeon.enter', instanceId: 'deepseek-tide', tierId: 'story' })
    const reEnterUpdate = await c1.waitFor('dungeon.update', (u) => u.instance !== null && u.instance.tierId === 'story', { from: m1 })
    assert.equal(reEnterUpdate.instance?.instanceId, 'deepseek-tide')
    assert.equal(reEnterUpdate.instance?.completed, false)

    await c1.close()
    await c2.close()
  } finally {
    await srv.close()
    await rm(dir, { recursive: true, force: true })
  }
})
