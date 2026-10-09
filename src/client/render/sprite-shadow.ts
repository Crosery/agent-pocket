// Character / creature shadows. Sprites do not render into the sun shadow map any more (that path cast a magnified,
// sheared copy of the 64px alpha: blocky, shared one stale depth material between actors and drifted off the feet).
// Each sprite owns two small ground meshes instead:
//  - a contact ellipse under the soles, placed from the lowest opaque rows of the current frame (so it follows the
//    feet through the walk cycle) and shrunk / faded while the body is lifted,
//  - a cast silhouette: the sprite's own alpha laid on the ground along the light, blurred in the shader (the blur grows
//    with height like a penumbra), faded toward the tip, joined to the soles, dimmed by cloud shadows, off indoors.
// Both hug the rendered terrain (stairs included) because their vertices are placed on sampled ground heights.
// All numbers come from render.json spriteShadow; the light state is fed once per frame by updateSpriteShadows().
import * as THREE from 'three'
import { RENDER, hexToRgb, type Vec3 } from './config.ts'
import { createCanvas, textureSize } from './sprite-utils.ts'
import { CLOUD_GLSL, sceneLightUniforms } from './world/scene-light.ts'

const S = RENDER.spriteShadow

// ---------------------------------------------------------------------------
// Light state shared by every shadow
// ---------------------------------------------------------------------------

export const spriteShadowState = {
  /** Unit horizontal direction toward the light. */
  lx: 0,
  lz: 1,
  /** Shadow length per unit height. */
  slope: 1,
  /** Cast silhouette opacity (0 = hidden). */
  cast: 0,
  /** Bumps when the light changed enough to rebuild the cast meshes. */
  stamp: 0,
}

const shared = { uColor: { value: new THREE.Color().setRGB(...hexToRgb(S.color), THREE.SRGBColorSpace) } }

/** Shadow length per unit of height for a light whose unit direction has vertical component `dirY` (cot of the elevation). */
export function shadowSlope(dirY: number, cfg = S.cast): number {
  const y = Math.max(dirY, 1e-3)
  return Math.min(cfg.maxSlope, (cfg.lengthMul * Math.sqrt(Math.max(0, 1 - dirY * dirY))) / y)
}

/** Cast opacity for a light of `intensity` (sun intensity after the weather), the moon share and the indoor share. */
export function castStrength(intensity: number, moon: boolean, outdoor: boolean, cfg = S): number {
  const t = Math.min(1, Math.max(0, (intensity - cfg.light.min) / (cfg.light.full - cfg.light.min)))
  return cfg.cast.opacity * t * t * (3 - 2 * t) * (moon ? cfg.light.moon : 1) * (outdoor ? 1 : cfg.light.indoor)
}

/**
 * Ground offset from the soles of a card point at sideways position `px` and height `h` (already scaled). The card is
 * turned to face the light, so its width runs perpendicular to the horizontal light direction and the shadow runs away
 * from it: height 0 maps onto the soles, whatever the light.
 */
export function castOffset(out: { x: number; z: number }, lx: number, lz: number, slope: number, px: number, h: number): { x: number; z: number } {
  out.x = lz * px - lx * h * slope
  out.z = -lx * px - lz * h * slope
  return out
}

export interface SpriteShadowFrame {
  /** Unit direction toward the shadow-casting light. */
  dir: Vec3
  /** Its intensity after the weather and the day / night switch. */
  light: number
  moon: boolean
  outdoor: boolean
  /** The quality tier and the shadow setting allow the cast silhouette. */
  cast: boolean
}

/** Call once per frame before the actors update. */
export function updateSpriteShadows(f: SpriteShadowFrame): void {
  const st = spriteShadowState
  const h = Math.hypot(f.dir[0], f.dir[2])
  const lx = h > 1e-4 ? f.dir[0] / h : 0
  const lz = h > 1e-4 ? f.dir[2] / h : 1
  const slope = shadowSlope(f.dir[1])
  const cast = f.cast ? castStrength(f.light, f.moon, f.outdoor) : 0
  const moved = Math.abs(lx - st.lx) + Math.abs(lz - st.lz) > 2e-3 || Math.abs(slope - st.slope) > 2e-3 || (cast > 0.002) !== (st.cast > 0.002)
  st.lx = lx; st.lz = lz; st.slope = slope; st.cast = cast
  if (moved) st.stamp++
}

