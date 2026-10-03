# three.js r186 — HD-2D renderer notes (Agent Pocket)

Target: `three@0.186.1` (npm `latest`, published 2026-09-24) + `WebGLRenderer`. Checked on 2026-10-02.

**How this was checked:**
- **[verified]** Import paths and exports: installed `three@0.186.1` locally and imported every module listed below in Node.
- **[verified]** Signatures and behaviour notes: read from the r186 source (`src/`, `examples/jsm/`), the r186 GitHub examples, the GitHub release notes and the Migration Guide.
- **[unverified]** The code snippets: they pass `node --check` for syntax, but none was run in a browser.

---

## 0. Changes up to r186 that affect this renderer

| Change | Since | What to do |
|---|---|---|
| `PCFSoftShadowMap` on WebGL: deprecated in r182, **removed in r186**. `WebGLShadowMap` now warns `"PCFSoftShadowMap has been removed. Using PCFShadowMap instead."` | r182 / r186 | Use `PCFShadowMap` (the default) with `light.shadow.radius` for softness, or `VSMShadowMap`. |
| `Clock` deprecated. `Timer` is in core (`THREE.Timer`, since r179). | r183 | `timer.connect(document); timer.update(t); timer.getDelta()` |
| `WebGLRenderer({ outputBufferType })` + `renderer.setEffects([...passes])` | r182 | Built-in post path; no `EffectComposer`/`OutputPass` needed (§3) |
| CommonJS build deprecated (`require('three')` warns); minified builds removed | r186 | ESM only |
| `Source` → `TextureSource` (old name warns) | r186 | |
| `Object3D.dispose()` added | r186 | Subclasses with `dispose()` must call `super.dispose()` |
| `Sky`/`SkyMesh`: `up` uniform removed (assumes +Y); legacy gamma removed in r183 | r186 / r183 | |
| `SunLight` addon (2-cascade CSM): `three/addons/lights/SunLight.js` | r186 (new) | Optional; `DirectionalLight` is enough for small tile maps |
| `ColorManagement.fromWorkingColorSpace` → `workingToColorSpace`, `toWorkingColorSpace` → `colorSpaceToWorking` | r177 | |
| `RGBELoader` → `HDRLoader` | r180 | |
| `KTX2Loader.detectSupportAsync()` deprecated → `detectSupport(renderer)` | r181 | |
| `DRACOLoader.setDecoderConfig()` deprecated (removal planned for r194). `setDecoderPath()` also accepts `{ js, wasm }`. | r185 | |
| `BufferGeometryUtils.mergeBufferGeometries` → `mergeGeometries` (the old name does not exist in r186) | r151 | `mergeGeometries(geoms, useGroups=false)` returns `null` on failure |
| `PostProcessing` → `RenderPipeline` | r183 | WebGPU/TSL only, not for `WebGLRenderer` |
| `Material.allowOverride` (default `true`) controls whether `scene.overrideMaterial` applies | present in r186 | See the BokehPass caveat in §8 |

TypeScript: `@types/three@0.186.0`.

## 1. Canonical imports (all verified in r186)

`three/addons/*` maps to `examples/jsm/*` through the package `exports`.

```js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Water } from 'three/addons/objects/Water.js';
import { Sky } from 'three/addons/objects/Sky.js';
```

Constructor signatures from r186 source:
- `EffectComposer(renderer, renderTarget?)`: default targets are `HalfFloatType`, so HDR values survive until `OutputPass`. Size is CSS px × pixel ratio. The pixel ratio is captured at construction; change it with `composer.setPixelRatio()`.
- `RenderPass(scene, camera, overrideMaterial = null, clearColor = null, clearAlpha = null)`
- `ShaderPass(shader, textureID = 'tDiffuse')`: **clones `shader.uniforms`**, so mutate `pass.uniforms.x.value`, not the shader object.
- `UnrealBloomPass(resolution: Vector2, strength = 1, radius, threshold)`: **`radius` and `threshold` have no defaults, so always pass all four.**
- `OutputPass()`: reads `renderer.toneMapping`, `toneMappingExposure` and `outputColorSpace`. Any pass that needs sRGB input (FXAA, LUTPass) must come **after** it.
- `BokehPass(scene, camera, { focus = 1, aperture = 0.025, maxblur = 1 })`: change values at runtime through `pass.uniforms.focus.value` and so on.
- `FXAAPass()`: a `ShaderPass(FXAAShader)` that updates its resolution in `setSize`. `SMAAPass()` takes no arguments.
- `LUTPass({ lut: Data3DTexture, intensity = 1 })`. `LUTCubeLoader` resolves to `{ title, size, domainMin, domainMax, texture3D }`.
- `InstancedMesh(geometry, material, count)`, `Fog(color, near = 1, far = 1000)`, `FogExp2(color, density = 0.00025)`, `HemisphereLight(skyColor, groundColor, intensity)`.

