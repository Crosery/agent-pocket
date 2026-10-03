import type { Settings } from '../../shared/types.ts'
import { INPUT_CONFIG } from './input-config.ts'
import type { InputConfig } from './input-config.ts'

/** True on devices whose primary pointer is touch. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  return coarse || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && !window.matchMedia?.('(pointer: fine)').matches)
}

/** UI scale that fits the reference layout into the viewport, snapped to `scaleStep`. */
export function computeUiScale(width: number, height: number, d: InputConfig['display'] = INPUT_CONFIG.display): number {
  const fit = Math.min(width / d.referenceWidth, height / d.referenceHeight)
  const snapped = Math.floor(fit / d.scaleStep) * d.scaleStep
  return Math.min(d.maxScale, Math.max(d.minScale, snapped))
}

let resizeBound = false

/**
 * Reflects settings onto <html> as CSS custom properties and data attributes:
 *   --ui-scale, --pixel-scale, --bgm-volume, --sfx-volume
 *   data-quality, data-text-speed, data-show-names, data-show-minimap, data-dof, data-bloom, data-shadows,
 *   data-touch-pref (auto|on|off), data-touch-controls (resolved on|off; 'auto' follows the device or a
 *   touch already seen by the input module).
 */
export function applyDocumentSettings(s: Settings): void {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  const updateScale = () => html.style.setProperty('--ui-scale', String(computeUiScale(window.innerWidth, window.innerHeight)))
  updateScale()
  if (!resizeBound) {
    resizeBound = true
    window.addEventListener('resize', updateScale)
  }
  html.style.setProperty('--pixel-scale', String(s.pixelScale))
  html.style.setProperty('--bgm-volume', String(s.bgmVolume))
  html.style.setProperty('--sfx-volume', String(s.sfxVolume))
  html.dataset.quality = s.quality
  html.dataset.textSpeed = s.textSpeed
  html.dataset.showNames = String(s.showNames)
  html.dataset.showMinimap = String(s.showMinimap)
  html.dataset.dof = String(s.dof)
  html.dataset.bloom = String(s.bloom)
  html.dataset.shadows = String(s.shadows)
  html.dataset.touchPref = s.touchControls
  const autoOn = isTouchDevice() || html.dataset.touchSeen === 'true'
  html.dataset.touchControls = s.touchControls === 'auto' ? (autoOn ? 'on' : 'off') : s.touchControls
}
