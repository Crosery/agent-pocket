// The HD-2D diorama shared by the 'world', 'together' and 'catch' plates (data/world.json `light`, `look`).
// The "hybrid" HD-2D path (game docs/research/three-hd2d-notes.md §4B): the environment (sky with pixel clouds,
// terrain of the game's 32-px textures, the game's GLB props, grass tufts, fireflies, contact shadows) renders at a
// low internal resolution and is upscaled by whole pixels with a 1-px depth outline, so low-poly props read as pixel
// art; the characters and creatures are pixel-art billboards drawn on top at full resolution, depth-tested against
// the upscaled depth; then god rays from the sun, tilt-shift, grade, and bloom/vignette in post.
// Golden hour: a warm key from front-left with soft violet shadows (shadow.intensity < 1 over a lavender hemisphere
// fill), drifting cloud shadows, the sun itself low on the horizon ahead (sky only), water that reflects the sky.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FSPass, makeRT, Compositor, W, H } from '../engine/gl';
import { Grade } from '../engine/grade';
import { D, lin } from '../engine/data';
import { terrainTexture, ATLAS, TEX, IMG, CELL } from '../engine/assets';
import { fbm2, hash, noise2 } from '../engine/util';

export interface Tile { x: number; z: number; top: string; side: string; h: number; water: boolean; biome: string; d: number }

/** Billboards (full-res pass) live on this camera layer; everything else on layer 0 (low-res pass). */
const BB_LAYER = 1;

const PIXEL_GLSL = /* glsl */ `
vec2 pixelUV(vec2 uv, vec2 texSize) {
  vec2 p = uv * texSize; vec2 seam = floor(p + 0.5); vec2 d = max(fwidth(p), vec2(1e-4));
  p = seam + clamp((p - seam) / d, -0.5, 0.5); return p / texSize;
}`;

/** Cheap value noise for material patches (the FSPass helpers are not available in three's built-in shaders). */
const VNOISE_GLSL = /* glsl */ `
float dHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float dNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(dHash(i), dHash(i + vec2(1, 0)), f.x), mix(dHash(i + vec2(0, 1)), dHash(i + vec2(1, 1)), f.x), f.y);
}`;

/**
 * The golden-hour sky, shared by the sky pass and the fog of every diorama material (distant terrain fades into
 * exactly the sky behind it: no edge in sight). Navy-violet zenith, a violet mid band, an orange horizon band that
 * widens toward the sun's azimuth, the sun's glow; below the horizon the haze stays luminous toward the sun.
 */
