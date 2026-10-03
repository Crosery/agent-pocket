// Billboard sprite helpers shared by the overworld (world-view) and the battle stage:
// pixel texture setup, bottom-pivot billboard quads, sprite-sheet UV frames, a Lambert sprite material with
// grass cut / hue shift / hit flash / camera-pitch lean, and a shadow depth material that turns the quad toward the light.
import * as THREE from 'three'
import { CONTENT, type Content } from '../../shared/content/index.ts'
import type { Dir } from '../../shared/types.ts'
import type { BillboardConfig } from './config.ts'

/** Nearest-filtered, mip-less sRGB texture (pixel art). Returns the same texture. */
export function configurePixelTexture<T extends THREE.Texture>(tex: T): T {
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

export function createPixelCanvasTexture(canvas: HTMLCanvasElement | OffscreenCanvas): THREE.CanvasTexture {
  return configurePixelTexture(new THREE.CanvasTexture(canvas as HTMLCanvasElement))
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export interface SheetLayout {
  cols: number
  rows: number
  rowOf: Record<Dir, number>
}

/** Character sheet layout from config.sprites (rows per direction, frames per row). */
export function sheetLayout(c: Content = CONTENT): SheetLayout {
  const s = c.config.sprites
  const rows = Math.max(...Object.values(s.sheetRows)) + 1
  return { cols: s.sheetFrames, rows, rowOf: s.sheetRows }
}

/**
 * Upright quad with its pivot at the bottom centre. Normals lean from "facing the camera" toward "up" so
 * sprites are lit by sun elevation instead of going dark when the light is behind the camera.
 */
export function createBillboardGeometry(width: number, height: number, normalTilt: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(width, height)
  geo.translate(0, height / 2, 0)
  const n = geo.getAttribute('normal') as THREE.BufferAttribute
  const v = new THREE.Vector3(0, normalTilt, 1 - normalTilt).normalize()
  for (let i = 0; i < n.count; i++) n.setXYZ(i, v.x, v.y, v.z)
  n.needsUpdate = true
  // the sprite shader may lean the card back around its pivot and stretch it up to 2x (pitch <= 60°): cull with a pivot sphere covering that
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(width / 2, height * 2))
  return geo
}

/** Points the quad's UVs at sheet cell (col,row), row 0 = top of the image. */
export function setGeometryFrame(geo: THREE.BufferGeometry, col: number, row: number, cols: number, rows: number, flipX = false): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  // half-texel-free: cells are exact multiples so nearest sampling never bleeds.
  let u0 = col / cols, u1 = (col + 1) / cols
  if (flipX) [u0, u1] = [u1, u0]
  const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows
  // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right.
  uv.setXY(0, u0, v1)
  uv.setXY(1, u1, v1)
  uv.setXY(2, u0, v0)
  uv.setXY(3, u1, v0)
  uv.needsUpdate = true
}

// ---------------------------------------------------------------------------
// Sprite material
// ---------------------------------------------------------------------------

export interface SpriteUniforms {
  /** Fragments below this local height are discarded (hides feet in tall grass). */
  uCutY: { value: number }
  /** Hue rotation in radians (shiny palettes). */
  uHue: { value: number }
  uSaturation: { value: number }
  /** 0..1 blend toward uFlashColor (hit flash, evolution glow). */
  uFlash: { value: number }
  uFlashColor: { value: THREE.Color }
  /** Fraction of the camera pitch the card leans back around its feet (0 = upright, 1 = parallel to the view plane). */
  uLean: { value: number }
  /** Fraction of the remaining pitch foreshortening undone by stretching the card (1 = art proportions on screen). */
  uCompensate: { value: number }
}

export interface SpriteMaterial {
  readonly material: THREE.MeshLambertMaterial
  readonly uniforms: SpriteUniforms
  setMap(map: THREE.Texture): void
  dispose(): void
}

/**
 * `billboard` leans/stretches the card against the camera pitch (overworld); without it the card stays an upright
 * quad. Depth is always written as the equivalent upright card, so a leaned sprite never sinks into walls behind it.
 */
