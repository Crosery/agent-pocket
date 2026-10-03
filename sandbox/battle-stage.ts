/// <reference types="vite/client" />
// Dev sandbox for the HD-2D battle diorama (src/client/render/battle). Cycles every MoveAnim, hit / miss / crit /
// faint, statuses, stat changes, heal, level up, weather, send-out / recall, catch and evolution.
//
// URL params: biome=<id> tod=<dawn|day|dusk|night> indoor=1 q=<quality> w=<weatherId> hud=0
//             p=<species> e=<species> ps=1 es=1 (shiny) pt=<sheet> et=<sheet|none>
//             do=<action> at=<seconds>  pre-populates the stage, runs one action and freezes the simulation `at`
//                                       seconds later (deterministic screenshots). Actions:
//               intro:<wild|trainer|pvp|legend>  attack:<anim>[:<side>[:<category>]]  hit:<eff>[:crit]  miss  faint
//               status:<id>  stat:<up|down>  heal  levelup  catch:<shakes>:<0|1>  sendout  recall  evolve  weather:<id>  idle
//             (no do=) cycles everything forever.
// Keys: Space pause/resume · N skip to next action · B next biome · T next time of day · I toggle indoor · Q quality
import * as THREE from 'three'
import { CONTENT } from '../src/shared/content/index.ts'
import type { MoveAnim, MoveCategory, Settings, TimeOfDay } from '../src/shared/types.ts'
import type { AssetStore } from '../src/client/contracts.ts'
import { createRenderer } from '../src/client/render/index.ts'
import { createBattleStage, type BattleStage, type IntroKind } from '../src/client/render/battle/index.ts'
import { STAGE } from '../src/client/render/battle/config.ts'
import { createAssetStore } from '../src/client/core/assets.ts'

const errorsEl = document.getElementById('errors')!
const logError = (msg: string) => { errorsEl.textContent += `${msg}\n` }
window.addEventListener('error', (e) => logError(`error: ${e.message}`))
window.addEventListener('unhandledrejection', (e) => logError(`rejection: ${String(e.reason?.stack ?? e.reason)}`))
const origError = console.error.bind(console)
console.error = (...a: unknown[]) => { logError(a.map(String).join(' ').slice(0, 400)); origError(...a) }

const params = new URLSearchParams(location.search)
const probe = { frames: 0, phase: 'boot', action: '', actionT: 0, frozen: false }
;(window as unknown as { __ap: typeof probe }).__ap = probe

const TODS: TimeOfDay[] = ['dawn', 'day', 'dusk', 'night']
/** Dev-harness pacing of the auto-cycle (seconds), its demo hit pattern and the fixed simulation step. Not game data. */
const DEMO = {
  gap: 0.25, weatherHold: 2.2, weatherShot: 0.4, catchGap: 0.4, catchHold: 0.8, loopGap: 0.6,
  effectiveness: [1, 2, 0.5, 1, 2, 0], missEvery: 7, critEvery: 5, failShakes: 1,
  step: 1 / 60,
}
const species = CONTENT.speciesList
const pick = (id: string | null, fallback: number) => (id && CONTENT.species[id] ? id : species[Math.max(0, Math.min(species.length - 1, fallback))]?.id ?? '')
const playerSpecies = pick(params.get('p'), 0)
const enemySpecies = pick(params.get('e'), species.length - 1)
const evolveTarget = CONTENT.species[playerSpecies]?.evolvesTo?.id ?? enemySpecies
const playerSheet = params.get('pt') ?? CONTENT.characters.find((c) => c.playable)?.id ?? null
const enemySheetParam = params.get('et')
const enemySheet = enemySheetParam === 'none' ? null : enemySheetParam ?? CONTENT.characters.find((c) => !c.playable)?.id ?? null

const state = {
  biome: params.get('biome') && CONTENT.biomeById[params.get('biome')!] ? params.get('biome')! : CONTENT.biomes[0].id,
  tod: (TODS.includes(params.get('tod') as TimeOfDay) ? params.get('tod') : 'day') as TimeOfDay,
  indoor: params.get('indoor') === '1',
  paused: false,
  skip: false,
}

/** A move using the anim (for its type and category), else a cycled type. */
function moveFor(anim: string, i: number): { type: string; category: MoveCategory } {
  const m = CONTENT.moveList.find((x) => x.anim === anim)
  if (m) return { type: m.type, category: m.category }
  return { type: CONTENT.types[i % CONTENT.types.length].id, category: 'special' }
}

