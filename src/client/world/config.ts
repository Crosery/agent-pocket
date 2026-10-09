// Typed view of content/game.json (overworld + integration tunables) and its validation against CONTENT.
import type { Dir, FieldWeatherKind, GameMap, ScriptStep } from '../../shared/types.ts'
import type { WorldFx } from '../contracts.ts'
import { CONTENT, t, type Content } from '../../shared/content/index.ts'
import gameJson from '../../../content/game.json' with { type: 'json' }
import { WORLD_CONTENT } from '../../shared/world/data.ts'

export type MapKind = GameMap['kind']
export type Range = [number, number]

export interface FootstepDef { sfx: string; volume: number; pitch: number; fx?: WorldFx }
export interface PropInteraction { action: 'box' | 'statue' | 'text' | 'script' | 'anchor'; text?: string; script?: ScriptStep[] }

export interface GameTuning {
  loop: { maxDtSec: number; pauseWhenHidden: boolean }
  loading: { showAfterMs: number; fadeOutMs: number; steps: string[]; worldSliceMs: number }
  title: { importCodeMaxLen: number }
  newGame: { startAnchor: string; facing: Dir; respawnAtStart: boolean; introScript: ScriptStep[] }
  player: {
    radius: number; cornerSlip: number; cornerSlipRate: number; substepTiles: number; axisDeadzone: number
    facingHysteresis: number; elevSmoothing: number; zoomByMapKind: Partial<Record<MapKind, number>>; showOwnName: boolean
    /** Fraction of the intended step that must actually be covered to count as moving. */
    movingRatio: number
    /** bump plays when blocked and less than stuckRatio of the intended step was covered. */
    bump: { sfx: string; cooldownMs: number; volume: number; stuckRatio: number }
    bike: { mapKinds: MapKind[]; sfxOn: string; sfxOff: string }
    surf: { hopMs: number; rideLift: number; splashEverySec: number; sfx: string; fx: WorldFx }
  }
  footsteps: {
    stride: { walk: number; run: number; bike: number; surf: number }
    default: FootstepDef
    surf: FootstepDef
    terrain: Record<string, FootstepDef>
  }
  follower: {
    /** Trail distance behind the player (tiles), + distancePerSize per unit of species size above 1. */
    distance: number; distancePerSize: number
    /** Personal space (tiles, + the same size extra): a follower in the player's way walks round its side at up to
     * sidestepSpeed (tiles/s along the circle) instead of being walked through. */
    minGap: number; sidestepSpeed: number
    /** Sideways gap (tiles) kept from the player while trailing on the camera side: base (the player's half width) +
     * perSize (half the card width of a size-1 lead) * species size, so even a wide lead never covers the player.
     * sideDeadzone: lateral offset (tiles) below which the follower keeps its current side; blendPerSec: how fast the
     * swing aside eases in / out (full swings per second); tries: swing shares tested (1, 1 - 1/tries, ...) when the
     * full swing would put it in a wall; dropBack: extra trail distance (base + perSize * size) taken when walls leave
     * no room to swing aside, so it hangs back instead of covering the player. */
    cameraClear: { base: number; perSize: number; sideDeadzone: number; blendPerSec: number; tries: number; dropBack: { base: number; perSize: number } }
    /** Speed cap (tiles/s): maxSpeed, or catchUpMul x the player's speed when that is higher. */
    maxSpeed: number; catchUpMul: number
    /** |sin| of the angle off the player's path above which the follower keeps its current side when pushed aside. */
    sideBias: number
    trailSpacing: number; maxTrail: number; indoorMaxSize: number
    /** Follower position is a critically damped spring on its trail target: natural frequency (rad/s), so it settles
     * in about 4 / springOmega seconds without overshooting and never starts or stops with a jolt. */
    springOmega: number
    /** Hop gait below moveMinSpeed (tiles/s); mirror flips need flipMinSpeed sideways (tiles/s). */
    teleportDistance: number; moveMinSpeed: number; flipMinSpeed: number
    mapKinds: MapKind[]; interactRadius: number; fx: WorldFx; cryPitch: number
    tiredBelow: number
    /** Map kinds where indoorMaxSize applies. */
    sizeCapMapKinds: MapKind[]
  }
  interact: { reach: number; radius: number; reachAcrossProps: string[]; props: Record<string, PropInteraction>; sfx: string }
  npc: {
    showNames: boolean; walkSpeed: number; turnToPlayer: boolean; cullDistance: number; blockedRetrySec: number
    wander: { pauseMinSec: number; pauseMaxSec: number; stepChance: number; maxStepsPerMove: number }
    trainer: { exclaimMs: number; approachSpeed: number; sfx: string; fx: WorldFx; bubble: string; cooldownSec: number }
  }
  encounters: {
    requireConsciousParty: boolean; surfEncounters: boolean; grassRateMultiplier: number; graceSteps: number
    transition: { kind: 'fade' | 'battle' | 'iris'; inMs: number; flashColor: string; flashMs: number; sfx: string; fx: WorldFx }
    legendRarityOrder: number; scriptedCanRun: boolean; repelOfferRefill: boolean
  }
  roaming: {
    mapKinds: MapKind[]; spawnIntervalSec: number; spawnTries: number; minSpawnDistance: number; despawnMargin: number
    lifetimeSec: Range; idleSec: Range; wanderRadius: number; speed: number; fleeSpeed: number; chaseSpeed: number
    touchRadius: number; noticeRange: number
    /** Radians a cornered fleeing roamer turns to slide along a wall. */
    fleeSlideRad: number
    noticeBubble: string; noticeBubbleMs: number; fleeBubble: string; despawnFx: WorldFx; spawnFx: WorldFx
    requireEncounterTerrain: boolean; cullDistance: number; arriveEpsilon: number
    /** Terrain keys no roamer or event creature spawns on (1-tile causeways would force the battle). */
    avoidTerrain?: string[]
  }
  warp: { fadeMs: number; sfx: Record<string, string>; fx: WorldFx }
  region: {
    bannerCooldownSec: number; musicFadeMs: number; nightMusicForTowns: boolean
    weatherIntensity: Partial<Record<FieldWeatherKind, number>>; recheckSec: number
    /** Map kinds whose regions drive the HUD name, banner, music and weather. */
    mapKinds: MapKind[]; defaultWeather: FieldWeatherKind
  }
  items: { pickupSfx: string; keyItemSfx: string; hiddenGlint: { radius: number; intervalSec: number; fx: WorldFx } }
  battle: { sayIntroBefore: boolean; sayDefeatTextAfter: boolean; lossAbortsScript: boolean; afterBattleSettleMs: number; fallbackMaxSteps: number }
  blackout: { fadeMs: number; sfx: string }
  fly: { minBadges: number; keyItemKind: string; mapKinds: MapKind[]; sfx: string }
  /**
   * Teleport anchors (content/world/anchors.json): who may travel between them, separate from the town fly above.
   * `keyItemKind` '' = no key item needed; `scanSec` = how often the surroundings are checked for anchors to
   * activate; `beaconRadius` = anchors within this many tiles get their glow drawn.
   */
  anchorTravel: { minBadges: number; keyItemKind: string; mapKinds: MapKind[]; scanSec: number; beaconRadius: number }
  script: {
    maxDepth: number; healWaitMs: number; healSfx: string; moneySfx: string; questSfx: string; unlockSfx: string
    fadeMs: number; moveNpcSpeed: number
  }
  presence: {
    chatBubbleMs: number; emoteBubbleMs: number; bubbleMaxChars: number; interactRadius: number
    followerDistance: number; followerRate: number; leadDebounceSec: number; inspectTimeoutMs: number
    /** Remote players walk while their interpolated position moves faster than moveMinSpeed (tiles/s), held
     * moveHoldMs through short snapshot stalls. */
    moveMinSpeed: number; moveHoldMs: number
  }
  markers: { refreshSec: number; trainers: boolean; quest: boolean; others: boolean; rares: boolean; wild: boolean; items: boolean }
  fog: { mapKinds: MapKind[] }
  autosave: { events: string[]; minIntervalSec: number; onHidden: boolean }
  hud: { moneyCheckSec: number }
  flags: { badgePrefix: string; bossWonPrefix: string }
  debug: {
    partySize: number; partyLevel: number; money: number; keyItemKinds: string[]
    categoryQty: Record<string, number>; freezeClockWithTime: boolean; overlayRefreshMs: number; battleLevel: number
    /** ?dev=1 boss sandbox: a sensible team (party level = boss level + levelOffset) and counter items in the bag. */
    boss: { party: string[]; levelOffset: number; counterQty: number }
  }
}

