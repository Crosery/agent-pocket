// CPU-simulated VFX particle pools (one additive HDR pool that blooms, one alpha-blended pool for smoke, debris
// and dark effects). Shapes: the renderer's particle shapes plus pixel squares and text glyphs from an atlas.
// Streak shapes align with their screen-space velocity.
import * as THREE from 'three'
import { createCanvas } from '../sprite-utils.ts'
import { VFX_SHAPES, type VfxShape } from './config.ts'

export interface ParticleSpawn {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  life: number
  size: number
  /** Size multiplier reached at the end of life. */
  grow: number
  color: THREE.Color
  color1: THREE.Color
  alpha: number
  shape: VfxShape
  glyph: number
  gravity: number
  drag: number
  /** Angular speed (rad/s) around the vertical axis through (cx, cz). */
  orbit: number
  cx: number
  cz: number
  spin: number
}

export interface ParticlePool {
  readonly points: THREE.Points
  spawn(p: ParticleSpawn): void
  update(dt: number, camera: THREE.Camera, pxPerUnit: number): void
  clear(): void
  dispose(): void
}

export interface GlyphAtlas {
  readonly texture: THREE.Texture
  readonly grid: number
  index(ch: string): number
  dispose(): void
}

/** Atlas of every glyph used by the timelines, drawn white so particles tint it. */
export function createGlyphAtlas(chars: string, font: string, cell: number): GlyphAtlas {
  const list = [...new Set([...chars])]
  const grid = Math.max(1, Math.ceil(Math.sqrt(list.length)))
  const c = createCanvas(grid * cell, grid * cell)
  const g = c.getContext('2d')!
  g.font = font
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#ffffff'
  list.forEach((ch, i) => g.fillText(ch, (i % grid) * cell + cell / 2, Math.floor(i / grid) * cell + cell / 2 + 1))
  const texture = new THREE.CanvasTexture(c)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  const idx = new Map(list.map((ch, i) => [ch, i]))
  return {
    texture, grid,
    index(ch) { return idx.get(ch) ?? 0 },
    dispose() { texture.dispose() },
  }
}

const SHAPE_ID = (s: VfxShape) => Math.max(0, VFX_SHAPES.indexOf(s))
const STREAK = SHAPE_ID('streak'), HSTREAK = SHAPE_ID('hstreak')