## 2. Renderer, colour management, tone mapping

```js
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;   // default
renderer.toneMapping = THREE.NeutralToneMapping;    // keeps a pixel-art palette closest to source; ACES/AgX shift hue and saturation
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;       // default; PCFSoftShadowMap is removed in r186
// THREE.ColorManagement.enabled === true and workingColorSpace === 'srgb-linear' by default.
```

- Colour textures need `tex.colorSpace = THREE.SRGBColorSpace`. Data textures (normal, roughness) keep `NoColorSpace`. `GLTFLoader` sets these automatically.
- Hex or CSS colours in code are treated as sRGB and converted to linear. Shader uniforms receive linear values.
- **With `EffectComposer` or `setEffects`, tone mapping is global.** It is applied in `OutputPass`/`WebGLOutput` after the scene is drawn to a render target, so `material.toneMapped = false` has no effect. If sprites must keep exact palette colours, use `NeutralToneMapping` at exposure 1, or `NoToneMapping`.

## 3. Two post-processing paths

**A. `EffectComposer`** (classic, most control, supports passes after `OutputPass`):

`RenderPass → [tilt-shift H, V] → UnrealBloomPass → OutputPass → grade/vignette ShaderPass (display space) → optional LUTPass`

**B. `renderer.setEffects()`** (r182+, as used in the r186 `webgl_shaders_ocean` example):

```js
const renderer = new THREE.WebGLRenderer({ outputBufferType: THREE.HalfFloatType }); // required, otherwise setEffects() errors
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setEffects([tiltH, tiltV, bloomPass]); // no RenderPass and no OutputPass (warns if one is passed)
renderer.render(scene, camera);                 // scene → effects (linear HDR) → tone map + sRGB automatically
```

Path B notes, verified in `src/renderers/webgl/WebGLOutput.js`:
- The scene target uses MSAA ×4 when `antialias: true`.
- The effects ping-pong in HalfFloat targets.
- **Every effect runs before tone mapping**, so display-referred grading, LUTs and FXAA cannot run after output.
- Each effect's `setSize(w, h)` is called with the drawing-buffer size.

**Recommendation:** use A, because it allows display-space grading and custom low-res passes. B is fine for a simple bloom-only chain.

## 4. Low internal resolution, nearest-neighbour upscale, crisp UI

### Option A: low-res canvas, upscaled by CSS (simplest; every pass runs at low res)

`image-rendering: pixelated` is Baseline (MDN). It scales by the nearest integer multiple, then smooths any remainder, so keep the scale integral in **device** pixels:

```js
const LOW_H = 270;
let LOW_W = 480;
renderer.setPixelRatio(1);
renderer.domElement.style.imageRendering = 'pixelated';

function resize() {
  const dpr = window.devicePixelRatio || 1;
  LOW_W = Math.round(LOW_H * innerWidth / innerHeight);              // keep the window aspect
  renderer.setSize(LOW_W, LOW_H, false);                              // false = drawing buffer only, CSS untouched
  composer.setSize(LOW_W, LOW_H);
  camera.aspect = LOW_W / LOW_H;
  camera.updateProjectionMatrix();
  const k = Math.max(1, Math.floor(Math.min(innerWidth * dpr / LOW_W, innerHeight * dpr / LOW_H)));
  renderer.domElement.style.width = `${(LOW_W * k) / dpr}px`;
  renderer.domElement.style.height = `${(LOW_H * k) / dpr}px`;
}
```