export function createSpriteMaterial(map: THREE.Texture, opts: { alphaTest: number; opacity?: number; billboard?: BillboardConfig }): SpriteMaterial {
  const uniforms: SpriteUniforms = {
    uCutY: { value: -1e6 },
    uHue: { value: 0 },
    uSaturation: { value: 1 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uLean: { value: opts.billboard?.lean ?? 0 },
    uCompensate: { value: opts.billboard?.compensate ?? 0 },
  }
  const material = new THREE.MeshLambertMaterial({
    map,
    alphaTest: opts.alphaTest,
    side: THREE.DoubleSide,
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
  })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSpriteY;\nuniform float uLean;\nuniform float uCompensate;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSpriteY = position.y;
vec3 apUpright = transformed;
bool apPose = uLean > 0.0 || uCompensate > 0.0;
if (apPose) {
  // camera pitch below the horizon (view-matrix row 2 = the camera's back axis); mirrored by billboardAnchorScale()
  float apPitch = asin(clamp(viewMatrix[1][2], -0.999, 0.999));
  float apLean = apPitch * uLean;
  float apRest = max(cos(apPitch - apLean), 0.05);
  float apY = transformed.y * mix(1.0, 1.0 / apRest, uCompensate);
  // lean after the object's own scale (walk squash, bob) so the card stays planar: local z gets scale.y / scale.z
  float apZ = length(modelMatrix[1].xyz) / max(length(modelMatrix[2].xyz), 1e-4);
  transformed.y = apY * cos(apLean);
  transformed.z = -apY * sin(apLean) * apZ;
  // upright card covering the same screen height: its depth is written instead of the leaned card's
  apUpright.y = apY * apRest / max(cos(apPitch), 0.05);
}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
if (apPose) {
  vec4 apClip = projectionMatrix * modelViewMatrix * vec4(apUpright, 1.0);
  gl_Position.z = apClip.z / apClip.w * gl_Position.w;
}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vSpriteY;
uniform float uCutY;
uniform float uHue;
uniform float uSaturation;
uniform float uFlash;
uniform vec3 uFlashColor;
vec3 spriteHue(vec3 c, float a) {
  const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYiq * c;
  float h = atan(yiq.z, yiq.y) + a;
  float ch = length(yiq.yz);
  return toRgb * vec3(yiq.x, ch * cos(h), ch * sin(h));
}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vSpriteY < uCutY) discard;')
      .replace('#include <color_fragment>', `#include <color_fragment>
if (uHue != 0.0 || uSaturation != 1.0) {
  vec3 hc = spriteHue(diffuseColor.rgb, uHue);
  float l = dot(hc, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = max(mix(vec3(l), hc, uSaturation), 0.0);
}`)
      .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, uFlashColor, uFlash);\n#include <opaque_fragment>')
  }
  material.customProgramCacheKey = () => 'ap-sprite-v2'
  return {
    material,
    uniforms,
    setMap(m) { if (material.map !== m) { material.map = m; material.needsUpdate = true } },
    dispose() { material.dispose() },
  }
}

// ---------------------------------------------------------------------------
// Shadows: the depth pass rotates each billboard to face the light so its shadow keeps a full silhouette
// whatever the camera yaw. One shared material; three copies map/alphaTest from the sprite material.
// ---------------------------------------------------------------------------

export const spriteShadowUniforms = { uSpriteLightXZ: { value: new THREE.Vector2(0, 1) } }

/** Call once per frame with the direction toward the shadow-casting light. */
export function setSpriteShadowLight(dirToLight: THREE.Vector3): void {
  const v = spriteShadowUniforms.uSpriteLightXZ.value.set(dirToLight.x, dirToLight.z)
  if (v.lengthSq() < 1e-6) v.set(0, 1)
  else v.normalize()
}

let sharedDepth: THREE.MeshDepthMaterial | null = null

