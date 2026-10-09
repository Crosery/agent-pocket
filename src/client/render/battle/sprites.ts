// Battle billboards: creature sprites (mirrored per slot, shiny hue, idle breathing) and trainer sheet sprites.
// Built on the renderer's sprite material with an extra pixel-dissolve uniform; a matching depth material keeps
// the light-facing shadow trick and dissolves the shadow too. Per-frame animation is written by effects into
// `fx` (reset every frame) so overlapping effects compose.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { Dir } from '../../../shared/types.ts'
import type { AssetStore } from '../../contracts.ts'
import { RENDER, hexToRgb } from '../config.ts'
import {
  createBillboardGeometry, createBlobShadow, createSpriteMaterial, setGeometryFrame, sheetLayout,
  spriteShadowUniforms, textureImageReady, textureSize, type SpriteMaterial,
} from '../sprite-utils.ts'
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
  setCreature(speciesId: string | null, shiny: boolean, sizeMul: number, facesRight: boolean): void
  setSheet(sheet: string | null, row: Dir): void
  /** Boss idle motion: replaces the breathing and adds a slow float; null restores the defaults. */
  setIdleMotion(m: { breath: BreathDef; floatAmp: number; floatHz: number } | null): void
  /** Temporarily shows another texture (evolution swap); null restores the assigned one. */
  setTextureOverride(tex: THREE.Texture | null): void
  /** World point at a fraction of the visual height, including the current offset and scale. */
  pointAt(h: number, out: THREE.Vector3): THREE.Vector3
  setShadows(on: boolean): void
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

function createDepthMaterial(u: DissolveUniforms): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, spriteShadowUniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uSpriteLightXZ;\nvarying vec2 vApUv;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vApUv = uv;
{
  vec2 ax = vec2(modelMatrix[0][0], modelMatrix[0][2]);
  float objYaw = atan(-ax.y, ax.x);
  float wantYaw = atan(uSpriteLightXZ.x, uSpriteLightXZ.y);
  float d = wantYaw - objYaw;
  float c = cos(d), s = sin(d);
  transformed.xz = vec2(transformed.x * c + transformed.z * s, -transformed.x * s + transformed.z * c);
}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DISSOLVE_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (uDissolve > 0.0 && apDissolveHash(floor(vApUv * uDissolveCells)) < uDissolve) discard;`)
  }
  m.customProgramCacheKey = () => 'ap-battle-sprite-depth-v1'
  return m
}

const srgb = (hex: string) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)

export function createBattleSprite(kind: 'creature' | 'trainer', assets: AssetStore, home: THREE.Vector3, phase: number): BattleSprite {
  const C = STAGE.creature, T = STAGE.trainer
  const cfg = kind === 'creature'
    ? { alphaTest: C.alphaTest, tilt: C.normalTilt, blob: C.blob, breath: C.breath as BreathDef }
    : { alphaTest: T.alphaTest, tilt: T.normalTilt, blob: T.blob, breath: T.breath as BreathDef }
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
  const depth = createDepthMaterial(du)
  let geo = createBillboardGeometry(1, 1, cfg.tilt)
  const mesh = new THREE.Mesh(geo, sm.material)
  mesh.customDepthMaterial = depth
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.frustumCulled = false
  const blob = createBlobShadow(cfg.blob.size, cfg.blob.opacity)
  const blobMat = blob.material as THREE.MeshBasicMaterial
  root.add(mesh, blob)

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
  let shadows = true
  let layout = sheetLayout()
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
    rebuild()
  }

  const sprite: BattleSprite = {
    kind, root, mesh, home, fx,
    present: false,
    get height() { return height },
    get width() { return width },
    get id() { return id },
    get shiny() { return shiny },
    setCreature(speciesId, isShiny, sizeMul, facesRight) {
      id = speciesId
      shiny = isShiny
      if (!speciesId) { tex = null; return }
      const sp = CONTENT.species[speciesId]
      const size = THREE.MathUtils.clamp(1 + ((sp?.size ?? 1) - 1) * C.sizeInfluence, C.sizeClamp[0], C.sizeClamp[1])
      height = C.height * size * sizeMul
      flip = facesRight === RENDER.creatures.artFacesLeft
      tex = assets.creatureTexture(speciesId)
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
    setShadows(on) { shadows = on },
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
      blob.visible = visible
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
      blob.position.set(fx.offset.x, P.blobLift, fx.offset.z)
      const lift = Math.max(0, fx.offset.y) + float
      const aspectMix = 1 - P.blobWidthMix + P.blobWidthMix * (width / Math.max(1e-3, height))
      const bs = s * Math.max(P.blobMinScale, 1 - lift * P.blobLiftShrink) * aspectMix
      blob.scale.set(bs, 1, bs)
      blobMat.opacity = cfg.blob.opacity * Math.max(0, 1 - fx.dissolve) * Math.max(P.blobMinOpacity, 1 - lift * P.blobLiftFade)
      sm.uniforms.uFlash.value = THREE.MathUtils.clamp(fx.flash, 0, 1)
      sm.uniforms.uFlashColor.value.copy(fx.flashColor)
      sm.uniforms.uHue.value = (shiny ? shinyCfg.hue : 0) + fx.hue
      du.uDissolve.value = fx.dissolve
      mesh.castShadow = shadows
    },
    dispose() {
      geo.dispose()
      sm.dispose()
      depth.dispose()
      blank.dispose()
      blob.geometry.dispose()
      blobMat.dispose()
      root.removeFromParent()
    },
  }
  return sprite
}