// ---------------------------------------------------------------------------
// Foot measurement from the sprite alpha
// ---------------------------------------------------------------------------

export interface Footprint {
  /** Lower edge of the lowest opaque texel, as a fraction of the cell height above the cell bottom (-1 = unknown). */
  bottom: number
  /** Horizontal centre of the lowest `footRows` opaque rows, -0.5..0.5 from the cell centre (texture orientation). */
  cx: number
  /** Their horizontal extent as a fraction of the cell width. */
  span: number
}

const UNKNOWN: Footprint = { bottom: -1, cx: 0, span: 0 }

/** Measures every cell of RGBA pixel data (rows top to bottom). Pure, so it can be tested without a canvas. */
export function footprintsFromAlpha(data: ArrayLike<number>, width: number, height: number, cols: number, rows: number, alphaTest: number, footRows: number): Footprint[] {
  const out: Footprint[] = []
  const w = Math.floor(width / cols), h = Math.floor(height / rows)
  const cut = alphaTest * 255
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let low = -1
      scan: for (let y = h - 1; y >= 0; y--) {
        for (let x = 0; x < w; x++) {
          if (data[((r * h + y) * width + c * w + x) * 4 + 3] >= cut) { low = y; break scan }
        }
      }
      if (low < 0) { out.push(UNKNOWN); continue }
      let sum = 0, n = 0, lo = w, hi = -1
      for (let y = Math.max(0, low - footRows + 1); y <= low; y++) {
        for (let x = 0; x < w; x++) {
          if (data[((r * h + y) * width + c * w + x) * 4 + 3] < cut) continue
          sum += x; n++
          if (x < lo) lo = x
          if (x > hi) hi = x
        }
      }
      out.push({ bottom: 1 - (low + 1) / h, cx: n ? (sum / n + 0.5) / w - 0.5 : 0, span: n ? (hi - lo + 1) / w : 0 })
    }
  }
  return out
}

const footCache = new WeakMap<object, { key: string; feet: Footprint[] }>()

/** Footprint of sheet cell (col,row); each loaded atlas is read once. */
export function spriteFootprint(texture: THREE.Texture | null, col: number, row: number, cols: number, rows: number, alphaTest: number, footRows: number): Footprint {
  const image = texture?.image as HTMLCanvasElement | undefined
  if (!image || !(image.width > 0 && image.height > 0)) return UNKNOWN
  const key = `${image.width}/${image.height}/${cols}/${rows}/${alphaTest}/${footRows}`
  let cached = footCache.get(image)
  if (!cached || cached.key !== key) {
    let feet: Footprint[] = []
    try {
      const canvas = typeof image.getContext === 'function' ? image : createCanvas(image.width, image.height)
      const g = canvas.getContext('2d', { willReadFrequently: true })!
      if (canvas !== image) g.drawImage(image, 0, 0)
      feet = footprintsFromAlpha(g.getImageData(0, 0, image.width, image.height).data, image.width, image.height, cols, rows, alphaTest, footRows)
    } catch {
      // a loading placeholder or unreadable image keeps the nominal ellipse
    }
    cached = { key, feet }
    footCache.set(image, cached)
  }
  return cached.feet[row * cols + col] ?? UNKNOWN
}

