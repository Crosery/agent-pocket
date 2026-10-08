// HD-2D renderer: low internal resolution, CSS-upscaled with nearest filtering (DOM UI stays crisp), and the
// post chain RenderPass -> depth/tilt-shift DOF -> UnrealBloom (HDR emissives only) -> grade + transitions
// -> OutputPass (tone mapping + sRGB). Every tunable comes from content/render.json and CONTENT.config.render.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { WebGLRenderTarget } from 'three'
import { CONTENT } from '../../shared/content/index.ts'
import type { Settings } from '../../shared/types.ts'
import type { HD2DRenderer, PostParams, RenderView } from '../contracts.ts'
import { RENDER, hexToRgb, qualityPreset, type QualityPreset } from './config.ts'
import { DofShader, GradeShader, TRANSITION_KIND } from './post-shaders.ts'

export interface InternalSize { width: number; height: number; scale: number }

/** The concrete renderer: the contract plus what other render modules need (quality, internal size, clock). */
export interface HD2DRendererExt extends HD2DRenderer {
  readonly settings: Settings
  readonly quality: QualityPreset
  readonly internal: InternalSize
  /** Seconds accumulated through render(dt). */
  readonly time: number
  onSettingsChanged(fn: (s: Settings) => void): () => void
  dispose(): void
}

export function isHD2DRendererExt(r: HD2DRenderer): r is HD2DRendererExt {
  return 'internal' in r && 'quality' in r && 'onSettingsChanged' in r
}

const TONE_MAPPING: Record<string, THREE.ToneMapping> = {
  neutral: THREE.NeutralToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  none: THREE.NoToneMapping,
}

function basePost(settings: Settings, q: QualityPreset): PostParams {
  const p = RENDER.post
  return {
    dof: settings.dof && q.dof,
    focusDistance: RENDER.camera.near + 10,
    tiltShift: p.tiltShift,
    bokehScale: p.bokehScale,
    bloom: settings.bloom && q.bloom,
    bloomStrength: p.bloomStrength,
    bloomThreshold: p.bloomThreshold,
    vignette: p.vignette,
    saturation: p.saturation,
    contrast: p.contrast,
    warmth: p.warmth,
    exposure: p.exposure,
    pixelScale: settings.pixelScale,
    flash: 0,
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    split: 0,
  }
}