- **UI:** use a DOM overlay (or a second canvas) at native resolution so it stays crisp.
- **Picking:** use `getBoundingClientRect()` on the canvas to convert pointer position to NDC.

### Option B: hybrid "true HD-2D" (pixelated scene, smooth full-res bloom/DOF/vignette on top; closest to Octopath)

The composer runs at full resolution. The first pass renders the scene to a low-res nearest-filtered target and blits it up:

```js
class LowResRenderPass extends Pass {
  constructor(scene, camera, lowHeight = 270) {
    super();                     // needsSwap = true: we write into writeBuffer
    this.scene = scene;
    this.camera = camera;
    this.lowHeight = lowHeight;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // keep HDR for bloom
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.quad = new FullScreenQuad(new THREE.MeshBasicMaterial({ map: this.target.texture, depthTest: false, depthWrite: false }));
  }
  setSize(width, height) {       // composer passes the full-res drawing-buffer size
    this.target.setSize(Math.round(this.lowHeight * width / height), this.lowHeight);
  }
  render(renderer, writeBuffer /*, readBuffer */) {
    renderer.setRenderTarget(this.target);
    if (!renderer.autoClear) renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() {
    this.target.dispose();
    this.quad.material.dispose();
    this.quad.dispose();
  }
}
// composer.addPass(new LowResRenderPass(scene, camera, 270)); then add the passes from §8
```

- `renderer.setPixelRatio(devicePixelRatio)` stays normal here. A WebGL UI scene drawn after `composer.render()` (`autoClear=false`, `clearDepth()`) is crisp.
- Built-in alternative: `RenderPixelatedPass(pixelSize, scene, camera, { normalEdgeStrength, depthEdgeStrength })` adds outline edges. Its normal buffer uses `scene.overrideMaterial = MeshNormalMaterial`, so alpha-cut sprites appear there as solid quads; set `normalEdgeStrength = 0` if this causes edge artefacts.
- The r186 example `webgl_postprocessing_pixel.html` added "snap objects to pixel grid" helpers (`pixelAlignFrustum`, `pixelAlignObject`) for an **orthographic** camera. Port them if camera pans shimmer. Exact snapping is not possible with a perspective camera.

## 5. Pixel-art textures and sprite sheets

```js
async function loadPixelTexture(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;   // after first upload, changing these needs tex.needsUpdate = true
  return tex;
}
```

`tex.clone()` shares the same `TextureSource`. WebGL also shares the GPU texture when sampler settings match (keyed on wrap, filter, format, colorSpace and similar), so per-sprite clones with their own `offset`/`repeat` cost one upload. Each clone bumps `source.version`, which causes one re-upload, so clone at spawn time rather than per frame.

## 6. Billboard sprites (Mesh + PlaneGeometry, cylindrical) with shadows

- **Do not use `THREE.Sprite`.** `WebGLShadowMap` only renders `isMesh`, `isLine` and `isPoints` objects, so a Sprite cannot cast shadows. It is also a spherical billboard.
- **The shadow pass copies `map`, `alphaMap`, `alphaTest`, `side`/`shadowSide`, displacement and clipping from the object's material into the depth material.** This applies to the default material and to `customDepthMaterial` (see `WebGLShadowMap.getDepthMaterial`). Alpha-tested sprites therefore cast correctly shaped shadows with **no custom depth material**. You only need `customDepthMaterial` (or `customDistanceMaterial` for point lights) when the vertex shader moves vertices, for example GPU billboarding or wind (§7).
- In r186 shadow maps are `DepthTexture`s, so `depthPacking: RGBADepthPacking` on a custom depth material is unnecessary but harmless.
- **PCF renders the flipped side** (`FrontSide` → `BackSide`; VSM uses `material.side`). A single-sided quad can lose its shadow, so use `side: DoubleSide` or set `shadowSide`.

