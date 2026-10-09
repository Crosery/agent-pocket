// One-shot world FX (render.json "fx": icon pops, particle bursts, ground rings, light columns) and the
// glowing ground-item orbs.
import * as THREE from 'three'
import { RENDER, PARTICLE_SHAPES, hexToRgb, type FxBurst, type FxColumn, type FxIcon, type FxRing } from '../config.ts'
import { billboardAnchorScale, cameraPitch, createCanvas } from '../sprite-utils.ts'

export interface FxSystem {
  readonly group: THREE.Group
  spawn(kind: string, x: number, y: number, z: number): void
  setGroundItems(items: { id: string; x: number; y: number; z: number }[]): void
  /** Persistent teleport-anchor glow (render.json anchors.beacons): ground ring, plus column and sparkles while `on`. */
  setBeacons(items: { id: string; x: number; y: number; z: number; style: string; on: boolean }[]): void
  update(dt: number, time: number, camera: THREE.PerspectiveCamera, pxScale: number): void
  dispose(): void
}

const srgb = (hex: string) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)
const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0])

export function createFxSystem(): FxSystem {
  const F = RENDER.fx
  const group = new THREE.Group()
  group.name = 'fx'
  /** Height multiplier for icons / bursts riding on actors, following the sprite billboard pose (last camera). */
  let bodyScale = 1

  // --- burst particles (CPU simulated pool) ---
  const N = Math.max(16, F.poolSize)
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N), shape = new Float32Array(N)
  const vel = new Float32Array(N * 3), life = new Float32Array(N), maxLife = new Float32Array(N), grav = new Float32Array(N), drag = new Float32Array(N)
  let cursor = 0
  const pGeo = new THREE.BufferGeometry()
  const attr = (a: Float32Array, n: number) => { const b = new THREE.BufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b }
  pGeo.setAttribute('position', attr(pos, 3))
  pGeo.setAttribute('aColor', attr(col, 3))
  pGeo.setAttribute('aSize', attr(size, 1))
  pGeo.setAttribute('aAlpha', attr(alpha, 1))
  pGeo.setAttribute('aShape', attr(shape, 1))
  const pMat = new THREE.ShaderMaterial({
    uniforms: { uRef: { value: 1 } },
    vertexShader: /* glsl */`
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vColor = aColor; vAlpha = aAlpha; vShape = aShape;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aAlpha > 0.0 ? max(1.0, aSize) : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p);
  float a = 1.0;
  int s = int(vShape + 0.5);
  if (s == ${PARTICLE_SHAPES.indexOf('star')}) { if (min(abs(p.x), abs(p.y)) > 0.08 && r > 0.15) discard; a = 1.0 - r; }
  else if (s == ${PARTICLE_SHAPES.indexOf('soft')}) { if (r > 0.5) discard; a = (1.0 - r * 2.0); }
  else if (s == ${PARTICLE_SHAPES.indexOf('leaf')}) { if (abs(p.x) * 2.0 + abs(p.y) > 0.5) discard; }
  else if (s == ${PARTICLE_SHAPES.indexOf('ring')}) { if (abs(r - 0.36) > 0.1) discard; }
  else { if (r > 0.5) discard; }
  gl_FragColor = vec4(vColor, vAlpha * a);
}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const points = new THREE.Points(pGeo, pMat)
  points.frustumCulled = false
  points.renderOrder = 30
  group.add(points)

  function burst(e: FxBurst, x: number, y: number, z: number): void {
    const colors = e.colors.map(srgb)
    for (let i = 0; i < e.count; i++) {
      const k = cursor
      cursor = (cursor + 1) % N
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * e.radius
      pos.set([x + Math.cos(a) * r, y + e.y * bodyScale, z + Math.sin(a) * r], k * 3)
      const sp = rand(e.speed)
      vel.set([Math.cos(a) * sp, rand(e.up), Math.sin(a) * sp], k * 3)
      const c = colors[Math.floor(Math.random() * colors.length)].clone().multiplyScalar(e.glow)
      col.set([c.r, c.g, c.b], k * 3)
      size[k] = rand(e.size)
      maxLife[k] = life[k] = rand(e.life)
      grav[k] = e.gravity
      drag[k] = e.drag
      shape[k] = PARTICLE_SHAPES.indexOf(e.shape)
      alpha[k] = 1
    }
  }

  // --- icons ("!", "?", hearts) ---
  const iconTex = new Map<string, THREE.Texture>()
  function iconTexture(e: FxIcon): THREE.Texture {
    const key = `${e.glyph}|${e.color}|${e.outline}`
    let t = iconTex.get(key)
    if (t) return t
    const s = F.iconTexSize
    const c = createCanvas(s, s)
    const g = c.getContext('2d')!
    g.font = F.iconFont
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineJoin = 'round'
    g.lineWidth = Math.max(2, s / 8)
    g.strokeStyle = e.outline
    g.strokeText(e.glyph, s / 2, s / 2 + 1)
    g.fillStyle = e.color
    g.fillText(e.glyph, s / 2, s / 2 + 1)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.NearestFilter
    t.generateMipmaps = false
    iconTex.set(key, t)
    return t
  }
  const iconGeo = new THREE.PlaneGeometry(1, 1)
  interface Live { obj: THREE.Mesh; t: number; dur: number; kind: 'icon' | 'ring' | 'column'; e: FxIcon | FxRing | FxColumn; base: THREE.Vector3 }
  const live: Live[] = []

  const ringGeo = new THREE.RingGeometry(0.85, 1, 32, 1)
  ringGeo.rotateX(-Math.PI / 2)
  const colGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true)
  colGeo.translate(0, 0.5, 0)
  const glowMat = (c: THREE.Color, vertical: boolean) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: c }, uAlpha: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv; void main(){ float k = ${vertical ? '1.0 - vUv.y' : '1.0'}; gl_FragColor = vec4(uColor * uAlpha * k, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  })

  // --- ground items ---
  const G = RENDER.groundItems
  const orbGeo = new THREE.IcosahedronGeometry(G.radius, 1)
  const orbMat = new THREE.MeshBasicMaterial({ color: srgb(G.color).multiplyScalar(G.glow) })
  let orbs: THREE.InstancedMesh | null = null
  let orbItems: { x: number; y: number; z: number; phase: number }[] = []
  const orbGlowGeo = new THREE.BufferGeometry()
  const orbGlowMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: srgb(G.color).multiplyScalar(G.glow) }, uScale: { value: 300 }, uSize: { value: G.glowSize }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
uniform float uScale, uSize, uTime;
attribute float aPhase;
varying float vPulse;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPulse = 0.75 + 0.25 * sin(uTime * 3.0 + aPhase);
  gl_PointSize = max(1.0, uSize * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uColor;
varying float vPulse;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(uColor * pow(1.0 - r, 2.0) * 0.6 * vPulse, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const orbGlow = new THREE.Points(orbGlowGeo, orbGlowMat)
  orbGlow.frustumCulled = false
  orbGlow.visible = false
  group.add(orbGlow)
  const _m = new THREE.Matrix4()

  // --- teleport anchor beacons ---
  const B = RENDER.anchors.beacons
  interface Beacon { x: number; y: number; z: number; style: string; on: boolean; phase: number; idle: number; ring: THREE.Mesh; col: THREE.Mesh | null; core: THREE.Mesh | null }
  const coreGeo = new THREE.PlaneGeometry(1, 1)
  const coreMat = (c: THREE.Color) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: c }, uAlpha: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 2.0; if (r > 1.0) discard; float k = pow(1.0 - r, 2.2); gl_FragColor = vec4(uColor * uAlpha * k, 1.0); }',
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  })
  let beacons: Beacon[] = []
  const dropBeacons = () => {
    for (const b of beacons) {
      for (const m of [b.ring, b.col, b.core]) if (m) { group.remove(m); (m.material as THREE.Material).dispose() }
    }
    beacons = []
  }
  const sameBeacons = (items: { id: string; x: number; y: number; z: number; style: string; on: boolean }[]) =>
    items.length === beacons.length && items.every((it, i) => beacons[i].x === it.x && beacons[i].y === it.y && beacons[i].z === it.z && beacons[i].style === it.style && beacons[i].on === it.on)

  return {
    group,
    spawn(kind, x, y, z) {
      const list = F.kinds[kind]
      if (!list) return
      for (const e of list) {
        if (e.type === 'burst') burst(e, x, y, z)
        else if (e.type === 'icon') {
          const mat = new THREE.MeshBasicMaterial({ map: iconTexture(e), transparent: true, alphaTest: 0.4, depthTest: false, depthWrite: false })
          const m = new THREE.Mesh(iconGeo, mat)
          m.renderOrder = 40
          m.position.set(x, y + e.y * bodyScale, z)
          group.add(m)
          live.push({ obj: m, t: 0, dur: e.life, kind: 'icon', e, base: m.position.clone() })
        } else if (e.type === 'ring') {
          const m = new THREE.Mesh(ringGeo, glowMat(srgb(e.color).multiplyScalar(e.intensity), false))
          m.position.set(x, y + e.y, z)
          m.renderOrder = 25
          group.add(m)
          live.push({ obj: m, t: 0, dur: e.life, kind: 'ring', e, base: m.position.clone() })
        } else if (e.type === 'column') {
          const m = new THREE.Mesh(colGeo, glowMat(srgb(e.color).multiplyScalar(e.intensity), true))
          m.position.set(x, y, z)
          m.renderOrder = 25
          group.add(m)
          live.push({ obj: m, t: 0, dur: e.life, kind: 'column', e, base: m.position.clone() })
        }
      }
    },
    setGroundItems(items) {
      if (orbs) { group.remove(orbs); orbs.dispose(); orbs = null }
      orbItems = items.map((it, i) => ({ x: it.x, y: it.y, z: it.z, phase: i * 1.7 }))
      orbGlow.visible = items.length > 0
      if (!items.length) return
      orbs = new THREE.InstancedMesh(orbGeo, orbMat, items.length)
      orbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      orbs.frustumCulled = false
      group.add(orbs)
      const p = new Float32Array(items.length * 3), ph = new Float32Array(items.length)
      orbItems.forEach((o, i) => { p.set([o.x, o.y + G.height, o.z], i * 3); ph[i] = o.phase })
      orbGlowGeo.setAttribute('position', new THREE.BufferAttribute(p, 3))
      orbGlowGeo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1))
    },
    setBeacons(items) {
      if (sameBeacons(items)) return
      dropBeacons()
      items.forEach((it, i) => {
        const st = B[it.style]
        if (!st) return
        const ring = new THREE.Mesh(ringGeo, glowMat(srgb(st.color).multiplyScalar(it.on ? st.ring.intensity : st.ring.dormantIntensity), false))
        ring.scale.set(st.ring.radius, 1, st.ring.radius)
        ring.position.set(it.x, it.y + st.ring.y, it.z)
        ring.renderOrder = 24
        ring.frustumCulled = false
        group.add(ring)
        let col: THREE.Mesh | null = null
        let core: THREE.Mesh | null = null
        if (it.on) {
          core = new THREE.Mesh(coreGeo, coreMat(srgb(st.color).multiplyScalar(st.core.intensity)))
          core.scale.setScalar(st.core.size)
          core.position.set(it.x, it.y + st.core.y, it.z)
          core.renderOrder = 26
          core.frustumCulled = false
          group.add(core)
          col = new THREE.Mesh(colGeo, glowMat(srgb(st.color).multiplyScalar(st.column.intensity), true))
          col.scale.set(st.column.radius, st.column.height, st.column.radius)
          col.position.set(it.x, it.y + st.column.from, it.z)
          col.renderOrder = 24
          col.frustumCulled = false
          group.add(col)
        }
        beacons.push({ x: it.x, y: it.y, z: it.z, style: it.style, on: it.on, phase: i * 2.3, idle: (i * 0.37) % 1, ring, col, core })
      })
    },
    update(dt, time, camera, pxScale) {
      bodyScale = billboardAnchorScale(cameraPitch(camera), RENDER.camera.billboard)
      for (const b of beacons) {
        const st = B[b.style]
        const k = (hz: number, amp: number) => 1 + amp * Math.sin((time * hz + b.phase) * Math.PI * 2)
        ;(b.ring.material as THREE.ShaderMaterial).uniforms.uAlpha.value = b.on ? k(st.ring.pulseHz, st.ring.pulseAmp) : 1
        if (b.col) (b.col.material as THREE.ShaderMaterial).uniforms.uAlpha.value = k(st.column.pulseHz, st.column.pulseAmp)
        if (b.core) {
          const pulse = k(st.core.pulseHz, st.core.pulseAmp)
          b.core.quaternion.copy(camera.quaternion)
          b.core.scale.setScalar(st.core.size * (0.9 + 0.1 * pulse))
          ;(b.core.material as THREE.ShaderMaterial).uniforms.uAlpha.value = pulse
        }
        if (b.on) {
          b.idle -= dt
          if (b.idle <= 0) { b.idle = st.idle.everySec * (0.7 + 0.6 * Math.random()); burst(st.idle.burst, b.x, b.y, b.z) }
        }
      }
      // particles
      let any = false
      for (let k = 0; k < N; k++) {
        if (life[k] <= 0) { if (alpha[k] !== 0) { alpha[k] = 0; any = true } continue }
        any = true
        life[k] -= dt
        const d = Math.exp(-drag[k] * dt)
        vel[k * 3] *= d; vel[k * 3 + 2] *= d
        vel[k * 3 + 1] = vel[k * 3 + 1] * d - grav[k] * dt
        pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt
        const f = Math.max(0, life[k] / maxLife[k])
        alpha[k] = life[k] > 0 ? Math.min(1, f * 2) : 0
      }
      if (any) for (const name of ['position', 'aColor', 'aSize', 'aAlpha', 'aShape']) (pGeo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true
      // icons / rings / columns
      for (let i = live.length - 1; i >= 0; i--) {
        const l = live[i]
        l.t += dt
        const k = Math.min(1, l.t / l.dur)
        if (l.kind === 'icon') {
          const e = l.e as FxIcon
          const pop = l.t < e.pop ? 0.4 + 0.9 * (l.t / e.pop) : 1.3 - 0.3 * Math.min(1, (l.t - e.pop) / e.pop)
          l.obj.scale.setScalar(e.size * pop)
          l.obj.position.copy(l.base).y += e.rise * bodyScale * Math.min(1, l.t / (e.pop * 2))
          l.obj.quaternion.copy(camera.quaternion)
          ;(l.obj.material as THREE.MeshBasicMaterial).opacity = k > 0.8 ? (1 - k) / 0.2 : 1
        } else if (l.kind === 'ring') {
          const e = l.e as FxRing
          const r = e.radius[0] + (e.radius[1] - e.radius[0]) * (1 - (1 - k) * (1 - k))
          l.obj.scale.set(r, 1, r)
          ;(l.obj.material as THREE.ShaderMaterial).uniforms.uAlpha.value = 1 - k
        } else {
          const e = l.e as FxColumn
          l.obj.scale.set(e.radius * (1 - k * 0.6), e.height * (0.4 + k * 0.6), e.radius * (1 - k * 0.6))
          ;(l.obj.material as THREE.ShaderMaterial).uniforms.uAlpha.value = (1 - k) * Math.min(1, l.t * 8)
        }
        if (l.t >= l.dur) {
          group.remove(l.obj)
          ;(l.obj.material as THREE.Material).dispose()
          live.splice(i, 1)
        }
      }
      // ground item orbs bob
      if (orbs) {
        orbItems.forEach((o, i) => {
          _m.makeTranslation(o.x, o.y + G.height + Math.sin(time * G.bobHz * Math.PI * 2 + o.phase) * G.bobAmp, o.z)
          orbs!.setMatrixAt(i, _m)
        })
        orbs.instanceMatrix.needsUpdate = true
        orbGlowMat.uniforms.uScale.value = pxScale
        orbGlowMat.uniforms.uTime.value = time
      }
    },
    dispose() {
      for (const l of live) { group.remove(l.obj); (l.obj.material as THREE.Material).dispose() }
      live.length = 0
      dropBeacons()
      pGeo.dispose(); pMat.dispose(); iconGeo.dispose(); ringGeo.dispose(); colGeo.dispose(); coreGeo.dispose()
      for (const t of iconTex.values()) t.dispose()
      orbs?.dispose(); orbGeo.dispose(); orbMat.dispose(); orbGlowGeo.dispose(); orbGlowMat.dispose()
    },
  }
}
