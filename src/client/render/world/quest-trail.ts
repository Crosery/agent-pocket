import * as THREE from 'three'
import { UI_CONFIG } from '../../ui/config.ts'

/** Ground-level pixel diamonds; independent from item glints, so untracking clears them immediately. */
export function createQuestTrail() {
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: UI_CONFIG.glyphPalette.h, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
  const material = new THREE.MeshBasicMaterial({
    color: UI_CONFIG.glyphPalette.h, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false,
    side: THREE.DoubleSide,
  })
  const glow = new THREE.InstancedMesh(geometry, glowMaterial, 32)
  glow.name = 'quest-navigation-glow'
  glow.count = 0
  glow.frustumCulled = false
  glow.visible = false
  const mesh = new THREE.InstancedMesh(geometry, material, 32)
  mesh.name = 'quest-navigation-trail'
  mesh.count = 0
  mesh.frustumCulled = false
  mesh.visible = false
  const matrix = new THREE.Matrix4()
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)
  const position = new THREE.Vector3(), scale = new THREE.Vector3()
  const trailPoints: { x: number; y: number; height: number }[] = []
  const compose = (target: THREE.InstancedMesh, index: number, size: number, lift: number) => {
    const p = trailPoints[index]
    position.set(p.x + 0.5, p.height + lift, p.y + 0.5)
    scale.setScalar(size)
    matrix.compose(position, rotation, scale)
    target.setMatrixAt(index, matrix)
  }
  return {
    mesh,
    glow,
    set(inputPoints: readonly { x: number; y: number }[], height: (x: number, y: number) => number) {
      const count = Math.min(inputPoints.length, 32)
      trailPoints.length = 0
      for (const p of inputPoints.slice(0, count)) {
        trailPoints.push({ x: p.x, y: p.y, height: height(p.x + 0.5, p.y + 0.5) })
      }
      glow.count = count
      mesh.count = count
      glow.visible = count > 0
      mesh.visible = count > 0
      for (let i = 0; i < count; i++) {
        const isArrived = count === 1 && inputPoints.length === 1
        compose(glow, i, isArrived ? 0.52 : 0.40, 0.058)
        compose(mesh, i, isArrived ? 0.36 : 0.22, 0.074)
      }
      glow.instanceMatrix.needsUpdate = true
      mesh.instanceMatrix.needsUpdate = true
    },
    update(time: number, reducedMotion: boolean) {
      if (!trailPoints.length) return
      if (reducedMotion) {
        glowMaterial.opacity = 0.22
        material.opacity = 0.92
        for (let i = 0; i < trailPoints.length; i++) {
          const isArrived = trailPoints.length === 1
          compose(glow, i, isArrived ? 0.48 : 0.36, 0.058)
          compose(mesh, i, isArrived ? 0.34 : 0.21, 0.074)
        }
      } else {
        for (let i = 0; i < trailPoints.length; i++) {
          // Offset each marker so the breadcrumb reads as a moving sparkle, not one
          // flat blinking strip. The next tile gets the strongest pulse.
          const phase = time * 4.6 - i * 0.72
          const pulse = (Math.sin(phase) + 1) * 0.5
          const next = i === 1 || trailPoints.length === 1
          const isArrived = trailPoints.length === 1
          compose(glow, i, (isArrived ? 0.48 : next ? 0.48 : 0.38) + pulse * (next ? 0.15 : 0.09), 0.058)
          compose(mesh, i, (isArrived ? 0.34 : next ? 0.24 : 0.21) + pulse * (next ? 0.07 : 0.035), 0.074)
        }
        glowMaterial.opacity = 0.12 + Math.sin(time * 4.6) * 0.12 + 0.12
        material.opacity = 0.72 + Math.sin(time * 4.6) * 0.16 + 0.08
      }
      glow.instanceMatrix.needsUpdate = true
      mesh.instanceMatrix.needsUpdate = true
    },
    dispose() {
      geometry.dispose()
      glowMaterial.dispose()
      material.dispose()
      glow.removeFromParent()
      mesh.removeFromParent()
    },
  }
}