export function spriteDepthMaterial(): THREE.MeshDepthMaterial {
  if (sharedDepth) return sharedDepth
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, spriteShadowUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uSpriteLightXZ;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec2 ax = vec2(modelMatrix[0][0], modelMatrix[0][2]);
  float objYaw = atan(-ax.y, ax.x);
  float wantYaw = atan(uSpriteLightXZ.x, uSpriteLightXZ.y);
  float d = wantYaw - objYaw;
  float c = cos(d), s = sin(d);
  transformed.xz = vec2(transformed.x * c + transformed.z * s, -transformed.x * s + transformed.z * c);
}`)
  }
  m.customProgramCacheKey = () => 'ap-sprite-depth-v1'
  sharedDepth = m
  return m
}

// ---------------------------------------------------------------------------
// Billboarding
// ---------------------------------------------------------------------------

const _dir = new THREE.Vector3()

/** Yaw that makes a +Z-facing quad face the camera (cylindrical billboard, parallel to the view plane). */
export function cameraYaw(camera: THREE.Camera): number {
  camera.getWorldDirection(_dir)
  return Math.atan2(-_dir.x, -_dir.z)
}

/** Camera pitch below the horizon in radians (what the sprite shader reads from the view matrix). */
export function cameraPitch(camera: THREE.Camera): number {
  camera.getWorldDirection(_dir)
  return Math.asin(THREE.MathUtils.clamp(-_dir.y, -0.999, 0.999))
}

/**
 * Height multiplier for points riding on a billboard (name tags, icons over heads): an upright point at
 * height y * scale projects where the leaned / stretched card shows its height y. Mirrors the sprite shader.
 */
export function billboardAnchorScale(pitch: number, b: BillboardConfig): number {
  if (!(b.lean > 0 || b.compensate > 0)) return 1
  const rest = Math.max(Math.cos(pitch - pitch * b.lean), 0.05)
  const stretch = 1 + (1 / rest - 1) * b.compensate
  return (stretch * rest) / Math.max(Math.cos(pitch), 0.05)
}

let blobTex: THREE.Texture | null = null

/** Soft round contact-shadow texture (shared). */
export function blobShadowTexture(): THREE.Texture {
  if (blobTex) return blobTex
  const size = 32
  const c = createCanvas(size, size)
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(0,0,0,1)')
  grad.addColorStop(0.55, 'rgba(0,0,0,0.75)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  blobTex = new THREE.CanvasTexture(c)
  blobTex.colorSpace = THREE.SRGBColorSpace
  return blobTex
}

/** Flat contact shadow quad lying on the ground (y = 0 of its parent). */
export function createBlobShadow(size: number, opacity: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(size, size * 0.6)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, opacity, depthWrite: false, color: 0x000000 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = 0.02
  mesh.renderOrder = 1
  return mesh
}

/** Texture image is ready to be read into a canvas / uploaded. */
export function textureImageReady(tex: THREE.Texture): boolean {
  const img = tex.image as unknown
  if (!img) return false
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) return img.complete && img.naturalWidth > 0
  const w = (img as { width?: number }).width
  return typeof w === 'number' && w > 0
}

export function textureSize(tex: THREE.Texture): { w: number; h: number } {
  const img = tex.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | null
  if (!img) return { w: 0, h: 0 }
  return { w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 }
}

/** Draws a texture's image (canvas, image, bitmap or raw RGBA data) into a 2D context. */
export function drawTextureImage(g: CanvasRenderingContext2D, tex: THREE.Texture, dx: number, dy: number, dw: number, dh: number): boolean {
  const img = tex.image as unknown
  if (!textureImageReady(tex)) return false
  const data = (img as { data?: ArrayLike<number> }).data
  if (data && !(typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement)) {
    const { w, h } = textureSize(tex)
    const tmp = createCanvas(w, h)
    const tg = tmp.getContext('2d')!
    const id = tg.createImageData(w, h)
    const flip = tex.flipY
    for (let y = 0; y < h; y++) {
      const sy = flip ? h - 1 - y : y
      for (let x = 0; x < w * 4; x++) id.data[y * w * 4 + x] = data[sy * w * 4 + x]
    }
    tg.putImageData(id, 0, 0)
    g.drawImage(tmp, dx, dy, dw, dh)
    return true
  }
  g.drawImage(img as CanvasImageSource, dx, dy, dw, dh)
  return true
}
