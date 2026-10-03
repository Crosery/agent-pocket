// Billboarded pixel characters (4-direction walk sheets) and creatures (single image) in the overworld.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { Dir } from '../../../shared/types.ts'
import type { Actor, ActorOptions, AssetStore, CreatureActor } from '../../contracts.ts'
import { RENDER, hexToRgb } from '../config.ts'
import {
  createBillboardGeometry, createBlobShadow, createSpriteMaterial, setGeometryFrame, sheetLayout, spriteDepthMaterial,
} from '../sprite-utils.ts'
import type { OverlayLayer, OverlayTag } from './overlay.ts'

/** What the world view needs from every live actor each frame. */
export interface ActorEntry {
  readonly object: THREE.Object3D
  readonly tag: OverlayTag
  /** World position of the name-tag anchor (above the head). */
  head(out: THREE.Vector3): THREE.Vector3
  /** Grass bend radius (world units) or 0. */
  readonly bendRadius: number
  isVisible(): boolean
}

export interface ActorContext {
  assets: AssetStore
  root: THREE.Object3D
  overlay: OverlayLayer
  registry: Set<ActorEntry>
  /** Cylindrical billboard yaw (shared, updated by the world view). */
  yaw: { value: number }
  inGrassAt(x: number, y: number): boolean
}

export function createActorImpl(ctx: ActorContext, opts: ActorOptions): Actor {
  const A = RENDER.actors
  const layout = sheetLayout()
  const geo = createBillboardGeometry(A.width, A.height, A.normalTilt)
  const sprite = createSpriteMaterial(ctx.assets.characterTexture(opts.sheet), { alphaTest: A.alphaTest, opacity: opts.kind === 'remote' ? A.remoteAlpha : 1, billboard: RENDER.camera.billboard })
  const mesh = new THREE.Mesh(geo, sprite.material)
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.customDepthMaterial = spriteDepthMaterial()
  mesh.name = `actor:${opts.sheet}`
  const blob = createBlobShadow(A.blob.size, A.blob.opacity)
  const object = new THREE.Group()
  object.add(mesh, blob)
  ctx.root.add(object)
  const tag = ctx.overlay.createTag()
  tag.setName(opts.name ?? null, opts.nameColor ?? A.nameColor)

  let facing: Dir = 'down'
  let moving = false, running = false, visible = true, grassManual = false
  let frameT = 0, frame = 0, hopT = -1, landT = -1
  // per-actor phase so a crowd never breathes in sync
  let lifeT = (opts.sheet.length * 0.37 + (opts.name?.length ?? 0) * 0.61) % 3
  let lastFrame = -1, lastRow = -1
  let lastX = Number.NaN, lastY = 0, wasMoving = false, lastContact = 3

  const applyFrame = () => {
    const row = layout.rowOf[facing] ?? 0
    if (frame === lastFrame && row === lastRow) return
    setGeometryFrame(geo, frame, row, layout.cols, layout.rows)
    lastFrame = frame
    lastRow = row
  }
  applyFrame()

  const actor: Actor = {
    object,
    x: 0, y: 0, elev: 0,
    get facing() { return facing },
    set facing(d: Dir) { actor.setFacing(d) },
    setPosition(x, y, elev) {
      actor.x = x; actor.y = y; actor.elev = elev
      object.position.set(x, elev, y)
    },
    setFacing(d) { facing = d; applyFrame() },
    setMoving(m, r) { moving = m; running = r },
    setName(text, color) { tag.setName(text, color ?? opts.nameColor ?? A.nameColor) },
    setSheet(sheet) { sprite.setMap(ctx.assets.characterTexture(sheet)) },
    setVisible(v) { visible = v; object.visible = v },
    setInGrass(v) { grassManual = v },
    bubble(text, ms) { tag.bubble(text, ms ?? A.bubbleMs) },
    hop() { hopT = 0 },
    update(dt) {
      lifeT += dt
      // sheet frames: even = legs together (0 doubles as idle), odd = contact. The phase follows the distance
      // covered so feet don't slide; each walk starts mid contact frame, leading with the other foot than last time.
      const W = A.walkCycle
      const travelled = Number.isNaN(lastX) ? 0 : Math.hypot(actor.x - lastX, actor.y - lastY)
      lastX = actor.x
      lastY = actor.y
      if (moving) {
        if (!wasMoving) frameT = (lastContact === 1 ? 3 : 1) + 0.5
        const advance = travelled > 0 && travelled < W.teleportTiles
          ? travelled * 2 / (running ? W.stride.run : W.stride.walk)
          : dt * (running ? A.runFps : A.walkFps)
        frameT += Math.min(advance, dt * W.maxFps)
        frame = Math.floor(frameT) % layout.cols
        if (frame % 2 === 1) lastContact = frame
      } else { frameT = 0; frame = 0 }
      wasMoving = moving
      applyFrame()
      let lift = 0
      if (hopT >= 0) {
        hopT += dt / (A.hop.ms / 1000)
        if (hopT >= 1) { hopT = -1; landT = 0 }
        else lift = 4 * A.hop.height * hopT * (1 - hopT)
      }
      // chibi motion: a soft bounce on every step, idle breathing, a squash when landing from a hop
      const M = A.motion
      let sy = 1
      if (moving) {
        const stepFrames = layout.cols / Math.max(1, M.stepsPerCycle)
        // peaks mid legs-together frame, 0 mid contact frame (the planted foot stays on the ground)
        const step = Math.abs(Math.cos((frameT - 0.5) * Math.PI / stepFrames))
        lift += step * M.stepBounce * (running ? M.runBounceMul : 1)
        sy += (step - 0.5) * M.stepSquash
      } else sy += Math.sin(lifeT * M.breatheHz * Math.PI * 2) * M.breathe
      if (landT >= 0) {
        landT += dt / (M.landMs / 1000)
        if (landT >= 1) landT = -1
        else sy -= Math.sin(landT * Math.PI) * M.landSquash
      }
      mesh.scale.set(1 / Math.sqrt(sy), sy, 1)
      mesh.position.y = lift
      mesh.rotation.y = ctx.yaw.value
      blob.scale.setScalar(1 - Math.min(0.5, lift))
      const inGrass = grassManual || (lift < 0.05 && ctx.inGrassAt(actor.x, actor.y))
      sprite.uniforms.uCutY.value = inGrass ? A.grassCut * A.height : -1e6
      tag.update(dt)
    },
    dispose() {
      ctx.registry.delete(entry)
      object.removeFromParent()
      geo.dispose()
      sprite.dispose()
      blob.geometry.dispose()
      ;(blob.material as THREE.Material).dispose()
      tag.dispose()
    },
  }
  const entry: ActorEntry = {
    object, tag,
    head(out) { return out.set(actor.x, actor.elev + mesh.position.y + A.height, actor.y) },
    bendRadius: 1,
    isVisible: () => visible,
  }
  ctx.registry.add(entry)
  return actor
}

