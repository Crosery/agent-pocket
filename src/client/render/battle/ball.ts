// Capture ball: a small lit sphere painted with the ball's color (top), white (bottom), a dark band and a button,
// plus a contact shadow. Pose (position / spin / wobble) is driven by the stage choreography.
import * as THREE from 'three'
import { hexToRgb } from '../config.ts'
import { createBlobShadow, createCanvas } from '../sprite-utils.ts'
import { STAGE } from './config.ts'

export interface CaptureBall {
  readonly group: THREE.Group
  readonly mesh: THREE.Mesh
  setColor(hex: string): void
  /** Emissive glow multiplier (catch success dims the ball). */
  setGlow(k: number): void
  /** Ground contact shadow at (x, groundY, z) with height above ground fading it. */
  placeShadow(x: number, groundY: number, z: number, height: number): void
  setVisible(v: boolean): void
  dispose(): void
}

const css = (hex: string) => { const [r, g, b] = hexToRgb(hex); return `rgb(${r * 255},${g * 255},${b * 255})` }

export function createCaptureBall(): CaptureBall {
  const B = STAGE.ball
  const [W, H] = B.texSize
  const canvas = createCanvas(W, H)
  const g = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  const material = new THREE.MeshLambertMaterial({ map: texture, emissive: new THREE.Color(), emissiveMap: texture })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(B.radius, B.segments[0], B.segments[1]), material)
  mesh.castShadow = true
  const group = new THREE.Group()
  group.name = 'capture-ball'
  group.add(mesh)
  const shadow = createBlobShadow(B.shadowSize, B.shadowOpacity)
  const shadowMat = shadow.material as THREE.MeshBasicMaterial
  group.visible = false
  shadow.visible = false
  let glow = 1
  let color = B.defaultColor

  function paint(hex: string): void {
    g.fillStyle = css(hex)
    g.fillRect(0, 0, W, H / 2)
    g.fillStyle = css(B.white)
    g.fillRect(0, H / 2, W, H / 2)
    const bw = Math.max(1, Math.round(B.bandWidth * H))
    g.fillStyle = css(B.band)
    g.fillRect(0, Math.round(H / 2 - bw / 2), W, bw)
    // button on the +Z face: u = 0.25 on three's sphere mapping (geometry fact, not a tunable)
    const r = Math.max(1, Math.round(B.buttonSize * H))
    g.beginPath(); g.arc(W * 0.25, H / 2, r + B.buttonRim, 0, Math.PI * 2); g.fill()
    g.fillStyle = css(B.button)
    g.beginPath(); g.arc(W * 0.25, H / 2, r, 0, Math.PI * 2); g.fill()
    texture.needsUpdate = true
  }
  paint(color)

  const applyGlow = () => material.emissive.setRGB(B.emissive * glow, B.emissive * glow, B.emissive * glow)
  applyGlow()

  return {
    group,
    mesh,
    setColor(hex) { if (hex !== color) { color = hex; paint(hex) } },
    setGlow(k) { glow = k; applyGlow() },
    placeShadow(x, groundY, z, height) {
      if (!shadow.parent && group.parent) group.parent.add(shadow)
      shadow.position.set(x, groundY + B.shadowLift, z)
      const k = Math.max(0, 1 - height * B.shadowFade)
      shadow.scale.setScalar(B.shadowMinScale + (1 - B.shadowMinScale) * k)
      shadowMat.opacity = B.shadowOpacity * k
      shadow.visible = group.visible
    },
    setVisible(v) { group.visible = v; shadow.visible = v && shadowMat.opacity > 0.01 },
    dispose() {
      group.removeFromParent()
      shadow.removeFromParent()
      mesh.geometry.dispose()
      material.dispose()
      texture.dispose()
      shadow.geometry.dispose()
      shadowMat.dispose()
    },
  }
}
