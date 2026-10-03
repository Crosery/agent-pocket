// Integer UI scaling + shared CSS custom properties.
// One UI pixel ("--u") is always an integer number of DEVICE pixels, so the 12px pixel font and 1-unit borders stay
// crisp on any DPR. Base resolution, limits and animation timings come from content/ui.json.
import { touchPadHeight, UI_CONFIG, type UIConfig } from './config.ts'
import { glyphDims, glyphUrl } from './glyphs.ts'

export interface UIScale {
  /** Device pixels per UI pixel (integer). */
  deviceScale: number
  /** CSS pixels per UI pixel (= deviceScale / devicePixelRatio). Exposed as --ap-ui-scale (and --u = 1 UI px). */
  cssPerUnit: number
  /** Viewport size in UI pixels. */
  unitsW: number
  unitsH: number
  compact: boolean
  portrait: boolean
}

export function computeUIScale(vw: number, vh: number, dpr: number, cfg: UIConfig['scale'] = UI_CONFIG.scale): UIScale {
  const portrait = vh > vw
  const bw = portrait ? cfg.baseHeight : cfg.baseWidth
  const bh = portrait ? cfg.baseWidth : cfg.baseHeight
  const d = dpr > 0 ? dpr : 1
  const fit = Math.floor(Math.min((vw * d) / bw, (vh * d) / bh))
  const minDevice = Math.ceil(d * cfg.minCssPerUnit - 1e-6)
  const deviceScale = Math.min(cfg.maxDeviceScale, Math.max(1, fit, minDevice))
  const cssPerUnit = deviceScale / d
  const unitsW = vw / cssPerUnit
  const unitsH = vh / cssPerUnit
  return { deviceScale, cssPerUnit, unitsW, unitsH, compact: unitsW < cfg.compactBelowWidth, portrait }
}

let current: UIScale | null = null
let installed = false
const listeners = new Set<(s: UIScale) => void>()

function apply(): void {
  const s = computeUIScale(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)
  const changed = !current || current.deviceScale !== s.deviceScale || current.cssPerUnit !== s.cssPerUnit ||
    current.compact !== s.compact || current.unitsW !== s.unitsW || current.unitsH !== s.unitsH
  current = s
  const root = document.documentElement
  root.style.setProperty('--ap-ui-scale', String(s.cssPerUnit))
  root.classList.toggle('ap-compact', s.compact)
  root.classList.toggle('ap-portrait', s.portrait)
  if (changed) for (const fn of listeners) fn(s)
}

function setStaticVars(): void {
  const root = document.documentElement.style
  const a = UI_CONFIG.anim
  root.setProperty('--ap-panel-open-ms', `${a.panelOpenMs}ms`)
  root.setProperty('--ap-panel-close-ms', `${a.panelCloseMs}ms`)
  root.setProperty('--ap-modal-open-ms', `${a.modalOpenMs}ms`)
  root.setProperty('--ap-cursor-bob-ms', `${a.cursorBobMs}ms`)
  root.setProperty('--ap-toast-enter-ms', `${a.toastEnterMs}ms`)
  root.setProperty('--ap-toast-leave-ms', `${a.toastLeaveMs}ms`)
  root.setProperty('--ap-touch-inset', `${touchPadHeight() + UI_CONFIG.scale.touchInsetGapCss}px`)
  root.setProperty('--ap-minimap-size', String(UI_CONFIG.minimap.size))
  root.setProperty('--ap-minimap-compact-size', String(UI_CONFIG.minimap.compactSize))
  root.setProperty('--ap-minimap-ring', String(UI_CONFIG.minimap.ring))
  root.setProperty('--ap-list-min-w', String(UI_CONFIG.list.minWidth))
  root.setProperty('--ap-list-detail-w', String(UI_CONFIG.list.detailWidth))
  root.setProperty('--ap-hp-w', String(UI_CONFIG.bars.hp.width))
  root.setProperty('--ap-exp-w', String(UI_CONFIG.bars.exp.width))
  root.setProperty('--ap-banner-fade', `${UI_CONFIG.hud.bannerFadeMs}ms`)
  root.setProperty('--ap-region-fade', `${UI_CONFIG.hud.regionFadeMs}ms`)
  root.setProperty('--ap-chat-fade', `${UI_CONFIG.chat.fadeMs}ms`)
  root.setProperty('--ap-chat-idle-opacity', String(UI_CONFIG.chat.idleOpacity))
  for (const [k, color] of Object.entries(UI_CONFIG.chat.channelColors)) root.setProperty(`--ap-chat-${k}`, color)
  // Glyph art used by CSS pseudo-elements (cursor, indicators, studs).
  for (const id of ['cursor', 'advance', 'end', 'scrollUp', 'scrollDown', 'diamond']) {
    const { w, h } = glyphDims(id)
    root.setProperty(`--ap-g-${id}`, `url("${glyphUrl(id)}")`)
    root.setProperty(`--ap-g-${id}-w`, String(w))
    root.setProperty(`--ap-g-${id}-h`, String(h))
  }
}

/** Installs scaling + CSS variables once; safe to call from every UI module. */
export function ensureUIEnvironment(): UIScale {
  if (!installed) {
    installed = true
    setStaticVars()
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    // DPR changes (browser zoom, moving between monitors) do not always fire resize.
    const watchDpr = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mq.addEventListener('change', () => { apply(); watchDpr() }, { once: true })
    }
    watchDpr()
    apply()
  }
  return current!
}

export function getUIScale(): UIScale {
  return current ?? ensureUIEnvironment()
}

export function onUIScaleChange(fn: (s: UIScale) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Overrides the bottom space (CSS px) reserved under dialogue/chat. By default it follows
 * html[data-touch-controls="on"] (set by core/): pad height from content/input.json + scale.touchInsetGapCss.
 * null restores that default.
 */
export function setUIBottomInset(cssPx: number | null): void {
  const s = document.documentElement.style
  if (cssPx === null) s.removeProperty('--ap-bottom-inset')
  else s.setProperty('--ap-bottom-inset', `${Math.max(0, cssPx)}px`)
}

/** Makes `root` a positioning context for absolutely positioned UI layers. */
export function prepareRoot(root: HTMLElement): void {
  if (root === document.body || root === document.documentElement) root.classList.add('ap-root-fixed')
  else if (getComputedStyle(root).position === 'static') root.style.position = 'relative'
  root.classList.add('ap-root')
}
