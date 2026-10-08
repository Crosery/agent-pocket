// Billboarded pixel characters (4-direction walk sheets) and creatures (single image) in the overworld.
import * as THREE from 'three'
import { CONTENT } from '../../../shared/content/index.ts'
import type { Dir } from '../../../shared/types.ts'
import type { Actor, ActorOptions, AssetStore, CreatureActor } from '../../contracts.ts'
import { RENDER, hexToRgb } from '../config.ts'
import { createCharacterAnimation } from '../character-animation.ts'
import {
  billboardPointToWorld, createBillboardGeometry, createBlobShadow, createSpriteMaterial, setGeometryFrame, sheetLayout, spriteDepthMaterial, spriteOpaqueTop,
  type SpriteMaterial,
} from '../sprite-utils.ts'
import { applyOcclusion } from './occlusion.ts'
import { attachMirror, type Mirror } from './reflections.ts'
import type { OverlayLayer, OverlayTag } from './overlay.ts'

/** What the world view needs from every live actor each frame. */
export interface ActorEntry {
  readonly object: THREE.Object3D
  readonly tag: OverlayTag
  /** World position of the name-tag anchor (above the head). */
  head(out: THREE.Vector3, pitch?: number): THREE.Vector3
  /** Grass bend radius (world units) or 0. */
  readonly bendRadius: number
  /** Footstep feedback (footsteps.ts): characters step by walked distance, creatures hop; size multiplier of the marks. */
  readonly stepKind: 'foot' | 'hop'
  readonly stepScale: number
  /** Reflection card in water (reflections.ts). */
  readonly mirror: Mirror
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

/** Same-row tie-break against other sprites (render.json actors.renderOrder / depthBias). */
function layer(mesh: THREE.Mesh, sprite: SpriteMaterial, kind: keyof typeof RENDER.actors.renderOrder): void {
  mesh.renderOrder = RENDER.actors.renderOrder[kind]
  sprite.uniforms.uDepthBias.value = RENDER.actors.depthBias[kind]
}

/** Rounds a scale factor to whole texels of a `texels`-tall image (nearest-sampled pixel art never shimmers). */
function snapScale(s: number, texels: number): number {
  return 1 + Math.round((s - 1) * texels) / texels
}

/** Moves `v` toward `to` by at most `step`. */
function approach(v: number, to: number, step: number): number {
  return v < to ? Math.min(to, v + step) : Math.max(to, v - step)
}

/** Grass cut (local card units above the pivot) for a body lifted `lift` above the ground, scaled by `sy`. */
function cutUniform(cutH: number, lift: number, sy: number): number {
  const c = (cutH - lift) / Math.max(sy, 1e-3)
  return c > 1e-4 ? c : -1e6
}

export function createActorImpl(ctx: ActorContext, opts: ActorOptions): Actor {
  const A = RENDER.actors
  let layout = sheetLayout()
  const cell = CONTENT.config.sprites.sheetCell
  const geo = createBillboardGeometry(A.width, A.height, A.normalTilt, (A.footInset * A.height) / cell, A.cardSegments)
  const sprite = createSpriteMaterial(ctx.assets.characterTexture(opts.sheet), { alphaTest: A.alphaTest, opacity: opts.kind === 'remote' ? A.remoteAlpha : 1, billboard: RENDER.camera.billboard })
  const mesh = new THREE.Mesh(geo, sprite.material)
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.customDepthMaterial = spriteDepthMaterial()
  mesh.name = `actor:${opts.sheet}`
  layer(mesh, sprite, opts.kind)
  const blob = createBlobShadow(A.blob.size, A.blob.opacity)
  const object = new THREE.Group()
  object.add(mesh, blob)
  ctx.root.add(object)
  const mirror = attachMirror(mesh, object, sprite.material, { w: A.width, h: A.height }, A.alphaTest)
  const tag = ctx.overlay.createTag()
  tag.setName(opts.name ?? null, opts.nameColor ?? A.nameColor)

  let facing: Dir = 'down'
  let moving = false, running = false, visible = true, grassManual = false
  const animation = () => createCharacterAnimation(layout.walkFrames, layout.walkStart, {
    frames: layout.idleFrames, fps: CONTENT.config.sprites.idleFps, settleMs: CONTENT.config.sprites.idleSettleMs,
    phase: (mesh.id * 0.618 + opts.sheet.length * 0.37) % layout.idleFrames,
  })
  let gait = animation()
  let frame = 0, hopT = -1, landT = -1, hopMs = A.hop.ms, hopHeight = A.hop.height, cutH = 0
  // per-actor phase so a crowd never breathes in sync
  let lifeT = (opts.sheet.length * 0.37 + (opts.name?.length ?? 0) * 0.61) % 3
  let lastFrame = -1, lastRow = -1
  let lastX = Number.NaN, lastY = 0

  const applyFrame = () => {
    const next = sheetLayout(CONTENT, sprite.material.map)
    if (next.cols !== layout.cols) {
      layout = next
      gait = animation()
      frame = 0
      lastFrame = -1
    }
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
    setFacing(d) {
      if (facing !== d && !moving) { gait.reset(); frame = 0 }
      facing = d
      applyFrame()
    },
    setMoving(m, r) {
      moving = m; running = r
      if (!m) { gait.update(0, false, 0); frame = gait.frame; applyFrame() }
    },
    setName(text, color) { tag.setName(text, color ?? opts.nameColor ?? A.nameColor) },
    setSheet(sheet) { sprite.setMap(ctx.assets.characterTexture(sheet)); gait.reset(); frame = 0; lastFrame = -1; applyFrame() },
    setVisible(v) { visible = v; object.visible = v },
    setInGrass(v) { grassManual = v },
    bubble(text, ms) { tag.bubble(text, ms ?? A.bubbleMs) },
    hop(o) { hopT = 0; landT = -1; hopMs = o?.ms ?? A.hop.ms; hopHeight = o?.height ?? A.hop.height },
    update(dt) {
      lifeT += dt
      const W = A.walkCycle
      const travelled = Number.isNaN(lastX) ? 0 : Math.hypot(actor.x - lastX, actor.y - lastY)
      lastX = actor.x
      lastY = actor.y
      applyFrame()
      const rate = layout.walkFrames / CONTENT.config.sprites.sheetFrames
      gait.update(dt, moving, (running ? A.runFps : A.walkFps) * rate, travelled, running ? W.stride.run : W.stride.walk, W.teleportTiles, W.maxFps * rate)
      frame = gait.frame
      applyFrame()
      let lift = 0
      if (hopT >= 0) {
        hopT += dt / (hopMs / 1000)
        if (hopT >= 1) { hopT = -1; landT = 0 }
        else lift = 4 * hopHeight * hopT * (1 - hopT)
      }
      // Authored idle poses stay grounded; only legacy sheets use whole-card breathing.
      const M = A.motion
      let sy = 1
      if (moving) {
        const stepFrames = layout.walkFrames / Math.max(1, M.stepsPerCycle)
        // peaks mid legs-together frame, 0 mid contact frame (the planted foot stays on the ground)
        const step = Math.abs(Math.cos((gait.phase - 0.5) * Math.PI / stepFrames))
        lift += step * M.stepBounce * (running ? M.runBounceMul : 1)
        sy += (step - 0.5) * M.stepSquash
      } else if (layout.idleFrames === 1) sy += Math.sin(lifeT * M.breatheHz * Math.PI * 2) * M.breathe
      // stretch while rising / falling (none at the apex), then a damped spring on touch-down: squash, overshoot, settle
      if (hopT >= 0) sy += Math.abs(1 - 2 * hopT) * M.hopStretch
      if (landT >= 0) {
        landT += dt / (M.landMs / 1000)
        if (landT >= 1) landT = -1
        else sy -= Math.exp(-M.landDamp * landT) * Math.cos(landT * M.landCycles * Math.PI * 2) * M.landSquash
      }
      let sx = 1 / Math.sqrt(sy)
      if (M.snapTexels) { sy = snapScale(sy, cell); sx = snapScale(sx, cell) }
      mesh.scale.set(sx, sy, 1)
      mesh.position.y = lift
      mesh.rotation.y = ctx.yaw.value
      blob.scale.setScalar(1 - Math.min(0.5, lift))
      // tall grass: the cut sinks in / rises out over grassCutMs; a hop (also one the controller lifts) clears it
      const cutFull = A.grassCut * A.height
      const cutTo = grassManual || (hopT < 0 && ctx.inGrassAt(actor.x, actor.y)) ? cutFull : 0
      cutH = approach(cutH, cutTo, A.grassCutMs > 0 ? (dt * cutFull * 1000) / A.grassCutMs : Infinity)
      sprite.uniforms.uCutY.value = cutUniform(cutH, lift, sy)
      tag.update(dt)
    },
    dispose() {
      ctx.registry.delete(entry)
      object.removeFromParent()
      mirror.dispose()
      geo.dispose()
      sprite.dispose()
      blob.geometry.dispose()
      ;(blob.material as THREE.Material).dispose()
      tag.dispose()
    },
  }
  const entry: ActorEntry = {
    object, tag,
    head(out, pitch = 0) {
      const top = spriteOpaqueTop(sprite.material.map, frame, layout.rowOf[facing], layout.cols, layout.rows, A.alphaTest)
      out.set(0, A.height * (top - A.footInset / cell), 0)
      return billboardPointToWorld(out, mesh, pitch, RENDER.camera.billboard)
    },
    bendRadius: 1,
    stepKind: 'foot',
    stepScale: 1,
    mirror,
    isVisible: () => visible,
  }
  ctx.registry.add(entry)
  return actor
}

export function createCreatureActorImpl(ctx: ActorContext, speciesId: string, shiny: boolean): CreatureActor {
  const A = RENDER.actors, C = RENDER.creatures
  const species = CONTENT.species[speciesId]
  const h = (species?.size ?? 1) * A.height * C.height
  const geo = createBillboardGeometry(h, h, A.normalTilt, (C.footInset * h) / CONTENT.config.sprites.creatureSize, A.cardSegments)
  const sprite = createSpriteMaterial(ctx.assets.creatureTexture(speciesId), { alphaTest: C.alphaTest, billboard: RENDER.camera.billboard })
  // a creature between the camera and the player (the follower walking north of it) is screen-door thinned around
  // the player like occluding props, but keeps occlusionKeep of its coverage
  const occShape = { value: new THREE.Vector2(RENDER.occlusion.soft, C.occlusionKeep) }
  if (C.occlusionKeep < 1) {
    applyOcclusion(sprite.material)
    const compile = sprite.material.onBeforeCompile
    sprite.material.onBeforeCompile = (shader, renderer) => {
      compile.call(sprite.material, shader, renderer)
      shader.uniforms.uApOccShape = occShape
    }
  }
  const mesh = new THREE.Mesh(geo, sprite.material)
  mesh.castShadow = true
  mesh.customDepthMaterial = spriteDepthMaterial()
  mesh.name = `creature:${speciesId}`
  layer(mesh, sprite, 'creature')
  const blob = createBlobShadow(A.blob.size * Math.max(0.6, h / A.height), A.blob.opacity)
  const object = new THREE.Group()
  const body = new THREE.Group()
  body.add(mesh)
  object.add(body, blob)
  ctx.root.add(object)
  const mirror = attachMirror(mesh, object, sprite.material, { w: h, h }, C.alphaTest)
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
  let moving = false, visible = true, facingLeft = true, wantLeft = true, flipT = 0, started = false
  // hop gait: phase 0 = feet on the ground; advanced by distance travelled
  let hopPh = 0, hopHz = C.move.minHz, gait = 0, cutH = 0, lastX = Number.NaN, lastY = 0

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
    setFacingLeft(left) {
      wantLeft = left
      // before the first frame (spawn) the facing applies at once
      if (!started && left !== facingLeft) { facingLeft = left; flip() }
    },
    setMoving(m) { moving = m },
    setVisible(v) { visible = v; object.visible = v },
    setCompanion(on) {
      sprite.material.depthWrite = !on
      layer(mesh, sprite, on ? 'companion' : 'creature')
    },
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
      started = true
      if (wantLeft !== facingLeft) {
        flipT += dt * 1000
        if (flipT >= C.flipHoldMs) { facingLeft = wantLeft; flip(); flipT = 0 }
      } else flipT = 0
      const B = C.bob, M = C.move
      let travelled = Number.isNaN(lastX) ? 0 : Math.hypot(actor.x - lastX, actor.y - lastY)
      if (travelled >= A.walkCycle.teleportTiles) travelled = 0
      lastX = actor.x
      lastY = actor.y
      if (moving) {
        if (dt > 0) hopHz = Math.min(M.maxHz, Math.max(M.minHz, travelled / M.hopStride / dt))
        hopPh = (hopPh + hopHz * dt) % 1
      } else if (hopPh > 0) {
        // stopping finishes the hop in the air instead of dropping to the ground
        hopPh += hopHz * dt
        if (hopPh >= 1) hopPh = 0
      }
      gait = approach(gait, moving || hopPh > 0 ? 1 : 0, M.blendMs > 0 ? (dt * 1000) / M.blendMs : 1)
      const bob = Math.sin(t * B.hz * Math.PI * 2)
      const hopS = Math.sin(hopPh * Math.PI)
      const lift = (bob * B.amp + B.amp) * (1 - gait) + hopS * M.hopHeight * gait
      const sy = (1 + bob * B.squash) * (1 - gait) + (1 + (hopS - 0.5) * B.squash * 2) * gait
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
      // same ground-level grass as characters: a hop lifts the body out of it smoothly
      const cutFull = A.grassCut * A.height
      cutH = approach(cutH, ctx.inGrassAt(actor.x, actor.y) ? cutFull : 0, A.grassCutMs > 0 ? (dt * cutFull * 1000) / A.grassCutMs : Infinity)
      sprite.uniforms.uCutY.value = cutUniform(cutH, lift, sy)
      occShape.value.set(RENDER.occlusion.soft, C.occlusionKeep)
      tag.update(dt)
    },
    dispose() {
      ctx.registry.delete(entry)
      object.removeFromParent()
      mirror.dispose()
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
    head(out, pitch = 0) {
      const top = spriteOpaqueTop(sprite.material.map, 0, 0, 1, 1, C.alphaTest)
      out.set(0, h * (top - C.footInset / CONTENT.config.sprites.creatureSize), 0)
      return billboardPointToWorld(out, mesh, pitch, RENDER.camera.billboard)
    },
    bendRadius: Math.max(0.5, h / A.height),
    stepKind: 'hop',
    stepScale: Math.max(0.6, h / A.height),
    mirror,
    isVisible: () => visible,
  }
  ctx.registry.add(entry)
  return actor
}
