// Painted battle backdrop on a large curved cylinder behind the diorama (the biome's battleBg UI asset), tinted for
// time of day, optionally fading its painted sky so the starry dome shows at night. Without a painting, layered
// procedural silhouettes (data-driven layer list) stand on a transparent sky over the gradient dome.
import * as THREE from 'three'
import type { AssetStore } from '../../contracts.ts'
import { hexToRgb } from '../config.ts'
import { createCanvas } from '../sprite-utils.ts'
import { hashString } from '../world/coords.ts'
import { STAGE, type SilhouetteLayer, type SilhouetteShapes, type Vec2 } from './config.ts'

export interface Backdrop {
  readonly mesh: THREE.Mesh
  /** Resolves when the painting loaded (or the silhouette fallback is in place). */
  readonly ready: Promise<void>
  readonly painted: boolean
  update(tint: THREE.Color, fog: THREE.Color, fogMix: number, skyReplace: number): void
  dispose(): void
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296 }
}

/** Periodic 1D value noise (period = width) so the texture tiles when mirrored / repeated. */
function noise1(x: number, period: number, seed: number): number {
  const h = (i: number) => { const r = rng(seed + (((i % period) + period) % period) * 7919); r(); return r() }
  const i = Math.floor(x), f = x - i
  const u = f * f * (3 - 2 * f)
  return h(i) * (1 - u) + h(i + 1) * u
}

function fbm(x: number, period: number, seed: number): number {
  let a = 0, amp = 0.5, p = period, xx = x
  for (let o = 0; o < 4; o++) { a += noise1(xx, p, seed + o * 31) * amp; xx *= 2; p *= 2; amp *= 0.5 }
  return a / 0.9375
}

function css(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}

/** Draws one silhouette layer; y measured from the bottom of the canvas. */
function drawLayer(g: CanvasRenderingContext2D, W: number, H: number, l: SilhouetteLayer, idx: number, sh: SilhouetteShapes): void {
  const seed = l.seed ?? hashString(`${l.kind}:${idx}`)
  const r = rng(seed)
  const span = (v: Vec2) => v[0] + r() * (v[1] - v[0])
  const top = H * (1 - l.top), base = H * (1 - l.base)
  const amp = l.amp ?? sh.layerDefaults.amp
  const freq = Math.max(1, Math.round(l.freq ?? sh.layerDefaults.freq))
  const lightDensity = l.lightDensity ?? sh.layerDefaults.lightDensity
  g.fillStyle = css(l.color)
  const ridge = (fn: (x: number) => number) => {
    g.beginPath()
    g.moveTo(0, H)
    for (let x = 0; x <= W; x++) g.lineTo(x, fn(x))
    g.lineTo(W, H)
    g.closePath()
    g.fill()
  }
  switch (l.kind) {
    case 'mountains':
      ridge((x) => {
        const u = (x / W) * freq
        const peaks = 1 - Math.abs(fbm(u, freq, seed) * 2 - 1)
        return base - (base - top) * Math.pow(peaks, sh.mountains.sharp) * amp
      })
      break
    case 'hills':
      ridge((x) => base - (base - top) * fbm((x / W) * freq, freq, seed) * amp)
      break
    case 'sea':
      ridge((x) => base - (base - top) * (1 - sh.sea.swell * fbm((x / W) * freq, freq, seed)))
      if (l.lightColor) {
        g.fillStyle = css(l.lightColor)
        for (let i = 0; i < W * lightDensity; i++) g.fillRect(Math.floor(r() * W), Math.floor(top + r() * (H - top)), Math.round(span(sh.sea.glintPx)), 1)
      }
      break
    case 'pines':
    case 'trees': {
      const P = l.kind === 'pines' ? sh.pines : sh.trees
      g.fillRect(0, base, W, H - base)
      const n = freq * P.perFreq
      for (let i = 0; i < n; i++) {
        const cx = (i + r() * P.jitter) * (W / n)
        const h = (base - top) * span(P.height) * amp
        const w = (W / n) * span(P.width)
        if (l.kind === 'pines') {
          g.beginPath(); g.moveTo(cx - w / 2, base); g.lineTo(cx, base - h); g.lineTo(cx + w / 2, base); g.closePath(); g.fill()
        } else {
          const cy = base - h * sh.trees.crownH, cr = w * sh.trees.crownR
          g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.fill()
          g.fillRect(cx - cr, cy, cr * 2, base - cy)
        }
      }
      break
    }
    case 'city':
    case 'spires': {
      const P = l.kind === 'city' ? sh.city : sh.spires
      g.fillRect(0, base, W, H - base)
      const n = freq * P.perFreq
      for (let i = 0; i < n; i++) {
        const w = (W / n) * span(P.width)
        const x = (i + r() * P.jitter) * (W / n)
        const h = (base - top) * span(P.height) * amp
        g.fillStyle = css(l.color)
        g.fillRect(Math.floor(x), Math.floor(base - h), Math.ceil(w), Math.ceil(h))
        if (l.kind === 'spires') {
          g.beginPath(); g.moveTo(x, base - h); g.lineTo(x + w / 2, base - h - w * sh.spires.tip); g.lineTo(x + w, base - h); g.closePath(); g.fill()
        } else if (l.lightColor) {
          const pitch = sh.city.windowPitch, px = sh.city.windowPx
          g.fillStyle = css(l.lightColor)
          for (let yy = base - h + pitch - px; yy < base - px; yy += pitch) {
            for (let xx = x + px; xx < x + w - px; xx += pitch) if (r() < lightDensity) g.fillRect(Math.floor(xx), Math.floor(yy), px, px)
          }
        }
      }
      break
    }
    case 'wall':
      g.fillRect(0, top, W, H - top)
      if (l.lightColor) {
        g.fillStyle = css(l.lightColor)
        const step = Math.max(1, Math.round((H - top) / sh.wall.lines))
        for (let yy = top + sh.wall.lineOffset; yy < H; yy += step) g.fillRect(0, Math.floor(yy), W, 1)
      }
      break
    case 'columns': {
      const n = freq
      const C = sh.columns
      for (let i = 0; i < n; i++) {
        const w = (W / n) * C.width
        const x = (i + 0.5) * (W / n) - w / 2
        const cw = w * C.capWidth
        g.fillRect(Math.floor(x), Math.floor(top), Math.ceil(w), Math.ceil(H - top))
        g.fillRect(Math.floor(x + w / 2 - cw / 2), Math.floor(top), Math.ceil(cw), Math.max(1, Math.ceil(w * C.capHeight)))
      }
      break
    }
  }
}

