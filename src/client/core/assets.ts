import * as THREE from 'three'
import type { AssetManifest, AssetStore } from '../contracts.ts'
import { CONTENT } from '../../shared/content/index.ts'
import { createPlaceholders, TUFT_SUFFIX } from './placeholders.ts'
import { PH } from './placeholders-data.ts'
import type { PlaceholderKind } from './placeholders.ts'
import { prepareCharacterSheet } from '../render/character-idle.ts'

type Kind = keyof AssetManifest

/** Asset layout under /assets (mirrors the DESIGN.md asset table). */
const LAYOUT: Record<Kind, { dir: string; ext: string }> = {
  creatures: { dir: 'creatures', ext: 'png' },
  characters: { dir: 'characters', ext: 'png' },
  portraits: { dir: 'portraits', ext: 'png' },
  textures: { dir: 'textures', ext: 'png' },
  models: { dir: 'models', ext: 'glb' },
  items: { dir: 'items', ext: 'png' },
  bgm: { dir: 'audio/bgm', ext: 'mp3' },
  ui: { dir: 'ui', ext: 'png' },
}
const KINDS = Object.keys(LAYOUT) as Kind[]
const TERRAIN_DIR = 'terrain/'

const emptyManifest = (): AssetManifest => ({ creatures: [], characters: [], portraits: [], textures: [], models: [], items: [], bgm: [], ui: [] })

/** Content-addressed CDN prefix for public/ in static CDN builds (vite.config.ts define), else null. */
declare const __AP_PUBLIC_BASE__: string | null | undefined

function baseUrl(): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env
  const cdn = typeof __AP_PUBLIC_BASE__ === 'string' ? __AP_PUBLIC_BASE__ : null
  const b = cdn ?? env?.BASE_URL ?? '/'
  return b.endsWith('/') ? b : `${b}/`
}

/** URL of a file under public/ (content-addressed CDN prefix in static CDN builds, else the Vite base). */
export function publicAssetUrl(path: string): string {
  return `${baseUrl()}${path.replace(/^\/+/, '')}`
}

/** Manifest entries may be ids, file names or paths relative to the kind's directory. */
function normalizeEntry(kind: Kind, raw: string): { id: string; file: string } | null {
  let e = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!e) return null
  const prefix = `assets/${LAYOUT[kind].dir}/`
  if (e.startsWith(prefix)) e = e.slice(prefix.length)
  else if (e.startsWith(`${LAYOUT[kind].dir}/`)) e = e.slice(LAYOUT[kind].dir.length + 1)
  const m = /^(.*)\.([a-z0-9]+)$/i.exec(e)
  return m ? { id: m[1], file: e } : { id: e, file: `${e}.${LAYOUT[kind].ext}` }
}

function configurePixelTexture(tex: THREE.Texture): THREE.Texture {
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  return tex
}

function blankCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  return c
}

