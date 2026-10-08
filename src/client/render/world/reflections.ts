// Cheap water reflections of actors: every billboard gets a second card, flipped about the waterline in screen space,
// darkened, tinted and rippled sideways. The card is only drawn over water tiles (a fragment test against the height
// field at the point where the view ray meets the water plane) and writes the depth of that point, so props, grass and
// other actors in front still hide it. No render target, no planar camera. Tunables: render.json "reflections".
import * as THREE from 'three'
import { RENDER, hexToRgb } from '../config.ts'

export interface Mirror {
  /** Water plane height (world units) the actor mirrors in, or null to hide the reflection. */
  setLevel(y: number | null): void
  dispose(): void
}

const emptyHeights = (() => {
  const t = new THREE.DataTexture(new Float32Array([-1e5]), 1, 1, THREE.RedFormat, THREE.FloatType)
  t.needsUpdate = true
  return t
})()

/** Uniforms every mirror shares: the height field the water test reads, scene light and the look. */
const shared = {
  uRHeight: { value: emptyHeights as THREE.Texture },
  uRMapSize: { value: new THREE.Vector2(1, 1) },
  uRWrap: { value: 0 },
  uRTime: { value: 0 },
  uRLight: { value: new THREE.Color(1, 1, 1) },
  uRTint: { value: new THREE.Color() },
  /** alpha, darken, tint amount, fade length (share of the card height). */
  uRCfg: { value: new THREE.Vector4() },
  /** sideways wobble (card units), frequency (1/unit of depth), speed (rad/s). */
  uRDistort: { value: new THREE.Vector3() },
  uRTol: { value: 0 },
  uLean: { value: 0 },
  uCompensate: { value: 0 },
}

function syncConfig(): void {
  const C = RENDER.reflections, B = RENDER.camera.billboard
  shared.uRTint.value.setRGB(...hexToRgb(C.tint), THREE.SRGBColorSpace)
  shared.uRCfg.value.set(C.alpha, C.darken, C.tintAmount, Math.max(C.fade, 1e-3))
  shared.uRDistort.value.set(C.distort.amp, C.distort.freq, C.distort.speed)
  shared.uRTol.value = C.tolerance
  shared.uLean.value = B.lean
  shared.uCompensate.value = B.compensate
}
syncConfig()

const VERT = /* glsl */`
uniform float uLean, uCompensate;
uniform vec3 uBase;
uniform vec2 uCard;
varying vec2 vUv;
varying vec3 vWorld;
varying float vUp, vFrac, vCardX;
void main() {
  vec3 p = position;
  // the same lean / stretch the sprite shader applies, so the card has the silhouette the player sees
  float pitch = asin(clamp(viewMatrix[1][2], -0.999, 0.999));
  float lean = pitch * uLean;
  float rest = max(cos(pitch - lean), 0.05);
  float y = p.y * mix(1.0, 1.0 / rest, uCompensate);
  float sz = length(modelMatrix[1].xyz) / max(length(modelMatrix[2].xyz), 1e-4);
  p.y = y * cos(lean);
  p.z = -y * sin(lean) * sz;
  vec3 w = (modelMatrix * vec4(p, 1.0)).xyz;
  // flip about the screen line through the waterline under the actor: offsets along the camera's up axis change sign
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 o = w - uBase;
  float u = dot(o, up);
  vUp = u;
  vWorld = uBase + o - 2.0 * u * up;
  vUv = uv;
  vFrac = clamp(position.y / uCard.y, 0.0, 1.0);
  vCardX = position.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`

const FRAG = /* glsl */`
uniform mat4 projectionMatrix;
uniform sampler2D uMap, uRHeight;
uniform vec2 uRMapSize;
uniform float uRWrap, uRTime, uRTol, uWater, uAlphaTest;
uniform vec3 uRLight, uRTint, uRDistort;
uniform vec4 uRCfg;
varying vec2 vUv;
varying vec3 vWorld;
varying float vUp, vFrac, vCardX;
void main() {
  // derivatives first: uniform control flow
  float dUvDx = dFdx(vUv.x), dCardDx = dFdx(vCardX);
  if (vUp < 0.0 || vWorld.y > uWater) discard;
  // where the view ray to this pixel crosses the water plane (the pixel is drawn there, so that tile must be water)
  float t = (uWater - cameraPosition.y) / (vWorld.y - cameraPosition.y);
  vec3 hit = cameraPosition + (vWorld - cameraPosition) * t;
  vec2 huv = (floor(hit.xz) + 0.5) / uRMapSize;
  float ground;
  if (uRWrap > 0.5) ground = texture2D(uRHeight, fract(huv)).r;
  else {
    if (huv.x <= 0.0 || huv.y <= 0.0 || huv.x >= 1.0 || huv.y >= 1.0) discard;
    ground = texture2D(uRHeight, huv).r;
  }
  if (abs(ground - uWater) > uRTol) discard;
  float wob = sin(vUp * uRDistort.y + uRTime * uRDistort.z + hit.x * 2.3);
  float perUnit = abs(dCardDx) > 1e-6 ? dUvDx / dCardDx : 0.0;
  vec4 tex = texture2D(uMap, vec2(vUv.x + wob * uRDistort.x * perUnit, vUv.y));
  if (tex.a < uAlphaTest) discard;
  vec3 col = mix(tex.rgb * uRCfg.y, uRTint, uRCfg.z) * uRLight;
  gl_FragColor = vec4(col, uRCfg.x * (1.0 - clamp(vFrac / uRCfg.w, 0.0, 1.0)));
  vec4 hc = projectionMatrix * viewMatrix * vec4(hit, 1.0);
  gl_FragDepth = clamp(hc.z / hc.w * 0.5 + 0.5, 0.0, 1.0);
}`

