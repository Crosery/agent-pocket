// Shared GLSL (ES 3.0) prepended to every FSPass and usable in custom ShaderMaterials.
// Hashes/simplex noise adapted from mexicat/pdoom-video (MIT); simplex noise by Ashima Arts / Stefan Gustavson (MIT).
// Built lazily: the palette comes from data/style.json, which loads before any pass is created.
import { SCALE } from './scale';
import { D, lin } from './data';

const v3 = (c: [number, number, number]) => `vec3(${c.map((x) => x.toFixed(5)).join(',')})`;

let cached = '';
export function glslCommon() {
  if (cached) return cached;
  // (the engine's own passes are built before data/style.json loads: they get no palette constants)
  const pal = D ? Object.keys(D.style.palette).map((k) => `const vec3 C_${k.replace(/([A-Z])/g, '_$1').toUpperCase()} = ${v3(lin(k))};`).join('\n') : '';
  const src = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
const float PX_SCALE = ${SCALE.toFixed(1)};
#define FRAG_PX (gl_FragCoord.xy / PX_SCALE)
${pal}
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat(vec3 x) { return clamp(x, 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 _mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 _mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 _permute(vec3 x) { return _mod289(((x * 34.0) + 10.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy)); vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1; i = _mod289(i);
  vec3 p = _permute(_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0; vec3 h = abs(x) - 0.5; vec3 ox = floor(x + 0.5); vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
/** Pixel-art texture lookup at any scale: texel-centre snap with a one-screen-pixel blend at texel edges
 *  (csantosbh 2014 / Cole Cecil 2017). Needs a LINEAR-filtered texture of size texSize. */
vec2 pixelUV(vec2 uv, vec2 texSize) {
  vec2 p = uv * texSize;
  vec2 seam = floor(p + 0.5);
  vec2 d = max(fwidth(p), vec2(1e-4));
  p = seam + clamp((p - seam) / d, -0.5, 0.5);
  return p / texSize;
}
`;
  if (D) cached = src;
  return src;
}
