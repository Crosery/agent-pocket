// GLSL for the HD-2D post chain: depth-aware tilt-shift DOF and the grade/transition pass.
// Values are uniforms fed from content/render.json + PostParams; nothing here is tuned.
import * as THREE from 'three'

const fullscreenVertex = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/** Gather DOF: circle of confusion = max(depth distance from the focus band, screen distance from the tilt band). */
export const DofShader = {
  name: 'APDofShader',
  defines: { SAMPLES: 20 },
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(640, 360) },
    uNear: { value: 0.5 },
    uFar: { value: 200 },
    uFocus: { value: 16 },
    uFocusRange: { value: 3 },
    uFocusFalloff: { value: 9 },
    uTilt: { value: 0.6 },
    uTiltBand: { value: 0.16 },
    uFocusY: { value: 0.5 },
    uMaxBlur: { value: 2.5 },
  },
  vertexShader: fullscreenVertex,
  fragmentShader: /* glsl */`
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uNear, uFar, uFocus, uFocusRange, uFocusFalloff, uTilt, uTiltBand, uFocusY, uMaxBlur;
varying vec2 vUv;

float cocAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float z = -perspectiveDepthToViewZ(d, uNear, uFar);
  float dz = max(abs(z - uFocus) - uFocusRange, 0.0) / max(uFocusFalloff, 1e-3);
  float tilt = max(abs(uv.y - uFocusY) - uTiltBand, 0.0) * uTilt * 2.0;
  return clamp(max(dz, tilt), 0.0, 1.0);
}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float r0 = cocAt(vUv) * uMaxBlur;
  if (r0 < 0.35) { gl_FragColor = base; return; }
  vec3 acc = base.rgb;
  float wsum = 1.0;
  for (int i = 0; i < SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(SAMPLES)) * r0;
    float a = fi * 2.39996323;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uResolution;
    vec3 c = texture2D(tDiffuse, uv).rgb;
    float cs = cocAt(uv) * uMaxBlur;
    // sharper samples only contribute if their own blur reaches this pixel: no halos around in-focus sprites
    float w = clamp(cs - r + 1.0, 0.0, 1.0);
    acc += c * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, base.a);
}`,
}

export const TRANSITION_KIND = { none: 0, fade: 1, battle: 2, iris: 3 } as const

/** Linear-HDR grade + flash + screen transitions (fade, battle swirl-shatter, iris). Runs before OutputPass. */
export const GradeShader = {
  name: 'APGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(640, 360) },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uPivot: { value: 0.2 },
    uWarmth: { value: 0 },
    uWarmthScale: { value: 0.15 },
    uVignette: { value: 0.4 },
    uVignetteSoft: { value: 0.6 },
    uLift: { value: new THREE.Vector3() },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uTransKind: { value: 0 },
    uTrans: { value: 0 },
    uTransColor: { value: new THREE.Color(0, 0, 0) },
    uIrisCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uSwirlPortion: { value: 0.45 },
    uSwirlTurns: { value: 2 },
    uShardCells: { value: 6 },
    uShardSpin: { value: 1.5 },
    uShardStagger: { value: 0.5 },
    uBattleFlash: { value: 0.9 },
    uIrisSoft: { value: 1.5 },
    uIrisMax: { value: 1.2 },
  },
  vertexShader: fullscreenVertex,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uSaturation, uContrast, uPivot, uWarmth, uWarmthScale, uVignette, uVignetteSoft;
uniform vec3 uLift, uGain;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform int uTransKind;
uniform float uTrans;
uniform vec3 uTransColor;
uniform vec2 uIrisCenter;
uniform float uSwirlPortion, uSwirlTurns, uShardCells, uShardSpin, uShardStagger, uBattleFlash, uIrisSoft, uIrisMax;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float pulse(float x, float c, float w) { return max(0.0, 1.0 - abs(x - c) / w); }

vec3 grade(vec3 col) {
  col = col * uGain + uLift;
  float w = uWarmth * uWarmthScale;
  col *= vec3(1.0 + w, 1.0 + w * 0.15, 1.0 - w);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, uSaturation), 0.0);
  col = uPivot * pow(max(col, 0.0) / uPivot, vec3(uContrast));
  return col;
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 uv = vUv;
  float cover = 0.0;
  float extraFlash = 0.0;

  if (uTransKind == 2 && uTrans > 0.0) {
    float sp = clamp(uTrans / max(uSwirlPortion, 1e-3), 0.0, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float r = length(p);
    p = rot2(sp * sp * uSwirlTurns * 6.2831853 * (1.0 - smoothstep(0.0, 1.0, r))) * p;
    vec2 swirled = p / vec2(aspect, 1.0) + 0.5;
    extraFlash = uBattleFlash * (pulse(sp, 0.12, 0.08) + pulse(sp, 0.42, 0.08));
    float sh = clamp((uTrans - uSwirlPortion) / max(1.0 - uSwirlPortion, 1e-3), 0.0, 1.0);
    uv = swirled;
    if (sh > 0.0) {
      vec2 q = vUv * vec2(aspect, 1.0) * uShardCells;
      vec2 cell = floor(q);
      vec2 f = fract(q);
      bool upper = f.x + f.y > 1.0;
      vec2 c = upper ? vec2(2.0 / 3.0) : vec2(1.0 / 3.0);
      float rnd = hash12(cell * 2.0 + (upper ? 1.0 : 0.0));
      float pt = clamp(sh * (1.0 + uShardStagger) - rnd * uShardStagger, 0.0, 1.0);
      float scale = max(1.0 - pt, 1e-3);
      vec2 src = c + rot2(-(rnd - 0.5) * 2.0 * uShardSpin * pt) * (f - c) / scale;
      bool inside = upper
        ? (src.x <= 1.0 && src.y <= 1.0 && src.x + src.y >= 1.0)
        : (src.x >= 0.0 && src.y >= 0.0 && src.x + src.y <= 1.0);
      if (!inside || pt >= 1.0) cover = 1.0;
      vec2 srcUv = (cell + src) / uShardCells / vec2(aspect, 1.0);
      vec2 sp2 = (srcUv - 0.5) * vec2(aspect, 1.0);
      sp2 = rot2(uSwirlTurns * 6.2831853 * (1.0 - smoothstep(0.0, 1.0, length(sp2)))) * sp2;
      uv = sp2 / vec2(aspect, 1.0) + 0.5;
      extraFlash += pt * 0.25 * (1.0 - pt);
    }
  } else if (uTransKind == 1) {
    cover = clamp(uTrans, 0.0, 1.0);
  } else if (uTransKind == 3 && uTrans > 0.0) {
    float radius = (1.0 - clamp(uTrans, 0.0, 1.0)) * uIrisMax;
    float d = length((vUv - uIrisCenter) * vec2(aspect, 1.0));
    float soft = uIrisSoft / uResolution.y;
    cover = uTrans >= 1.0 ? 1.0 : smoothstep(radius - soft, radius, d);
  }

  vec4 src = texture2D(tDiffuse, clamp(uv, vec2(0.0), vec2(1.0)));
  vec3 col = grade(src.rgb);

  vec2 dv = (vUv - 0.5) * vec2(aspect, 1.0);
  float rv = length(dv) / length(vec2(0.5 * aspect, 0.5));
  col *= 1.0 - uVignette * smoothstep(1.0 - uVignetteSoft, 1.0, rv);

  col = mix(col, uFlashColor, clamp(uFlash + extraFlash, 0.0, 1.0));
  col = mix(col, uTransColor, cover);
  gl_FragColor = vec4(col, src.a);
}`,
}
