// GPU particle fields for weather (rain, snow, sand, fog wisps, ash) and biome ambience (fireflies, leaves,
// petals, dust, embers, spores, motes, sparkles). Each field lives in a box that slides with the focus;
// particles are world-anchored (wrapped in the box) and sit on the terrain via a heightmap texture.
// Every parameter comes from render.json "particles".
import * as THREE from 'three'
import { RENDER, PARTICLE_SHAPES, hexToRgb, type ParticleKindDef } from '../config.ts'

export interface ParticleField {
  readonly points: THREE.Points
  readonly kind: string
  /** Visible amount 0..1 (fade in/out). */
  level: number
  target: number
  update(dt: number, time: number, focus: THREE.Vector3, wind: THREE.Vector2, light: THREE.Color, timeFactor: number, pxScale: number): void
  dispose(): void
}

/** `wrapHeight`: heightTex is a toroidal window (tile (x, z) at texel (x mod W, z mod H)) of an unbounded map. */
export function createParticleField(kind: string, def: ParticleKindDef, heightTex: THREE.Texture | null, mapSize: THREE.Vector2, countScale: number, wrapHeight = false): ParticleField {
  const count = Math.max(1, Math.round(def.count * countScale))
  const seeds = new Float32Array(count * 4)
  const colors = new Float32Array(count * 3)
  const palette = (def.colors?.length ? def.colors : [def.color ?? '#ffffff']).map((h) => new THREE.Color().setRGB(...hexToRgb(h), THREE.SRGBColorSpace))
  let s = 0x9e3779b9 ^ count
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; return s / 4294967296 }
  for (let i = 0; i < count; i++) {
    seeds.set([rnd(), rnd(), rnd(), rnd()], i * 4)
    const c = palette[Math.floor(rnd() * palette.length)]
    colors.set([c.r, c.g, c.b], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  const additive = def.glow > RENDER.particleAdditiveGlow
  const mat = new THREE.ShaderMaterial({
    defines: { HAS_HEIGHT: heightTex ? 1 : 0, HEIGHT_WRAP: wrapHeight ? 1 : 0, SHAPE: PARTICLE_SHAPES.indexOf(def.shape), RING_LIFE: def.life ? 1 : 0 },
    uniforms: {
      uTime: { value: 0 },
      uFocus: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(...def.box) },
      uY: { value: new THREE.Vector2(...def.y) },
      uVel: { value: new THREE.Vector3(...def.velocity) },
      uWind: { value: new THREE.Vector2() },
      uSwirl: { value: def.swirl },
      uSwirlSpeed: { value: def.swirlSpeed },
      uSize: { value: def.size },
      uWorldSize: { value: def.worldSize ? 1 : 0 },
      uScale: { value: 300 },
      uAlpha: { value: def.alpha },
      uGlow: { value: def.glow },
      uTwinkle: { value: def.twinkle },
      uLife: { value: def.life ?? 1 },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uLit: { value: additive ? 0 : 1 },
      uHeight: { value: heightTex },
      uMapSize: { value: mapSize },
    },
    vertexShader: /* glsl */`
uniform float uTime, uSwirl, uSwirlSpeed, uSize, uWorldSize, uScale, uTwinkle, uLife;
uniform vec3 uFocus, uBox, uVel;
uniform vec2 uY, uWind, uMapSize;
#if HAS_HEIGHT
uniform sampler2D uHeight;
#endif
attribute vec4 aSeed;
attribute vec3 aColor;
varying vec3 vColor;
varying float vFade;
varying float vSpin;
varying float vPhase;
float h1(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  vec3 vel = uVel + vec3(uWind.x, 0.0, uWind.y);
  vec2 boxMin = uFocus.xz - uBox.xz * 0.5;
  vec2 seedXZ = aSeed.xz;
  float phase = 0.0;
#if RING_LIFE
  float cyc = uTime / uLife + aSeed.w;
  float id = floor(cyc);
  phase = fract(cyc);
  seedXZ = vec2(h1(id * 12.9898 + aSeed.x * 78.233), h1(id * 39.3468 + aSeed.z * 11.135));
#endif
  float sw = aSeed.w * 6.2831853;
  vec2 swirl = vec2(sin(uTime * uSwirlSpeed + sw), cos(uTime * uSwirlSpeed * 0.83 + sw * 1.3)) * uSwirl;
  vec2 xz = seedXZ * uBox.xz + vel.xz * uTime + swirl;
  xz = mod(xz - boxMin, uBox.xz) + boxMin;
  float range = uY.y - uY.x;
  float yf = range > 0.0 ? fract(aSeed.y + vel.y * uTime / range + sin(uTime * uSwirlSpeed + sw) * uSwirl * 0.05) : 0.0;
  float ground = uFocus.y;
#if HAS_HEIGHT
  vec2 huv = (floor(xz) + 0.5) / uMapSize;
#if HEIGHT_WRAP
  ground = texture2D(uHeight, fract(huv)).r;
#else
  if (huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0) ground = texture2D(uHeight, huv).r;
#endif
#endif
  vec3 wp = vec3(xz.x, ground + uY.x + yf * range, xz.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vec2 edge = min(xz - boxMin, boxMin + uBox.xz - xz);
  vFade = smoothstep(0.0, 2.0, min(edge.x, edge.y));
  if (range > 0.0) vFade *= smoothstep(0.0, 0.08, yf) * smoothstep(1.0, 0.85, yf);
  float tw = uTwinkle > 0.0 ? 0.55 + 0.45 * sin(uTime * uTwinkle * 6.0 + aSeed.w * 40.0) : 1.0;
  vFade *= tw;
  vPhase = phase;
#if RING_LIFE
  vFade *= 1.0 - phase;
#endif
  vColor = aColor;
  vSpin = uTime * (1.0 + aSeed.x * 2.0) + sw;
  float size = uWorldSize > 0.5 ? uSize * uScale / -mv.z : uSize;
#if RING_LIFE
  size *= 0.4 + phase * 0.8;
#endif
  gl_PointSize = max(1.0, size);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform float uAlpha, uGlow, uLit;
uniform vec3 uLight;
varying vec3 vColor;
varying float vFade;
varying float vSpin;
varying float vPhase;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a = 1.0;
#if SHAPE == 0
  if (length(p) > 0.5) discard;
#elif SHAPE == 1
  float lx = abs(p.x + p.y * 0.18);
  if (lx > 0.09) discard;
  a = smoothstep(-0.5, 0.3, -p.y);
#elif SHAPE == 2
  if (abs(p.y) > 0.09) discard;
  a = smoothstep(-0.5, 0.3, p.x);
#elif SHAPE == 3
  float r = length(p);
  if (abs(r - 0.36) > 0.1) discard;
#elif SHAPE == 4
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  a = (1.0 - r) * (1.0 - r);
#elif SHAPE == 5
  float c = cos(vSpin), s = sin(vSpin);
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  if (abs(q.x) * 2.2 + abs(q.y) > 0.45) discard;
#elif SHAPE == 6
  float cross = min(abs(p.x), abs(p.y));
  float r = length(p);
  if (cross > 0.07 && r > 0.14) discard;
  a = 1.0 - r * 1.4;
#endif
  vec3 col = vColor * uGlow * mix(vec3(1.0), uLight, uLit);
  gl_FragColor = vec4(col, a * uAlpha * vFade);
}`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 10
  points.name = `particles:${kind}`

  const field: ParticleField = {
    points, kind, level: 0, target: 1,
    update(dt, time, focus, wind, light, timeFactor, pxScale) {
      const k = 1 - Math.exp(-dt / Math.max(0.05, RENDER.ambientFadeSeconds / 3))
      field.level += (field.target - field.level) * k
      const u = mat.uniforms
      u.uTime.value = time
      ;(u.uFocus.value as THREE.Vector3).copy(focus)
      ;(u.uWind.value as THREE.Vector2).copy(wind).multiplyScalar(def.windFactor)
      ;(u.uLight.value as THREE.Color).copy(light)
      u.uAlpha.value = def.alpha * field.level * timeFactor
      u.uScale.value = pxScale
      points.visible = u.uAlpha.value > 0.003
    },
    dispose() { geo.dispose(); mat.dispose() },
  }
  return field
}

/** Night-sky aurora curtains drawn as a camera-facing band across the top of the view. */
export interface Aurora {
  readonly mesh: THREE.Mesh
  update(time: number, camera: THREE.PerspectiveCamera, level: number): void
  dispose(): void
}

export function createAurora(): Aurora {
  const A = RENDER.aurora
  const cols = A.colors.map((h) => new THREE.Color().setRGB(...hexToRgb(h), THREE.SRGBColorSpace))
  while (cols.length < 3) cols.push(cols[cols.length - 1] ?? new THREE.Color(1, 1, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uC0: { value: cols[0] }, uC1: { value: cols[1] }, uC2: { value: cols[2] },
      uIntensity: { value: A.intensity },
      uSpeed: { value: A.speed },
      uBands: { value: A.bands },
      uHeight: { value: A.height },
      uAlpha: { value: A.alpha },
    },
    vertexShader: /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
uniform float uTime, uLevel, uIntensity, uSpeed, uBands, uHeight, uAlpha;
uniform vec3 uC0, uC1, uC2;
varying vec2 vUv;
void main() {
  float t = uTime * uSpeed;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uBands) break;
    float fi = float(i);
    float centre = 1.0 - uHeight * (0.35 + 0.25 * fi) + 0.06 * sin(vUv.x * (5.0 + fi * 2.0) + t * (1.0 + fi * 0.4) + fi * 2.1) + 0.03 * sin(vUv.x * 13.0 - t * 1.7);
    float d = vUv.y - centre;
    float curtain = exp(-d * d * 120.0) + max(0.0, -d) * exp(d * 9.0) * 0.6 * step(d, 0.0);
    float rays = 0.65 + 0.35 * sin(vUv.x * 160.0 + sin(vUv.x * 9.0 + t * 2.0) * 4.0 + fi);
    vec3 c = mix(uC0, mix(uC1, uC2, fract(fi * 0.5)), clamp(-d * 6.0 + 0.5, 0.0, 1.0));
    acc += c * curtain * rays;
  }
  float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x) * smoothstep(0.2, 0.55, vUv.y);
  gl_FragColor = vec4(acc * uIntensity * uLevel * uAlpha * edge, 1.0);
}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 20
  mesh.name = 'aurora'
  const _fwd = new THREE.Vector3()
  return {
    mesh,
    update(time, camera, level) {
      mat.uniforms.uTime.value = time
      mat.uniforms.uLevel.value = level
      mesh.visible = level > 0.003
      if (!mesh.visible) return
      const d = A.distance
      const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
      const w = h * camera.aspect
      camera.getWorldDirection(_fwd)
      mesh.position.copy(camera.position).addScaledVector(_fwd, d)
      mesh.quaternion.copy(camera.quaternion)
      mesh.scale.set(w, h, 1)
    },
    dispose() { mesh.geometry.dispose(); mat.dispose() },
  }
}