/** Card-local height of the soles' lower edge for a `cell`-texel card whose bottom is raised by `footInset` texels: 0 when the art puts its soles on that row. */
export function soleHeight(cardHeight: number, cell: number, soleRow: number, footInset: number): number {
  return ((cell - soleRow - 1) / cell) * cardHeight - (footInset / cell) * cardHeight
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

const VERT_CAST = /* glsl */`
attribute float aH;
varying vec2 vUv;
varying float vH;
varying vec2 vWorld;
void main() {
  vUv = uv;
  vH = aH;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const FRAG_CAST = /* glsl */`
uniform sampler2D uMap;
uniform vec2 uTexel;
uniform vec4 uCell;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uShape;
uniform float uCloudK;
${CLOUD_GLSL}
varying vec2 vUv;
varying float vH;
varying vec2 vWorld;
float apTap(vec2 uv) {
  vec2 inside = step(uCell.xy, uv) * step(uv, uCell.zw);
  return texture2D(uMap, uv).a * inside.x * inside.y;
}
void main() {
  // penumbra: the blur radius (sprite texels) grows from the soles to the head; two rings of six taps around the centre
  vec2 e = uTexel * mix(uShape.x, uShape.y, vH);
  float a = apTap(vUv) * 0.16;
  a += (apTap(vUv + vec2(1.0, 0.0) * e * 0.5) + apTap(vUv + vec2(0.5, 0.866) * e * 0.5) + apTap(vUv + vec2(-0.5, 0.866) * e * 0.5)
    + apTap(vUv + vec2(-1.0, 0.0) * e * 0.5) + apTap(vUv + vec2(-0.5, -0.866) * e * 0.5) + apTap(vUv + vec2(0.5, -0.866) * e * 0.5)) * 0.09;
  a += (apTap(vUv + vec2(1.0, 0.0) * e) + apTap(vUv + vec2(0.5, 0.866) * e) + apTap(vUv + vec2(-0.5, 0.866) * e)
    + apTap(vUv + vec2(-1.0, 0.0) * e) + apTap(vUv + vec2(-0.5, -0.866) * e) + apTap(vUv + vec2(0.5, -0.866) * e)) * 0.05;
  float alpha = a * uOpacity * (1.0 - uShape.z * vH);
  if (uCloudK > 0.0 && uApCloud.x > 0.001) alpha *= 1.0 - uCloudK * uApCloud.x * apCloudMask(vWorld);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}`

const VERT_CONTACT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const FRAG_CONTACT = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform vec2 uShape;
varying vec2 vUv;
void main() {
  float d = length(vUv * 2.0 - 1.0);
  float a = pow(1.0 - smoothstep(uShape.x, 1.0, d), uShape.y) * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}`

function groundMaterial(extra: THREE.ShaderMaterialParameters): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: S.ground.offsetFactor, polygonOffsetUnits: S.ground.offsetUnits,
    ...extra,
  })
}

export interface SpriteShadowOptions {
  /** The sprite's card geometry: its uv attribute is shared (frame, flip) and its rest positions give the silhouette. */
  geometry: THREE.BufferGeometry
  map: () => THREE.Texture | null
  alphaTest: number
  /** Rendered terrain top (world units) at world x, z. */
  ground: (x: number, z: number) => number
}

export interface SpriteShadowPose {
  /** World position of the soles (y = the actor's ground height). */
  x: number; y: number; z: number
  /** Card yaw (the camera billboard yaw), its scale (walk squash) and how far the body is lifted off the ground. */
  yaw: number; scaleX: number; scaleY: number; lift: number
  /** 0..1 multiplier of both shadows (dissolving battle sprites); default 1. */
  fade?: number
}

export interface SpriteShadow {
  readonly object: THREE.Group
  update(pose: SpriteShadowPose): void
  /** The owner rebuilt its card geometry (battle sprites change aspect). */
  setGeometry(geometry: THREE.BufferGeometry): void
  dispose(): void
}

const _o = { x: 0, z: 0 }

