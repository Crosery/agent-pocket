// GPU particle fields for weather (rain, snow, sand, fog wisps, ash) and biome ambience (fireflies, leaves,
// petals, dust, embers, spores, motes, sparkles). Each field lives in a box that slides with the focus;
// particles are world-anchored (wrapped in the box) and sit on the terrain via a heightmap texture.
// Every parameter comes from render.json "particles".
import * as THREE from 'three'
import { RENDER, PARTICLE_SHAPES, hexToRgb, type ParticleKindDef } from '../config.ts'
import type { ImpactKind } from '../physics-config.ts'
import { WIND_DRIFT_GLSL, windUniforms } from './wind.ts'

export interface ParticleField {
  readonly points: THREE.Points
  readonly kind: string
  /** Visible amount 0..1 (fade in/out). */
  level: number
  target: number
  /** Splashes where the drops land (render.json impacts[kind]); off by quality tier. */
  impactOn: boolean
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
      uWindDir: windUniforms.uWindDir,
      uGustWave: windUniforms.uGustWave,
      uGustDrift: { value: def.windFactor > 0 ? RENDER.wind.drift.gust : 0 },
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
uniform float uTime, uSwirl, uSwirlSpeed, uSize, uWorldSize, uScale, uTwinkle, uLife, uGustDrift;
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
${WIND_DRIFT_GLSL}
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
  // gust fronts push the particle along the wind (same field as the grass sway); the edge fade ignores it
  vec2 xzBase = xz;
  xz += apGustDrift(xz, uWind, uTime, uGustDrift);
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
  vec2 edge = min(xzBase - boxMin, boxMin + uBox.xz - xzBase);
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
  const impactDef: ImpactKind | undefined = RENDER.impacts[kind]
  const impact = impactDef && def.life === undefined && def.velocity[1] < 0 ? createImpact(geo, mat, def, impactDef, additive) : null
  if (impact) points.add(impact.points)

  const field: ParticleField = {
    points, kind, level: 0, target: 1, impactOn: false,
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
      if (impact) {
        impact.points.visible = field.impactOn
        impact.material.uniforms.uImpAlpha.value = impactDef!.alpha * field.level * timeFactor
      }
    },
    dispose() { geo.dispose(); mat.dispose(); impact?.material.dispose() },
  }
  return field
}

/**
 * Splashes for a falling field: a second Points object over the same drop buffers. Each drop's landing spot and the
 * time since it landed follow from its closed-form path (the fall wraps from the ground back to the top), so the
 * splash appears exactly where and when the visible drop hits, on the ground or on the water surface (the height
 * field holds the liquid surface).
 */
function createImpact(geo: THREE.BufferGeometry, main: THREE.ShaderMaterial, def: ParticleKindDef, imp: ImpactKind, additive: boolean): { points: THREE.Points; material: THREE.ShaderMaterial } {
  const color = new THREE.Color().setRGB(...hexToRgb(imp.color), THREE.SRGBColorSpace)
  const material = new THREE.ShaderMaterial({
    defines: { ...main.defines, FLECK: imp.style === 'fleck' ? 1 : 0 },
    uniforms: {
      // the drops' own state, shared with the main material
      uTime: main.uniforms.uTime, uFocus: main.uniforms.uFocus, uBox: main.uniforms.uBox, uY: main.uniforms.uY,
      uVel: main.uniforms.uVel, uWind: main.uniforms.uWind, uWindDir: main.uniforms.uWindDir, uGustWave: main.uniforms.uGustWave,
      uGustDrift: main.uniforms.uGustDrift, uSwirl: main.uniforms.uSwirl, uSwirlSpeed: main.uniforms.uSwirlSpeed,
      uScale: main.uniforms.uScale, uHeight: main.uniforms.uHeight, uMapSize: main.uniforms.uMapSize, uLight: main.uniforms.uLight,
      uLit: main.uniforms.uLit,
      uImpAlpha: { value: imp.alpha },
      uImpLife: { value: imp.life },
      uImpSize: { value: imp.size },
      uImpShare: { value: imp.share },
      uImpColor: { value: color },
    },
    vertexShader: /* glsl */`
uniform float uTime, uSwirl, uSwirlSpeed, uScale, uGustDrift, uImpLife, uImpSize, uImpShare, uImpAlpha;
uniform vec3 uFocus, uBox, uVel;
uniform vec2 uY, uWind, uMapSize;
#if HAS_HEIGHT
uniform sampler2D uHeight;
#endif
attribute vec4 aSeed;
varying float vPhase;
varying float vA;
${WIND_DRIFT_GLSL}
float h1(float n) { return fract(sin(n) * 43758.5453123); }
vec2 dropXZ(float t) {
  vec3 vel = uVel + vec3(uWind.x, 0.0, uWind.y);
  vec2 boxMin = uFocus.xz - uBox.xz * 0.5;
  float sw = aSeed.w * 6.2831853;
  vec2 swirl = vec2(sin(t * uSwirlSpeed + sw), cos(t * uSwirlSpeed * 0.83 + sw * 1.3)) * uSwirl;
  vec2 xz = aSeed.xz * uBox.xz + vel.xz * t + swirl;
  xz = mod(xz - boxMin, uBox.xz) + boxMin;
  return xz + apGustDrift(xz, uWind, t, uGustDrift);
}
void main() {
  float range = uY.y - uY.x;
  float sw = aSeed.w * 6.2831853;
  float yf = fract(aSeed.y + uVel.y * uTime / range + sin(uTime * uSwirlSpeed + sw) * uSwirl * 0.05);
  // seconds since this drop reached the ground (yf runs 1 -> 0 and wraps)
  float since = (1.0 - yf) * range / max(1e-3, -uVel.y);
  float phase = since / uImpLife;
  vA = 0.0; vPhase = phase;
  if (phase >= 1.0 || h1(aSeed.w * 97.13 + aSeed.x * 13.7) > uImpShare) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 xz = dropXZ(uTime - since);
  float ground = uFocus.y;
#if HAS_HEIGHT
  vec2 huv = (floor(xz) + 0.5) / uMapSize;
#if HEIGHT_WRAP
  ground = texture2D(uHeight, fract(huv)).r;
#else
  if (huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0) ground = texture2D(uHeight, huv).r;
#endif
#endif
  vec4 mv = viewMatrix * vec4(xz.x, ground + uY.x + 0.03, xz.y, 1.0);
  vec2 boxMin = uFocus.xz - uBox.xz * 0.5;
  vec2 edge = min(xz - boxMin, boxMin + uBox.xz - xz);
  vA = (1.0 - phase) * smoothstep(0.0, 2.0, min(edge.x, edge.y));
#if FLECK
  float size = uImpSize;
#else
  float size = uImpSize * (0.2 + 0.8 * phase);
#endif
  gl_PointSize = max(2.0, size * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uImpColor, uLight;
uniform float uImpAlpha, uLit;
varying float vPhase;
varying float vA;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
#if FLECK
  if (r > 1.0) discard;
  float a = 1.0;
#else
  // widening ring, with a bright spot in the first third (the drop itself)
  float ring = step(abs(r - 0.78), 0.2);
  float dot = step(r, 0.34) * step(vPhase, 0.3);
  float a = max(ring, dot);
  if (a <= 0.0) discard;
#endif
  gl_FragColor = vec4(uImpColor * mix(vec3(1.0), uLight, uLit), a * vA * uImpAlpha);
}`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  const points = new THREE.Points(geo, material)
  points.frustumCulled = false
  points.renderOrder = 10
  points.name = 'impacts'
  points.visible = false
  return { points, material }
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