```js
const PPU = 16; // texture pixels per world unit

function createSpriteMesh(sheet, frameW, frameH, cols, rows) {
  const w = frameW / PPU;
  const h = frameH / PPU;
  const geo = new THREE.PlaneGeometry(w, h);
  geo.translate(0, h / 2, 0);                         // pivot at the feet
  const n = geo.attributes.normal;                     // lit by sun elevation, not by camera angle
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  const map = sheet.clone();
  map.repeat.set(1 / cols, 1 / rows);
  const mat = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = false;                          // avoids self-shadow streaks on a camera-facing quad
  mesh.userData.setFrame = (col, row) => map.offset.set(col / cols, 1 - (row + 1) / rows);
  return mesh;                                         // flip horizontally with mesh.scale.x = -1
}

const _camDir = new THREE.Vector3();
function updateBillboards(sprites, camera) {
  camera.getWorldDirection(_camDir);
  const yaw = Math.atan2(-_camDir.x, -_camDir.z);      // rotates the plane's +Z normal back toward the camera
  for (const s of sprites) s.rotation.y = yaw;         // parallel billboards: no skew at screen edges
}
```

**Shadow that does not rotate with the camera.** Without this, a camera-facing quad's shadow thins out as the camera yaws. Add an invisible, light-facing proxy:

```js
function addShadowProxy(sprite) {
  const proxy = new THREE.Mesh(sprite.geometry, new THREE.MeshBasicMaterial({
    map: sprite.material.map, alphaTest: 0.5, side: THREE.DoubleSide,
    colorWrite: false, depthWrite: false,   // invisible in the main pass, still drawn into the shadow map
  }));
  proxy.castShadow = true;
  sprite.castShadow = false;
  sprite.add(proxy);
  return proxy;
}
const _toSun = new THREE.Vector3();
function updateShadowProxy(proxy, sprite, sun) {
  _toSun.subVectors(sun.position, sun.target.position);
  proxy.rotation.y = Math.atan2(_toSun.x, _toSun.z) - sprite.rotation.y; // child space: cancel the parent's yaw
}
```

Do not hide the proxy with `layers` or `material.visible = false`. The shadow pass tests the **main camera's** layers and skips invisible materials.

Other options:
- Cutout sprites (`alphaTest`) go in the opaque pass with depth write, so no sorting is needed. `alphaHash: true` gives dithered semi-transparency without sorting.
- `alphaToCoverage` needs MSAA, which is not useful at low res.

## 7. Tile world, InstancedMesh, wind sway

- **Static tiles:** merge per chunk (for example 16×16) with `mergeGeometries(geoms)`. All inputs must share the same attribute set and be either all indexed or all non-indexed.
- **Repeated props, grass and trees:** one `InstancedMesh` per mesh part per chunk, so frustum culling still works.

```js
const windUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
  uWindStrength: { value: 0.12 },
};

function addWind(material, height = 1.0) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms);   // shared uniform objects: one update drives everything
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
    vec3 root = instanceMatrix[3].xyz;        // per-instance phase from its translation
  #else
    vec3 root = vec3(0.0);
  #endif
  float k = clamp(position.y / ${height.toFixed(3)}, 0.0, 1.0);
  k *= k;                                     // root fixed, tip moves most
  float phase = dot(root.xz, vec2(0.37, 0.71));
  float sway = sin(uTime * 1.7 + phase) * 0.7 + sin(uTime * 3.1 + phase * 1.9) * 0.3;
  transformed.xz += uWindDir * (sway * uWindStrength * k);
}`);
  };
  material.customProgramCacheKey = () => `wind:${height}`; // the default key is onBeforeCompile.toString()
  return material;
}
```

- `transformed` is in geometry space, before `instanceMatrix`, so a Y-rotated instance sways in its own local direction. This gives natural variation.
- This keeps `worldpos_vertex` and `shadowmap_vertex` consistent, because both read `transformed`. `MeshDepthMaterial` and `MeshDistanceMaterial` also include `<common>`, `<begin_vertex>` and `<project_vertex>`, so the same patch works on them.

```js
const COUNT = 4000;
const dummy = new THREE.Object3D();
const grassMat = addWind(new THREE.MeshLambertMaterial({ map: grassTex, alphaTest: 0.5, side: THREE.DoubleSide }), 0.4);
const grass = new THREE.InstancedMesh(bladeGeo, grassMat, COUNT);
for (let i = 0; i < COUNT; i++) {
  dummy.position.set(Math.random() * 32, 0, Math.random() * 32);
  dummy.rotation.y = Math.random() * Math.PI * 2;
  dummy.scale.setScalar(0.8 + Math.random() * 0.4);
  dummy.updateMatrix();
  grass.setMatrixAt(i, dummy.matrix);
}
grass.instanceMatrix.needsUpdate = true;
grass.computeBoundingSphere();   // recompute after changing matrices, or culling uses a stale sphere
grass.receiveShadow = true;      // grass usually should not cast