const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith, uMid, uHorizon, uSunGlowCol, uSunDirW; uniform float uSunGlow, uSunPow, uHorizonW, uMidW, uBelow, uFogNear, uFogFar, uFogMax, uTime;
vec3 skyColor(vec3 d) {
  float e = d.y;
  vec2 hz = normalize(d.xz + vec2(1e-5)), hs = normalize(uSunDirW.xz + vec2(1e-5));
  float az = max(0.0, dot(hz, hs));
  vec3 c = mix(uZenith, uMid, exp(-max(e, 0.0) / uMidW));
  float band = exp(-max(e, 0.0) / (uHorizonW * (0.6 + 1.6 * az * az)));
  c = mix(c, uHorizon * (0.6 + 0.55 * az), band);
  if (e < 0.0) c = mix(uMid * uBelow, uHorizon * (0.6 + 0.55 * az), exp(e / (uHorizonW * (1.6 + 2.4 * az * az))));
  float s = max(0.0, dot(d, normalize(uSunDirW)));
  c += uSunGlowCol * pow(s, uSunPow) * uSunGlow;
  return c;
}`;
export interface Sky { [k: string]: { value: any } }

/** Shared uniforms of the frontier (one set per diorama). */
export interface Frontier { uR: { value: number }; uRise: { value: number }; uBand: { value: number }; uDrop: { value: number }; uGold: { value: THREE.Color } }
/** Shared rim-light uniforms of the billboards (texel offset toward the sun, colour, amount). */
export interface Rim { uRimDir: { value: THREE.Vector2 }; uRimCol: { value: THREE.Color }; uRimAmt: { value: number } }

interface PatchOpts {
  texSize?: [number, number]; frontier?: Frontier; gold?: boolean; depth?: boolean; sky?: Sky;
  /** lit terrain/props: drifting cloud shadows on the direct light */
  clouds?: boolean;
  /** water: reflects the sky (Fresnel) and glints toward the sun */
  water?: boolean;
  /** billboard: 1-art-px rim on the edge facing the sun, and a depth bias toward the camera (wins against the blocky upscaled ground depth at its feet) */
  rim?: Rim; depthBias?: number;
}

/** Patch a built-in material: crisp pixel-art sampling, sky fog, frontier rise/discard/gold band, clouds, water, rim. */
export function patchMaterial(m: THREE.Material, o: PatchOpts) {
  m.onBeforeCompile = (sh) => {
    if (o.sky && !o.depth) {
      // fog toward the sky colour of the view ray (aerial perspective into the haze), not a flat fog colour
      Object.assign(sh.uniforms, o.sky);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSkyW;`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          vec4 skyW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            skyW = instanceMatrix * skyW;
          #endif
          vSkyW = (modelMatrix * skyW).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSkyW; ${SKY_GLSL} ${VNOISE_GLSL}
          uniform float uCsScale, uCsCover, uCsSoft, uCsMin, uWaterRefl, uWaterGlint; uniform vec2 uCsWind; uniform vec3 uWaterGlintCol;`)
        .replace('#include <fog_fragment>', `{
            vec3 dv = vSkyW - cameraPosition;
            float fogF = smoothstep(uFogNear, uFogFar, length(dv)) * uFogMax;
            gl_FragColor.rgb = mix(gl_FragColor.rgb, skyColor(normalize(dv)), fogF);
          }`);
      if (o.clouds || o.water) {
        let inj = '';
        if (o.clouds) inj += `{
            // cloud shadows drifting over the land (the clearing's sun pool is a break in them)
            vec2 q = vSkyW.xz * uCsScale + uCsWind * uTime;
            float n = dNoise(q) * 0.65 + dNoise(q * 2.3 + 17.1) * 0.35;
            float cs = mix(1.0, uCsMin, smoothstep(uCsCover - uCsSoft, uCsCover + uCsSoft, n));
            reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs;
          }`;
        if (o.water) inj += `{
            // the lake reflects the sky (Fresnel) and glints in pixel steps on the sun's path
            vec3 V = normalize(vSkyW - cameraPosition);
            vec3 R = reflect(V, vec3(0.0, 1.0, 0.0));
            float F = 0.25 + 0.75 * pow(1.0 - max(0.0, -V.y), 4.0);
            vec3 sk = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
            reflectedLight.directDiffuse *= 1.0 - F; reflectedLight.indirectDiffuse *= 1.0 - F;
            totalEmissiveRadiance += sk * F * uWaterRefl;
            float sp = pow(max(0.0, dot(normalize(R.xz), normalize(uSunDirW.xz))), 40.0);
            float g = step(0.93, dHash(floor(vSkyW.xz * 6.0) + floor(uTime * 5.0) * 13.7));
            totalEmissiveRadiance += uWaterGlintCol * g * sp * uWaterGlint;
          }`;
        sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          ${inj}`);
      }
    }
    if (o.frontier) {
      Object.assign(sh.uniforms, o.frontier);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aBirth; uniform float uR, uRise, uBand, uDrop; varying float vBand; varying float vBorn;`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          float kRise = clamp((uR - aBirth) / uRise, 0.0, 1.0);
          float eRise = 1.0 - pow(1.0 - kRise, 3.0);
          mvPosition.y -= (1.0 - eRise) * uDrop;
          // the gold line sits on the newest tiles that have (almost) risen, so it reads from a low camera too
          vBand = exp(-pow((aBirth - uR + uRise * 0.9) / uBand, 2.0)) * step(uR - uRise * 1.6, aBirth);
          vBorn = uR - aBirth;
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uGold; varying float vBand; varying float vBorn;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          if (vBorn < 0.0) discard;`);
      if (o.gold && !o.depth) sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += uGold * vBand;`);
    }
    if (o.depthBias) {
      // move only the depth toward the camera (the image stays where it is)
      sh.vertexShader = sh.vertexShader.replace('#include <logdepthbuf_vertex>', `#include <logdepthbuf_vertex>
          { vec4 qb = projectionMatrix * (mvPosition + vec4(0.0, 0.0, ${o.depthBias.toFixed(3)}, 0.0)); gl_Position.z = qb.z / qb.w * gl_Position.w; }`);
    }
    if (o.texSize) {
      sh.uniforms.uTexSize = { value: new THREE.Vector2(...o.texSize) };
      if (o.rim) Object.assign(sh.uniforms, o.rim);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec2 uTexSize; ${PIXEL_GLSL}
          ${o.rim ? 'uniform vec2 uRimDir; uniform vec3 uRimCol; uniform float uRimAmt;' : ''}`)
        .replace('#include <map_fragment>', `#ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, pixelUV(vMapUv, uTexSize) );
            diffuseColor *= sampledDiffuseColor;
            ${o.rim ? `{
              // one art pixel on the silhouette's sun side: opaque here, transparent one texel toward the sun
              float an = texture2D(map, pixelUV(vMapUv + uRimDir / uTexSize, uTexSize)).a;
              float rk = step(0.5, sampledDiffuseColor.a) * (1.0 - step(0.5, an)) * step(0.5, dot(abs(uRimDir), vec2(1.0)));
              diffuseColor.rgb = mix(diffuseColor.rgb, uRimCol, rk * uRimAmt);
            }` : ''}
          #endif`);
    }
  };
  m.customProgramCacheKey = () => `px${o.texSize?.join('x') ?? 0}f${o.frontier ? 1 : 0}g${o.gold ? 1 : 0}d${o.depth ? 1 : 0}s${o.sky ? 1 : 0}c${o.clouds ? 1 : 0}w${o.water ? 1 : 0}r${o.rim ? 1 : 0}b${o.depthBias ?? 0}`;
  return m;
}

/** Deterministic terrain field (data/world.json). */
export function sampleTerrain(x: number, z: number): Omit<Tile, 'd'> {
  const C = D.world, N = C.noise, s = C.seed;
  const sp = C.spawn;
  let e = fbm2(x * N.elev, z * N.elev, N.elevOct, s) * 0.5 + 0.5;
  e += noise2(x * N.detail, z * N.detail, s + 9) * 0.035;
  const m = fbm2(x * N.moist + 40, z * N.moist - 17, 3, s + 3) * 0.5 + 0.5;
  const tmp = fbm2(x * N.temp - 60, z * N.temp + 25, 2, s + 5) * 0.5 + 0.5;
  const r = Math.hypot(x, z);
  // a flat meadow around the spawn point, blended into the field
  const sk = Math.min(1, Math.max(0, (r - sp.radius) / (sp.blend ?? 6)));
  const spawnE = C.levels[sp.level] + 0.02;
  e = spawnE + (e - spawnE) * sk;
  const lv = C.levels as number[];
  let level = 0;
  while (level < lv.length - 1 && e > lv[level + 1]!) level++;
  const water = e < C.waterLevel;
  let biome: string;
  if (water) biome = 'water';
  else if (e < C.waterLevel + C.beachBand) biome = 'beach';
  else if (level >= 5 || tmp < 0.32) biome = level >= 4 || tmp < 0.32 ? 'snow' : 'alpine';
  else if (level >= 4) biome = 'alpine';
  else if (m > 0.62) biome = 'forest';
  else if (m < 0.36 && tmp > 0.55) biome = 'dry';
  else if (m > 0.5 && hash(Math.floor(x / 7), Math.floor(z / 7), s) > 0.7) biome = 'bloom';
  else biome = 'meadow';
  if (r < sp.radius) biome = sp.biome;
  const B = C.biomes[biome];
  const shallow = water && e > C.waterLevel - C.shallowBand;
  return {
    x, z, biome, water,
    top: water ? (shallow ? C.water.shallow : C.water.deep) : B.top,
    side: water ? 'cliff_rock' : B.side,
    h: water ? C.baseHeight : C.baseHeight + level * C.levelHeight,
  };
}

