// Country-facing overworld attitude of roaming wild creatures (content/events/spawn.json roamingPolicy):
//   US     hostile: chases, unless the player's strongest party member outlevels it - then it flees
//   CN     neutral: never chases, never flees
//   others neutral, but flee once the player outlevels them
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTENT } from '../src/shared/content/index.ts'
import { createCreature } from '../src/shared/creature.ts'
import { GAMEPLAY } from '../src/shared/gameplay/data.ts'
import { validateGameplay } from '../src/shared/gameplay/validate.ts'
import { roamingDisposition } from '../src/shared/gameplay/spawns.ts'
import { Rng } from '../src/shared/rng.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { regionAt } from '../src/shared/world/worldapi.ts'
import type { Creature } from '../src/shared/types.ts'
import type { CreatureActor, GameContext } from '../src/client/contracts.ts'
import { createRoamingLayer } from '../src/client/world/roaming.ts'
import { createSpecialLayer, standable, type SpecialSpec } from '../src/client/world/rarity-spawns.ts'
import { GAME } from '../src/client/world/config.ts'

const speciesOf = (country: string) => {
  const sp = CONTENT.speciesList.find((s) => s.country === country)
  assert.ok(sp, `a species from ${country}`)
  return sp.id
}
const otherCountry = [...new Set(CONTENT.speciesList.map((s) => s.country))].find((c) => c !== 'US' && c !== 'CN')!

test('roaming policy lives in content and validates against the species data', () => {
  assert.deepEqual(validateGameplay(GAMEPLAY, CONTENT).filter((e) => e.includes('roamingPolicy')), [])
  assert.equal(GAMEPLAY.spawn.roamingPolicy.countries.US.base, 'chase')
  assert.deepEqual(GAMEPLAY.spawn.roamingPolicy.countries.CN, { base: 'neutral', outleveled: 'neutral' })
  const bad = { default: { base: 'neutral', outleveled: 'sulk' }, countries: { ZZ: { base: 'chase', outleveled: 'flee' } } }
  const errs = validateGameplay({ ...GAMEPLAY, spawn: { ...GAMEPLAY.spawn, roamingPolicy: bad as never } }, CONTENT).filter((e) => e.includes('roamingPolicy'))
  assert.equal(errs.length, 2, errs.join('\n'))
})

test('country roaming policy keeps domestic creatures neutral', () => {
  assert.equal(roamingDisposition('CN', 4, 99), 'neutral')
  assert.equal(roamingDisposition(' cn ', 40, 1), 'neutral')
  assert.equal(roamingDisposition('CN', 8, 8), 'neutral')
})

test('US creatures chase until the strongest party member outlevels them', () => {
  assert.equal(roamingDisposition('US', 8, 8), 'chase')
  assert.equal(roamingDisposition('US', 8, 7), 'chase')
  assert.equal(roamingDisposition('US', 8, 0), 'chase')
  assert.equal(roamingDisposition('US', 8, 9), 'flee')
})

test('other countries stay neutral until the player has a level advantage', () => {
  for (const code of ['DE', 'JP', 'UK', 'INTL']) {
    assert.equal(roamingDisposition(code, 8, 8), 'neutral')
    assert.equal(roamingDisposition(code, 8, 7), 'neutral')
    assert.equal(roamingDisposition(code, 8, 9), 'flee')
  }
  assert.equal(roamingDisposition(undefined, 8, 9), 'flee')
})

test('every species resolves to a stance from its real country', () => {
  for (const sp of CONTENT.speciesList) {
    const low = roamingDisposition(sp.country, 20, 5), high = roamingDisposition(sp.country, 20, 40)
    if (sp.country === 'CN') assert.deepEqual([low, high], ['neutral', 'neutral'], sp.id)
    else if (sp.country === 'US') assert.deepEqual([low, high], ['chase', 'flee'], sp.id)
    else assert.deepEqual([low, high], ['neutral', 'flee'], sp.id)
  }
})

// ---- the real layers on the real overworld --------------------------------------------------------------------

const world = buildWorld()
const map = world.maps[world.startMap]
const spawn = map.spawn

const stubActor = (): CreatureActor => ({
  object: undefined as never, x: 0, y: 0, elev: 0, speciesId: '',
  setPosition() {}, setFacingLeft() {}, setMoving() {}, setVisible() {}, setShiny() {}, setAura() {}, bubble() {}, update() {}, dispose() {},
})

function fakeCtx(partyLevel: number): GameContext {
  const lead = createCreature(speciesOf('CN'), partyLevel, { rng: new Rng(1) }, CONTENT)
  return {
    data: CONTENT,
    save: { party: [lead] as Creature[] },
    clock: { timeOfDay: 'day' },
    world: { createCreatureActor: stubActor, elevationAt: () => 0, spawnFx() {} },
    audio: { playSfx() {} },
    renderer: { flash() {}, shake() {} },
  } as unknown as GameContext
}

const specFor = (ctx: GameContext, speciesId: string, level: number): SpecialSpec => ({
  tag: 'test', creature: createCreature(speciesId, level, { rng: new Rng(2) }, ctx.data), aura: null, roaming: true,
  avoidPlayer: false, speedMul: 1, noticeRadius: 0, cues: {},
})

/** Finds an open strip near the spawn: a roamer can run straight toward or away from a player standing in it. */
function openSpot(wild = false): { x: number; y: number } {
  const ctx = { data: { ...CONTENT, world } } as unknown as Pick<GameContext, 'data'>
  for (let r = 6; r < 80; r += 2) for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
    const cx = spawn.x + dx, cy = spawn.y + dy
    let ok = true
    for (let y = cy - 2; y <= cy + 2 && ok; y++) for (let x = cx - 4; x <= cx + 8 && ok; x++) if (!standable(map, x, y, ctx)) ok = false
    if (ok && wild) { const rg = regionAt(map, cx, cy); ok = !!rg && rg.encounters.length > 0 && rg.roamingDensity > 0.3 }
    if (ok) return { x: cx + 0.5, y: cy + 0.5 }
  }
  throw new Error('no open ground near the spawn')
}