// Swaying trees that cast shadows: the depth pass needs the same displacement.
trees.customDepthMaterial = addWind(new THREE.MeshDepthMaterial(), 3.0); // map/alphaTest are copied from trees.material
// For dynamic per-frame instance updates: inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
```

## 8. Post effects for HD-2D (EffectComposer chain)

```js
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));          // or new LowResRenderPass(scene, camera, 270)

const tiltH = new ShaderPass(HorizontalTiltShiftShader);  // uniforms: h, r
const tiltV = new ShaderPass(VerticalTiltShiftShader);    // uniforms: v, r
composer.addPass(tiltH);
composer.addPass(tiltV);

const size = renderer.getDrawingBufferSize(new THREE.Vector2());
const bloom = new UnrealBloomPass(size.clone(), 0.6, 0.4, 1.0); // threshold 1.0: only HDR > 1 (emissive) blooms
composer.addPass(bloom);

composer.addPass(new OutputPass());                       // tone map + sRGB; everything after is display-referred

const HD2DGradeShader = {
  name: 'HD2DGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 16 / 9 },
    uVignette: { value: 0.35 },
    uVignetteSoft: { value: 0.6 },
    uSaturation: { value: 1.1 },
    uContrast: { value: 1.05 },
    uLift: { value: new THREE.Vector3(0.02, 0.01, 0.03) },
    uGain: { value: new THREE.Vector3(1.03, 1.0, 0.95) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uAspect, uVignette, uVignetteSoft, uSaturation, uContrast;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * uGain + uLift * (1.0 - c.rgb);
      col = (col - 0.5) * uContrast + 0.5;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      float r = length(d) / length(vec2(0.5 * uAspect, 0.5));   // 0 centre, 1 corner
      col *= 1.0 - uVignette * smoothstep(1.0 - uVignetteSoft, 1.0, r);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};
const grade = new ShaderPass(HD2DGradeShader);
composer.addPass(grade);
// Optional: const lut = new LUTPass({ lut: cube.texture3D, intensity: 0.6 }); composer.addPass(lut); (after OutputPass, as in the r186 3dlut example)
// Simple alternative to the custom grade: new ShaderPass(VignetteShader) with uniforms offset, darkness.

const _ndc = new THREE.Vector3();
function updatePost(focusWorldPos, blurPx = 3) {
  renderer.getDrawingBufferSize(size);
  _ndc.copy(focusWorldPos).project(camera);
  const r = _ndc.y * 0.5 + 0.5;                    // focus band follows the player (vUv.y, 0 = bottom)
  tiltH.uniforms.h.value = blurPx / size.x;        // blur grows with |r - vUv.y|
  tiltV.uniforms.v.value = blurPx / size.y;
  tiltH.uniforms.r.value = r;
  tiltV.uniforms.r.value = r;
  grade.uniforms.uAspect.value = size.x / size.y;
}
```

- **Tilt-shift (screen-space, two 9-tap passes) is the recommended "HD-2D DOF".** It is cheap and does not depend on depth, so there are no sprite halos. ShaderPass has no `setSize`, so update `h`/`v` on resize.
- **BokehPass caveats:**
  - It re-renders the scene with `scene.overrideMaterial = MeshDepthMaterial`, which ignores the sprites' `map`/`alphaTest`. Cutout sprites and leaves become solid rectangles in depth, which produces rectangular halos. `material.allowOverride = false` is not a fix: the colour material would then be written into the depth target.
  - It hard-codes `PERSPECTIVE_CAMERA: 1`. For an `OrthographicCamera`, set `bokeh.materialBokeh.defines.PERSPECTIVE_CAMERA = 0; bokeh.materialBokeh.needsUpdate = true;`.
- **Depth-aware DOF that respects `alphaTest`** (sketch, unverified at runtime):
  1. Create the composer with `new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w, h) }))`. `clone()` gives the second buffer its own `DepthTexture`. Call `composer.setSize()` afterwards, because the constructor takes the target's size as CSS size and multiplies it by the pixel ratio.
  2. Add a `ShaderPass` subclass right after `RenderPass` whose `render()` sets `this.uniforms.tDepth.value = readBuffer.depthTexture` before calling `super.render(...)`.
  3. Linearise depth with `#include <packing>` and `perspectiveDepthToViewZ`.
