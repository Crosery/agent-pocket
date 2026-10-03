// Stylised pixel water (waves, sparkles, shoreline foam, transparent shallows), waterfall sheets (pixel streaks
// scrolling down, white crest and splash foam) and emissive animated lava.
import * as THREE from 'three'
import { RENDER, hexToRgb } from '../config.ts'

const srgb = (hex: string) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)

const NOISE = /* glsl */`
float apHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float apNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(apHash(i), apHash(i + vec2(1.0, 0.0)), u.x), mix(apHash(i + vec2(0.0, 1.0)), apHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`

export interface LiquidMaterials {
  water: THREE.ShaderMaterial
  falls: THREE.ShaderMaterial
  lava: THREE.ShaderMaterial
  /** Per-frame: time, scene light color multiplier, sparkle toggle. */
  update(time: number, light: THREE.Color, sparkles: boolean): void
  dispose(): void
}

export function createLiquidMaterials(): LiquidMaterials {
  const W = RENDER.water, L = RENDER.lava
  const water = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uDeep: { value: srgb(W.deep) },
      uMid: { value: srgb(W.mid) },
      uShallow: { value: srgb(W.shallow) },
      uFoam: { value: srgb(W.foam) },
      uSparkle: { value: srgb(W.sparkle) },
      uSparkleI: { value: W.sparkleIntensity },
      uSparkleDensity: { value: W.sparkleDensity },
      uSparkleOn: { value: 1 },
      uAlphaDeep: { value: W.alphaDeep },
      uAlphaShallow: { value: W.alphaShallow },
      uPixel: { value: W.pixelsPerTile },
      uWaveSpeed: { value: W.waveSpeed },
      uWaveScale: { value: W.waveScale },
      uWaveHeight: { value: W.waveHeight },
      uFoamWidth: { value: W.foamWidth },
      uFoamSpeed: { value: W.foamSpeed },
      uFoamNoise: { value: W.foamNoise },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uLightMin: { value: W.lightMin },
      uRippleScale: { value: W.rippleScale },
      uRippleSpeed: { value: W.rippleSpeed },
      uTroughLevel: { value: W.troughLevel },
      uTroughShade: { value: W.troughShade },
      uCrestLevel: { value: W.crestLevel },
      uCrestAmount: { value: W.crestAmount },
    }]),
    vertexShader: /* glsl */`
#include <common>
#include <fog_pars_vertex>
uniform float uTime, uWaveSpeed, uWaveHeight;
attribute float aShore;
attribute float aDeep;
varying vec3 vWorld;
varying float vShore;
varying float vDeep;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y += (sin(wp.x * 1.7 + uTime * uWaveSpeed * 1.3) + cos(wp.z * 2.1 + uTime * uWaveSpeed)) * uWaveHeight * (1.0 - aShore * 0.7);
  vWorld = wp.xyz;
  vShore = aShore;
  vDeep = aDeep;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform float uTime, uSparkleI, uSparkleDensity, uSparkleOn, uAlphaDeep, uAlphaShallow, uPixel, uWaveSpeed, uWaveScale, uFoamWidth, uFoamSpeed, uFoamNoise;
uniform float uRippleScale, uRippleSpeed, uTroughLevel, uTroughShade, uCrestLevel, uCrestAmount, uLightMin;
uniform vec3 uDeep, uMid, uShallow, uFoam, uSparkle, uLight;
varying vec3 vWorld;
varying float vShore;
varying float vDeep;
${NOISE}
void main() {
  vec2 cell = floor(vWorld.xz * uPixel);
  vec2 p = cell / uPixel;
  float t = uTime * uWaveSpeed;
  // slow swell: broad brightness modulation
  float swell = sin(p.x * 2.1 * uWaveScale + t) * 0.5 + sin(p.y * 1.7 * uWaveScale - t * 0.8) * 0.5;
  // ripple field: two scrolling noise octaves, quantised into trough / body / crest pixel bands
  float rt = uTime * uRippleSpeed;
  float rip = apNoise(p * uRippleScale + vec2(rt * 0.31, rt * 0.17)) * 0.62
            + apNoise(p * uRippleScale * 2.1 + vec2(-rt * 0.23, rt * 0.29) + 7.3) * 0.38;
  vec3 base = mix(uShallow, mix(uMid, uDeep, smoothstep(0.35, 1.0, vDeep)), smoothstep(0.0, 0.55, vDeep));
  vec3 col = base * (1.0 + 0.05 * swell);
  col *= 1.0 - step(rip, uTroughLevel) * uTroughShade;
  col = mix(col, uFoam, step(uCrestLevel, rip) * uCrestAmount);
  float n = apNoise(p * 1.3 + vec2(t * 0.21, -t * 0.17));
  float edge = vShore + (n - 0.5) * uFoamNoise + sin(uTime * uFoamSpeed + (p.x + p.y) * 3.0) * 0.07;
  float foam = step(1.0 - uFoamWidth, edge);
  float foamCore = step(1.0 - uFoamWidth * 0.5, edge);
  col = mix(col, uFoam, foam * 0.45 + foamCore * 0.4);
  col *= max(uLight, vec3(uLightMin));
  float h = apHash(cell);
  float tw = sin(uTime * 3.0 + h * 61.0);
  float spark = step(1.0 - uSparkleDensity, h) * step(0.9, tw) * uSparkleOn * (1.0 - foam);
  col += uSparkle * uSparkleI * spark * max(dot(uLight, vec3(0.333)), 0.25);
  float alpha = mix(uAlphaShallow, uAlphaDeep, vDeep);
  alpha = max(alpha, foam * 0.92);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    fog: true,
    transparent: true,
    depthWrite: false,
  })

  const lava = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uHot: { value: srgb(L.hot) },
      uMid: { value: srgb(L.mid) },
      uCrust: { value: srgb(L.crust) },
      uEmissive: { value: L.emissive },
      uPixel: { value: L.pixelsPerTile },
      uFlow: { value: L.flowSpeed },
      uCrustAmount: { value: L.crustAmount },
      uPulse: { value: L.pulseSpeed },
    }]),
    vertexShader: /* glsl */`
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform float uTime, uEmissive, uPixel, uFlow, uCrustAmount, uPulse;
uniform vec3 uHot, uMid, uCrust;
varying vec3 vWorld;
${NOISE}
void main() {
  vec2 p = floor(vWorld.xz * uPixel) / uPixel;
  vec2 flow = vec2(uTime * uFlow, uTime * uFlow * 0.6);
  float n = apNoise(p * 0.9 + flow) * 0.6 + apNoise(p * 2.3 - flow * 1.7) * 0.3 + apNoise(p * 5.1 + flow * 0.5) * 0.1;
  float pulse = 0.85 + 0.15 * sin(uTime * uPulse + n * 6.0);
  vec3 hot = mix(uMid, uHot, smoothstep(0.45, 0.85, n)) * uEmissive * pulse;
  float crust = smoothstep(uCrustAmount - 0.04, uCrustAmount + 0.02, 1.0 - n);
  float rim = 1.0 - smoothstep(0.0, 0.08, abs((1.0 - n) - uCrustAmount));
  vec3 col = mix(hot, uCrust, crust);
  col += uMid * rim * uEmissive * 0.6;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    fog: true,
  })

  const F = W.falls
  const falls = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uBody: { value: srgb(F.body) },
      uStreak: { value: srgb(F.streak) },
      uFoam: { value: srgb(W.foam) },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uLightMin: { value: W.lightMin },
      uPixel: { value: W.pixelsPerTile },
      uSpeed: { value: F.speed },
      uStreaks: { value: F.streaks },
      uStreakAmount: { value: F.streakAmount },
      uCrestBand: { value: F.crestBand },
      uSplashBand: { value: F.splashBand },
      uAlpha: { value: F.alpha },
    }]),
    vertexShader: /* glsl */`
#include <common>
#include <fog_pars_vertex>
attribute vec3 aFall;
varying vec3 vFall;
void main() {
  vFall = aFall;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform float uTime, uLightMin, uPixel, uSpeed, uStreaks, uStreakAmount, uCrestBand, uSplashBand, uAlpha;
uniform vec3 uBody, uStreak, uFoam, uLight;
varying vec3 vFall;
${NOISE}
void main() {
  // pixel grid in (along, down) world units; streaks are columns of noise scrolling down
  vec2 cell = floor(vec2(vFall.x, vFall.y) * uPixel);
  vec2 p = cell / uPixel;
  float col = floor(p.x * uStreaks);
  float speed = uSpeed * (0.75 + 0.5 * apHash(vec2(col, 3.1)));
  float n = apNoise(vec2(col * 1.7, p.y * 2.2 - uTime * speed));
  vec3 c = mix(uBody, uStreak, step(1.0 - uStreakAmount, n));
  float fromTop = p.y, fromBot = vFall.z - p.y;
  float crest = 1.0 - step(uCrestBand, fromTop + (apHash(cell + floor(uTime * 6.0)) - 0.5) * 0.04);
  float splash = 1.0 - step(uSplashBand * (0.6 + 0.4 * apNoise(vec2(p.x * 3.0, uTime * 2.0))), fromBot);
  c = mix(c, uFoam, max(crest, splash) * 0.85);
  c *= max(uLight, vec3(uLightMin));
  gl_FragColor = vec4(c, max(uAlpha, max(crest, splash)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  falls.name = 'waterfall'

  return {
    water,
    falls,
    lava,
    update(time, light, sparkles) {
      water.uniforms.uTime.value = time
      falls.uniforms.uTime.value = time
      lava.uniforms.uTime.value = time
      ;(water.uniforms.uLight.value as THREE.Color).copy(light)
      ;(falls.uniforms.uLight.value as THREE.Color).copy(light)
      water.uniforms.uSparkleOn.value = sparkles ? 1 : 0
    },
    dispose() { water.dispose(); falls.dispose(); lava.dispose() },
  }
}