export function createRenderer(canvas: HTMLCanvasElement, settings: Settings): HD2DRendererExt {
  const P = RENDER.post
  let current: Settings = { ...settings }
  let quality = qualityPreset(current.quality)

  const gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false })
  gl.setPixelRatio(1)
  gl.outputColorSpace = THREE.SRGBColorSpace
  gl.toneMapping = TONE_MAPPING[P.toneMapping] ?? THREE.NeutralToneMapping
  gl.toneMappingExposure = P.exposure
  // Kept on: shadow casting is toggled per light (changing castShadow recompiles programs; toggling the map does not).
  gl.shadowMap.enabled = true
  gl.shadowMap.type = THREE.PCFShadowMap
  // the composer issues several renders per frame: reset stats once per frame so gl.info reflects the whole frame
  gl.info.autoReset = false
  canvas.style.imageRendering = 'pixelated'

  const internal: InternalSize = { width: 2, height: 2, scale: 1 }
  let cssW = Math.max(1, canvas.clientWidth || 640)
  let cssH = Math.max(1, canvas.clientHeight || 360)

  const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(2, 2) })
  const composer = new EffectComposer(gl, target)
  composer.setPixelRatio(1)

  const emptyScene = new THREE.Scene()
  const emptyCamera = new THREE.PerspectiveCamera()
  const renderPass = new RenderPass(emptyScene, emptyCamera)
  const dofPass = new ShaderPass(DofShader)
  const dofRender = dofPass.render.bind(dofPass)
  dofPass.render = (renderer, writeBuffer, readBuffer: WebGLRenderTarget, deltaTime, maskActive) => {
    dofPass.uniforms.tDepth.value = readBuffer.depthTexture
    dofRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
  }
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), P.bloomStrength, P.bloomRadius, P.bloomThreshold)
  const gradePass = new ShaderPass(GradeShader)
  const outputPass = new OutputPass()
  composer.addPass(renderPass)
  composer.addPass(dofPass)
  composer.addPass(bloomPass)
  composer.addPass(gradePass)
  composer.addPass(outputPass)

  const g = gradePass.uniforms
  const tr = P.transition
  g.uSwirlPortion.value = tr.swirlPortion
  g.uSwirlTurns.value = tr.swirlTurns
  g.uShardCells.value = tr.shardCells
  g.uShardSpin.value = tr.shardSpin
  g.uShardStagger.value = tr.shardStagger
  g.uBattleFlash.value = tr.battleFlash
  g.uIrisSoft.value = tr.irisSoftPx
  g.uIrisMax.value = tr.irisMaxRadius
  g.uPivot.value = P.contrastPivot
  g.uWarmthScale.value = P.warmthScale
  g.uVignetteSoft.value = P.vignetteSoftness
  g.uLift.value.set(...P.lift)
  g.uGain.value.set(...P.gain)
  g.uSplitRange.value.set(P.split.lo, P.split.hi)
  ;(g.uTransColor.value as THREE.Color).setRGB(...hexToRgb(tr.fadeColor), THREE.SRGBColorSpace)

  const post: PostParams = basePost(current, quality)
  const eff: PostParams = { ...post }

  let time = 0
  const flashState = { t: 0, dur: 1, color: new THREE.Color(1, 1, 1) }
  const shakeState = { t: 0, dur: 1, intensity: 0, seed: Math.random() * 100 }
  let transKind: keyof typeof TRANSITION_KIND = 'none'
  let transAmount = 0
  const listeners = new Set<(s: Settings) => void>()

  const _focus = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _up = new THREE.Vector3()
  const _saved = new THREE.Vector3()
  const _savedQ = new THREE.Quaternion()

  function layout(): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const devW = Math.max(1, Math.round(cssW * dpr))
    const devH = Math.max(1, Math.round(cssH * dpr))
    const maxH = CONTENT.config.render.internalHeight[current.quality] ?? devH
    const scale = Math.max(P.minScale, Math.round(current.pixelScale) || 1, Math.ceil(devH / maxH))
    internal.width = Math.max(1, Math.round(devW / scale))
    internal.height = Math.max(1, Math.round(devH / scale))
    internal.scale = scale
    gl.setSize(internal.width, internal.height, false)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    composer.setSize(internal.width, internal.height)
    dofPass.uniforms.uResolution.value.set(internal.width, internal.height)
    g.uResolution.value.set(internal.width, internal.height)
  }

  function applyQuality(): void {
    quality = qualityPreset(current.quality)
    Object.assign(post, basePost(current, quality), { flash: post.flash })
    const samples = Math.max(1, Math.round(quality.dofSamples))
    if (dofPass.material.defines.SAMPLES !== samples) {
      dofPass.material.defines.SAMPLES = samples
      dofPass.material.needsUpdate = true
    }
  }

  layout()
  applyQuality()

  const api: HD2DRendererExt = {
    canvas,
    gl,
    post,
    get settings() { return current },
    get quality() { return quality },
    internal,
    get time() { return time },

    resize(width: number, height: number) {
      cssW = Math.max(1, Math.round(width))
      cssH = Math.max(1, Math.round(height))
      layout()
    },

    applySettings(s: Settings) {
      const relayout = s.quality !== current.quality || s.pixelScale !== current.pixelScale
      current = { ...s }
      applyQuality()
      if (relayout) layout()
      for (const fn of listeners) fn(current)
    },

    onSettingsChanged(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    render(view: RenderView, dtSec: number) {
      const dt = Math.max(0, Math.min(dtSec, 0.25))
      time += dt
      gl.info.reset()
      const camera = view.camera

      // flash: quadratic decay
      if (flashState.t > 0) {
        flashState.t = Math.max(0, flashState.t - dt)
        const k = flashState.t / flashState.dur
        post.flash = k * k
      } else post.flash = 0

      Object.assign(eff, post, view.post ?? {})
      if (view.post?.flash !== undefined) eff.flash = Math.max(post.flash, view.post.flash)

      const aspect = internal.width / internal.height
      if (Math.abs(camera.aspect - aspect) > 1e-4) {
        camera.aspect = aspect
        camera.updateProjectionMatrix()
      }
      camera.updateMatrixWorld()

      let focusY = 0.5
      if (view.focus) {
        eff.focusDistance = camera.position.distanceTo(view.focus)
        _focus.copy(view.focus).project(camera)
        focusY = THREE.MathUtils.clamp(_focus.y * 0.5 + 0.5, 0, 1)
        g.uIrisCenter.value.set(THREE.MathUtils.clamp(_focus.x * 0.5 + 0.5, 0, 1), focusY)
      } else g.uIrisCenter.value.set(0.5, 0.5)

      const du = dofPass.uniforms
      dofPass.enabled = eff.dof && quality.dof
      du.uNear.value = camera.near
      du.uFar.value = camera.far
      du.uFocus.value = eff.focusDistance
      du.uFocusRange.value = P.focusRange
      du.uFocusFalloff.value = P.focusFalloff
      du.uTilt.value = eff.tiltShift
      du.uTiltBand.value = P.tiltBand
      du.uFocusY.value = focusY
      du.uMaxBlur.value = eff.bokehScale

      bloomPass.enabled = eff.bloom && quality.bloom
      bloomPass.strength = eff.bloomStrength
      bloomPass.threshold = eff.bloomThreshold
      bloomPass.radius = P.bloomRadius

      g.uSaturation.value = eff.saturation
      g.uContrast.value = eff.contrast
      g.uWarmth.value = eff.warmth
      g.uVignette.value = eff.vignette
      g.uSplit.value = eff.split ?? 0
      g.uShadowTint.value.set(...(eff.shadowTint ?? [1, 1, 1]))
      g.uHighlightTint.value.set(...(eff.highlightTint ?? [1, 1, 1]))
      g.uFlash.value = THREE.MathUtils.clamp(eff.flash, 0, 1)
      ;(g.uFlashColor.value as THREE.Color).copy(flashState.color).multiplyScalar(P.flash.strength)
      g.uTransKind.value = TRANSITION_KIND[transKind]
      g.uTrans.value = transAmount
      gl.toneMappingExposure = eff.exposure

      renderPass.scene = view.scene
      renderPass.camera = camera

      // screen shake: camera-space offset with a short roll, restored after rendering
      let shaken = false
      if (shakeState.t > 0) {
        shakeState.t = Math.max(0, shakeState.t - dt)
        const amp = shakeState.intensity * (shakeState.t / shakeState.dur)
        const f = P.shake.frequency
        const s = shakeState.seed
        const ox = Math.sin(time * f + s) * 0.6 + Math.sin(time * f * 2.3 + s * 1.7) * 0.4
        const oy = Math.cos(time * f * 1.3 + s * 0.7) * 0.6 + Math.sin(time * f * 3.1 + s) * 0.4
        _saved.copy(camera.position)
        _savedQ.copy(camera.quaternion)
        _right.setFromMatrixColumn(camera.matrixWorld, 0)
        _up.setFromMatrixColumn(camera.matrixWorld, 1)
        camera.position.addScaledVector(_right, ox * amp).addScaledVector(_up, oy * amp)
        camera.rotateZ(THREE.MathUtils.degToRad(P.shake.rollDeg) * ox * Math.min(1, amp))
        camera.updateMatrixWorld()
        shaken = true
      }

      composer.render(dt)

      if (shaken) {
        camera.position.copy(_saved)
        camera.quaternion.copy(_savedQ)
        camera.updateMatrixWorld()
      }
    },

    flash(color?: string, ms?: number) {
      flashState.color.setRGB(...hexToRgb(color ?? P.flash.color), THREE.SRGBColorSpace)
      flashState.dur = Math.max(0.001, (ms ?? P.flash.ms) / 1000)
      flashState.t = flashState.dur
    },

    shake(intensity: number, ms: number) {
      if (intensity <= 0 || ms <= 0) return
      if (shakeState.t > 0 && shakeState.intensity * (shakeState.t / shakeState.dur) > intensity) return
      shakeState.intensity = intensity
      shakeState.dur = ms / 1000
      shakeState.t = shakeState.dur
      shakeState.seed = Math.random() * 100
    },

    setTransition(kind, amount) {
      transKind = kind
      transAmount = THREE.MathUtils.clamp(amount, 0, 1)
    },

    dispose() {
      listeners.clear()
      composer.dispose()
      target.dispose()
      bloomPass.dispose()
      dofPass.dispose()
      gradePass.dispose()
      outputPass.dispose()
      gl.dispose()
    },
  }
  return api
}