function firstBallColor(): string {
  for (const i of CONTENT.itemList) if (i.effect.kind === 'ball') return i.effect.color
  return STAGE.ball.defaultColor
}

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement
  const hud = document.getElementById('hud')!
  if (params.get('hud') === '0') hud.classList.add('hidden')
  const settings: Settings = { ...CONTENT.config.defaultSettings }
  const q = params.get('q')
  if (q && q in CONTENT.config.render.internalHeight) settings.quality = q as Settings['quality']
  const assets: AssetStore = createAssetStore()
  await assets.init()
  const renderer = createRenderer(canvas, settings)
  const resize = () => renderer.resize(innerWidth, innerHeight)
  addEventListener('resize', resize)
  resize()

  let stage: BattleStage = build()
  let label = ''
  function build(): BattleStage {
    const s = createBattleStage(renderer, assets, { biome: state.biome, timeOfDay: state.tod, indoor: state.indoor })
    s.setTrainer(0, playerSheet)
    s.setTrainer(1, enemySheet)
    const w = params.get('w')
    if (w) s.weatherFx(w)
    return s
  }
  function rebuild(): void {
    stage.dispose()
    stage = build()
    populate(stage)
  }
  function populate(s: BattleStage): void {
    s.setCreature(0, playerSpecies, params.get('ps') === '1')
    s.setCreature(1, enemySpecies, params.get('es') === '1')
    s.showCreature(0, true)
    s.showCreature(1, true)
  }

  const say = (t: string) => { label = t; probe.action = t; probe.actionT = 0 }

  async function runAction(s: BattleStage, spec: string): Promise<void> {
    const [kind, a, b, c] = spec.split(':')
    say(spec)
    switch (kind) {
      case 'intro': {
        s.showCreature(0, false)
        s.showCreature(1, false)
        await s.intro((a as IntroKind) || 'wild')
        break
      }
      case 'attack': {
        const anim = (a || 'hit') as MoveAnim
        const side = (Number(b) === 1 ? 1 : 0) as 0 | 1
        const mv = moveFor(anim, 0)
        await s.attack(side, anim, mv.type, (c as MoveCategory) || mv.category)
        break
      }
      case 'hit': await s.hit(1, Number(a || 1), b === 'crit'); break
      case 'miss': await s.miss(0); break
      case 'faint': await s.faint(1); break
      case 'status': await s.statusFx(1, a || CONTENT.statuses[0].id); break
      case 'stat': await s.statFx(0, a !== 'down'); break
      case 'heal': await s.healFx(0); break
      case 'levelup': await s.levelUpFx(0); break
      case 'catch': await s.throwBall(firstBallColor(), Number(a ?? 3), b !== '0'); break
      case 'sendout': s.showCreature(0, false); await s.sendOut(0); break
      case 'recall': await s.recall(0); break
      case 'evolve': await s.evolveFx(playerSpecies, evolveTarget, false); break
      case 'weather': s.weatherFx(a || CONTENT.weathers[0].id); await new Promise((r) => setTimeout(r, DEMO.weatherShot * 1000)); break
      default: break
    }
  }

  async function cycle(): Promise<void> {
    const anims = Object.keys(STAGE.timelines.anims) as MoveAnim[]
    const balls = CONTENT.itemList.filter((i) => i.effect.kind === 'ball').map((i) => (i.effect as { color: string }).color)
    const pause = (sec: number) => new Promise<void>((r) => { const t0 = performance.now(); const tick = () => { if (state.skip || performance.now() - t0 > sec * 1000) { state.skip = false; r() } else requestAnimationFrame(tick) }; tick() })
    for (;;) {
      const s = stage
      say('intro:wild')
      s.setCreature(1, enemySpecies, params.get('es') === '1')
      s.showCreature(0, false)
      s.showCreature(1, false)
      await s.intro('wild')
      say('sendOut 0')
      s.setCreature(0, playerSpecies, params.get('ps') === '1')
      await s.sendOut(0, balls[0])
      for (let i = 0; i < anims.length && s === stage; i++) {
        const side = (i % 2) as 0 | 1
        const mv = moveFor(anims[i], i)
        say(`attack ${anims[i]} (${CONTENT.typeById[mv.type]?.nameZh ?? mv.type}, ${mv.category}) side ${side}`)
        await s.attack(side, anims[i], mv.type, mv.category)
        const target = (1 - side) as 0 | 1
        if (mv.category === 'status') { await pause(DEMO.gap); continue }
        const eff = DEMO.effectiveness[i % DEMO.effectiveness.length]
        const crit = i % DEMO.critEvery === DEMO.critEvery - 1
        if (i % DEMO.missEvery === DEMO.missEvery - 1) { say(`miss side ${side}`); await s.miss(side) }
        else { say(`hit side ${target} eff ${eff}${crit ? ' crit' : ''}`); await s.hit(target, eff, crit) }
        await pause(DEMO.gap)
      }
      for (const st of CONTENT.statuses) { say(`status ${st.id} ${st.nameZh}`); await s.statusFx(1, st.id); await pause(DEMO.gap) }
      say('stat up'); await s.statFx(0, true)
      say('stat down'); await s.statFx(1, false)
      say('heal'); await s.healFx(0)
      say('level up'); await s.levelUpFx(0)
      for (const w of CONTENT.weathers) { say(`weather ${w.id} ${w.nameZh}`); s.weatherFx(w.id); await pause(DEMO.weatherHold) }
      s.weatherFx('none')
      say(`catch fail (${DEMO.failShakes} shake)`); await s.throwBall(balls[1 % balls.length] ?? STAGE.ball.defaultColor, DEMO.failShakes, false); await pause(DEMO.catchGap)
      say('catch success'); await s.throwBall(balls[2 % balls.length] ?? STAGE.ball.defaultColor, CONTENT.config.catch.shakeChecks, true); await pause(DEMO.catchHold)
      s.setCreature(1, enemySpecies, false)
      s.showCreature(1, true)
      say('recall 0'); await s.recall(0)
      say('sendOut 0'); await s.sendOut(0, balls[3 % balls.length])
      say('faint 1'); await s.faint(1)
      say('evolve'); await s.evolveFx(playerSpecies, evolveTarget, false)
      await pause(DEMO.loopGap)
    }
  }

  const action = params.get('do')
  const freezeAt = Number(params.get('at') ?? NaN)
  populate(stage)
  if (action) {
    probe.phase = 'ready-wait'
    await stage.ready
    probe.phase = 'action'
    void runAction(stage, action).then(() => { probe.phase = 'done' })
  } else void cycle()

  addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space': state.paused = !state.paused; break
      case 'KeyN': state.skip = true; break
      case 'KeyB': state.biome = CONTENT.biomes[(CONTENT.biomes.findIndex((b) => b.id === state.biome) + 1) % CONTENT.biomes.length].id; rebuild(); break
      case 'KeyT': state.tod = TODS[(TODS.indexOf(state.tod) + 1) % TODS.length]; rebuild(); break
      case 'KeyI': state.indoor = !state.indoor; rebuild(); break
      case 'KeyQ': {
        const qs = Object.keys(CONTENT.config.render.internalHeight) as Settings['quality'][]
        const cur = renderer.settings.quality
        renderer.applySettings({ ...renderer.settings, quality: qs[(qs.indexOf(cur) + 1) % qs.length] })
        resize()
        break
      }
    }
  })

  const STEP = DEMO.step
  let fps = 60, last = performance.now()
  function frame(now: number): void {
    const realDt = (now - last) / 1000
    last = now
    fps = fps * 0.95 + (1 / Math.max(1e-3, realDt)) * 0.05
    const frozen = state.paused || (Number.isFinite(freezeAt) && probe.phase !== 'ready-wait' && probe.actionT >= freezeAt)
    probe.frozen = frozen
    const dt = frozen ? 0 : STEP
    if (!frozen) probe.actionT += STEP
    stage.update(dt)
    renderer.render(stage.view, dt)
    probe.frames++
    const info = renderer.gl.info.render
    hud.textContent = `${state.biome}${state.indoor ? ' (indoor)' : ''} · ${state.tod} · ${renderer.settings.quality} · ${fps.toFixed(0)} fps · ${info.calls} calls\n${label}${frozen ? '  [frozen]' : ''}`
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  Object.assign(window, { __apStage: () => stage, THREE })
}

main().catch((e) => logError(String(e?.stack ?? e)))
