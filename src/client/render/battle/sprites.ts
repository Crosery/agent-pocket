// Battle billboards: creature sprites (mirrored per slot, shiny hue, idle breathing) and trainer sheet sprites.
// Built on the renderer's sprite material with an extra pixel-dissolve uniform; the shadows are the shared contact
// ellipse + cast silhouette of sprite-shadow.ts (flat stage floor). Per-frame animation is written by effects into
// `fx` (reset every frame) so overlapping effects compose.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { Dir } from '../../../shared/types.ts'
import type { AssetStore } from '../../contracts.ts'
import { RENDER, hexToRgb } from '../config.ts'
import {
  createBillboardGeometry, createSpriteMaterial, setGeometryFrame, sheetLayout,
  textureImageReady, textureSize, type SpriteMaterial,
} from '../sprite-utils.ts'
import { createSpriteShadow } from '../sprite-shadow.ts'
import { STAGE, type BreathDef } from './config.ts'
import { createCharacterAnimation } from '../character-animation.ts'

/** Transient per-frame animation state written by effects. */
export interface SpriteFx {
  offset: THREE.Vector3
  scale: number
  squash: number
  flash: number
  flashColor: THREE.Color
  dissolve: number
  /** Extra hue rotation (glitch flicker). */
  hue: number
}

export interface BattleSprite {
  readonly kind: 'creature' | 'trainer'
  readonly root: THREE.Group
  readonly mesh: THREE.Mesh
  /** Ground position of the slot (world). */
  readonly home: THREE.Vector3
  /** Base visibility; effects (reveal / vanish) toggle it. */
  present: boolean
  readonly fx: SpriteFx
  /** Nominal world height / width of the sprite card. */
  readonly height: number
  readonly width: number
  readonly id: string | null
  readonly shiny: boolean
  /** Opaque part of the sprite card as fractions of it (y down); the whole card until the art is decoded. */
  readonly opaque: { x0: number; y0: number; x1: number; y1: number }
  setCreature(speciesId: string | null, shiny: boolean, sizeMul: number, facesRight: boolean): void
  setSheet(sheet: string | null, row: Dir): void
  /** Boss idle motion: replaces the breathing and adds a slow float; null restores the defaults. */
  setIdleMotion(m: { breath: BreathDef; floatAmp: number; floatHz: number } | null): void
  /** Temporarily shows another texture (evolution swap); null restores the assigned one. */
  setTextureOverride(tex: THREE.Texture | null): void
  /** World point at a fraction of the visual height, including the current offset and scale. */
  pointAt(h: number, out: THREE.Vector3): THREE.Vector3
  resetFx(): void
  update(dt: number, time: number, yaw: number): void
  dispose(): void
}

const DISSOLVE_GLSL = /* glsl */`
varying vec2 vApUv;
uniform float uDissolve, uDissolveCells, uDissolveEdge;
uniform vec3 uDissolveColor;
float apDissolveHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`

interface DissolveUniforms {
  uDissolve: { value: number }
  uDissolveCells: { value: number }
  uDissolveEdge: { value: number }
  uDissolveColor: { value: THREE.Color }
}

function patchDissolve(sm: SpriteMaterial, u: DissolveUniforms): void {
  const m = sm.material
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vApUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvApUv = uv;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DISSOLVE_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
float apD = apDissolveHash(floor(vApUv * uDissolveCells));
if (uDissolve > 0.0 && apD < uDissolve) discard;`)
      .replace('#include <opaque_fragment>', `if (uDissolve > 0.0 && apD < uDissolve + uDissolveEdge) outgoingLight = uDissolveColor;
#include <opaque_fragment>`)
  }
  m.customProgramCacheKey = () => 'ap-battle-sprite-v1'
}

const FULL_CARD = { x0: 0, y0: 0, x1: 1, y1: 1 }
const opaqueCache = new WeakMap<object, BattleSprite['opaque']>()