/**
 * Adds a reflection card to a billboard mesh. `anchor` is the actor's root (its x / z place the waterline), `map` is
 * read at render time so sheet swaps follow, `card` is the card size in world units.
 */
export function attachMirror(mesh: THREE.Mesh, anchor: THREE.Object3D, source: { map: THREE.Texture | null }, card: { w: number; h: number }, alphaTest: number): Mirror {
  const uniforms = {
    ...shared,
    uMap: { value: source.map as THREE.Texture },
    uWater: { value: 0 },
    uBase: { value: new THREE.Vector3() },
    uCard: { value: new THREE.Vector2(card.w, card.h) },
    uAlphaTest: { value: alphaTest },
  }
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  const mirror = new THREE.Mesh(mesh.geometry, material)
  mirror.name = 'mirror'
  mirror.renderOrder = RENDER.reflections.renderOrder
  mirror.frustumCulled = false
  mirror.visible = false
  let level = 0
  mirror.onBeforeRender = () => {
    uniforms.uMap.value = source.map as THREE.Texture
    uniforms.uWater.value = level
    uniforms.uBase.value.set(anchor.position.x, level, anchor.position.z)
  }
  mesh.add(mirror)
  return {
    setLevel(y) {
      mirror.visible = y !== null
      if (y !== null) level = y
    },
    dispose() { mirror.removeFromParent(); material.dispose() },
  }
}

export interface ReflectionEnv {
  /** Surface height of the water tile, or null when the tile holds no water. */
  waterY(tx: number, ty: number): number | null
  heights: { texture: THREE.Texture; size: THREE.Vector2; wrap: boolean }
}

export interface MirrorActor {
  readonly object: THREE.Object3D
  readonly mirror: Mirror
  isVisible(): boolean
}

export interface Reflections {
  setEnv(env: ReflectionEnv | null): void
  /** Per frame: picks the water plane of every actor near the focus (nearest first, capped) and hides the rest. */
  update(time: number, light: THREE.Color, focus: { x: number; z: number }, actors: Iterable<MirrorActor>, enabled: boolean): void
}

const RECHECK_SEC = 0.5

export function createReflections(): Reflections {
  const C = RENDER.reflections
  let env: ReflectionEnv | null = null
  const cache = new WeakMap<MirrorActor, { tx: number; tz: number; at: number; level: number | null }>()
  const near: { a: MirrorActor; d: number }[] = []

  function levelAt(tx: number, tz: number): number | null {
    if (!env) return null
    const R = Math.round(C.reach)
    let best: number | null = null, bd = Infinity
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = dx * dx + dz * dz
      if (d >= bd) continue
      const y = env.waterY(tx + dx, tz + dz)
      if (y !== null) { best = y; bd = d }
    }
    return best
  }

  return {
    setEnv(e) {
      env = e
      shared.uRHeight.value = e ? e.heights.texture : emptyHeights
      shared.uRWrap.value = e?.heights.wrap ? 1 : 0
      if (e) shared.uRMapSize.value.copy(e.heights.size)
    },
    update(time, light, focus, actors, enabled) {
      shared.uRTime.value = time
      shared.uRLight.value.copy(light)
      near.length = 0
      for (const a of actors) {
        const p = a.object.position
        const d = Math.hypot(p.x - focus.x, p.z - focus.z)
        if (enabled && env && a.isVisible() && d <= C.maxDistance) near.push({ a, d })
        else a.mirror.setLevel(null)
      }
      near.sort((m, n) => m.d - n.d)
      for (let i = 0; i < near.length; i++) {
        const a = near[i].a
        if (i >= C.maxActors) { a.mirror.setLevel(null); continue }
        const tx = Math.floor(a.object.position.x), tz = Math.floor(a.object.position.z)
        let c = cache.get(a)
        // chunks stream in under an actor standing still, so the lookup is repeated now and then
        if (!c || c.tx !== tx || c.tz !== tz || time - c.at > RECHECK_SEC) { c = { tx, tz, at: time, level: levelAt(tx, tz) }; cache.set(a, c) }
        a.mirror.setLevel(c.level)
      }
    },
  }
}