export function createAssetStore(): AssetStore {
  let manifest = emptyManifest()
  const files = new Map<string, string>()          // `${kind}:${id}` -> file path relative to the kind dir
  const textures = new Map<string, THREE.Texture>()
  const models = new Map<string, Promise<THREE.Object3D | null>>()
  const placeholders = createPlaceholders()
  const root = baseUrl()
  const sprites = CONTENT.config.sprites

  const has = (kind: Kind, id: string) => files.has(`${kind}:${id}`)
  const url = (kind: Kind, id: string): string | null => {
    const f = files.get(`${kind}:${id}`)
    return f ? `${root}assets/${LAYOUT[kind].dir}/${f.split('/').map(encodeURIComponent).join('/')}` : null
  }

  /** Real file when listed (falls back to the placeholder on load error), else the placeholder. */
  const texture = (key: string, src: string | null, ph: { kind: PlaceholderKind; id: string }, size: [number, number], setup: (t: THREE.Texture, real: boolean) => void): THREE.Texture => {
    const hit = textures.get(key)
    if (hit) return hit
    let tex: THREE.Texture
    if (src) {
      let currentImage: HTMLCanvasElement | HTMLImageElement = blankCanvas(size[0], size[1])
      tex = new THREE.Texture(currentImage)
      const replaceImage = (image: HTMLImageElement | HTMLCanvasElement) => {
        if (ph.kind === 'character') image = prepareCharacterSheet(image)
        if (currentImage.width !== image.width || currentImage.height !== image.height) {
          // WebGL2 storage is immutable; reallocate without changing the Texture held by live materials.
          tex.dispose()
        }
        currentImage = image
        tex.image = currentImage
        tex.needsUpdate = true
      }
      const img = new Image()
      img.decoding = 'async'
      img.crossOrigin = 'anonymous'   // CDN-hosted textures must be CORS-clean for WebGL
      img.onload = () => replaceImage(img)
      img.onerror = () => { setup(tex, false); replaceImage(placeholders.canvas(ph.kind, ph.id)) }
      img.src = src
      configurePixelTexture(tex)
      setup(tex, true)
    } else {
      const image = placeholders.canvas(ph.kind, ph.id)
      tex = new THREE.CanvasTexture(ph.kind === 'character' ? prepareCharacterSheet(image) : image)
      configurePixelTexture(tex)
      setup(tex, false)
    }
    tex.name = key
    tex.needsUpdate = true
    textures.set(key, tex)
    return tex
  }

  const noWrap = () => { /* sprites keep ClampToEdge */ }
  // Creatures are usually drawn smaller than their 128px art (overworld, far battle slot): nearest minification
  // without mips turns the detailed art into shimmering noise, so they minify through mipmaps (magnify stays nearest).
  const smoothMinify = (t: THREE.Texture) => { t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true }

  const loadGltf = async (modelUrl: string): Promise<THREE.Object3D | null> => {
    try {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
      ])
      const loader = new GLTFLoader()
      loader.setMeshoptDecoder(MeshoptDecoder)
      const gltf = await loader.loadAsync(modelUrl)
      const scene = gltf.scene
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of mats) {
          for (const v of Object.values(mat)) {
            if (v instanceof THREE.Texture) {
              v.magFilter = THREE.NearestFilter
              v.minFilter = THREE.NearestFilter
              v.generateMipmaps = false
              v.needsUpdate = true
            }
          }
        }
      })
      return scene
    } catch (err) {
      console.warn(`[assets] model ${modelUrl} failed to load`, err)
      return null
    }
  }

  const cloneModel = async (tpl: THREE.Object3D): Promise<THREE.Object3D> => {
    let skinned = false
    tpl.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true })
    if (!skinned) return tpl.clone(true)
    const { clone } = await import('three/addons/utils/SkeletonUtils.js')
    return clone(tpl)
  }

  return {
    get manifest() { return manifest },
    async init() {
      const next = emptyManifest()
      files.clear()
      try {
        const res = await fetch(`${root}assets/manifest.json`, { cache: 'no-cache' })
        if (res.ok) {
          const raw = (await res.json()) as Partial<Record<Kind, unknown>>
          for (const kind of KINDS) {
            const list = Array.isArray(raw[kind]) ? (raw[kind] as unknown[]) : []
            for (const entry of list) {
              if (typeof entry !== 'string') continue
              const n = normalizeEntry(kind, entry)
              if (!n) continue
              next[kind].push(n.id)
              files.set(`${kind}:${n.id}`, n.file)
            }
          }
        }
      } catch { /* no manifest: everything is procedural */ }
      manifest = next
    },
    has,
    creatureTexture(speciesId) {
      const s = sprites.creatureSize
      return texture(`creature:${speciesId}`, url('creatures', speciesId), { kind: 'creature', id: speciesId }, [s, s], smoothMinify)
    },
    creatureImageUrl(speciesId) {
      return url('creatures', speciesId) ?? placeholders.dataUrl('creature', speciesId)
    },
    characterTexture(sheetId) {
      const rows = Math.max(...Object.values(sprites.sheetRows)) + 1
      return texture(`character:${sheetId}`, url('characters', sheetId), { kind: 'character', id: sheetId }, [sprites.sheetCell * sprites.sheetFrames, sprites.sheetCell * rows], noWrap)
    },
    characterImageUrl(sheetId) {
      return url('characters', sheetId) ?? placeholders.dataUrl('character', sheetId)
    },
    portraitUrl(id) {
      return url('portraits', id)
    },
    terrainTexture(key) {
      const file = url('textures', `${TERRAIN_DIR}${key}`)
      const tuft = key.endsWith(TUFT_SUFFIX)
      const n = PH.terrain.size
      return texture(`terrain:${key}`, file, { kind: 'terrain', id: key }, [n, n], (t, real) => {
        t.wrapS = real ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping
        t.wrapT = tuft ? THREE.ClampToEdgeWrapping : real ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping
      })
    },
    textureUrl(path) {
      const clean = path.replace(/^\/+/, '').replace(/\.[a-z0-9]+$/i, '')
      return url('textures', clean)
    },
    itemIconUrl(itemId) {
      return url('items', itemId) ?? placeholders.dataUrl('item', itemId)
    },
    async loadModel(modelId) {
      const u = url('models', modelId)
      if (!u) return null
      let p = models.get(modelId)
      if (!p) { p = loadGltf(u); models.set(modelId, p) }
      const tpl = await p
      return tpl ? cloneModel(tpl) : null
    },
    bgmUrl(id) {
      return url('bgm', id)
    },
    uiUrl(id) {
      return url('ui', id)
    },
  }
}
