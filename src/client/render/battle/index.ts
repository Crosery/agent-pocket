// HD-2D battle diorama (Octopath-style): a lit 3D slice of the biome with a painted backdrop, billboard creatures
// and trainers with real shadows, a cinematic camera and data-driven VFX timelines for every MoveAnim. Every
// tunable (layout, shots, timings, colors, particle counts...) lives in content/battle-stage.json.
//
// Choreography methods return promises resolved by update(dt): drive update() from the render loop.
// Side semantics follow BattleEvent: hit(side) = the side taking damage, miss(side) = the attacker.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { MoveAnim, MoveCategory, StatusId, TypeId, WeatherId } from '../../../shared/types.ts'
import type { AssetStore, BattleStageOptions, HD2DRenderer, PostParams, RenderView } from '../../contracts.ts'
import { RENDER, hexToRgb, qualityPreset } from '../config.ts'
import { isHD2DRendererExt } from '../hd2d.ts'
import { cameraYaw } from '../sprite-utils.ts'
import { createCaptureBall } from './ball.ts'
import { createBattleCamera } from './camera.ts'
import { STAGE, expandSteps, otherSide, shotFor, timelineLength, type ShotDef, type SideIndex, type VfxStep } from './config.ts'
import { createEnvironment } from './environment.ts'
import { createSharedGeometries } from './meshes.ts'
import { createGlyphAtlas, createParticlePool } from './particles.ts'
import { colorHex, spawnStep, type Effect, type FxCtx, type FxHost } from './primitives.ts'
import { BOSS_PRES, bossEntry, bossTheme, themeGlyphs, type BossEntry } from './boss-config.ts'
import { createBattleSprite, type BattleSprite } from './sprites.ts'
import { createScheduler, ease } from './timeline.ts'

export type IntroKind = 'wild' | 'trainer' | 'pvp' | 'legend'

export interface BattleStage {
  readonly view: RenderView
  /** Resolves once props and the backdrop have loaded (intro() waits for it, bounded by readyTimeoutMs). */
  readonly ready: Promise<void>
  /**
   * Assigns a slot's creature (null clears it). An occupied (visible) slot swaps sprites in place; an empty slot
   * keeps the creature hidden until intro() reveals it (wild / legend foe) or sendOut() presents it.
   */
  setCreature(side: 0 | 1, speciesId: string | null, shiny: boolean): void
  /** Shows / hides a slot's creature instantly (no effect). */
  showCreature(side: 0 | 1, visible: boolean): void
  setTrainer(side: 0 | 1, sheet: string | null): void
  /**
   * Marks a slot as holding a boss (content/boss-presentation.json): scaled sprite, boss camera base shot, idle float
   * and the theme's aura. Call before setCreature(); null returns the slot to a normal creature.
   */
  setBoss(side: 0 | 1, bossId: string | null): void
  /** Screen rectangle of a creature's sprite card as fractions of the viewport (QA / layout audit); null when hidden. */
  creatureRect(side: 0 | 1): { left: number; top: number; right: number; bottom: number } | null
  intro(kind: IntroKind): Promise<void>
  sendOut(side: 0 | 1, ballColor?: string): Promise<void>
  recall(side: 0 | 1): Promise<void>
  attack(side: 0 | 1, anim: MoveAnim, type: TypeId, category: MoveCategory): Promise<void>
  /** `side` = the creature taking the hit. */
  hit(side: 0 | 1, effectiveness: number, crit: boolean): Promise<void>
  /** `side` = the attacker whose move missed (the foe dodges). */
  miss(side: 0 | 1): Promise<void>
  faint(side: 0 | 1): Promise<void>
  statusFx(side: 0 | 1, status: StatusId): Promise<void>
  statFx(side: 0 | 1, up: boolean): Promise<void>
  healFx(side: 0 | 1): Promise<void>
  /** Sets the persistent battle weather ('none' clears) and plays its start burst. */
  weatherFx(w: WeatherId): void
  throwBall(color: string, shakes: number, success: boolean): Promise<void>
  levelUpFx(side: 0 | 1): Promise<void>
  /** Evolution cutscene; resolves false when cancelEvolve() interrupted it. */
  evolveFx(fromSpecies: string, toSpecies: string, shiny: boolean): Promise<boolean>
  /** Requests cancellation of a running evolveFx (honoured during the silhouette alternation). */
  cancelEvolve(): void
  update(dt: number): void
  dispose(): void
}