export function createCreatureActorImpl(ctx: ActorContext, speciesId: string, shiny: boolean): CreatureActor {
  const A = RENDER.actors, C = RENDER.creatures
  const species = CONTENT.species[speciesId]
  const h = (species?.size ?? 1) * A.height * C.height
  const geo = createBillboardGeometry(h, h, A.normalTilt)
  const sprite = createSpriteMaterial(ctx.assets.creatureTexture(speciesId), { alphaTest: C.alphaTest, billboard: RENDER.camera.billboard })
  const mesh = new THREE.Mesh(geo, sprite.material)
  mesh.castShadow = true
  mesh.customDepthMaterial = spriteDepthMaterial()
  mesh.name = `creature:${speciesId}`
  const blob = createBlobShadow(A.blob.size * Math.max(0.6, h / A.height), A.blob.opacity)
  const object = new THREE.Group()
  const body = new THREE.Group()
  body.add(mesh)
  object.add(body, blob)
  ctx.root.add(object)
  const tag = ctx.overlay.createTag()

  // shiny sparkles: a few twinkling points around the body
  const sparkleGeo = new THREE.BufferGeometry()
  const sp = new Float32Array(C.shiny.sparkles * 3), spPhase = new Float32Array(C.shiny.sparkles)
  for (let i = 0; i < C.shiny.sparkles; i++) {
    const a = (i / C.shiny.sparkles) * Math.PI * 2
    sp.set([Math.cos(a) * h * 0.45, h * (0.2 + 0.7 * ((i * 0.618) % 1)), Math.sin(a) * h * 0.2], i * 3)
    spPhase[i] = i * 2.399
  }
  sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3))
  sparkleGeo.setAttribute('aPhase', new THREE.BufferAttribute(spPhase, 1))
  const sparkleColor = new THREE.Color().setRGB(...hexToRgb(C.shiny.sparkleColor), THREE.SRGBColorSpace).multiplyScalar(C.shiny.sparkleGlow)
  const sparkleMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: sparkleColor }, uSize: { value: C.shiny.sparkleSize }, uSpeed: { value: C.shiny.twinkleSpeed } },
    vertexShader: /* glsl */`
uniform float uTime, uSize, uSpeed;
attribute float aPhase;
varying float vA;
void main() {
  vA = max(0.0, sin(uTime * uSpeed + aPhase));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = vA > 0.0 ? uSize : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uColor;
varying float vA;
void main() { vec2 p = abs(gl_PointCoord - 0.5); if (min(p.x, p.y) > 0.08 && length(p) > 0.16) discard; gl_FragColor = vec4(uColor * vA, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const sparkles = new THREE.Points(sparkleGeo, sparkleMat)
  sparkles.frustumCulled = false
  body.add(sparkles)

  // rarity aura: pulsing ground ring + rising motes
  const ringGeo = new THREE.RingGeometry(C.aura.radius * C.aura.ringInner, C.aura.radius, 24, 1)
  ringGeo.rotateX(-Math.PI / 2)
  const auraColor = new THREE.Color()
  const ringMat = new THREE.MeshBasicMaterial({ color: auraColor, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.position.y = 0.03
  const moteGeo = new THREE.BufferGeometry()
  const mp = new Float32Array(C.aura.motes * 3), mph = new Float32Array(C.aura.motes)
  for (let i = 0; i < C.aura.motes; i++) {
    const a = i * 2.399
    mp.set([Math.cos(a) * C.aura.radius * 0.8, 0, Math.sin(a) * C.aura.radius * 0.8], i * 3)
    mph[i] = (i * 0.37) % 1
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3))
  moteGeo.setAttribute('aPhase', new THREE.BufferAttribute(mph, 1))
  const moteMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: auraColor }, uH: { value: C.aura.moteHeight }, uI: { value: C.aura.intensity }, uSpeed: { value: C.aura.moteSpeed }, uSize: { value: C.aura.moteSize } },
    vertexShader: /* glsl */`