- **Bloom:** with HalfFloat targets, use `threshold ≈ 1` and `emissiveIntensity` of 2–4 on lanterns and windows, so night lights glow without the whole daylit scene blooming. In r186 `UnrealBloomPass` no longer requests a depth buffer and merges adjacent taps into bilinear fetches.
- **FXAA:** skip it for pixel art. If used, it must go after `OutputPass`.

## 9. Shadows

- **`PCFShadowMap` (default):** in r186 it uses hardware `sampler2DShadow`, a 5-tap Vogel disk rotated by interleaved-gradient noise, scaled by `shadow.radius` in texels. `radius = 1` is the default; 2–3 gives soft edges.
  - **[inferred]** The noise is per screen pixel, so in Option A (low-res canvas) it may show as coarse dithering. Keep `radius` small there, or use `BasicShadowMap` for crisp pixel shadows.
- **`VSMShadowMap`:** soft and smooth through `shadow.radius` and `shadow.blurSamples` (default 8). **Receivers also cast**, so watch for light bleeding. Not supported for point lights.
- **`light.shadow` properties (r186):** `intensity` (1), `bias`, `normalBias`, `radius`, `blurSamples`, `mapSize` (512²), `autoUpdate`, `needsUpdate`. For static scenes use `renderer.shadowMap.autoUpdate = false` and set `renderer.shadowMap.needsUpdate = true` on change.

```js
const sun = new THREE.DirectionalLight(0xfff1dc, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const S = 24; // half-extent in world units around the player
Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 0.5, far: 150 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 2;
scene.add(sun, sun.target);   // the target must be in the scene (or call sun.target.updateMatrixWorld())

const _sunDir = new THREE.Vector3();
function placeSun(focus, elevationRad, azimuthRad) {
  _sunDir.setFromSphericalCoords(1, Math.PI / 2 - elevationRad, azimuthRad);
  sun.target.position.copy(focus);                  // the shadow frustum follows the player
  sun.position.copy(focus).addScaledVector(_sunDir, 60);
}
```

- **Program recompiles:** shadow-casting light counts are shader defines (`NUM_DIR_LIGHT_SHADOWS`, etc.). Keep the light set and `castShadow` constant at runtime, and animate intensity and colour instead.
- **`SunLight`** (`new SunLight(color, intensity)`, direction = its position, 2 cascades, 1024² per cascade, `shadow.camera.left/right/top/bottom` ignored) is new in r186. Use it only if maps get large or open-world.

## 10. Day-night lighting

```js
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a2f28, 0.8);
scene.add(hemi);
scene.background = new THREE.Color();
scene.fog = new THREE.Fog(0x9ecbff, 25, 90);         // linear fog suits the HD-2D haze; FogExp2(color, density) also works

const KEYS = [
  { t: 0.00, sky: 0x0d1433, sun: 0x6f86c9, sunI: 0.35, hemiI: 0.25 }, // midnight (moonlight)
  { t: 0.23, sky: 0xf29e6d, sun: 0xffb27a, sunI: 1.2, hemiI: 0.5 },   // dawn
  { t: 0.50, sky: 0x9ecbff, sun: 0xfff1dc, sunI: 2.5, hemiI: 0.9 },   // noon
  { t: 0.77, sky: 0xff7f5c, sun: 0xff9466, sunI: 1.0, hemiI: 0.45 },  // dusk
  { t: 1.00, sky: 0x0d1433, sun: 0x6f86c9, sunI: 0.35, hemiI: 0.25 },
];
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();

function applyTimeOfDay(t, focus) {                  // t in [0, 1)
  let i = 0;
  while (KEYS[i + 1].t < t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const f = (t - a.t) / (b.t - a.t);
  scene.background.lerpColors(_c0.set(a.sky), _c1.set(b.sky), f);
  scene.fog.color.copy(scene.background);
  hemi.color.copy(scene.background);
  sun.color.lerpColors(_c0.set(a.sun), _c1.set(b.sun), f);
  sun.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, f);
  hemi.intensity = THREE.MathUtils.lerp(a.hemiI, b.hemiI, f);
  const e = Math.sin((t - 0.25) * Math.PI * 2);     // +1 noon, -1 midnight
  const elevation = THREE.MathUtils.degToRad(15 + 50 * Math.abs(e)); // >= 15° keeps shadows short
  const azimuth = (e >= 0 ? t : t + 0.5) * Math.PI * 2;              // at night the same light acts as the moon
  placeSun(focus, elevation, azimuth);
}
```