/** Bounding box of the visible pixels of a texture (alpha above the sprite cut-off), fractions of the image. */
function opaqueBox(t: THREE.Texture, alphaTest: number): BattleSprite['opaque'] {
  const hit = opaqueCache.get(t)
  if (hit) return hit
  const { w, h } = textureSize(t)
  const img = t.image as CanvasImageSource | undefined
  if (!img || !w || !h || typeof document === 'undefined') return FULL_CARD
  const k = Math.min(1, 96 / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k))
  const c = document.createElement('canvas')
  c.width = cw
  c.height = ch
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) return FULL_CARD
  g.drawImage(img, 0, 0, cw, ch)
  const { data } = g.getImageData(0, 0, cw, ch)
  const cut = alphaTest * 255
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (data[(y * cw + x) * 4 + 3] <= cut) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  const box = x1 < 0 ? FULL_CARD : { x0: x0 / cw, y0: y0 / ch, x1: (x1 + 1) / cw, y1: (y1 + 1) / ch }
  opaqueCache.set(t, box)
  return box
}

const srgb = (hex: string) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)

export function createBattleSprite(kind: 'creature' | 'trainer', assets: AssetStore, home: THREE.Vector3, phase: number): BattleSprite {
  const C = STAGE.creature, T = STAGE.trainer
  const cfg = kind === 'creature'
    ? { alphaTest: C.alphaTest, tilt: C.normalTilt, breath: C.breath as BreathDef }
    : { alphaTest: T.alphaTest, tilt: T.normalTilt, breath: T.breath as BreathDef }
  const root = new THREE.Group()
  root.name = `battle-${kind}`
  root.position.copy(home)
  const blank = new THREE.Texture()
  const sm = createSpriteMaterial(blank, { alphaTest: cfg.alphaTest })
  const du: DissolveUniforms = {
    uDissolve: { value: 0 },
    uDissolveCells: { value: C.dissolveCells },
    uDissolveEdge: { value: C.dissolveEdgeWidth },
    uDissolveColor: { value: srgb(C.dissolveEdge).multiplyScalar(C.dissolveEdgeGlow) },
  }
  patchDissolve(sm, du)
  let geo = createBillboardGeometry(1, 1, cfg.tilt)
  const mesh = new THREE.Mesh(geo, sm.material)
  mesh.receiveShadow = false
  mesh.frustumCulled = false
  const shadow = createSpriteShadow({ geometry: geo, map: () => sm.material.map, alphaTest: cfg.alphaTest, ground: () => home.y })
  root.add(mesh, shadow.object)

  const fx: SpriteFx = { offset: new THREE.Vector3(), scale: 1, squash: 0, flash: 0, flashColor: new THREE.Color(1, 1, 1), dissolve: 0, hue: 0 }
  let height = 1
  let width = 1
  let aspect = -1
  let tex: THREE.Texture | null = null
  let override: THREE.Texture | null = null
  let id: string | null = null
  let shiny = false
  let flip = false
  let row = 0
  let layout = sheetLayout()
  let opaque = FULL_CARD
  let motion: { breath: BreathDef; floatAmp: number; floatHz: number } | null = null
  const idleAnimation = () => createCharacterAnimation(layout.walkFrames, layout.walkStart, {
    frames: layout.idleFrames, fps: CONTENT.config.sprites.idleFps, settleMs: CONTENT.config.sprites.idleSettleMs, phase,
  })
  let idle = idleAnimation()
  let idleFrame = -1
  const shinyCfg = RENDER.creatures.shiny

  function rebuild(): void {
    geo.dispose()
    geo = createBillboardGeometry(width, height, cfg.tilt)
    mesh.geometry = geo
    shadow.setGeometry(geo)
    if (kind === 'creature') setGeometryFrame(geo, 0, 0, 1, 1, flip)
    else {
      idleFrame = layout.idleFrames > 1 ? idle.frame : T.frame
      setGeometryFrame(geo, idleFrame, row, layout.cols, layout.rows)
    }
  }

  function syncAspect(): void {
    const t = override ?? tex
    if (!t || !textureImageReady(t)) return
    const { w, h } = textureSize(t)
    if (!w || !h) return
    let layoutChanged = false
    if (kind === 'trainer') {
      const next = sheetLayout(CONTENT, t)
      layoutChanged = next.cols !== layout.cols
      layout = next
      if (layoutChanged) idle = idleAnimation()
    }
    const a = kind === 'creature' ? w / h : (w / layout.cols) / (h / layout.rows)
    if (Math.abs(a - aspect) < 1e-4 && !layoutChanged) return
    aspect = a
    width = height * a
    opaque = kind === 'creature' ? opaqueBox(t, cfg.alphaTest) : FULL_CARD
    rebuild()
  }

  const sprite: BattleSprite = {
    kind, root, mesh, home, fx,
    present: false,
    get height() { return height },
    get width() { return width },
    get id() { return id },
    get shiny() { return shiny },
    get opaque() { return opaque },
    setCreature(speciesId, isShiny, sizeMul, facesRight) {
      id = speciesId
      shiny = isShiny
      if (!speciesId) { tex = null; return }
      const sp = CONTENT.species[speciesId]
      const size = THREE.MathUtils.clamp(1 + ((sp?.size ?? 1) - 1) * C.sizeInfluence, C.sizeClamp[0], C.sizeClamp[1])
      height = C.height * size * sizeMul
      flip = facesRight === RENDER.creatures.artFacesLeft
      tex = assets.creatureTexture(speciesId)
      opaque = FULL_CARD
      sm.setMap(override ?? tex)
      sm.uniforms.uHue.value = shiny ? shinyCfg.hue : 0
      sm.uniforms.uSaturation.value = shiny ? shinyCfg.saturation : 1
      aspect = -1
      width = height
      rebuild()
      syncAspect()
    },
    setSheet(sheet, dir) {
      id = sheet
      if (!sheet) { tex = null; return }
      height = T.height
      width = height
      idle.reset()
      row = layout.rowOf[dir] ?? 0
      tex = assets.characterTexture(sheet)
      sm.setMap(tex)
      aspect = -1
      rebuild()
      syncAspect()
    },
    setIdleMotion(m) { motion = m },
    setTextureOverride(t) {
      override = t
      const m = override ?? tex
      if (m) sm.setMap(m)
      aspect = -1
      syncAspect()
    },
    pointAt(h, out) {
      const s = fx.scale
      return out.set(home.x + fx.offset.x, home.y + fx.offset.y + height * s * (1 + fx.squash) * h, home.z + fx.offset.z)
    },
    resetFx() {
      fx.offset.set(0, 0, 0)
      fx.scale = 1
      fx.squash = 0
      fx.flash = 0
      fx.flashColor.setRGB(1, 1, 1)
      fx.dissolve = 0
      fx.hue = 0
    },
    update(dt, time, yaw) {
      if (aspect < 0 || kind === 'trainer') syncAspect()
      const has = !!(override ?? tex)
      const visible = sprite.present && has && fx.scale > 1e-3 && fx.dissolve < 0.999
      mesh.visible = visible
      shadow.object.visible = visible
      if (!visible) return
      if (kind === 'trainer' && layout.idleFrames > 1) {
        idle.update(dt, false, 0)
        if (idle.frame !== idleFrame) {
          idleFrame = idle.frame
          setGeometryFrame(geo, idleFrame, row, layout.cols, layout.rows)
        }
      }
      const b = motion?.breath ?? cfg.breath
      const P = STAGE.sprite
      const breath = kind === 'trainer' && layout.idleFrames > 1 ? 0 : Math.sin(time * b.hz * Math.PI * 2 + phase)
      const sq = fx.squash + breath * b.squash
      const s = fx.scale
      mesh.scale.set(s * (1 - sq * P.squashWiden), s * (1 + sq), s)
      const float = motion ? (0.5 + 0.5 * Math.sin(time * motion.floatHz * Math.PI * 2 + phase)) * motion.floatAmp * height : 0
      mesh.position.set(fx.offset.x, fx.offset.y + float + Math.max(0, breath) * b.bob * height, fx.offset.z)
      mesh.rotation.set(0, yaw, 0)
      shadow.object.position.set(fx.offset.x, 0, fx.offset.z)
      shadow.update({
        x: home.x + fx.offset.x, y: home.y, z: home.z + fx.offset.z, yaw, scaleX: mesh.scale.x, scaleY: mesh.scale.y,
        lift: mesh.position.y, fade: Math.max(0, 1 - fx.dissolve),
      })
      sm.uniforms.uFlash.value = THREE.MathUtils.clamp(fx.flash, 0, 1)
      sm.uniforms.uFlashColor.value.copy(fx.flashColor)
      sm.uniforms.uHue.value = (shiny ? shinyCfg.hue : 0) + fx.hue
      du.uDissolve.value = fx.dissolve
    },
    dispose() {
      geo.dispose()
      sm.dispose()
      blank.dispose()
      shadow.dispose()
      root.removeFromParent()
    },
  }
  return sprite
}
