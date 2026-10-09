// Floor markers that tie each creature to its side: a ring and a faint disc on the ground under the creature, in the
// side's colour (content/battle-stage.json markers). Flat on the floor, so nothing ever sits on a sprite.
import * as THREE from 'three'
import { STAGE } from './config.ts'
import type { BattleSprite } from './sprites.ts'

export interface SideMarkers {
  /** `scale` is each slot's creature scale; hidden while the creature is absent or dissolving. */
  update(sprites: readonly BattleSprite[], scale: readonly number[], time: number): void
  dispose(): void
}

export function createSideMarkers(scene: THREE.Scene, homes: readonly THREE.Vector3[]): SideMarkers {
  const M = STAGE.markers
  const ringGeo = new THREE.RingGeometry(1 - M.width, 1, M.segments)
  const discGeo = new THREE.CircleGeometry(1, M.segments)
  const parts = homes.map((home, side) => {
    const color = new THREE.Color(M.colors[side])
    const mat = (opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false })
    const group = new THREE.Group()
    group.name = `side-marker-${side}`
    group.rotation.x = -Math.PI / 2
    group.position.set(home.x, home.y + M.lift, home.z)
    const ring = new THREE.Mesh(ringGeo, mat(M.ring))
    const disc = new THREE.Mesh(discGeo, mat(M.disc))
    ring.renderOrder = disc.renderOrder = M.renderOrder
    group.add(disc, ring)
    group.visible = false
    scene.add(group)
    return { group, ring: ring.material as THREE.MeshBasicMaterial, disc: disc.material as THREE.MeshBasicMaterial }
  })
  return {
    update(sprites, scale, time) {
      parts.forEach((p, side) => {
        const sp = sprites[side]
        const on = !!sp && sp.present && !!sp.id && sp.fx.dissolve < 0.5
        p.group.visible = on
        if (!on) return
        const pulse = 1 + M.pulse * Math.sin(time * M.hz * Math.PI * 2 + side * Math.PI)
        const r = M.radius * scale[side]
        p.group.scale.set(r * pulse, r * pulse, 1)
        p.ring.opacity = M.ring * (1 - sp.fx.dissolve)
        p.disc.opacity = M.disc * (1 - sp.fx.dissolve)
      })
    },
    dispose() {
      for (const p of parts) { p.group.removeFromParent(); p.ring.dispose(); p.disc.dispose() }
      ringGeo.dispose()
      discGeo.dispose()
    },
  }
}