- Keep a fixed pool of `PointLight`s for lamps and set `intensity = 0` by day; changing the light count recompiles shaders.
- Lights are physical since r165 (`useLegacyLights` removed). `scene.environmentIntensity` and `backgroundIntensity` exist.
- `Sky` (`three/addons/objects/Sky.js`) now has cloud uniforms (`cloudCoverage`, `cloudDensity`, `cloudElevation`, `cloudScale`, `cloudSpeed`, `time`) and outputs HDR. The r186 ocean example uses exposure 0.1 with ACES. For a stylised HD-2D look a colour or gradient background is easier to grade.

## 11. Stylised water (custom ShaderMaterial with fog)

`Water.js` (`Water(geometry, { textureWidth, textureHeight, waterNormals, sunDirection, sunColor, waterColor, distortionScale, fog, alpha, side, eye, clipBias, time })`) and `Water2.js` render a planar reflection, which redraws the scene. That is too heavy and too realistic here. Use a cheap stylised shader:

```js
const waterMat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(0x4fc3d9) },
      uDeep: { value: new THREE.Color(0x1d5f8a) },
      uFoam: { value: new THREE.Color(0xe8fbff) },
      uPixel: { value: 16.0 }, // world-space quantisation (texels per unit)
    },
  ]),
  vertexShader: /* glsl */`
    #include <common>
    #include <fog_pars_vertex>
    uniform float uTime;
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      worldPos.y += sin(worldPos.x * 1.7 + uTime * 1.3) * 0.03 + cos(worldPos.z * 2.1 + uTime) * 0.03;
      vWorldPos = worldPos.xyz;
      vec4 mvPosition = viewMatrix * worldPos;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    uniform float uTime;
    uniform vec3 uShallow, uDeep, uFoam;
    uniform float uPixel;
    varying vec3 vWorldPos;
    void main() {
      vec2 p = floor(vWorldPos.xz * uPixel) / uPixel;
      float w = sin(p.x * 3.0 + uTime) * sin(p.y * 2.3 - uTime * 0.8);
      vec3 col = mix(uDeep, uShallow, 0.5 + 0.5 * w);
      col = mix(col, uFoam, step(0.92, w));
      gl_FragColor = vec4(col, 0.9);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
  fog: true,          // ShaderMaterial.fog defaults to false
  transparent: true,
});
```

- The chunk order (tonemapping → colorspace → fog) mirrors the built-in materials in r186.
- To receive shadows on water, patch `MeshLambertMaterial` through `onBeforeCompile` instead of using a raw ShaderMaterial.

## 12. GLTFLoader (.glb props)

```js
const draco = new DRACOLoader().setDecoderPath('/vendor/draco/'); // copy node_modules/three/examples/jsm/libs/draco/{draco_decoder.js,.wasm,draco_wasm_wrapper.js}
const ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/').detectSupport(renderer); // libs/basis/
const gltfLoader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

const gltf = await gltfLoader.loadAsync('/models/props/tree.glb');
gltf.scene.updateMatrixWorld(true);
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  o.castShadow = true;
  o.receiveShadow = true;
  const map = o.material.map;
  if (map) {                                   // pixel-art props: nearest sampling
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.needsUpdate = true;
  }
});