/** Runs the special layer for `seconds` and reports start/end distance and whether the creature ever noticed the player. */
function simulate(wildCountry: string, wildLevel: number, playerLevel: number, seconds = 8) {
  const ctx = fakeCtx(playerLevel)
  const at = openSpot()
  const player = { x: at.x, y: at.y }
  const layer = createSpecialLayer({ ctx, rng: new Rng(7), cues: { play() {} } as never, map: () => map, reserved: () => false })
  const s = layer.spawn(specFor(ctx, speciesOf(wildCountry), wildLevel), player.x + 3, player.y, { cue: false })
  const start = Math.hypot(s.x - player.x, s.y - player.y)
  let noticed = false, home = 0
  for (let t = 0; t < seconds; t += 0.05) {
    layer.update(0.05, player, true)
    noticed ||= s.noticed
    home = Math.max(home, Math.hypot(s.x - s.home.x, s.y - s.home.y))
  }
  return { start, end: Math.hypot(s.x - player.x, s.y - player.y), noticed, home }
}

test('special roamer: US and stronger than us -> chases the player down', () => {
  const r = simulate('US', 12, 5)
  assert.ok(r.noticed && r.end < r.start - 2, `end ${r.end.toFixed(2)} vs start ${r.start.toFixed(2)}`)
})

test('special roamer: US but we are stronger -> runs away', () => {
  const r = simulate('US', 5, 12)
  assert.ok(r.noticed && r.end > r.start + 2, `end ${r.end.toFixed(2)} vs start ${r.start.toFixed(2)}`)
})

test('special roamer: CN never chases or flees, whatever the levels', () => {
  for (const [wild, mine] of [[12, 5], [5, 12], [8, 8]]) {
    const r = simulate('CN', wild, mine)
    assert.equal(r.noticed, false, `CN ${wild} vs ${mine} noticed the player`)
    assert.ok(r.home <= GAME.roaming.wanderRadius + 0.5 && r.end > 0.8, `CN ${wild} vs ${mine} only wanders around its home (${r.home.toFixed(2)})`)
  }
})

test('special roamer: other countries flee when we are stronger, ignore us otherwise', () => {
  const fled = simulate(otherCountry, 5, 12)
  assert.ok(fled.noticed && fled.end > fled.start + 2, `${otherCountry} stronger-us: end ${fled.end.toFixed(2)} vs ${fled.start.toFixed(2)}`)
  for (const [wild, mine] of [[12, 5], [8, 8]]) {
    const r = simulate(otherCountry, wild, mine)
    assert.equal(r.noticed, false, `${otherCountry} ${wild} vs ${mine} noticed the player`)
  }
})

test('grass roamers take their mood from country and level, and re-evaluate when our best level changes', () => {
  const picks = [['US', 12], ['US', 5], ['CN', 12], ['CN', 5], [otherCountry, 12], [otherCountry, 5]] as const
  const ctx = fakeCtx(8)
  const at = openSpot(true)
  const player = { x: at.x, y: at.y }
  const g = { map }
  for (const [country, level] of picks) {
    let next = 0
    const layer = createRoamingLayer({
      ctx, rng: new Rng(11), grid: () => g, reserved: () => false,
      pick: () => (next++ === 0 ? { speciesId: speciesOf(country), level, shiny: false, aura: null, rare: false } : null),
    })
    for (let i = 0; i < 400 && !layer.list.length; i++) layer.update(0.1, player, true)
    const r = layer.list[0]
    assert.ok(r, `${country} roamer spawned`)
    const want = country === 'CN' ? 'calm' : country === 'US' ? (level > 8 ? 'chase' : 'flee') : level < 8 ? 'flee' : 'calm'
    assert.equal(r.mood, want, `${country} Lv${level} vs party Lv8`)
    // level up past it (or drop below it): the mood follows on the next step
    ctx.save.party[0].level = 30
    layer.update(0.1, player, true)
    assert.equal(layer.list[0].mood, country === 'CN' ? 'calm' : 'flee', `${country} Lv${level} after the party reaches Lv30`)
    ctx.save.party[0].level = 8
  }
})

test('a fleeing grass roamer cornered against a wall slides along it instead of freezing', () => {
  const ctx = fakeCtx(60)
  const at = openSpot(true)
  const player = { x: at.x, y: at.y }
  let given = false
  let wallX = -Infinity
  const layer = createRoamingLayer({
    ctx, rng: new Rng(21), grid: () => ({ map, blocked: (tx: number) => tx <= wallX }), reserved: () => false,
    pick: () => (given ? null : (given = true, { speciesId: speciesOf('US'), level: 5, shiny: false, aura: null, rare: false })),
  })
  for (let i = 0; i < 400 && !layer.list.length; i++) layer.update(0.1, player, true)
  const r = layer.list[0]
  assert.ok(r && r.mood === 'flee', 'a US roamer weaker than the party flees')
  // wall right behind the roamer, player on the open side
  wallX = Math.floor(r.x) - 1
  const p = { x: r.x + 2, y: r.y }
  const y0 = r.y
  for (let t = 0; t < 4; t += 0.05) layer.update(0.05, p, true)
  assert.ok(Math.abs(r.y - y0) > 1.2, `slid ${Math.abs(r.y - y0).toFixed(2)} tiles along the wall`)
  assert.ok(Math.hypot(r.x - p.x, r.y - p.y) > 2.2, 'and put distance between itself and the player')
})
