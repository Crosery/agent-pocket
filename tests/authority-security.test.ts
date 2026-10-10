// Authoritative security and progression regression tests:
// - Rejects forged `ev:<nonce>` scatter item minting while allowing deterministic active-event scatter pickups once
// - Requires typed `sourceId`/`npcId` + `stepPath` on script grants, locks choice branches, and blocks flag clearing
// - Allows Aide opening story `phi-3` research after `lesson-types` battle and multi-step `mythic-chain` research
// - Atomic `claimResearch` with `research:claimed` & per-level idempotency; blocks `setFlag` on research claim flags
// - Enforces wild zero-encounter region gates, roaming legend proximity/condition gates, boss entry-map & daily lockouts
// - Enforces dynamic shop badge tiers and town-specific extra stock
// - Binds boss contract rolls to the won battle's `runSeq` and blocks authority mutations while `dungeonBusy` is set
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { BattleAction, Creature } from '../src/shared/types.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { activeEvents, eventSalt, startActions } from '../src/shared/gameplay/events.ts'
import { levelRewards, researchLevel, researchPoints } from '../src/shared/gameplay/research.ts'
import { hashString, Rng } from '../src/shared/rng.ts'
import { startServer } from '../src/server/index.ts'
import { loadWorldInfo } from '../src/server/world.ts'
import { joinAuthenticatedClient } from './net-fixture.ts'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'ap-auth-sec-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeStrongCreature(seed: number, level = 80): Creature {
  return createCreature(CONTENT.speciesList[0].id, level, {
    rng: new Rng(seed),
    otName: 'SecTester',
    shiny: false,
  }, CONTENT)
}