export const GAME: GameTuning = gameJson as unknown as GameTuning

/** Text that is either a text-table key (localised via t()) or a literal string from data. */
export function textOrKey(s: string, params?: Record<string, string | number>, c: Content = CONTENT): string {
  return s in c.text ? t(s, params, c) : s
}

/** Overworld fx kinds the renderer implements (code capability ids, mirrored from the WorldFx contract). */
const WORLD_FX: readonly WorldFx[] = ['exclaim', 'question', 'grass', 'dust', 'sparkle', 'splash', 'heart', 'warp', 'levelup', 'shiny']
const MAP_KINDS: readonly MapKind[] = ['overworld', 'interior', 'cave']
const GAME_EVENTS = [
  'save:changed', 'party:changed', 'bag:changed', 'money:changed', 'dex:seen', 'dex:caught', 'map:entered', 'region:entered',
  'quest:updated', 'badge:earned', 'battle:start', 'battle:end', 'settings:changed', 'net:status', 'chat:message', 'toast',
]

/** Problems in content/game.json (unknown sfx/fx/terrain/prop/event ids, bad ranges). Empty = consistent. */
export function validateGameContent(g: GameTuning = GAME, c: Content = CONTENT): string[] {
  const errs: string[] = []
  const sfx = new Set(c.audio.sfx)
  const checkSfx = (where: string, id: string, optional = false) => {
    if (optional && id === '') return
    if (!sfx.has(id)) errs.push(`game.json ${where}: unknown sfx "${id}"`)
  }
  const checkFx = (where: string, id: string | undefined) => {
    if (id !== undefined && !WORLD_FX.includes(id as WorldFx)) errs.push(`game.json ${where}: unknown fx "${id}"`)
  }
  const checkKinds = (where: string, kinds: string[]) => {
    for (const k of kinds) if (!MAP_KINDS.includes(k as MapKind)) errs.push(`game.json ${where}: unknown map kind "${k}"`)
  }
  const checkRange = (where: string, r: Range) => {
    if (!Array.isArray(r) || r.length !== 2 || !(r[0] <= r[1]) || r[0] < 0) errs.push(`game.json ${where}: bad range`)
  }
  const checkStep = (where: string, f: FootstepDef) => {
    checkSfx(where, f.sfx)
    checkFx(where, f.fx)
    if (!(f.volume >= 0 && f.volume <= 1)) errs.push(`game.json ${where}: volume out of 0..1`)
    if (!(f.pitch > 0)) errs.push(`game.json ${where}: pitch must be > 0`)
  }

  checkSfx('player.bump.sfx', g.player.bump.sfx)
  checkSfx('player.bike.sfxOn', g.player.bike.sfxOn)
  checkSfx('player.bike.sfxOff', g.player.bike.sfxOff)
  checkSfx('player.surf.sfx', g.player.surf.sfx)
  checkFx('player.surf.fx', g.player.surf.fx)
  checkKinds('player.bike.mapKinds', g.player.bike.mapKinds)
  if (!(g.player.radius > 0 && g.player.radius < 0.5)) errs.push('game.json player.radius must be in (0, 0.5)')
  if (!(g.player.substepTiles > 0 && g.player.substepTiles <= 0.5)) errs.push('game.json player.substepTiles must be in (0, 0.5]')
  checkStep('footsteps.default', g.footsteps.default)
  checkStep('footsteps.surf', g.footsteps.surf)
  for (const [key, f] of Object.entries(g.footsteps.terrain)) {
    if (!c.terrainByKey[key]) errs.push(`game.json footsteps.terrain: unknown terrain "${key}"`)
    checkStep(`footsteps.terrain.${key}`, f)
  }
  checkKinds('follower.mapKinds', g.follower.mapKinds)
  {
    const F = g.follower
    for (const k of ['distance', 'distancePerSize', 'minGap', 'sidestepSpeed', 'sideBias', 'moveMinSpeed', 'flipMinSpeed'] as const) {
      if (!(typeof F[k] === 'number' && F[k] >= 0)) errs.push(`game.json follower.${k}: must be a number >= 0`)
    }
    if (!(F.minGap < F.distance)) errs.push('game.json follower.minGap must be < follower.distance (it would shove the follower off its trail)')
    for (const k of ['base', 'perSize', 'sideDeadzone', 'blendPerSec'] as const) {
      if (!(typeof F.cameraClear?.[k] === 'number' && F.cameraClear[k] >= 0)) errs.push(`game.json follower.cameraClear.${k}: must be a number >= 0`)
    }
    if (!(F.sidestepSpeed > 0)) errs.push('game.json follower.sidestepSpeed must be > 0 (a follower in the way would never step aside)')
    if (!(F.cameraClear?.blendPerSec > 0)) errs.push('game.json follower.cameraClear.blendPerSec must be > 0')
    if (!(Number.isInteger(F.cameraClear?.tries) && F.cameraClear.tries >= 1)) errs.push('game.json follower.cameraClear.tries must be an integer >= 1')
    for (const k of ['base', 'perSize'] as const) {
      if (!(typeof F.cameraClear?.dropBack?.[k] === 'number' && F.cameraClear.dropBack[k] >= 0)) errs.push(`game.json follower.cameraClear.dropBack.${k}: must be a number >= 0`)
    }
    if (!(F.maxSpeed > 0 && F.catchUpMul >= 1)) errs.push('game.json follower: maxSpeed must be > 0 and catchUpMul >= 1 (it could never keep up)')
  }
  checkFx('follower.fx', g.follower.fx)
  checkSfx('interact.sfx', g.interact.sfx)
  for (const key of g.interact.reachAcrossProps) if (!c.props[key]) errs.push(`game.json interact.reachAcrossProps: unknown prop "${key}"`)
  for (const [key, p] of Object.entries(g.interact.props)) {
    if (!c.props[key]) errs.push(`game.json interact.props: unknown prop "${key}"`)
    if (!['box', 'statue', 'text', 'script', 'anchor'].includes(p.action)) errs.push(`game.json interact.props.${key}: unknown action "${p.action}"`)
    if (p.action === 'text' && !p.text) errs.push(`game.json interact.props.${key}: text action needs "text"`)
    if (p.action === 'script' && !Array.isArray(p.script)) errs.push(`game.json interact.props.${key}: script action needs "script"`)
  }
  checkSfx('npc.trainer.sfx', g.npc.trainer.sfx)
  checkFx('npc.trainer.fx', g.npc.trainer.fx)
  checkSfx('encounters.transition.sfx', g.encounters.transition.sfx)
  checkFx('encounters.transition.fx', g.encounters.transition.fx)
  if (!(g.encounters.grassRateMultiplier > 0 && g.encounters.grassRateMultiplier <= 1)) {
    errs.push('game.json encounters.grassRateMultiplier must be in (0, 1]')
  }
  checkKinds('roaming.mapKinds', g.roaming.mapKinds)
  checkRange('roaming.lifetimeSec', g.roaming.lifetimeSec)
  checkRange('roaming.idleSec', g.roaming.idleSec)
  if (!(g.roaming.fleeSlideRad > 0 && g.roaming.fleeSlideRad < Math.PI)) errs.push('game.json roaming.fleeSlideRad must be in (0, pi)')
  checkFx('roaming.despawnFx', g.roaming.despawnFx)
  checkFx('roaming.spawnFx', g.roaming.spawnFx)
  for (const key of g.roaming.avoidTerrain ?? []) if (!c.terrainByKey[key]) errs.push(`game.json roaming.avoidTerrain: unknown terrain "${key}"`)
  for (const [kind, id] of Object.entries(g.warp.sfx)) checkSfx(`warp.sfx.${kind}`, id, true)
  checkFx('warp.fx', g.warp.fx)
  checkSfx('items.pickupSfx', g.items.pickupSfx)
  checkSfx('items.keyItemSfx', g.items.keyItemSfx)
  checkFx('items.hiddenGlint.fx', g.items.hiddenGlint.fx)
  checkSfx('blackout.sfx', g.blackout.sfx)
  checkSfx('fly.sfx', g.fly.sfx)
  checkKinds('fly.mapKinds', g.fly.mapKinds)
  checkKinds('anchorTravel.mapKinds', g.anchorTravel.mapKinds)
  if (g.anchorTravel.keyItemKind && !c.itemList.some((it) => it.effect.kind === 'key' && it.effect.key === g.anchorTravel.keyItemKind)) errs.push(`game.json anchorTravel.keyItemKind: no item of kind "${g.anchorTravel.keyItemKind}"`)
  if (!(g.anchorTravel.scanSec > 0 && g.anchorTravel.beaconRadius > 0)) errs.push('game.json anchorTravel: scanSec and beaconRadius must be > 0')
  for (const [id, k] of Object.entries(WORLD_CONTENT.anchors.kinds)) {
    if (g.interact.props[k.prop]?.action !== 'anchor') errs.push(`game.json interact.props.${k.prop}: anchor kind "${id}" needs action "anchor"`)
  }
  for (const k of ['healSfx', 'moneySfx', 'questSfx', 'unlockSfx'] as const) checkSfx(`script.${k}`, g.script[k])
  checkKinds('fog.mapKinds', g.fog.mapKinds)
  checkKinds('follower.sizeCapMapKinds', g.follower.sizeCapMapKinds)
  checkKinds('region.mapKinds', g.region.mapKinds)
  for (const k of Object.keys(g.region.weatherIntensity)) if (!(`game.weather.${k}` in c.text)) errs.push(`text: missing "game.weather.${k}"`)
  if (!(g.region.defaultWeather in g.region.weatherIntensity)) errs.push(`game.json region.defaultWeather: "${g.region.defaultWeather}" has no weatherIntensity`)
  for (const e of g.autosave.events) if (!GAME_EVENTS.includes(e)) errs.push(`game.json autosave.events: unknown event "${e}"`)
  for (const cat of Object.keys(g.debug.categoryQty)) if (!c.itemList.some((it) => it.category === cat)) errs.push(`game.json debug.categoryQty: no items in category "${cat}"`)
  for (const id of g.debug.boss.party) if (!c.species[id]) errs.push(`game.json debug.boss.party: unknown species "${id}"`)
  for (const step of g.newGame.introScript) {
    if (step.op === 'say' && !(step.text in c.text)) errs.push(`game.json newGame.introScript: missing text key "${step.text}"`)
    if (step.op === 'sfx') checkSfx('newGame.introScript', step.id)
  }
  return errs
}

/** Final tall-grass roll rate after the global comfort multiplier and active event modifiers. */
export function grassEncounterRate(base: number, eventMultiplier = 1, g: GameTuning = GAME): number {
  const rate = Math.max(0, base) * Math.max(0, g.encounters.grassRateMultiplier) * Math.max(0, eventMultiplier)
  return Math.min(1, rate)
}