const gltfCache = new Map<string, Promise<THREE.Group>>();
function loadGLB(name: string) {
  let p = gltfCache.get(name);
  if (!p) {
    p = new GLTFLoader().loadAsync(`game/models/${name}.glb`).then((g) => g.scene);
    gltfCache.set(name, p);
  }
  return p;
}

/** Soft radial alpha (contact shadows): a white disc fading out, tinted by the material colour. */
let blobTex: THREE.Texture | null = null;
function blobTexture() {
  if (blobTex) return blobTex;
  const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.55, 'rgba(255,255,255,0.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, N, N);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

/** A pixel-art billboard (character frame or creature) standing on the ground, facing the camera. */
export class Billboard {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  shadow: THREE.Mesh;
  /** contact shadow on the ground (low-res pass), placed by place() */
  blob: THREE.Mesh | null = null;
  constructor(tex: THREE.Texture, texW: number, texH: number, public height: number, aspect = 1, frontier?: Frontier, sky?: Sky, o: { rim?: Rim; lowRes?: boolean } = {}) {
    const g = new THREE.PlaneGeometry(height * aspect, height);
    g.translate(0, height / 2, 0);
    this.mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide });
    // billboards are unlit: they take the key light's warmth as a tint (data/world.json light.spriteTint)
    this.mat.color.setRGB(...(D.world.light.spriteTint as [number, number, number]));
    patchMaterial(this.mat, { texSize: [texW, texH], frontier, sky, rim: o.rim, depthBias: o.lowRes ? 0 : D.world.look.depthBias });
    this.mesh = new THREE.Mesh(g, this.mat);
    if (!o.lowRes) this.mesh.layers.set(BB_LAYER);
    // the sprite faces the camera, so with a low side sun it would cast only a sliver: an invisible twin plane
    // turned to face the sun casts the full silhouette (it stays on layer 0, so the low-res pass draws it into
    // the shadow map while the visible sprite waits for the full-res pass)
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5 });
    this.shadow = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide }));
    this.shadow.castShadow = true;
    this.shadow.customDepthMaterial = dm;
    this.mesh.add(this.shadow);
  }
  /** Use a sub-rect of the texture (px, top-left origin). */
  setFrame(_tex: THREE.Texture, texW: number, texH: number, x: number, y: number, w: number, h: number, flip = false) {
    const uv = this.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const u0 = x / texW, u1 = (x + w) / texW, v0 = y / texH, v1 = (y + h) / texH;
    const [a, b] = flip ? [u1, u0] : [u0, u1];
    // PlaneGeometry uv order: (0,1) (1,1) (0,0) (1,0) -> our textures are flipY=false (top-left origin)
    uv.setXY(0, a, v0); uv.setXY(1, b, v0); uv.setXY(2, a, v1); uv.setXY(3, b, v1);
    uv.needsUpdate = true;
  }
  /** Contact shadow under the sprite (created by Diorama.add). */
  makeBlob(sky?: Sky) {
    const L = D.world.look.blob;
    const m = new THREE.MeshBasicMaterial({ map: blobTexture(), color: new THREE.Color().setRGB(...lin(L.color)), transparent: true, opacity: L.opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    patchMaterial(m, { sky });
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.blob = new THREE.Mesh(g, m);
    this.blob.renderOrder = 1;
    return this.blob;
  }
  /** Stand at (x, y, z); `ground` = terrain height under it (the contact shadow stays there and fades with height). */
  place(x: number, y: number, z: number, ground = y, sx = 1, sy = 1) {
    this.mesh.position.set(x, y, z);
    this.mesh.scale.set(sx, sy, 1);
    if (this.blob) {
      const L = D.world.look.blob, air = Math.max(0, y - ground);
      const k = 1 / (1 + air * 1.2), w = this.height * L.w * sx * (0.6 + 0.4 * k);
      this.blob.position.set(x, ground + 0.01, z);
      this.blob.scale.set(w, 1, w * L.d);
      (this.blob.material as THREE.MeshBasicMaterial).opacity = L.opacity * k;
      this.blob.visible = this.mesh.visible;
    }
  }
  face(cam: THREE.Camera) {
    // spherical facing, but keep the sprite upright
    const p = this.mesh.position, c = cam.position;
    const yaw = Math.atan2(c.x - p.x, c.z - p.z);
    this.mesh.rotation.set(0, yaw, 0);
    const horiz = Math.hypot(c.x - p.x, c.z - p.z);
    const tilt = -Math.min(0.5, Math.atan2(c.y - p.y, horiz) * 0.55);
    this.mesh.rotateX(tilt);
    if (this.blob) this.blob.rotation.set(0, yaw, 0);
    // the shadow twin: world orientation = facing the sun's azimuth (local = inverse of the parent's rotation, then that)
    const sd = D.world.light.sunDir as [number, number, number];
    this.shadow.rotation.set(0, 0, 0);
    this.shadow.rotateX(-tilt);
    this.shadow.rotateY(Math.atan2(sd[0], sd[2]) - yaw);
  }
}

export function creatureBillboard(id: string, height: number, frontier?: Frontier, sky?: Sky, rim?: Rim) {
  const b = new Billboard(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, height, 1, frontier, sky, { rim });
  const [x, y, w, h] = ATLAS.cell(id);
  b.setFrame(ATLAS.texture, ATLAS.canvas.width, ATLAS.canvas.height, x, y, w, h);
  // the sprite's feet sit at the bottom of its opaque box: shift the plane down so they touch the ground
  const box = ATLAS.box(id);
  b.mesh.geometry.translate(0, -(CELL - box.y1) / CELL * height, 0);
  return b;
}

export function characterBillboard(key: string, height: number, frontier?: Frontier, sky?: Sky, rim?: Rim) {
  const tex = TEX.get(`char:${key}`)!;
  const im = IMG.get(`char:${key}`)!;
  const b = new Billboard(tex, im.width, im.height, height, 1, frontier, sky, { rim });
  b.setFrame(tex, im.width, im.height, 0, 0, im.width / 4, im.height / 4);
  return b;
}

/** A grass tuft (the game's encounter grass) as a billboard in the low-res pass: foreground depth for the tilt-shift. */
export function tuftBillboard(key: string, height: number, sky?: Sky) {
  const tex = TEX.get(`tuft:${key}`)!, im = IMG.get(`tuft:${key}`)!;
  const b = new Billboard(tex, im.width, im.height, height, 1, undefined, sky, { lowRes: true });
  b.setFrame(tex, im.width, im.height, 0, 0, im.width, im.height);
  // grass is unlit like every billboard, but it sits in the light with the terrain, not lit like a character
  b.mat.color.setRGB(...(D.world.light.tuftTint as [number, number, number]));
  return b;
}

/** Sheet frame: rows down/left/right/up, 4 frames each. */
export function setCharFrame(b: Billboard, key: string, row: number, frame: number) {
  const tex = TEX.get(`char:${key}`)!, im = IMG.get(`char:${key}`)!;
  const cw = im.width / 4, ch = im.height / 4;
  b.setFrame(tex, im.width, im.height, (frame % 4) * cw, row * ch, cw, ch);
}

interface Firefly { x: number; y: number; z: number; ph: number; f: number; a: number }

export class Diorama {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  pool: THREE.SpotLight;
  hemi: THREE.HemisphereLight;
  frontier: Frontier;
  sky: Sky;
  rim: Rim;
  tiles: Tile[] = [];
  /** tile key "x,z" -> tile, and the tiles that carry a prop */
  byPos = new Map<string, Tile>();
  propTiles = new Set<string>();
  /** low internal resolution of the environment pass (data/world.json look.pixelDiv) */
  lw: number; lh: number;
  low: THREE.WebGLRenderTarget;
  rt = makeRT(W * 2, H * 2, { pxScale: 1 });
  blurA = makeRT(W, H, { depthBuffer: false });
  blurB = makeRT(W, H, { depthBuffer: false });
  raysA: THREE.WebGLRenderTarget;
  raysB: THREE.WebGLRenderTarget;
  grade = new Grade();
  comp = new Compositor();
  private down: FSPass;
  private tilt: FSPass;
  private skyPass: FSPass;
  private up: FSPass;
  private rayMask: FSPass;
  private rayBlur: FSPass;
  private ff: THREE.Points | null = null;
  private ffs: Firefly[] = [];
  private skySun: THREE.Vector3;

  constructor(fov: number, plate: string) {
    const L = D.world.light, K = D.world.look;
    this.camera = new THREE.PerspectiveCamera(fov, W / H, K.near ?? 0.3, 600);
    this.scene.background = null;
    this.scene.fog = null;
    const col = (h: string) => new THREE.Color().setRGB(...lin(h));
    this.skySun = new THREE.Vector3(...(L.skySunDir as [number, number, number])).normalize();
    const CS = K.cloudShadow, WA = K.water;
    this.sky = {
      uZenith: { value: col(L.zenith) }, uMid: { value: col(L.mid) }, uMidW: { value: L.midW }, uHorizon: { value: col(L.horizon) }, uSunGlowCol: { value: col(L.sunGlow) },
      uSunDirW: { value: this.skySun.clone() }, uSunGlow: { value: L.sunGlowI }, uSunPow: { value: L.sunGlowPow },
      uHorizonW: { value: L.horizonW }, uBelow: { value: L.below }, uFogNear: { value: 40 }, uFogFar: { value: 200 }, uFogMax: { value: L.fogMax },
      uTime: { value: 0 },
      uCsScale: { value: CS.scale }, uCsCover: { value: CS.cover }, uCsSoft: { value: CS.soft }, uCsMin: { value: CS.min }, uCsWind: { value: new THREE.Vector2(...(CS.wind as [number, number])) },
      uWaterRefl: { value: WA.reflect }, uWaterGlint: { value: WA.glint }, uWaterGlintCol: { value: col(WA.glintColor) },
    };
    const R = K.rim;
    this.rim = { uRimDir: { value: new THREE.Vector2(0, -1) }, uRimCol: { value: col(R.color).multiplyScalar(R.I) }, uRimAmt: { value: R.amount } };
    this.sun = new THREE.DirectionalLight(col(L.sun), L.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    // soft violet shadows: the direct light is only partly blocked; the lavender hemisphere fill shows through
    this.sun.shadow.radius = L.shadowRadius;
    this.sun.shadow.intensity = L.shadowIntensity;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(col(L.sky), col(L.ground), L.hemi);
    this.scene.add(this.hemi);
    // a pool of light on the clearing where the hero pair stands (a break in the clouds), so they stay findable wide
    const P = L.pool;
    this.pool = new THREE.SpotLight(col(P.color), P.I, 0, P.angle, P.penumbra, 0);
    this.scene.add(this.pool, this.pool.target);
    this.frontier = { uR: { value: 1e9 }, uRise: { value: 4 }, uBand: { value: 2 }, uDrop: { value: 6 }, uGold: { value: new THREE.Color().setRGB(...lin('goldHi')).multiplyScalar(2.2) } };
    this.grade.set(D.style.grade?.[plate]);

    this.lw = Math.round(W / K.pixelDiv); this.lh = Math.round(H / K.pixelDiv);
    this.low = new THREE.WebGLRenderTarget(this.lw, this.lh, {
      type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true,
      depthTexture: new THREE.DepthTexture(this.lw, this.lh, THREE.UnsignedIntType),
    });
    const small = { depthBuffer: false, pxScale: 1 } as const;
    this.raysA = makeRT(this.lw, this.lh, small);
    this.raysB = makeRT(this.lw, this.lh, small);

    const CL = K.clouds;
    this.skyPass = new FSPass(/* glsl */ `
      uniform mat4 invProj, camWorld;
      uniform vec3 cLit, cShade, sunCol; uniform float cScale, cCover, cSoft, cI, sunDisc, sunI;
      ${SKY_GLSL}
      float cn(vec2 p) { return snoise(p) * 0.55 + snoise(p * 2.07 + 11.3) * 0.3 + snoise(p * 4.3 - 5.1) * 0.15; }
      void main() {
        vec4 v = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
        vec3 d = normalize((camWorld * vec4(v.xyz / v.w, 0.0)).xyz);
        vec3 c = skyColor(d);
        vec3 sd = normalize(uSunDirW);
        float s = dot(d, sd);
        // the sun: a disc low on the horizon (HDR, blooms) with a soft corona
        c += sunCol * (smoothstep(sunDisc - 0.00008, sunDisc + 0.00004, s) * sunI + pow(max(s, 0.0), 900.0) * sunI * 0.25);
        if (d.y > 0.0 && cI > 0.0) {
          // pixel cumulus on a plane above the land, lit from below by the sun: warm toward it, violet away
          vec2 p = d.xz / (d.y + 0.06) * cScale + vec2(uTime * 0.012, 0.0);
          float n = cn(p);
          float cov = smoothstep(cCover - cSoft, cCover + cSoft, n) * smoothstep(0.0, 0.05, d.y) * (1.0 - smoothstep(0.35, 0.8, d.y));
          float under = smoothstep(-0.15, 0.25, cn(p + vec2(0.0, 0.18)) - n); // brighter bottom edges
          float toSun = pow(max(0.0, dot(normalize(d.xz), normalize(sd.xz))), 3.0);
          vec3 cc = mix(cShade, cLit, clamp(0.25 + 0.55 * toSun + 0.45 * under, 0.0, 1.0));
          cc += sunCol * pow(max(s, 0.0), 60.0) * 0.6;
          c = mix(c, cc, cov * cI);
        }
        fragColor = vec4(c, 1.0);
      }`, {
      ...this.sky, invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() },
      cLit: { value: col(CL.lit) }, cShade: { value: col(CL.shade) }, sunCol: { value: col(L.sunGlow) },
      cScale: { value: CL.scale }, cCover: { value: CL.cover }, cSoft: { value: CL.soft }, cI: { value: CL.I },
      sunDisc: { value: Math.cos(L.sunDiscDeg * Math.PI / 180) }, sunI: { value: L.sunDiscI },
    });
    // nearest upscale of the low-res environment into the full-res target, with its depth (so the billboards are
    // occluded correctly) and a 1-px outline where a pixel stands in front of a farther neighbour (t3ssel8r-style)
    const OL = K.outline;
    this.up = new FSPass(/* glsl */ `
      uniform sampler2D col, dep; uniform vec2 lowSize; uniform float near, far, olStr, olThr, olFar; uniform vec3 olCol;
      float ld(float d) { return (near * far) / (far - (far - near) * d); }
      void main() {
        ivec2 p = ivec2(floor(vUv * lowSize));
        ivec2 mx = ivec2(lowSize) - 1;
        vec3 c = texelFetch(col, p, 0).rgb;
        float d0 = texelFetch(dep, p, 0).r;
        if (d0 < 1.0 && olStr > 0.0) {
          float l0 = ld(d0), m = 0.0;
          ivec2 o[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
          for (int i = 0; i < 4; i++) {
            float dn = texelFetch(dep, clamp(p + o[i], ivec2(0), mx), 0).r;
            float ln = dn >= 1.0 ? far : ld(dn);
            m = max(m, step(l0 * (1.0 + olThr) + 0.08, ln));
          }
          c = mix(c, c * olCol, olStr * m * (1.0 - smoothstep(olFar * 0.5, olFar, l0)));
        }
        fragColor = vec4(c, 1.0);
        gl_FragDepth = d0;
      }`, {
      col: { value: this.low.texture }, dep: { value: this.low.depthTexture }, lowSize: { value: new THREE.Vector2(this.lw, this.lh) },
      near: { value: 0.3 }, far: { value: 600 }, olStr: { value: OL.strength }, olThr: { value: OL.threshold }, olFar: { value: 100 }, olCol: { value: col(OL.color) },
    });
    this.up.mat.depthTest = true; this.up.mat.depthWrite = true; this.up.mat.depthFunc = THREE.AlwaysDepth;
    // god rays (GPU Gems 3 ch. 13): the bright sky around the sun, occluded by the land, smeared toward the sun
    const GR = K.godRays;
    this.rayMask = new FSPass(/* glsl */ `
      uniform sampler2D col, dep; uniform vec2 sunUv, aspect; uniform float thr, rad;
      void main() {
        float d = texture(dep, vUv).r;
        vec3 c = texture(col, vUv).rgb;
        vec2 q = (vUv - sunUv) * aspect;
        float w = exp(-dot(q, q) / (rad * rad));
        fragColor = vec4(d >= 1.0 ? max(c - thr, 0.0) * w : vec3(0.0), 1.0);
      }`, { col: { value: this.low.texture }, dep: { value: this.low.depthTexture }, sunUv: { value: new THREE.Vector2() }, aspect: { value: new THREE.Vector2(W / H, 1) }, thr: { value: GR.threshold }, rad: { value: GR.radius } });
    this.rayBlur = new FSPass(/* glsl */ `
      uniform sampler2D src; uniform vec2 sunUv; uniform float density, decay, weight;
      void main() {
        const int N = ${GR.samples};
        vec2 dl = (vUv - sunUv) * density / float(N);
        vec2 tc = vUv; float il = 1.0; vec3 acc = vec3(0.0);
        for (int i = 0; i < N; i++) { tc -= dl; acc += texture(src, tc).rgb * il * weight; il *= decay; }
        fragColor = vec4(acc, 1.0);
      }`, { src: { value: this.raysA.texture }, sunUv: { value: new THREE.Vector2() }, density: { value: GR.density }, decay: { value: GR.decay }, weight: { value: GR.weight } });
    // 2x supersampled composite -> box downsample
    this.down = new FSPass(/* glsl */ `uniform sampler2D src; uniform vec2 texel;
      void main() {
        vec3 c = texture(src, vUv + texel * vec2(-0.5, -0.5)).rgb + texture(src, vUv + texel * vec2(0.5, -0.5)).rgb
               + texture(src, vUv + texel * vec2(-0.5, 0.5)).rgb + texture(src, vUv + texel * vec2(0.5, 0.5)).rgb;
        fragColor = vec4(c * 0.25, 1.0);
      }`, { src: { value: null }, texel: { value: new THREE.Vector2(1 / (W * 2), 1 / (H * 2)) } });
    // the HD-2D tilt-shift: blur grows away from a horizontal focus band
    this.tilt = new FSPass(/* glsl */ `uniform sampler2D src; uniform vec2 dir; uniform float focusY, band, blurPx;
      void main() {
        float d = max(0.0, abs(vUv.y - focusY) - band);
        float r = blurPx * smoothstep(0.0, 0.35, d);
        if (r < 0.05) { fragColor = vec4(texture(src, vUv).rgb, 1.0); return; }
        vec3 acc = vec3(0.0); float wsum = 0.0;
        for (int i = -6; i <= 6; i++) {
          float x = float(i) / 6.0;
          float w = exp(-x * x * 2.5);
          acc += texture(src, vUv + dir * x * r / vec2(${W}.0, ${H}.0)).rgb * w; wsum += w;
        }
        fragColor = vec4(acc / wsum, 1.0);
      }`, { src: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, focusY: { value: 0.5 }, band: { value: 0.1 }, blurPx: { value: 0 } });
  }

  /** Fog distances (world units from the camera). */
  setFog(near: number, far: number) { this.sky.uFogNear!.value = near; this.sky.uFogFar!.value = far; }
  /** Song time for drifting clouds, water glints and fireflies (0 = frozen). */
  setTime(t: number) { this.sky.uTime!.value = t; }

  /** Aim the clearing's pool of light at `p` (from above, along data/world.json light.pool.dir). */
  aimPool(p: THREE.Vector3) {
    const d = new THREE.Vector3(...(D.world.light.pool.dir as [number, number, number])).normalize();
    this.pool.position.copy(p).addScaledVector(d, 60);
    this.pool.target.position.copy(p);
  }

  /** Add a billboard to the scene, with its contact shadow. */
  add(b: Billboard, blob = true) {
    this.scene.add(b.mesh);
    if (blob) this.scene.add(b.makeBlob(this.sky));
    return b;
  }

  /**
   * Fireflies: single low-res pixels of warm HDR light (above the bloom threshold) drifting over the land around
   * `cx, cz` (data/world.json look.fireflies). Positions and twinkle are functions of setTime().
   */
  fireflies(cx: number, cz: number, heightAt: (x: number, z: number) => number, seed = 5) {
    const F = D.world.look.fireflies;
    for (let i = 0; i < F.n; i++) {
      const a = hash(i, seed) * Math.PI * 2, r = F.r[0] + Math.sqrt(hash(i, seed + 1)) * (F.r[1] - F.r[0]);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const t = this.byPos.get(`${Math.round(x)},${Math.round(z)}`);
      if (!t || t.water) continue;
      this.ffs.push({ x, z, y: heightAt(x, z) + F.y[0] + hash(i, seed + 2) * (F.y[1] - F.y[0]), ph: hash(i, seed + 3) * 100, f: 0.5 + hash(i, seed + 4), a: 0.6 + 0.4 * hash(i, seed + 5) });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.ffs.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(this.ffs.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({ size: F.px, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending });
    this.ff = new THREE.Points(g, m);
    this.ff.frustumCulled = false;
    this.scene.add(this.ff);
  }

  private updateFireflies() {
    if (!this.ff) return;
    const F = D.world.look.fireflies, t = this.sky.uTime!.value as number;
    const c = lin(F.color);
    const pos = this.ff.geometry.getAttribute('position') as THREE.BufferAttribute, colA = this.ff.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.ffs.forEach((p, i) => {
      const w = t * p.f;
      pos.setXYZ(i, p.x + Math.sin(w * 0.7 + p.ph) * 0.35, p.y + Math.sin(w * 1.1 + p.ph * 1.3) * 0.18, p.z + Math.cos(w * 0.6 + p.ph * 0.7) * 0.35);
      const tw = Math.max(0, Math.sin(w * 2.1 + p.ph * 2.0)) ** 2 * p.a * F.I;
      colA.setXYZ(i, c[0] * tw, c[1] * tw, c[2] * tw);
    });
    pos.needsUpdate = true; colA.needsUpdate = true;
  }

  /** Build terrain + props within radius `R` (tiles). `override(tile)` can restyle tiles (e.g. a path). */
  async build(R: number, override?: (t: Tile) => void, propClear: number = D.world.spawn.propClear) {
    const C = D.world;
    const byKey = new Map<string, Tile[]>();
    for (let z = -R; z <= R; z++) for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, z);
      if (d > R) continue;
      const t: Tile = { ...sampleTerrain(x, z), d: d + hash(x, z, 5) * 0.8 };
      override?.(t);
      this.tiles.push(t);
      this.byPos.set(`${x},${z}`, t);
      const k = `${t.top}|${t.side}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(t);
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const m4 = new THREE.Matrix4();
    const tint = (C.look.sideTint as [number, number, number]);
    for (const [k, list] of byKey) {
      const [topKey, sideKey] = k.split('|') as [string, string];
      const [topTex, sideTex] = await Promise.all([terrainTexture(topKey), terrainTexture(sideKey)]);
      const isWater = topKey === C.water.deep || topKey === C.water.shallow;
      const top = patchMaterial(new THREE.MeshStandardMaterial({ map: topTex, roughness: isWater ? C.waterLook.roughness : 0.95, metalness: 0, emissive: 0x000000 }), { texSize: [32, 32], frontier: this.frontier, gold: true, sky: this.sky, clouds: !isWater, water: isWater });
      const side = patchMaterial(new THREE.MeshStandardMaterial({ map: sideTex, roughness: 1, metalness: 0, color: new THREE.Color(...tint) }), { texSize: [32, 32], frontier: this.frontier, gold: true, sky: this.sky, clouds: true });
      const mesh = new THREE.InstancedMesh(box, [side, side, top, side, side, side], list.length);
      const birth = new Float32Array(list.length);
      list.forEach((t, i) => {
        m4.makeScale(1, t.h, 1).setPosition(t.x, 0, t.z);
        mesh.setMatrixAt(i, m4);
        birth[i] = t.d;
      });
      const g = box.clone();
      g.setAttribute('aBirth', new THREE.InstancedBufferAttribute(birth, 1));
      mesh.geometry = g;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.customDepthMaterial = patchMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), { frontier: this.frontier, depth: true });
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
    // props: instanced GLBs scattered by biome density
    const place = new Map<string, { x: number; z: number; y: number; r: number; s: number; d: number }[]>();
    for (const t of this.tiles) {
      if (t.water || (t as any).noProps || Math.hypot(t.x, t.z) < propClear) continue;
      // keep-clear circles (e.g. between the opening camera and the hero): data/world.json clearProps [x, z, r]
      if ((C.clearProps as [number, number, number][] | undefined)?.some(([cx, cz, cr]) => Math.hypot(t.x - cx, t.z - cz) < cr)) continue;
      const B = C.biomes[t.biome];
      let acc = 0;
      const u = hash(t.x, t.z, C.seed + 77);
      for (const [name, p] of B.props as [string, number][]) {
        acc += p * (C.propDensity ?? 1);
        if (u < acc) {
          if (!place.has(name)) place.set(name, []);
          this.propTiles.add(`${t.x},${t.z}`);
          place.get(name)!.push({ x: t.x + (hash(t.x, t.z, 3) - 0.5) * 0.4, z: t.z + (hash(t.x, t.z, 4) - 0.5) * 0.4, y: t.h, r: hash(t.x, t.z, 6) * Math.PI * 2, s: (0.85 + hash(t.x, t.z, 8) * 0.35) * C.propScale, d: t.d });
          break;
        }
      }
    }
    const emissive = (C.look.emissive ?? {}) as Record<string, [string, number]>;
    for (const [name, list] of place) {
      const src = await loadGLB(name);
      const meshes: THREE.Mesh[] = [];
      src.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const sm of meshes) {
        const mats = (Array.isArray(sm.material) ? sm.material : [sm.material]).map((mm) => {
          const m = (mm as THREE.MeshStandardMaterial).clone();
          if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.minFilter = THREE.NearestFilter; m.map.generateMipmaps = false; m.map.needsUpdate = true; }
          m.alphaTest = m.transparent ? 0.5 : m.alphaTest; m.transparent = false;
          // practical lights (crystals): HDR emissive above the bloom threshold
          const em = emissive[name];
          if (em) { m.emissive = new THREE.Color().setRGB(...lin(em[0])); m.emissiveIntensity = em[1]; }
          return patchMaterial(m, { frontier: this.frontier, gold: false, sky: this.sky, clouds: true });
        });
        const g = sm.geometry.clone();
        sm.updateWorldMatrix(true, false);
        g.applyMatrix4(sm.matrixWorld);
        const birth = new Float32Array(list.length);
        const im = new THREE.InstancedMesh(g, mats.length === 1 ? mats[0]! : mats, list.length);
        const q = new THREE.Quaternion(), e = new THREE.Euler();
        list.forEach((p, i) => {
          q.setFromEuler(e.set(0, p.r, 0));
          m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
          im.setMatrixAt(i, m4);
          birth[i] = p.d;
        });
        g.setAttribute('aBirth', new THREE.InstancedBufferAttribute(birth, 1));
        im.castShadow = true; im.receiveShadow = true;
        im.customDepthMaterial = patchMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5, map: (mats[0] as THREE.MeshStandardMaterial).map }), { frontier: this.frontier, depth: true });
        im.frustumCulled = false;
        this.scene.add(im);
      }
    }
  }

  /**
   * The standable tile nearest (x, z): dry land (not beach), no prop, and level with its four neighbours, so a
   * billboard never floats over water, a cliff edge or the void. Searches rings out to `maxR` tiles.
   */
  nearestStandable(x: number, z: number, maxR = 6): [number, number] {
    const ok = (tx: number, tz: number) => {
      const t = this.byPos.get(`${tx},${tz}`);
      if (!t || t.water || t.biome === 'beach' || this.propTiles.has(`${tx},${tz}`)) return false;
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => { const n = this.byPos.get(`${tx + dx},${tz + dz}`); return n && !n.water && n.h === t.h; });
    };
    const x0 = Math.round(x), z0 = Math.round(z);
    for (let r = 0; r <= maxR; r++) {
      let best: [number, number] | null = null, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || !ok(x0 + dx, z0 + dz)) continue;
        const d = Math.hypot(x0 + dx - x, z0 + dz - z);
        if (d < bd) { bd = d; best = [x0 + dx, z0 + dz]; }
      }
      if (best) return best;
    }
    return [x0, z0];
  }

  /** Frontier birth distance of the tile under (x, z) (when it rises). */
  birthAt(x: number, z: number) { return this.byPos.get(`${Math.round(x)},${Math.round(z)}`)?.d ?? Math.hypot(x, z); }

  heightAt(x: number, z: number) {
    const t = this.byPos.get(`${Math.round(x)},${Math.round(z)}`);
    return t ? t.h : sampleTerrain(Math.round(x), Math.round(z)).h;
  }

  /** Place the sun's shadow frustum around `target`, sized `extent` tiles. */
  aimSun(target: THREE.Vector3, extent: number) {
    const L = D.world.light;
    const dir = new THREE.Vector3(...(L.sunDir as [number, number, number])).normalize();
    this.sun.position.copy(target).addScaledVector(dir, 120);
    this.sun.target.position.copy(target);
    const c = this.sun.shadow.camera;
    c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent; c.near = 1; c.far = 300;
    c.updateProjectionMatrix();
  }

  /** The sun's position on screen (uv, y up) and whether it is in front of the camera. */
  private sunUv(): [number, number, boolean] {
    const p = this.camera.position.clone().addScaledVector(this.skySun, 400);
    const v = p.clone().applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z > -1) return [0.5, 0.5, false];
    p.project(this.camera);
    return [p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, true];
  }

  /**
   * Render to `out`: low-res environment (sky, terrain, props, tufts, fireflies, contact shadows) -> nearest upscale
   * with outline + depth -> full-res billboards -> god rays -> 2x downsample -> tilt-shift -> grade.
   */
  render(r: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, focusY: number, band: number, blurPx: number) {
    const K = D.world.look;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    this.updateFireflies();
    // the billboards' rim faces the sun (in the sprite's texture space: one texel toward it)
    const sv = this.skySun.clone().transformDirection(cam.matrixWorldInverse);
    const rx = sv.x, ry = -sv.y - 0.6; // the sun is low: bias the rim to the top edge
    const rl = Math.hypot(rx, ry) || 1;
    const q = (v: number) => (Math.abs(v / rl) > 0.38 ? Math.sign(v) : 0);
    this.rim.uRimDir.value.set(q(rx), q(ry));

    (this.skyPass.u.invProj!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (this.skyPass.u.camWorld!.value as THREE.Matrix4).copy(cam.matrixWorld);
    // 1. environment at the low internal resolution
    r.setRenderTarget(this.low);
    r.clear(true, true, true);
    this.skyPass.render(r, this.low);
    cam.layers.set(0);
    r.setRenderTarget(this.low);
    r.render(this.scene, cam);
    // 2. nearest upscale (+ outline, + depth) into the 2x target
    const U = this.up.u;
    U.near!.value = cam.near; U.far!.value = cam.far; U.olFar!.value = this.sky.uFogFar!.value;
    r.setRenderTarget(this.rt);
    r.clear(true, true, true);
    this.up.render(r, this.rt);
    // 3. billboards at full resolution, depth-tested against the environment
    cam.layers.set(BB_LAYER);
    const au = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt);
    r.render(this.scene, cam);
    r.shadowMap.autoUpdate = au;
    cam.layers.set(0);
    // 4. god rays from the sun through the gaps in the land
    const [sx, sy, front] = this.sunUv();
    const GR = K.godRays;
    const off = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5));
    const rayI = front ? GR.I * (1 - Math.min(1, Math.max(0, (off - 0.5) / 0.4))) : 0;
    if (rayI > 0) {
      (this.rayMask.u.sunUv!.value as THREE.Vector2).set(sx, sy);
      (this.rayBlur.u.sunUv!.value as THREE.Vector2).set(sx, sy);
      this.rayMask.render(r, this.raysA);
      this.rayBlur.render(r, this.raysB);
      this.comp.draw(r, this.raysB.texture, this.rt, { mode: 'add', opacity: rayI, premult: false });
    }
    // 5. downsample, tilt-shift, grade
    this.down.u.src!.value = this.rt.texture;
    this.down.render(r, this.blurA);
    const tu = this.tilt.u;
    tu.focusY!.value = focusY; tu.band!.value = band; tu.blurPx!.value = blurPx;
    tu.src!.value = this.blurA.texture; (tu.dir!.value as THREE.Vector2).set(1, 0); this.tilt.render(r, this.blurB);
    tu.src!.value = this.blurB.texture; (tu.dir!.value as THREE.Vector2).set(0, 1); this.tilt.render(r, this.blurA);
    this.grade.render(r, this.blurA.texture, out);
  }
}