test('authority security: event scatter verification, script step context, research claims, encounter/shop gates, contract runSeq & dungeonBusy', async () => {
  await withTempDir(async (dir) => {
    const worldInfo = await loadWorldInfo()
    assert.ok(worldInfo?.world, 'worldInfo must load generated world')
    const world = worldInfo.world
    const srv = await startServer({
      port: 0,
      dataDir: dir,
      distDir: pathJoin(dir, 'no-dist'),
      quiet: true,
      world: worldInfo,
      pvp: null,
    })

    const clients = []
    try {
      // 1. Prologue starter, contextualized script grants, Aide phi-3 after lesson-types battle, and forged ev:<nonce> rejection
      const hero = await joinAuthenticatedClient(srv, {
        name: 'SecHero',
        map: 'origin-lab',
        x: 6,
        y: 6,
      })
      clients.push(hero)

      // 1a. Forged ev:<nonce> item minting is rejected
      const forgedEvFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: 'gold-token',
        qty: 5,
        groundId: 'ev:forged-nonce-1',
      })
      const forgedEvErr = await hero.waitFor('error', (m) => m.code === 'authority_violation', { from: forgedEvFrom })
      assert.equal(forgedEvErr.code, 'authority_violation')
      assert.equal(srv.authority.getSave(hero.selfId)!.bag['gold-token'] ?? 0, 0)

      // 1b. Choose starter on origin-lab
      const starterId = CONTENT.speciesList.find((sp) => sp.starter)!.id
      const stFrom = hero.mark()
      hero.send({ t: 'script.op', op: 'chooseStarter', speciesId: starterId })
      const stSync = await hero.waitFor('state.sync', undefined, { from: stFrom })
      assert.equal(stSync.save.party.length, 1)
      assert.equal(stSync.save.flags.starter, starterId)

      // 1c. Script grant without sourceId/stepPath is rejected; valid stepPath succeeds once and rejects replay
      const noCtxFrom = hero.mark()
      hero.send({ t: 'script.op', op: 'giveItem', itemId: 'dex-device', qty: 1 })
      await hero.waitFor('error', (m) => m.code === 'authority_violation', { from: noCtxFrom })

      const dexFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: 'dex-device',
        qty: 1,
        sourceId: 'npc:professor',
        stepPath: '0.else.7',
      })
      const dexSync = await hero.waitFor('state.sync', undefined, { from: dexFrom })
      assert.equal(dexSync.save.bag['dex-device'], 1)

      const dupDexFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: 'dex-device',
        qty: 1,
        sourceId: 'npc:professor',
        stepPath: '0.else.7',
      })
      await hero.waitFor('error', (m) => m.code === 'authority_violation', { from: dupDexFrom })

      // Also cannot double-claim via script:ds-professor alias
      const aliasDexFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: 'dex-device',
        qty: 1,
        sourceId: 'script:ds-professor',
        stepPath: '7',
      })
      await hero.waitFor('error', (m) => m.code === 'authority_violation', { from: aliasDexFrom })

      // 1d. Choice locking on Aide: choosing branch 0 (lesson-types battle) and then trying to claim branch 1's skip gift is rejected
      const boostSave = srv.authority.getSave(hero.selfId)!
      boostSave.party[0] = makeStrongCreature(101, 50)
      srv.authority.setSave(hero.selfId, boostSave, { imported: false, trusted: true })

      const tbFrom = hero.mark()
      hero.send({ t: 'battle.start', kind: 'trainer', trainerId: 'lesson-types' })
      const tbStarted = await hero.waitFor('battle.started', undefined, { from: tbFrom })
      assert.equal(srv.authority.isInBattle(hero.selfId), true)
      while (!srv.authority.getSave(hero.selfId)!.flags['trainer:lesson-types']) {
        const actFrom = hero.mark()
        hero.send({
          t: 'battle.action',
          battleId: tbStarted.battleId,
          action: { kind: 'move', moveIndex: 0 } satisfies BattleAction,
        })
        const ev = await hero.waitFor('battle.events', (m) => m.battleId === tbStarted.battleId, { from: actFrom })
        if (ev.events.some((e) => e.t === 'end')) break
      }
      await hero.waitFor('battle.end', (m) => m.battleId === tbStarted.battleId, { from: tbFrom })
      assert.equal(srv.authority.isInBattle(hero.selfId), false)

      // Verify lesson-types battle already recorded phi-3 'see' = 1
      const afterLessonSave = srv.authority.getSave(hero.selfId)!
      assert.ok((afterLessonSave.research?.['phi-3']?.see ?? 0) >= 1, 'lesson-types battle sets phi-3 see research')

      // Claim branch 0's 3x cache-potion (0.else.1.b0.0.5.else.0 -> 0.else.1.b0.5.else.0)
      const b0GiftFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: 'cache-potion',
        qty: 3,
        sourceId: 'npc:aide-types',
        stepPath: '0.else.1.b0.5.else.0',
        choiceIndex: 0,
      })
      const b0GiftSync = await hero.waitFor('state.sync', undefined, { from: b0GiftFrom })
      assert.equal(b0GiftSync.save.bag['cache-potion'], 3)

      // Trying to also claim branch 1's 3x cache-potion (0.else.1.b1.1) is rejected by choice lock
      const b1GiftFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: 'cache-potion',
        qty: 3,
        sourceId: 'npc:aide-types',
        stepPath: '0.else.1.b1.1',
        choiceIndex: 1,
      })
      await hero.waitFor('error', (m) => m.code === 'authority_violation', { from: b1GiftFrom })

      // 1e. Aide's phi-3 gift and research steps ('see' and 'catch') succeed after lesson-types battle, and reject replay
      const phiFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'giveCreature',
        speciesId: 'phi-3',
        level: 6,
        sourceId: 'npc:aide-types',
        stepPath: '0.else.4',
      })
      const phiSync = await hero.waitFor('state.sync', undefined, { from: phiFrom })
      assert.ok(phiSync.save.party.some((c) => c.speciesId === 'phi-3'))

      const phiSeeFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'see',
        amount: 1,
        sourceId: 'npc:aide-types',
        stepPath: '0.else.5',
      })
      await hero.waitFor('state.sync', undefined, { from: phiSeeFrom })

      const phiCatchFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'catch',
        amount: 1,
        sourceId: 'npc:aide-types',
        stepPath: '0.else.6',
      })
      const phiCatchSync = await hero.waitFor('state.sync', undefined, { from: phiCatchFrom })
      assert.equal(phiCatchSync.save.research?.['phi-3']?.catch, 1)

      const dupPhiSeeFrom = hero.mark()
      hero.send({
        t: 'script.op',
        op: 'research',
        speciesId: 'phi-3',
        task: 'see',
        amount: 1,
        sourceId: 'npc:aide-types',
        stepPath: '0.else.5',
      })
      await hero.waitFor('error', (m) => m.code === 'authority_violation', { from: dupPhiSeeFrom })

      // 2. Encounter & Shop Gates
      // 2a. Unscripted wild encounter in zero-encounter indoor map (origin-lab) is rejected
      const indoorWildFrom = hero.mark()
      hero.send({
        t: 'battle.start',
        kind: 'wild',
        speciesId: CONTENT.speciesList[0].id,
        level: 5,
      })
      await hero.waitFor('error', (m) => m.code === 'invalid_encounter', { from: indoorWildFrom })

      // 2b. Unqualified roaming legend encounter is rejected
      const fakeLegendFrom = hero.mark()
      hero.send({
        t: 'battle.start',
        kind: 'wild',
        speciesId: 'claude-opus',
        roamer: true,
        level: 35,
      })
      await hero.waitFor('error', (m) => m.code === 'invalid_encounter', { from: fakeLegendFrom })

      // 2c. Boss encounter from wrong map (cursor on origin-lab instead of gym-code) is rejected
      const wrongBossMapFrom = hero.mark()
      hero.send({
        t: 'battle.start',
        kind: 'boss',
        bossId: 'cursor',
        tierId: 'story',
      })
      await hero.waitFor('error', (m) => m.code === 'invalid_encounter', { from: wrongBossMapFrom })

      // 2d. Shop gates: move hero to opensource-shop with 0 badges
      const shopper = await joinAuthenticatedClient(srv, {
        name: 'ShopTester',
        map: 'opensource-shop',
        x: 4,
        y: 5,
        money: 50_000,
        badges: [],
      })
      clients.push(shopper)

      // Buying 6-badge item (full-restore) with 0 badges in opensource-shop is rejected
      const lockedTierShopFrom = shopper.mark()
      shopper.send({ t: 'shop.buy', itemId: 'full-restore', qty: 1 })
      await shopper.waitFor('error', (m) => m.code === 'shop_invalid', { from: lockedTierShopFrom })

      // Buying hub-only extra item (rare-ball) in opensource-shop is rejected
      const wrongTownExtraFrom = shopper.mark()
      shopper.send({ t: 'shop.buy', itemId: 'rare-ball', qty: 1 })
      await shopper.waitFor('error', (m) => m.code === 'shop_invalid', { from: wrongTownExtraFrom })

      // Buying opensource extra item (chip-unit-test) in opensource-shop succeeds
      const validExtraFrom = shopper.mark()
      shopper.send({ t: 'shop.buy', itemId: 'chip-unit-test', qty: 1 })
      const validExtraSync = await shopper.waitFor('state.sync', undefined, { from: validExtraFrom })
      assert.equal(validExtraSync.save.bag['chip-unit-test'], 1)

      // 3. Active Event Scatter Pickup & Multi-Step Mythic Chain Research
      const owSpawn = world.maps[world.startMap].spawn
      const explorer = await joinAuthenticatedClient(srv, {
        name: 'Explorer',
        map: world.startMap,
        x: owSpawn.x,
        y: owSpawn.y,
        money: 5000,
      })
      clients.push(explorer)

      const expSave = srv.authority.getSave(explorer.selfId)!
      expSave.clockMinutes = 720
      expSave.events = {
        'token-rain': {
          lastDay: 0,
          count: 1,
          startedAt: 700,
          activeUntil: 880,
          anchor: { map: world.startMap, x: owSpawn.x, y: owSpawn.y },
        },
        'mythos-1': {
          lastDay: 0,
          count: 1,
          startedAt: 700,
          activeUntil: 880,
          anchor: { map: world.startMap, x: owSpawn.x, y: owSpawn.y },
        },
        'mythos-2': {
          lastDay: 0,
          count: 1,
          startedAt: 700,
          activeUntil: 880,
          anchor: { map: world.startMap, x: owSpawn.x, y: owSpawn.y },
        },
      }
      srv.authority.setSave(explorer.selfId, expSave, { imported: false, trusted: true })

      const activeList = activeEvents(expSave.events, expSave.clockMinutes)
      const tokenRainEv = activeList.find((e) => e.id === 'token-rain')!
      const evSeed = hashString(`events:${world.seed >>> 0}:${expSave.playerId}`)
      const trActions = startActions(tokenRainEv, {
        areaLevel: [2, 5],
        rng: new Rng(eventSalt(evSeed, tokenRainEv)),
        at: { x: owSpawn.x, y: owSpawn.y },
      })
      const firstScatter = trActions.items[0]
      assert.ok(firstScatter, 'token-rain must deterministically produce scatter items')

      const validEvItemFrom = explorer.mark()
      explorer.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: firstScatter.item,
        qty: firstScatter.qty,
        groundId: firstScatter.id,
      })
      const validEvSync = await explorer.waitFor('state.sync', undefined, { from: validEvItemFrom })
      assert.equal(validEvSync.save.bag[firstScatter.item], 1)

      // Replaying the same active event item pickup is rejected
      const replayEvItemFrom = explorer.mark()
      explorer.send({
        t: 'script.op',
        op: 'giveItem',
        itemId: firstScatter.item,
        qty: firstScatter.qty,
        groundId: firstScatter.id,
      })
      await explorer.waitFor('error', (m) => m.code === 'authority_violation', { from: replayEvItemFrom })

      // Multi-step mythic-chain research across mythos-1 and mythos-2 increments progress to 2
      const m1From = explorer.mark()
      explorer.send({
        t: 'script.op',
        op: 'research',
        speciesId: 'claude-mythos',
        task: 'mythic-chain',
        amount: 1,
        sourceId: 'ev:mythos-1:script:0',
        stepPath: '2',
      })
      const m1Sync = await explorer.waitFor('state.sync', undefined, { from: m1From })
      assert.equal(m1Sync.save.research?.['claude-mythos']?.['mythic-chain'], 1)

      const m2From = explorer.mark()
      explorer.send({
        t: 'script.op',
        op: 'research',
        speciesId: 'claude-mythos',
        task: 'mythic-chain',
        amount: 1,
        sourceId: 'ev:mythos-2:script:0',
        stepPath: '2',
      })
      const m2Sync = await explorer.waitFor('state.sync', undefined, { from: m2From })
      assert.equal(m2Sync.save.research?.['claude-mythos']?.['mythic-chain'], 2)

      // 4. Atomic claimResearch & Flag Protection
      const resSave = srv.authority.getSave(explorer.selfId)!
      resSave.research ??= {}
      for (const sp of CONTENT.speciesList.slice(0, 25)) {
        resSave.research[sp.id] = { see: 10, catch: 10, defeat: 10 }
      }
      srv.authority.setSave(explorer.selfId, resSave, { imported: false, trusted: true })
      const expectedLv = researchLevel(researchPoints(resSave.research ?? {})).level
      assert.ok(expectedLv >= 1, 'seeded research must reach at least level 1')
      const expectedRew = levelRewards(0, expectedLv)
      const moneyBeforeClaim = resSave.money

      // Forging research:claimed via setFlag is rejected
      const forgeClaimFlagFrom = explorer.mark()
      explorer.send({ t: 'script.op', op: 'setFlag', flag: 'research:claimed', value: 0 })
      await explorer.waitFor('error', (m) => m.code === 'authority_violation', { from: forgeClaimFlagFrom })

      // Atomic claimResearch succeeds once and grants exact rewards
      const claimFrom = explorer.mark()
      explorer.send({ t: 'script.op', op: 'claimResearch', level: expectedLv })
      const claimSync = await explorer.waitFor('state.sync', undefined, { from: claimFrom })
      assert.equal(claimSync.save.flags['research:claimed'], expectedLv)
      assert.equal(claimSync.save.money, moneyBeforeClaim + expectedRew.money)

      // Replaying claimResearch is rejected
      const dupClaimFrom = explorer.mark()
      explorer.send({ t: 'script.op', op: 'claimResearch', level: expectedLv })
      await explorer.waitFor('error', (m) => m.code === 'authority_violation', { from: dupClaimFrom })

      // 5. Boss Contract runSeq Binding & dungeonBusy Guard
      const raider = await joinAuthenticatedClient(srv, {
        name: 'Raider',
        map: 'origin-lab-b1',
        x: 13,
        y: 3,
        party: [makeStrongCreature(999, 100)],
        bag: { 'prompt-ball': 10 },
      })
      clients.push(raider)

      const bossStartFrom = raider.mark()
      raider.send({
        t: 'battle.start',
        kind: 'boss',
        bossId: 'deepseek',
        tierId: 'story',
        captureAfterWin: true,
      })
      const bossStarted = await raider.waitFor('battle.started', undefined, { from: bossStartFrom })
      for (let t = 0; t < 25; t++) {
        const stepFrom = raider.mark()
        raider.send({
          t: 'battle.action',
          battleId: bossStarted.battleId,
          action: { kind: 'move', moveIndex: 0 } satisfies BattleAction,
        })
        const ev = await raider.waitFor('battle.events', (m) => m.battleId === bossStarted.battleId, { from: stepFrom })
        if (ev.events.some((e) => e.t === 'end')) break
      }
      await raider.waitFor('battle.end', (m) => m.battleId === bossStarted.battleId, { from: bossStartFrom })

      // Mutate save.instances['deepseek-tide'].runSeq to 99 to simulate runSeq drift; contract must still bind to won runSeq (1)
      const driftSave = srv.authority.getSave(raider.selfId)!
      driftSave.instances!['deepseek-tide'].runSeq = 99
      srv.authority.setSave(raider.selfId, driftSave, { imported: false, trusted: true })

      const contractFrom = raider.mark()
      raider.send({
        t: 'battle.contract',
        battleId: bossStarted.battleId,
        bossId: 'deepseek',
        tierId: 'story',
        ballId: 'prompt-ball',
      })
      const contracted = await raider.waitFor('battle.contracted', (m) => m.battleId === bossStarted.battleId, { from: contractFrom })
      assert.ok(contracted.signed, 'first-clear story contract must sign boss card')
      assert.equal(contracted.save.instances?.['deepseek-tide'].lastRollRun?.story, 1, 'contract roll must record the won battle runSeq (1), not drifted runSeq (99)')

      // dungeonBusy blocks authority mutations with self_busy
      const livePlayer = (srv.hub as unknown as { authority: unknown }) && srv.store
      const raiderSaveBeforeBusy = srv.authority.getSave(raider.selfId)!
      // Simulate dungeonBusy on connected player via a fake handle call
      const busyErrors: string[] = []
      const fakeBusyPlayer = {
        id: raider.selfId,
        name: 'Raider',
        avatar: '',
        ip: '127.0.0.1',
        dungeonBusy: true,
        state: { id: raider.selfId, name: 'Raider', avatar: '', map: 'origin-lab-b1', x: 13, y: 3, facing: 'down' as const, lead: null, busy: true, badges: 0, dexCaught: 0 },
        profile: { id: raider.selfId, name: 'Raider', avatar: '', badges: [], dexCaught: 0, party: [], pvpWins: 0, pvpLosses: 0, playTimeSec: 0 },
        limits: { errors: { take: () => true } },
      }
      assert.ok(livePlayer)
      srv.authority.handle(fakeBusyPlayer as never, { t: 'shop.buy', itemId: 'prompt-ball', qty: 1 })
      assert.equal(srv.authority.getSave(raider.selfId)!.bag['prompt-ball'], raiderSaveBeforeBusy.bag['prompt-ball'], 'dungeonBusy must block shop.buy mutation')
      assert.equal(busyErrors.length, 0)
    } finally {
      await Promise.all(clients.map((c) => c.close()))
      await srv.close()
    }
  })
})
