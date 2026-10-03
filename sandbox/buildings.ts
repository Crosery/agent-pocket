// Dev sandbox for tools/blender/buildings.py output: loads every building GLB with the stock GLTFLoader,
// places it on a tile grid by PropDef footprint (facade +Z toward the camera), marks the world's door tile
// (src/shared/world/collision.ts convention) and renders with the game camera from content/config.json.
// ?night=1 switches to night lighting and turns on EMIT_ emissive maps; ?only=a,b limits the set.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import spec from '../tools/blender/buildings_spec.json' with { type: 'json' }
import propsJson from '../content/props.json' with { type: 'json' }
import config from '../content/config.json' with { type: 'json' }
import type { PropDef } from '../src/shared/types.ts'

const params = new URLSearchParams(location.search)
const night = params.has('night')
const only = params.get('only')?.split(',').filter(Boolean)
const props = new Map((propsJson as PropDef[]).map((p) => [p.key, p]))
const keys = Object.keys(spec.buildings).filter((k) => !only || only.includes(k))
const status = document.getElementById('status')!

const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setPixelRatio(1)
renderer.shadowMap.enabled = true
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(night ? 0x0b0e18 : 0x8fb6d8)
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4030, night ? 0.12 : 1.1))
const sun = new THREE.DirectionalLight(night ? 0x8fa8ff : 0xfff0d8, night ? 0.15 : 2.4)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
scene.add(sun, sun.target)

// shelf-pack by footprint; each slot reserves one extra row in front for the door tile
const rowWidth = only ? Math.max(12, ...keys.map((k) => props.get(k)!.footprint[0] + 2)) : 34
const gap = 2
let cx = 0
let cz = 0
let rowDepth = 0
const slots: { key: string; x: number; z: number }[] = []
for (const key of keys) {
  const [w, d] = props.get(key)!.footprint
  if (cx + w > rowWidth) {
    cx = 0
    cz += rowDepth + gap + 1
    rowDepth = 0
  }
  slots.push({ key, x: cx + w / 2, z: cz + d / 2 })
  cx += w + gap
  rowDepth = Math.max(rowDepth, d)
}
const extentZ = cz + rowDepth + 1

const grid = new THREE.GridHelper(Math.max(rowWidth, extentZ) + 8, Math.max(rowWidth, extentZ) + 8, 0x3d5530, 0x3d5530)
grid.position.set(rowWidth / 2, 0.002, extentZ / 2)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(rowWidth + 8, extentZ + 8), new THREE.MeshStandardMaterial({ color: 0x6f8f4e }))
floor.rotation.x = -Math.PI / 2
floor.position.set(rowWidth / 2, 0, extentZ / 2)
floor.receiveShadow = true
scene.add(floor, grid)

const camCfg = config.camera
const camera = new THREE.PerspectiveCamera(camCfg.fov, 1, 0.1, 600)
const pitch = THREE.MathUtils.degToRad(camCfg.pitchDeg)
const target = new THREE.Vector3(rowWidth / 2, 0, extentZ / 2)
const dist = Math.max(rowWidth, extentZ) * 1.9
camera.position.set(target.x, Math.sin(pitch) * dist, target.z + Math.cos(pitch) * dist)
camera.lookAt(target)
sun.position.set(target.x - 20, 40, target.z + 18)
sun.target.position.copy(target)
const sc = sun.shadow.camera
sc.left = sc.bottom = -45
sc.right = sc.top = 45
sc.far = 160

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

const doorMark = new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.55 })
const loader = new GLTFLoader()
const results = await Promise.allSettled(
  slots.map(async ({ key, x, z }) => {
    const def = props.get(key)!
    const gltf = await loader.loadAsync(`/assets/models/${def.model}.glb`)
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        if (mat.name.startsWith('EMIT_')) mat.emissiveIntensity = night ? 1.6 : 0
      }
    })
    gltf.scene.position.set(x, 0, z)
    scene.add(gltf.scene)
    if (def.door) {
      const [w, d] = def.footprint
      const tileX = Math.floor(w / 2) + def.door[0] - (w - 1) / 2
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), doorMark)
      mark.rotation.x = -Math.PI / 2
      mark.position.set(x + tileX, 0.01, z + d / 2 + 0.5)
      scene.add(mark)
    }
    if (night && def.light) {
      const l = new THREE.PointLight(def.light.color, def.light.intensity * 6, def.light.radius * 1.5)
      l.position.set(x, def.light.h, z + (def.door ? def.footprint[1] / 2 + 0.6 : 0))
      scene.add(l)
    }
  }),
)
const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${slots[i].key}: ${String(r.reason)}`] : []))
status.textContent = failed.length ? `failed: ${failed.join('; ')}` : `${slots.length} buildings loaded${night ? ' (night)' : ''}`
document.body.dataset.ready = '1'
renderer.setAnimationLoop(() => renderer.render(scene, camera))