/** `fade`: fade in / out as shares of each particle's life. */
export function createParticlePool(capacity: number, additive: boolean, atlas: GlyphAtlas, fade: { fadeIn: number; fadeOut: number }): ParticlePool {
  const N = Math.max(16, Math.floor(capacity))
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N)
  const shape = new Float32Array(N), rot = new Float32Array(N), glyph = new Float32Array(N)
  const vel = new Float32Array(N * 3), life = new Float32Array(N), maxLife = new Float32Array(N)
  const c0 = new Float32Array(N * 3), c1 = new Float32Array(N * 3), s0 = new Float32Array(N), grow = new Float32Array(N), a0 = new Float32Array(N)
  const grav = new Float32Array(N), drag = new Float32Array(N), orbit = new Float32Array(N), ctr = new Float32Array(N * 2), spin = new Float32Array(N)
  let cursor = 0
  let live = 0

  const geo = new THREE.BufferGeometry()
  const attr = (a: Float32Array, n: number) => { const b = new THREE.BufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b }
  geo.setAttribute('position', attr(pos, 3))
  geo.setAttribute('aColor', attr(col, 3))
  geo.setAttribute('aSize', attr(size, 1))
  geo.setAttribute('aAlpha', attr(alpha, 1))
  geo.setAttribute('aShape', attr(shape, 1))
  geo.setAttribute('aRot', attr(rot, 1))
  geo.setAttribute('aGlyph', attr(glyph, 1))
  const id = (s: VfxShape) => SHAPE_ID(s)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 300 }, uAtlas: { value: atlas.texture }, uGrid: { value: atlas.grid } },
    vertexShader: /* glsl */`
uniform float uScale;
attribute vec3 aColor;
attribute float aSize, aAlpha, aShape, aRot, aGlyph;
varying vec3 vColor;
varying float vAlpha, vShape, vRot, vGlyph;
void main() {
  vColor = aColor; vAlpha = aAlpha; vShape = aShape; vRot = aRot; vGlyph = aGlyph;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aAlpha > 0.0 ? max(1.0, aSize * uScale / max(0.1, -mv.z)) : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform sampler2D uAtlas;
uniform float uGrid;
varying vec3 vColor;
varying float vAlpha, vShape, vRot, vGlyph;
void main() {
  vec2 pc = gl_PointCoord;
  vec2 p = pc - 0.5;
  p.y = -p.y;
  float c = cos(vRot), s = sin(vRot);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  float r = length(p);
  float a = 1.0;
  int sh = int(vShape + 0.5);
  if (sh == ${id('dot')}) { if (r > 0.5) discard; }
  else if (sh == ${id('streak')} || sh == ${id('hstreak')}) { if (abs(q.y) > 0.07 || abs(q.x) > 0.5) discard; a = smoothstep(-0.5, 0.45, q.x); }
  else if (sh == ${id('ring')}) { if (abs(r - 0.36) > 0.1) discard; }
  else if (sh == ${id('soft')}) { if (r > 0.5) discard; a = (1.0 - r * 2.0); a *= a; }
  else if (sh == ${id('leaf')}) { if (abs(q.x) * 2.2 + abs(q.y) > 0.45) discard; }
  else if (sh == ${id('star')}) { float cr = min(abs(q.x), abs(q.y)); if (cr > 0.07 && r > 0.14) discard; a = 1.0 - r * 1.4; }
  else if (sh == ${id('square')}) { if (max(abs(q.x), abs(q.y)) > 0.42) discard; }
  else {
    float g = vGlyph;
    vec2 cell = vec2(mod(g, uGrid), floor(g / uGrid));
    vec2 uv = vec2((cell.x + pc.x) / uGrid, 1.0 - (cell.y + pc.y) / uGrid);
    a = texture2D(uAtlas, uv).a;
    if (a < 0.4) discard;
  }
  gl_FragColor = vec4(vColor, vAlpha * a);
}`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = additive ? 32 : 31
  points.name = additive ? 'vfx-add' : 'vfx-alpha'

  const _v = new THREE.Vector3()
  const _r = new THREE.Vector3()
  const _u = new THREE.Vector3()
  const _c = new THREE.Color()

  return {
    points,
    spawn(p) {
      const k = cursor
      cursor = (cursor + 1) % N
      if (life[k] <= 0) live++
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z
      vel[k * 3] = p.vx; vel[k * 3 + 1] = p.vy; vel[k * 3 + 2] = p.vz
      maxLife[k] = life[k] = Math.max(0.01, p.life)
      s0[k] = p.size
      grow[k] = p.grow
      c0.set([p.color.r, p.color.g, p.color.b], k * 3)
      c1.set([p.color1.r, p.color1.g, p.color1.b], k * 3)
      a0[k] = p.alpha
      shape[k] = SHAPE_ID(p.shape)
      glyph[k] = p.glyph
      grav[k] = p.gravity
      drag[k] = p.drag
      orbit[k] = p.orbit
      ctr[k * 2] = p.cx; ctr[k * 2 + 1] = p.cz
      spin[k] = p.spin
      rot[k] = Math.random() * Math.PI * 2
    },
    update(dt, camera, pxPerUnit) {
      mat.uniforms.uScale.value = pxPerUnit
      if (live <= 0) { points.visible = false; return }
      points.visible = true
      _r.setFromMatrixColumn(camera.matrixWorld, 0)
      _u.setFromMatrixColumn(camera.matrixWorld, 1)
      let alive = 0
      for (let k = 0; k < N; k++) {
        if (life[k] <= 0) { alpha[k] = 0; continue }
        life[k] -= dt
        if (life[k] <= 0) { alpha[k] = 0; continue }
        alive++
        const d = Math.exp(-drag[k] * dt)
        const i3 = k * 3
        vel[i3] *= d; vel[i3 + 2] *= d
        vel[i3 + 1] = vel[i3 + 1] * d - grav[k] * dt
        let x = pos[i3] + vel[i3] * dt, z = pos[i3 + 2] + vel[i3 + 2] * dt
        if (orbit[k] !== 0) {
          const a = orbit[k] * dt, cx = ctr[k * 2], cz = ctr[k * 2 + 1]
          const dx = x - cx, dz = z - cz, ca = Math.cos(a), sa = Math.sin(a)
          x = cx + dx * ca - dz * sa
          z = cz + dx * sa + dz * ca
        }
        pos[i3] = x; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] = z
        const f = 1 - life[k] / maxLife[k]
        _c.setRGB(c0[i3] + (c1[i3] - c0[i3]) * f, c0[i3 + 1] + (c1[i3 + 1] - c0[i3 + 1]) * f, c0[i3 + 2] + (c1[i3 + 2] - c0[i3 + 2]) * f)
        col[i3] = _c.r; col[i3 + 1] = _c.g; col[i3 + 2] = _c.b
        size[k] = s0[k] * (1 + (grow[k] - 1) * f)
        alpha[k] = a0[k] * Math.min(1, f / fade.fadeIn) * Math.min(1, (1 - f) / fade.fadeOut)
        if (shape[k] === STREAK || shape[k] === HSTREAK) {
          _v.set(vel[i3], vel[i3 + 1], vel[i3 + 2])
          rot[k] = Math.atan2(_v.dot(_u), _v.dot(_r))
        } else rot[k] += spin[k] * dt
      }
      live = alive
      for (const name of ['position', 'aColor', 'aSize', 'aAlpha', 'aShape', 'aRot', 'aGlyph']) (geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true
    },
    clear() {
      life.fill(0)
      alpha.fill(0)
      live = 0
      ;(geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true
    },
    dispose() { geo.dispose(); mat.dispose() },
  }
}
