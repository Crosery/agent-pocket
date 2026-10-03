// Sky dome (gradient + stars), sun/moon DirectionalLight with a focus-following snapped shadow frustum,
// hemisphere ambient and fog — all driven by a LightingState sampled from content/render.json.
import * as THREE from 'three'
import { RENDER, hexToRgb, type LightingState, type Vec3 } from '../config.ts'
import { setSpriteShadowLight } from '../sprite-utils.ts'

export interface SkyRig {
  readonly dome: THREE.Mesh
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly fog: THREE.Fog
  /** Scene light color estimate (for unlit shaders: water, weather particles). */
  readonly ambientLight: THREE.Color
  apply(s: LightingState, dir: Vec3, intensityMul: number, focus: THREE.Vector3, camera: THREE.PerspectiveCamera, camDistance: number, time: number): void
  setShadows(enabled: boolean, mapSize: number, radius: number): void
  dispose(): void
}

const setSrgb = (c: THREE.Color, hex: string) => c.setRGB(...hexToRgb(hex), THREE.SRGBColorSpace)

export function createSkyRig(scene: THREE.Scene): SkyRig {
  const S = RENDER.sun, K = RENDER.sky
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uBottom: { value: new THREE.Color() },
      uStars: { value: 0 },
      uStarColor: { value: setSrgb(new THREE.Color(), K.starColor) },
      uStarDensity: { value: K.starDensity },
      uStarIntensity: { value: K.starIntensity },
      uTwinkle: { value: K.twinkleSpeed },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uTop, uHorizon, uBottom, uStarColor;
uniform float uStars, uStarDensity, uStarIntensity, uTwinkle, uTime;
varying vec3 vDir;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  float y = vDir.y;
  vec3 col = y > 0.0 ? mix(uHorizon, uTop, pow(clamp(y, 0.0, 1.0), 0.6)) : mix(uHorizon, uBottom, pow(clamp(-y, 0.0, 1.0), 0.45));
  if (uStars > 0.0 && y > 0.02) {
    vec3 cell = floor(vDir * 180.0);
    float h = h3(cell);
    float tw = 0.6 + 0.4 * sin(uTime * uTwinkle + h * 40.0);
    col += uStarColor * step(1.0 - uStarDensity, h) * uStars * uStarIntensity * tw * smoothstep(0.02, 0.25, y);
  }
  gl_FragColor = vec4(col, 1.0);
}`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(K.domeRadius, 32, 16), domeMat)
  dome.renderOrder = -1000
  dome.frustumCulled = false
  dome.name = 'sky'

  const sun = new THREE.DirectionalLight(0xffffff, 1)
  sun.castShadow = true
  sun.shadow.bias = S.bias
  sun.shadow.normalBias = S.normalBias
  const cam = sun.shadow.camera
  cam.near = S.shadowNear
  cam.far = S.shadowFar
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1)
  const fog = new THREE.Fog(0xffffff, 10, 100)
  scene.fog = fog
  scene.add(dome, sun, sun.target, hemi)
  const ambientLight = new THREE.Color(1, 1, 1)

  const _dir = new THREE.Vector3()
  const _ls = new THREE.Vector3()
  const _snap = new THREE.Vector3()
  const _inv = new THREE.Matrix4()
  const _look = new THREE.Matrix4()
  const _c = new THREE.Color()
  let extent = S.shadowExtent

  return {
    dome, sun, hemi, fog, ambientLight,
    apply(s, dir, intensityMul, focus, camera, camDistance, time) {
      const u = domeMat.uniforms
      setSrgb(u.uTop.value, s.skyTop)
      setSrgb(u.uHorizon.value, s.skyHorizon)
      setSrgb(u.uBottom.value, s.skyBottom)
      u.uStars.value = s.stars
      u.uTime.value = time
      dome.position.copy(camera.position)

      setSrgb(sun.color, s.sun)
      sun.intensity = s.sunIntensity * intensityMul
      setSrgb(hemi.color, s.hemiSky)
      setSrgb(hemi.groundColor, s.hemiGround)
      hemi.intensity = s.hemiIntensity
      setSrgb(fog.color, s.fog)
      fog.near = camDistance + s.fogNear
      fog.far = camDistance + s.fogFar

      // shadow frustum follows the focus; snapped to shadow texels in light space so edges don't crawl
      _dir.set(dir[0], dir[1], dir[2]).normalize()
      setSpriteShadowLight(_dir)
      const want = Math.max(S.shadowExtent, camDistance * S.extentPerDistance)
      if (Math.abs(want - extent) > 0.5) extent = want
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent
      cam.updateProjectionMatrix()
      const texel = (2 * extent) / Math.max(1, sun.shadow.mapSize.x)
      _look.lookAt(_dir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0))
      _inv.copy(_look).invert()
      _ls.copy(focus).applyMatrix4(_inv)
      _ls.x = Math.round(_ls.x / texel) * texel
      _ls.y = Math.round(_ls.y / texel) * texel
      _snap.copy(_ls).applyMatrix4(_look)
      sun.target.position.copy(_snap)
      sun.position.copy(_snap).addScaledVector(_dir, S.distance)
      sun.target.updateMatrixWorld()

      // estimated diffuse light for unlit shaders
      ambientLight.copy(hemi.color).lerp(_c.copy(hemi.groundColor), 0.25).multiplyScalar(hemi.intensity)
      ambientLight.add(_c.copy(sun.color).multiplyScalar(sun.intensity * Math.max(0, _dir.y)))
      ambientLight.multiplyScalar(1 / Math.PI)
    },
    setShadows(enabled, mapSize, radius) {
      if (sun.castShadow !== enabled) sun.castShadow = enabled
      if (sun.shadow.mapSize.x !== mapSize) {
        sun.shadow.mapSize.set(mapSize, mapSize)
        sun.shadow.map?.dispose()
        sun.shadow.map = null
      }
      sun.shadow.radius = radius
    },
    dispose() {
      scene.remove(dome, sun, sun.target, hemi)
      dome.geometry.dispose()
      domeMat.dispose()
      sun.shadow.map?.dispose()
    },
  }
}