export function silhouetteCanvas(layers: SilhouetteLayer[], size: Vec2, shapes: SilhouetteShapes = STAGE.backdrop.shapes): HTMLCanvasElement {
  const [W, H] = size
  const c = createCanvas(W, H)
  const g = c.getContext('2d')!
  layers.forEach((l, i) => drawLayer(g, W, H, l, i, shapes))
  return c
}

export function createBackdrop(assets: AssetStore, paintingId: string | null, silhouetteKey: string, origin: THREE.Vector3): Backdrop {
  const B = STAGE.backdrop
  const uniforms = {
    uMap: { value: null as THREE.Texture | null },
    uCrop: { value: new THREE.Vector2(...B.cropV) },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFog: { value: new THREE.Color() },
    uFogMix: { value: 0 },
    uSkyReplace: { value: 0 },
    uSkyFade: { value: new THREE.Vector2(...B.skyFade) },
    uBrightness: { value: B.brightness },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
uniform sampler2D uMap;
uniform vec2 uCrop, uSkyFade;
uniform vec3 uTint, uFog;
uniform float uFogMix, uSkyReplace, uBrightness;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vec2(vUv.x, mix(uCrop.x, uCrop.y, vUv.y)));
  vec3 c = mix(t.rgb * uTint * uBrightness, uFog, uFogMix);
  float a = t.a * (1.0 - uSkyReplace * smoothstep(uSkyFade.x, uSkyFade.y, vUv.y));
  if (a < 0.003) discard;
  gl_FragColor = vec4(c, a);
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  })
  const geometry = new THREE.BufferGeometry()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'battle-backdrop'
  mesh.renderOrder = -900
  mesh.frustumCulled = false
  mesh.visible = false
  let painted = false
  let texture: THREE.Texture | null = null

  /** (Re)builds the arc so the image keeps its aspect: `aspect` = texture width / height of the cropped region. */
  function build(aspect: number): void {
    const n = Math.max(8, B.segments)
    const arc = THREE.MathUtils.degToRad(B.arcDeg)
    const imageArc = (B.height * aspect) / B.radius
    const cx = origin.x, cz = origin.z + B.centerZ, y0 = origin.y + B.baseY, y1 = y0 + B.height
    const pos: number[] = [], uv: number[] = [], idx: number[] = []
    for (let i = 0; i <= n; i++) {
      const th = -arc / 2 + (arc * i) / n
      const x = cx + Math.sin(th) * B.radius, z = cz - Math.cos(th) * B.radius
      const u = 0.5 + th / imageArc
      pos.push(x, y0, z, x, y1, z)
      uv.push(u, 0, u, 1)
      if (i < n) { const b = i * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3) }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geometry.setIndex(idx)
    geometry.computeBoundingSphere()
  }

  function useSilhouettes(): void {
    const layers = B.silhouettes[silhouetteKey] ?? B.silhouettes.default ?? []
    const canvas = silhouetteCanvas(layers, B.silhouetteTex)
    texture?.dispose()
    texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.MirroredRepeatWrapping
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    uniforms.uMap.value = texture
    uniforms.uCrop.value.set(0, 1)
    painted = false
    build(B.silhouetteTex[0] / B.silhouetteTex[1])
    mesh.visible = true
  }

  const url = paintingId ? assets.uiUrl(paintingId) : null
  const ready = new Promise<void>((resolve) => {
    if (!url) { useSilhouettes(); resolve(); return }
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      texture?.dispose()
      const t = new THREE.Texture(img)
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = THREE.MirroredRepeatWrapping
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.magFilter = THREE.LinearFilter
      t.generateMipmaps = true
      t.needsUpdate = true
      texture = t
      uniforms.uMap.value = t
      uniforms.uCrop.value.set(...B.cropV)
      painted = true
      const span = Math.max(0.05, B.cropV[1] - B.cropV[0])
      build((img.naturalWidth / Math.max(1, img.naturalHeight)) / span)
      mesh.visible = true
      resolve()
    }
    img.onerror = () => { useSilhouettes(); resolve() }
    img.src = url
  })

  return {
    mesh,
    ready,
    get painted() { return painted },
    update(tint, fog, fogMix, skyReplace) {
      uniforms.uTint.value.copy(tint)
      uniforms.uFog.value.copy(fog)
      uniforms.uFogMix.value = fogMix
      // silhouettes already leave the sky transparent
      uniforms.uSkyReplace.value = painted ? skyReplace : 0
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      texture?.dispose()
      mesh.removeFromParent()
    },
  }
}
