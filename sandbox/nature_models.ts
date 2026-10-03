// Dev sandbox: loads every GLB listed in tools/blender/nature_spec.json with the stock GLTFLoader, lays them out
// on a tile floor by PropDef footprint and renders with an HD-2D-ish camera. ?night=1 dims the sun to check EMIT_.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import spec from '../tools/blender/nature_spec.json' with { type: 'json' }
import propsJson from '../content/props.json' with { type: 'json' }
import type { PropDef } from '../src/shared/types.ts'

const props = new Map((propsJson as PropDef[]).map((p) => [p.key, p]))
const keys = Object.keys(spec.props)
const night = new URLSearchParams(location.search).has('night')
const status = document.getElementById('status')!

const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setPixelRatio(1)
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(night ? 0x0b0e18 : 0x8fb6d8)
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4030, night ? 0.15 : 1.1))
const sun = new THREE.DirectionalLight(0xfff0d8, night ? 0.1 : 2.2)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
scene.add(sun, sun.target)

// shelf-pack props into rows by footprint (X = width, Z = depth)
const rowWidth = 26
const gap = 1
let x = 0
let z = 0
let rowDepth = 0
const slots: { key: string; x: number; z: number }[] = []
for (const key of keys) {
  const [w, d] = props.get(key)?.footprint ?? [1, 1]
  const span = Math.max(w, 2)
  if (x + span > rowWidth) {
    x = 0
    z += rowDepth + gap + 1
    rowDepth = 0
  }
  slots.push({ key, x: x + span / 2, z: z + d / 2 })
  x += span + gap
  rowDepth = Math.max(rowDepth, d)
}
const extentZ = z + rowDepth
const floor = new THREE.Mesh(new THREE.PlaneGeometry(rowWidth + 4, extentZ + 4), new THREE.MeshStandardMaterial({ color: 0x6f8f4e }))
floor.rotation.x = -Math.PI / 2
floor.position.set(rowWidth / 2, 0, extentZ / 2)
floor.receiveShadow = true
scene.add(floor)

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400)
camera.position.set(rowWidth / 2, 34, extentZ + 30)
camera.lookAt(rowWidth / 2, 0, extentZ / 2 + 1)
sun.position.set(rowWidth / 2 - 12, 30, extentZ / 2 + 14)
sun.target.position.set(rowWidth / 2, 0, extentZ / 2)
const sc = sun.shadow.camera
sc.left = sc.bottom = -30
sc.right = sc.top = 30
sc.far = 120

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

const loader = new GLTFLoader()
const results = await Promise.allSettled(
  slots.map(async ({ key, x: px, z: pz }) => {
    const gltf = await loader.loadAsync(`/${spec.modelsDir.replace(/^public\//, '')}/${key}.glb`)
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    gltf.scene.position.set(px, 0, pz)
    scene.add(gltf.scene)
  }),
)
const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${slots[i].key}: ${String(r.reason)}`] : []))
status.textContent = failed.length ? `failed: ${failed.join('; ')}` : `${slots.length} models loaded`
document.body.dataset.ready = '1'
renderer.setAnimationLoop(() => renderer.render(scene, camera))