uniform float uTime, uH, uSpeed, uSize;
attribute float aPhase;
varying float vA;
void main() {
  float t = fract(uTime * uSpeed + aPhase);
  vec3 p = position;
  p.y += t * uH;
  vA = sin(t * 3.14159);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: 'uniform vec3 uColor; uniform float uI; varying float vA; void main(){ gl_FragColor = vec4(uColor * uI * vA, 1.0); }',
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.frustumCulled = false
  const aura = new THREE.Group()
  aura.add(ring, motes)
  aura.visible = false
  object.add(aura)

  let t = Math.random() * 10
  let moving = false, visible = true, facingLeft = true

  const flip = () => setGeometryFrame(geo, 0, 0, 1, 1, facingLeft !== C.artFacesLeft)
  flip()

  const actor: CreatureActor = {
    object,
    x: 0, y: 0, elev: 0,
    speciesId,
    setPosition(x, y, elev) {
      actor.x = x; actor.y = y; actor.elev = elev
      object.position.set(x, elev, y)
    },
    setFacingLeft(left) { if (left !== facingLeft) { facingLeft = left; flip() } },
    setMoving(m) { moving = m },
    setVisible(v) { visible = v; object.visible = v },
    setShiny(s) {
      sprite.uniforms.uHue.value = s ? C.shiny.hue : 0
      sprite.uniforms.uSaturation.value = s ? C.shiny.saturation : 1
      sparkles.visible = s
    },
    setAura(color) {
      aura.visible = !!color
      if (color) auraColor.setRGB(...hexToRgb(color), THREE.SRGBColorSpace)
    },
    bubble(text, ms) { tag.bubble(text, ms ?? A.bubbleMs) },
    update(dt) {
      t += dt
      const B = C.bob
      let lift = Math.sin(t * B.hz * Math.PI * 2) * B.amp + B.amp
      let sy = 1 + Math.sin(t * B.hz * Math.PI * 2) * B.squash
      if (moving) {
        const ph = Math.abs(Math.sin(t * C.move.hz * Math.PI))
        lift = ph * C.move.hopHeight
        sy = 1 + (ph - 0.5) * B.squash * 2
      }
      body.position.y = lift
      mesh.scale.set(1 / Math.sqrt(sy), sy, 1)
      mesh.rotation.y = ctx.yaw.value
      sparkles.rotation.y = ctx.yaw.value
      blob.scale.setScalar(1 - Math.min(0.4, lift))
      const pulse = 0.65 + 0.35 * Math.sin(t * C.aura.pulseHz * Math.PI * 2)
      ringMat.color.copy(auraColor).multiplyScalar(C.aura.intensity * pulse)
      ring.scale.setScalar(0.9 + 0.1 * pulse)
      sparkleMat.uniforms.uTime.value = t
      moteMat.uniforms.uTime.value = t
      sprite.uniforms.uCutY.value = !moving && ctx.inGrassAt(actor.x, actor.y) ? A.grassCut * h : -1e6
      tag.update(dt)
    },
    dispose() {
      ctx.registry.delete(entry)
      object.removeFromParent()
      geo.dispose(); sprite.dispose()
      blob.geometry.dispose(); (blob.material as THREE.Material).dispose()
      sparkleGeo.dispose(); sparkleMat.dispose()
      ringGeo.dispose(); ringMat.dispose(); moteGeo.dispose(); moteMat.dispose()
      tag.dispose()
    },
  }
  actor.setShiny(shiny)
  const entry: ActorEntry = {
    object, tag,
    head(out) { return out.set(actor.x, actor.elev + body.position.y + h, actor.y) },
    bendRadius: Math.max(0.5, h / A.height),
    isVisible: () => visible,
  }
  ctx.registry.add(entry)
  return actor
}