export function createSpriteShadow(opts: SpriteShadowOptions): SpriteShadow {
  const C = S.contact, K = S.cast
  const group = new THREE.Group()
  group.name = 'sprite-shadow'

  // contact ellipse: a small grid whose vertices are put on the ground; the radial falloff is drawn per fragment
  const g = C.grid
  const contactPos = new Float32Array(g * g * 3)
  const contactUv = new Float32Array(g * g * 2)
  const contactIndex: number[] = []
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) { contactUv[(j * g + i) * 2] = i / (g - 1); contactUv[(j * g + i) * 2 + 1] = j / (g - 1) }
  for (let j = 0; j < g - 1; j++) for (let i = 0; i < g - 1; i++) { const a = j * g + i; contactIndex.push(a, a + g, a + 1, a + 1, a + g, a + g + 1) }
  const contactGeo = new THREE.BufferGeometry()
  contactGeo.setAttribute('position', new THREE.BufferAttribute(contactPos, 3).setUsage(THREE.DynamicDrawUsage))
  contactGeo.setAttribute('uv', new THREE.BufferAttribute(contactUv, 2))
  contactGeo.setIndex(contactIndex)
  const contactMat = groundMaterial({
    uniforms: { uColor: shared.uColor, uOpacity: { value: 0 }, uShape: { value: new THREE.Vector2(C.core, C.power) } },
    vertexShader: VERT_CONTACT, fragmentShader: FRAG_CONTACT,
  })
  const contact = new THREE.Mesh(contactGeo, contactMat)
  contact.frustumCulled = false
  contact.renderOrder = 1
  contact.name = 'shadow-contact'

  // cast silhouette: the card's own vertex grid laid on the ground
  const castUniforms = {
    uMap: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uCell: { value: new THREE.Vector4(0, 0, 1, 1) },
    uColor: shared.uColor,
    uOpacity: { value: 0 },
    uShape: { value: new THREE.Vector3(K.blurNear, K.blurFar, K.tailFade) },
    uCloudK: { value: K.cloud },
    uApCloudMap: sceneLightUniforms.uApCloudMap,
    uApCloud: sceneLightUniforms.uApCloud,
    uApCloudScroll: sceneLightUniforms.uApCloudScroll,
    uApCloudMix: sceneLightUniforms.uApCloudMix,
  }
  const castMat = groundMaterial({ uniforms: castUniforms, vertexShader: VERT_CAST, fragmentShader: FRAG_CAST })
  const cast = new THREE.Mesh(new THREE.BufferGeometry(), castMat)
  cast.frustumCulled = false
  cast.renderOrder = 1
  cast.name = 'shadow-cast'
  cast.visible = false
  group.add(contact, cast)

  let card = opts.geometry
  let castGeo: THREE.BufferGeometry | null = null
  let restX = new Float32Array(0), restY = new Float32Array(0)
  let cardW = 1, cardH = 1, cardBottom = 0

  function build(geo: THREE.BufferGeometry): void {
    card = geo
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const n = pos.count
    restX = new Float32Array(n); restY = new Float32Array(n)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < n; i++) {
      restX[i] = pos.getX(i); restY[i] = pos.getY(i)
      minX = Math.min(minX, restX[i]); maxX = Math.max(maxX, restX[i])
      minY = Math.min(minY, restY[i]); maxY = Math.max(maxY, restY[i])
    }
    cardW = Math.max(1e-3, maxX - minX); cardH = Math.max(1e-3, maxY - minY); cardBottom = minY
    const aH = new Float32Array(n)
    for (let i = 0; i < n; i++) aH[i] = Math.min(1, Math.max(0, restY[i]) / Math.max(1e-3, maxY))
    castGeo?.dispose()
    castGeo = new THREE.BufferGeometry()
    castGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage))
    castGeo.setAttribute('uv', geo.getAttribute('uv'))
    castGeo.setAttribute('aH', new THREE.BufferAttribute(aH, 1))
    castGeo.setIndex(geo.index)
    cast.geometry = castGeo
    last[0] = Number.NaN
  }

  // what the meshes were last built for: pose, frame and light; unchanged statics are only refreshed now and then
  const last = new Float64Array(12).fill(Number.NaN)
  let lastTime = -1e9

  build(opts.geometry)

  return {
    object: group,
    setGeometry: build,
    update(p) {
      const st = spriteShadowState
      const uv = card.getAttribute('uv') as THREE.BufferAttribute
      const u0 = uv.getX(0), u1 = uv.getX(1), vTop = uv.getY(0), vBottom = uv.getY(uv.count - 1)
      const flipped = u0 > u1
      const uMin = Math.min(u0, u1), uMax = Math.max(u0, u1)
      const cols = Math.max(1, Math.round(1 / Math.max(uMax - uMin, 1e-4)))
      const rows = Math.max(1, Math.round(1 / Math.max(vTop - vBottom, 1e-4)))
      const col = Math.round(uMin * cols), row = Math.round((1 - vTop) * rows)
      const castOn = st.cast > 0.002
      const now = performance.now()
      const fade = p.fade ?? 1
      const sig = [p.x, p.y, p.z, p.yaw, p.scaleX, p.scaleY, p.lift, col + row * 4096 + (flipped ? 0.5 : 0), castOn ? st.stamp : -1, fade]
      let same = now - lastTime < S.ground.refreshSeconds * 1000
      for (let i = 0; i < sig.length; i++) { if (last[i] !== sig[i]) same = false; last[i] = sig[i] }
      castMat.uniforms.uOpacity.value = st.cast * fade
      cast.visible = castOn
      if (same) return
      lastTime = now

      const map = opts.map()
      const foot = spriteFootprint(map, col, row, cols, rows, opts.alphaTest, C.footRows)
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw)
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
      const lift = S.ground.lift
      const local = (x: number, z: number) => opts.ground(x, z) + lift - p.y

      // contact ellipse under the lowest opaque rows of this frame
      const gap = foot.bottom >= 0 ? Math.max(0, cardBottom + foot.bottom * cardH) * p.scaleY : 0
      const raised = p.lift + gap
      const scale = Math.max(C.minScale, 1 - raised * C.liftShrink)
      const cx = (flipped ? -foot.cx : foot.cx) * cardW * p.scaleX * C.footFollow
      const span = foot.span > 0 ? Math.min(C.maxSpan, Math.max(C.minSpan, foot.span * cardW * p.scaleX * C.spanMul)) : C.width
      const w = span * scale, d = span * (C.depth / C.width) * scale
      const ccx = p.x + rx * cx + fx * C.forward, ccz = p.z + rz * cx + fz * C.forward
      for (let j = 0; j < g; j++) {
        for (let i = 0; i < g; i++) {
          const u = (i / (g - 1) - 0.5) * w, v = (j / (g - 1) - 0.5) * d
          const gx = ccx + rx * u + fx * v, gz = ccz + rz * u + fz * v
          const k = (j * g + i) * 3
          contactPos[k] = gx - p.x; contactPos[k + 1] = local(gx, gz); contactPos[k + 2] = gz - p.z
        }
      }
      ;(contactGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      contactMat.uniforms.uOpacity.value = C.opacity * Math.max(C.minOpacity, 1 - raised * C.liftFade) * fade

      if (!castOn || !castGeo) return
      const size = map ? textureSize(map) : { w: 0, h: 0 }
      if (!(size.w > 0 && size.h > 0)) { cast.visible = false; return }
      castUniforms.uMap.value = map
      castUniforms.uTexel.value.set(1 / size.w, 1 / size.h)
      castUniforms.uCell.value.set(uMin, vBottom, uMax, vTop)
      const pos = castGeo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < restX.length; i++) {
        castOffset(_o, st.lx, st.lz, st.slope, restX[i] * p.scaleX * K.widthMul, Math.max(0, restY[i]) * p.scaleY)
        pos.setXYZ(i, _o.x, local(p.x + _o.x, p.z + _o.z), _o.z)
      }
      pos.needsUpdate = true
    },
    dispose() {
      group.removeFromParent()
      contactGeo.dispose(); contactMat.dispose()
      castGeo?.dispose(); castMat.dispose()
    },
  }
}