const srgb = (hex: string, out = new THREE.Color()) => out.setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)

function collectChars(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) { for (const x of node) collectChars(x, out); return }
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'chars' && typeof v === 'string') for (const ch of v) out.add(ch)
    else collectChars(v, out)
  }
}

export function createBattleStage(renderer: HD2DRenderer, assets: AssetStore, opts: BattleStageOptions): BattleStage {
  const S = STAGE, T = S.timelines
  const ext = isHD2DRendererExt(renderer) ? renderer : null
  const settings = () => ext?.settings ?? CONTENT.config.defaultSettings
  const quality = () => ext?.quality ?? qualityPreset(settings().quality)

  const scene = new THREE.Scene()
  scene.name = 'battle'
  const env = createEnvironment(scene, assets, { biome: opts.biome, timeOfDay: opts.timeOfDay, indoor: opts.indoor })
  const origin = env.origin
  const cam = createBattleCamera(origin)
  const sched = createScheduler()

  // --- actors --------------------------------------------------------------
  const spot = (xz: [number, number]) => new THREE.Vector3(origin.x + xz[0], env.groundAt(xz[0], xz[1]), origin.z + xz[1])
  const creatureHomes = S.slots.map((sl) => spot(sl.creature)) as [THREE.Vector3, THREE.Vector3]
  const trainerHomes = S.slots.map((sl) => spot(sl.trainer)) as [THREE.Vector3, THREE.Vector3]
  const creatures = creatureHomes.map((h, i) => createBattleSprite('creature', assets, h, S.creature.breathPhase[i])) as [BattleSprite, BattleSprite]
  const trainers = trainerHomes.map((h, i) => createBattleSprite('trainer', assets, h, S.trainer.breathPhase[i])) as [BattleSprite, BattleSprite]
  const evolveHome = spot(S.evolve.spot)
  const evolveSprite = createBattleSprite('creature', assets, evolveHome, S.evolve.breathPhase)
  for (const s of [...creatures, ...trainers, evolveSprite]) scene.add(s.root)
  let evolveActive = false

  // --- vfx -----------------------------------------------------------------
  const vfxGroup = new THREE.Group()
  vfxGroup.name = 'battle-vfx'
  scene.add(vfxGroup)
  const geos = createSharedGeometries(S.vfx.geometry)
  const chars = new Set<string>(S.vfx.glyphChars)
  collectChars(T, chars)
  for (const ch of themeGlyphs()) chars.add(ch)
  const atlas = createGlyphAtlas([...chars].join(''), S.vfx.glyphFont, S.vfx.glyphCell)
  const additive = createParticlePool(S.vfx.pool.add, true, atlas, S.vfx.look.particles)
  const alpha = createParticlePool(S.vfx.pool.alpha, false, atlas, S.vfx.look.particles)
  vfxGroup.add(additive.points, alpha.points)
  const vfxLights = Array.from({ length: Math.max(0, S.lighting.vfxLights) }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 1, S.lighting.vfxLightDecay)
    light.castShadow = false
    scene.add(light)
    return { light, busy: false, since: 0 }
  })
  const ball = createCaptureBall()
  scene.add(ball.group)

  const effects: Effect[] = []
  let dimAcc = 0
  let flashLevel = 0
  let time = 0
  let disposed = false
  let cancelEvolve = false
  const lastColor = srgb(S.vfx.neutral)
  const post: Partial<PostParams> = {}
  const focus = new THREE.Vector3().copy(origin)
  const view: RenderView = { scene, camera: cam.camera, focus, post }

  const host: FxHost = {
    group: vfxGroup,
    camera: cam,
    renderer,
    additive,
    alpha,
    atlas,
    geos,
    origin,
    creature: (s) => (evolveActive && s === 0 ? evolveSprite : creatures[s]),
    trainer: (s) => trainers[s],
    home: (s, who) => (who === 'trainer' ? trainerHomes[s] : evolveActive && s === 0 ? evolveHome : creatureHomes[s]),
    particleScale: () => quality().particleScale,
    acquireLight() {
      let slot = vfxLights.find((l) => !l.busy)
      if (!slot) slot = vfxLights.reduce((a, b) => (a.since <= b.since ? a : b), vfxLights[0])
      if (!slot) {
        // no pool configured: a detached light keeps the API total
        return new THREE.PointLight()
      }
      slot.busy = true
      slot.since = time
      return slot.light
    },
    releaseLight(l) {
      const slot = vfxLights.find((x) => x.light === l)
      if (slot) { slot.busy = false; l.intensity = 0 }
    },
    dim(a) { dimAcc = Math.min(S.vfx.dimMax, dimAcc + a) },
    flash(level) { flashLevel = Math.max(flashLevel, level) },
  }

  const addEffect = (e: Effect) => {
    effects.push(e)
    while (effects.length > S.vfx.maxEffects) effects.shift()?.dispose()
  }

  const ctxFor = (self: SideIndex, category: MoveCategory | null, main: THREE.Color): FxCtx => ({ self, foe: otherSide(self), category, main: main.clone() })

  /** Plays a timeline; resolves when its last step ends. */
  function run(steps: readonly VfxStep[], ctx: FxCtx): Promise<void> {
    if (disposed) return Promise.resolve()
    const list = expandSteps(steps, ctx.category)
    for (const st of list) sched.at(st.t ?? 0, () => {
      if (disposed) return
      const e = spawnStep(st, ctx, host)
      if (e) addEffect(e)
    })
    return sched.wait(timelineLength(list))
  }

  const typeColor = (speciesId: string | null): THREE.Color => {
    const t = speciesId ? CONTENT.species[speciesId]?.types[0] : undefined
    return srgb((t && CONTENT.typeById[t]?.color) || S.vfx.neutral)
  }

  const readyTimeout = new Promise<void>((r) => setTimeout(r, S.readyTimeoutMs))
  const ready = Promise.race([env.ready, readyTimeout])

  // --- ball choreography ------------------------------------------------------
  const _bp = new THREE.Vector3()
  function ballEffect(dur: number, pose: (k: number, t: number, p: THREE.Vector3) => void): Promise<void> {
    const ground = origin.y
    let t = 0
    addEffect({
      update(dt) {
        t += dt
        const k = Math.min(1, t / Math.max(1e-3, dur))
        pose(k, t, _bp)
        ball.group.position.copy(_bp)
        ball.placeShadow(_bp.x, ground, _bp.z, _bp.y - ground)
        return t < dur
      },
      dispose() {},
    })
    return sched.wait(dur)
  }

  function ballFlight(from: THREE.Vector3, to: THREE.Vector3, dur: number, arc: number): Promise<void> {
    ball.setVisible(true)
    ball.mesh.rotation.set(0, cameraYaw(cam.camera), 0)
    return ballEffect(dur, (k, t, p) => {
      const e = ease.linear(k)
      p.lerpVectors(from, to, e)
      p.y += arc * 4 * e * (1 - e)
      ball.mesh.rotation.x = -t * S.ball.spin
    })
  }

  const throwOrigin = (side: SideIndex, out: THREE.Vector3) => {
    const tr = trainers[side]
    if (tr.id && tr.present) return tr.pointAt(S.trainer.handH, out)
    return out.set(origin.x + S.slots[side].ballFrom[0], origin.y + S.slots[side].ballFrom[1], origin.z + S.slots[side].ballFrom[2])
  }

  const alive = () => !disposed
  const _qa = new THREE.Vector3()
  const _qb = new THREE.Vector3()

  // --- boss presentation ------------------------------------------------------
  const bosses: [BossEntry | null, BossEntry | null] = [null, null]
  const bossAura = [0, 0]
  const slotScale = (side: SideIndex) => S.slots[side].scale * (bosses[side]?.scale ?? 1)
  const expandedAura = new Map<string, VfxStep[]>()
  const auraSteps = (theme: string, steps: readonly VfxStep[]) => {
    let list = expandedAura.get(theme)
    if (!list) { list = expandSteps(steps, null); expandedAura.set(theme, list) }
    return list
  }
  function bossIdle(dt: number): void {
    for (const side of [0, 1] as const) {
      const boss = bosses[side]
      const theme = boss && BOSS_PRES.themes[boss.theme]
      const sp = creatures[side]
      if (!boss || !theme || !sp.present || !sp.id || sp.fx.dissolve > 0.5 || (evolveActive && side === 0)) continue
      bossAura[side] += dt * 1000
      if (bossAura[side] < theme.everyMs) continue
      bossAura[side] %= theme.everyMs
      const ctx = ctxFor(side, null, typeColor(sp.id))
      for (const st of auraSteps(boss.theme, theme.steps)) spawnStep(st, ctx, host)?.dispose()
    }
  }

  // --- evolution helpers -------------------------------------------------------
  /** Holds a sprite's flash at a level (silhouette) until stopped; `fadeOut` ramps it down. */
  function holdFlash(sp: BattleSprite, color: THREE.Color, rampIn: number) {
    let level = 0
    let target = 1
    let rate = 1 / Math.max(1e-3, rampIn)
    let done = false
    addEffect({
      update(dt) {
        if (done) return false
        level += Math.sign(target - level) * Math.min(Math.abs(target - level), rate * dt)
        if (level > sp.fx.flash) { sp.fx.flash = level; sp.fx.flashColor.copy(color) }
        if (target === 0 && level <= 0) { done = true; return false }
        return true
      },
      dispose() { done = true },
    })
    return { fadeOut(sec: number) { target = 0; rate = 1 / Math.max(1e-3, sec) } }
  }

  /** Dissolves every slot actor out (or back in). */
  function fadeActors(out: boolean, sec: number, saved: boolean[]): Promise<void> {
    const list = [...creatures, ...trainers]
    if (!out) list.forEach((s, i) => { s.present = saved[i] })
    let t = 0
    addEffect({
      update(dt) {
        t += dt
        const k = Math.min(1, t / Math.max(1e-3, sec))
        for (const s of list) s.fx.dissolve = Math.max(s.fx.dissolve, out ? k : 1 - k)
        if (k >= 1 && out) for (const s of list) s.present = false
        return k < 1
      },
      dispose() {},
    })
    return sched.wait(sec)
  }

  const stage: BattleStage = {
    view,
    ready,

    setCreature(side, speciesId, shiny) {
      const sp = creatures[side]
      const sl = S.slots[side]
      if (!speciesId) { sp.setCreature(null, false, slotScale(side), sl.facesRight); sp.present = false; return }
      sp.setCreature(speciesId, shiny, slotScale(side), sl.facesRight)
      if (side === 1) ball.setVisible(false)
    },

    showCreature(side, visible) { creatures[side].present = visible && !!creatures[side].id },

    creatureRect(side) {
      const sp = creatures[side]
      if (!sp.present || !sp.id) return null
      const cam3 = cam.camera
      const right = _qa.setFromMatrixColumn(cam3.matrixWorld, 0)
      const half = (sp.width * sp.fx.scale) / 2
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
      for (const [h, dx] of [[0, -1], [0, 1], [1, -1], [1, 1]] as const) {
        sp.pointAt(h, _qb)
        _qb.addScaledVector(right, dx * half).project(cam3)
        const x = _qb.x * 0.5 + 0.5, y = 0.5 - _qb.y * 0.5
        l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y)
      }
      return { left: l, top: t, right: r, bottom: b }
    },

    setBoss(side, bossId) {
      const entry = bossEntry(bossId)
      bosses[side] = entry
      bossAura[side] = 0
      const theme = bossTheme(bossId)
      creatures[side].setIdleMotion(theme ? { breath: theme.breath, floatAmp: theme.bob.amp, floatHz: theme.bob.hz } : null)
      if (side === 1) {
        const base = (entry ? BOSS_PRES.framing.base : S.camera.shots.base) as ShotDef
        cam.setBase(base)
        cam.cut(base)
      }
      const sp = creatures[side]
      if (sp.id) sp.setCreature(sp.id, sp.shiny, slotScale(side), S.slots[side].facesRight)
    },

    setTrainer(side, sheet) {
      const tr = trainers[side]
      tr.setSheet(sheet, S.slots[side].trainerRow)
      tr.present = !!sheet
    },

    async intro(kind) {
      await ready
      if (!alive()) return
      ball.setVisible(false)
      const foe = creatures[1]
      await run(T.intro[kind] ?? T.intro.wild, ctxFor(0, null, typeColor(foe.id)))
      if (!alive()) return
      if (foe.present && foe.shiny) await run(T.shiny, ctxFor(1, null, lastColor))
    },

    async sendOut(side, ballColor) {
      const sp = creatures[side]
      if (!sp.id || !alive()) return
      sp.present = false
      const color = srgb(ballColor ?? S.ball.defaultColor)
      ball.setColor(colorHex(color))
      ball.setGlow(1)
      const ctx = ctxFor(side, null, color)
      const from = throwOrigin(side, new THREE.Vector3())
      const to = sp.home.clone().setY(sp.home.y + S.ball.openH * sp.height)
      void run(T.sendOut.throw, ctx)
      await ballFlight(from, to, S.ball.sendOutDur, S.ball.sendOutArc)
      if (!alive()) return
      ball.setVisible(false)
      await run(T.sendOut.open, ctx)
      if (!alive()) return
      sp.present = true
      if (sp.shiny) await run(T.shiny, ctxFor(side, null, color))
    },

    async recall(side) {
      const sp = creatures[side]
      if (!sp.present || !alive()) return
      await run(T.recall, ctxFor(side, null, srgb(S.ball.defaultColor)))
      sp.present = false
    },

    async attack(side, anim, type, category) {
      srgb(CONTENT.typeById[type]?.color ?? S.vfx.neutral, lastColor)
      const steps = T.anims[anim] ?? T.anims[T.fallbackAnim] ?? []
      await run(steps, ctxFor(side, category, lastColor))
    },

    async hit(side, effectiveness, crit) {
      const list = effectiveness <= 0 ? T.hit.immune : effectiveness > 1 ? T.hit.super : effectiveness < 1 ? T.hit.weak : T.hit.normal
      await run(crit && effectiveness > 0 ? [...list, ...T.hit.crit] : list, ctxFor(side, null, lastColor))
    },

    async miss(side) {
      await run(T.miss, ctxFor(side, null, lastColor))
    },

    async faint(side) {
      const sp = creatures[side]
      if (!sp.present) return
      await run(T.faint, ctxFor(side, null, lastColor))
      sp.present = false
    },

    async statusFx(side, status) {
      const def = CONTENT.statusById[status]
      await run(T.status.byId[status] ?? T.status.default, ctxFor(side, null, srgb(def?.color ?? S.vfx.neutral)))
    },

    async statFx(side, up) {
      await run(up ? T.stat.up : T.stat.down, ctxFor(side, null, lastColor))
    },

    async healFx(side) {
      await run(T.heal, ctxFor(side, null, lastColor))
    },

    weatherFx(w) {
      env.setWeather(w, false)
      const def = CONTENT.weatherById[w]
      if (def) void run(T.weatherStart, ctxFor(0, null, srgb(def.color)))
    },

    async throwBall(color, shakes, success) {
      const B = S.ball
      const foe = creatures[1]
      if (!alive()) return
      const c = srgb(color || B.defaultColor)
      ball.setColor(colorHex(c))
      ball.setGlow(1)
      const ctx = ctxFor(0, null, c)
      const from = throwOrigin(0, new THREE.Vector3())
      const hover = foe.home.clone().setY(foe.home.y + B.hoverH * foe.height)
      void run(T.catch.throw, ctx)
      await ballFlight(from, hover, B.throwDur, B.throwArc)
      if (!alive()) return
      // absorb: the ball hangs, faces the camera and pulses while the creature is drawn in
      ball.mesh.rotation.set(0, cameraYaw(cam.camera), 0)
      const absorb = run(T.catch.absorb, ctx)
      await ballEffect(B.absorbDur, (k, _t, p) => {
        p.copy(hover)
        ball.mesh.scale.setScalar(1 + B.absorbPulse * ease.hump(k))
      })
      await absorb
      if (!alive()) return
      ball.mesh.scale.setScalar(1)
      foe.present = false
      // drop with bounces onto the ground
      const groundY = foe.home.y + B.radius
      const bounces = Math.max(0, Math.round(B.bounces))
      await ballEffect(B.dropDur, (k, _t, p) => {
        p.copy(hover)
        const fallK = bounces > 0 ? B.fallShare : 1
        if (k < fallK) p.y = hover.y + (groundY - hover.y) * ease.inQuad(k / fallK)
        else {
          const seg = ((k - fallK) / (1 - fallK)) * bounces
          const i = Math.min(bounces - 1, Math.floor(seg))
          p.y = groundY + B.bounceHeight * Math.pow(B.bounceDecay, i) * ease.hump(seg - i)
        }
      })
      if (!alive()) return
      void run(T.catch.land, ctx)
      await sched.wait(B.preWobble)
      const n = Math.max(0, Math.round(shakes))
      for (let i = 0; i < n && alive(); i++) {
        void run(T.catch.wobble, ctx)
        const sign = i % 2 ? -1 : 1
        await ballEffect(B.wobbleDur, (k, _t, p) => {
          p.set(foe.home.x, groundY, foe.home.z)
          ball.mesh.rotation.z = sign * THREE.MathUtils.degToRad(B.wobbleDeg) * Math.sin(Math.PI * 2 * k) * (1 - k * B.wobbleDecay)
        })
        ball.mesh.rotation.z = 0
        await sched.wait(B.wobblePause)
      }
      if (!alive()) return
      if (success) {
        ball.setGlow(B.dimOnCatch)
        await run(T.catch.success, ctx)
        await sched.wait(B.successHold)
      } else {
        ball.setVisible(false)
        await run(T.catch.fail, ctx)
        if (alive() && foe.id) foe.present = true
      }
    },

    async levelUpFx(side) {
      await run(T.levelUp, ctxFor(side, null, lastColor))
    },

    async evolveFx(fromSpecies, toSpecies, shiny) {
      const E = S.evolve
      await ready
      if (!alive()) return false
      cancelEvolve = false
      const saved = [...creatures, ...trainers].map((s) => s.present)
      const facing = !RENDER.creatures.artFacesLeft
      evolveSprite.setCreature(fromSpecies, shiny, E.scale, facing)
      const toTex = assets.creatureTexture(toSpecies)
      const fromTex = assets.creatureTexture(fromSpecies)
      const ctx = ctxFor(0, null, typeColor(toSpecies))
      await fadeActors(true, E.fadeActors, saved)
      if (!alive()) return false
      evolveActive = true
      evolveSprite.present = true
      cam.blendTo(shotFor(E.shot, 0)!, E.fadeActors)
      const start = run(T.evolve.start, ctx)
      const silColor = srgb(E.silhouetteColor).multiplyScalar(E.silhouetteGlow)
      const sil = holdFlash(evolveSprite, silColor, E.gather)
      await sched.wait(E.gather)
      if (!alive()) return false
      let cancelled = false
      let showTo = false
      for (let i = 0; i < E.swapCount && alive(); i++) {
        if (cancelEvolve) { cancelled = true; break }
        showTo = !showTo
        evolveSprite.setTextureOverride(showTo ? toTex : fromTex)
        void run(T.evolve.swap, ctx)
        const k = E.swapCount > 1 ? i / (E.swapCount - 1) : 1
        const interval = E.swapStart * Math.pow(E.swapEnd / E.swapStart, k)
        addEffect(((dur: number) => {
          let t = 0
          return {
            update(dt) { t += dt; evolveSprite.fx.scale *= 1 + E.swapPulse * ease.hump(t / dur); return t < dur },
            dispose() {},
          }
        })(interval))
        await sched.wait(interval)
      }
      await start
      if (!alive()) return false
      if (cancelled) {
        evolveSprite.setTextureOverride(null)
        await run(T.evolve.cancel, ctx)
        sil.fadeOut(E.revealDur)
        await sched.wait(E.revealDur)
      } else {
        evolveSprite.setTextureOverride(null)
        evolveSprite.setCreature(toSpecies, shiny, E.scale, facing)
        const finish = run(T.evolve.finish, ctx)
        sil.fadeOut(E.revealDur)
        await sched.wait(E.revealDur)
        if (shiny && alive()) await run(T.shiny, ctx)
        await finish
        await sched.wait(E.hold)
      }
      if (!alive()) return false
      evolveActive = false
      evolveSprite.present = false
      evolveSprite.setCreature(null, false, E.scale, facing)
      cam.home(E.restore)
      await fadeActors(false, E.restore, saved)
      return !cancelled
    },

    cancelEvolve() { cancelEvolve = true },

    update(dtSec) {
      if (disposed) return
      const dt = Math.max(0, Math.min(dtSec, S.maxDt))
      time += dt
      sched.advance(dt)
      for (const s of creatures) s.resetFx()
      for (const s of trainers) s.resetFx()
      evolveSprite.resetFx()
      dimAcc = 0
      flashLevel = 0
      for (let i = effects.length - 1; i >= 0; i--) {
        if (!effects[i].update(dt)) { effects[i].dispose(); effects.splice(i, 1) }
      }
      if (ext) {
        const aspect = ext.internal.width / ext.internal.height
        if (Math.abs(cam.camera.aspect - aspect) > 1e-4) { cam.camera.aspect = aspect; cam.camera.updateProjectionMatrix() }
      }
      cam.update(dt, time)
      const yaw = cameraYaw(cam.camera)
      for (const s of creatures) s.update(dt, time, yaw)
      for (const s of trainers) s.update(dt, time, yaw)
      evolveSprite.update(dt, time, yaw)
      bossIdle(dt)
      const q = quality()
      const internalH = ext?.internal.height ?? renderer.canvas.height
      const pxPerUnit = internalH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.camera.fov) / 2))
      additive.update(dt, cam.camera, pxPerUnit)
      alpha.update(dt, cam.camera, pxPerUnit)
      const shadows = settings().shadows && q.shadows
      for (const s of [...creatures, ...trainers, evolveSprite]) s.setShadows(shadows)
      env.setPointLightPool(Math.min(CONTENT.config.render.maxPointLights, q.pointLights, S.lighting.propLightPool))
      const benders = [...creatures, ...trainers].filter((s) => s.present && s.id).map((s) => {
        const p = s.pointAt(0, new THREE.Vector3())
        return { x: p.x, y: p.y, z: p.z, r: s.height * S.creature.bend }
      })
      const graded = env.update({
        dt, time, camera: cam.camera, camDistance: cam.distance, quality: q, settings: settings(), pxPerUnit, benders, dim: 1 - dimAcc,
      })
      Object.assign(post, graded)
      post.flash = flashLevel
      post.tiltShift = S.post.tiltShift
      post.bokehScale = S.post.bokehScale
      focus.copy(cam.look)
    },

    dispose() {
      if (disposed) return
      disposed = true
      sched.flush()
      for (const e of effects) e.dispose()
      effects.length = 0
      for (const s of [...creatures, ...trainers, evolveSprite]) s.dispose()
      for (const l of vfxLights) { l.light.removeFromParent(); l.light.dispose() }
      additive.dispose()
      alpha.dispose()
      atlas.dispose()
      geos.dispose()
      ball.dispose()
      env.dispose()
      scene.clear()
    },
  }
  return stage
}