// GLB part → InstancedMesh (bake the node transform into the geometry; reuse the same matrices for every part)
const parts = [];
gltf.scene.traverse((o) => { if (o.isMesh) parts.push(o); });
const forest = parts.map((src) => new THREE.InstancedMesh(src.geometry.clone().applyMatrix4(src.matrixWorld), src.material, 200));
```

- In r186, `DRACOLoader` defaults its decoder URLs to `new URL('../libs/draco/…', import.meta.url)`. Bundler pre-bundling (for example Vite's dep optimiser) can break those URLs, so set the path explicitly as above.
- Meshopt (gltfpack or gltf-transform) needs no wasm path and is the simplest compression choice.

## 13. Frame loop

```js
const timer = new THREE.Timer();
timer.connect(document);                       // uses the Page Visibility API to avoid delta spikes
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  const elapsed = timer.getElapsed();
  windUniforms.uTime.value = elapsed;
  waterMat.uniforms.uTime.value = elapsed;
  updateBillboards(sprites, camera);
  updatePost(player.position);
  composer.render(dt);                         // path B: renderer.render(scene, camera)
});
```

## 14. Gotcha checklist

1. `UnrealBloomPass`: always pass `(resolution, strength, radius, threshold)`.
2. `ShaderPass` clones uniforms, so tweak `pass.uniforms`.
3. FXAA and LUT go after `OutputPass`. With `setEffects` there is no "after output".
4. Tone mapping is global in both post paths, so `toneMapped = false` per material does nothing.
5. `THREE.Sprite` does not cast shadows. Use Mesh + Plane.
6. The shadow pass auto-copies `map`/`alphaTest`/`alphaMap` (also into `customDepthMaterial`). A custom depth material is only needed for vertex displacement.
7. PCF draws the flipped face into the shadow map. Use `DoubleSide` or `shadowSide` on quads.
8. `PCFSoftShadowMap` is removed in r186. Use `PCFShadowMap` + `radius`, or VSM.
9. Changing light or shadow counts recompiles programs.
10. `EffectComposer.setSize()` takes CSS px and multiplies by its own pixel ratio. Keep `renderer.setSize`, `composer.setSize` and `camera.aspect` in sync.
11. After changing texture filters or mipmaps post-upload, set `needsUpdate = true`.
12. `BokehPass`: alpha-cut objects give rectangular depth halos, and ortho cameras need `PERSPECTIVE_CAMERA=0`.
13. Add `DirectionalLight.target` to the scene when you move it.
14. Custom `ShaderMaterial` needs `fog: true`, `UniformsLib.fog` and the fog, tonemapping and colorspace chunks.
15. Custom `Object3D` subclasses with `dispose()` must call `super.dispose()` (r186).
16. `Clock` is deprecated. Use `Timer`.

## Sources

- npm `three` 0.186.1 (2026-09-24) and `@types/three` 0.186.0. Read the tarball source: `src/renderers/webgl/WebGLShadowMap.js`, `WebGLOutput.js`, `src/renderers/WebGLRenderer.js`, `examples/jsm/postprocessing/*`, `examples/jsm/shaders/*`, `examples/jsm/loaders/{GLTFLoader,DRACOLoader,KTX2Loader}.js`, `examples/jsm/lights/SunLight*.js`.
- Release notes r179–r186: https://github.com/mrdoob/three.js/releases/tag/r186 (r182: "Add `outputBufferType` and `setEffects()` #32461"; r186: PCFSoftShadowMap removal, SunLight, CJS deprecation, `Source`→`TextureSource`).
- Migration Guide: https://github.com/mrdoob/three.js/wiki/Migration-Guide
- r186 examples: `webgl_postprocessing_unreal_bloom.html`, `webgl_shaders_ocean.html` (setEffects + Water + Sky), `webgl_postprocessing_pixel.html` (pixel snapping, Timer), `webgl_postprocessing_dof.html`, `webgl_shadowmap_vsm.html`, `webgl_postprocessing_3dlut.html`.
- threejs.org docs (via Context7 `/websites/threejs`): `Object3D.customDepthMaterial`, `Material.customProgramCacheKey`, `WebGLRenderer` `outputBufferType`/`outputColorSpace`, `EffectComposer`.
- MDN `image-rendering`: https://developer.mozilla.org/en-US/docs/Web/CSS/image-rendering
