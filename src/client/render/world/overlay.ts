// DOM overlay for crisp name tags and speech bubbles above 3D actors (positioned via worldToScreen).
import { RENDER } from '../config.ts'

const STYLE_ID = 'ap-render-overlay-style'
// Layout-only CSS; every colour / size comes from render.json overlay.style through CSS variables set on the layer.
const CSS = `
.ap-ov-tag, .ap-ov-bubble { position: absolute; left: 0; top: 0; pointer-events: none; white-space: nowrap;
  font-family: var(--ap-font, 'Fusion Pixel', 'Fusion Pixel 12px', monospace); image-rendering: pixelated; will-change: transform; }
.ap-ov-tag { font-size: var(--ap-ov-tag-font); line-height: 1; padding: var(--ap-ov-tag-pad); color: var(--ap-tag-color, var(--ap-ov-tag-color));
  background: var(--ap-ov-tag-bg); border-radius: var(--ap-ov-tag-radius); text-shadow: var(--ap-ov-tag-shadow); }
.ap-ov-bubble { font-size: var(--ap-ov-bubble-font); line-height: 1.2; padding: var(--ap-ov-bubble-pad); color: var(--ap-ov-bubble-text);
  background: var(--ap-ov-bubble-bg); border: var(--ap-ov-bubble-border-px) solid var(--ap-ov-bubble-border); border-radius: var(--ap-ov-bubble-radius);
  box-shadow: var(--ap-ov-bubble-shadow); max-width: var(--ap-ov-bubble-max); white-space: normal; text-align: center;
  animation: ap-ov-pop var(--ap-ov-pop) steps(3) both; }
.ap-ov-bubble::after { content: ''; position: absolute; left: 50%; bottom: calc(-1 * var(--ap-ov-tail) - var(--ap-ov-bubble-border-px));
  margin-left: calc(-1 * var(--ap-ov-tail)); border: var(--ap-ov-tail) solid transparent; border-top-color: var(--ap-ov-bubble-border); border-bottom: 0; }
@keyframes ap-ov-pop { from { opacity: 0; scale: 0.6; } to { opacity: 1; scale: 1; } }
`

function styleVars(): string {
  const s = RENDER.overlay.style
  const vars: Record<string, string> = {
    'tag-font': `${s.tagFontPx}px`, 'tag-pad': s.tagPadding, 'tag-color': RENDER.actors.nameColor, 'tag-bg': s.tagBackground,
    'tag-radius': `${s.tagRadiusPx}px`, 'tag-shadow': s.tagTextShadow,
    'bubble-font': `${s.bubbleFontPx}px`, 'bubble-pad': s.bubblePadding, 'bubble-text': s.bubbleText, 'bubble-bg': s.bubbleBackground,
    'bubble-border': s.bubbleBorder, 'bubble-border-px': `${s.bubbleBorderPx}px`, 'bubble-radius': `${s.bubbleRadiusPx}px`,
    'bubble-shadow': s.bubbleShadow, 'bubble-max': `${s.bubbleMaxWidthPx}px`, 'tail': `${s.bubbleTailPx}px`, 'pop': `${s.popMs}ms`,
  }
  return Object.entries(vars).map(([k, v]) => `--ap-ov-${k}:${v};`).join('')
}

export interface OverlayTag {
  setName(text: string | null, color?: string): void
  bubble(text: string, ms: number): void
  /** Screen position in CSS px of the anchor (above the head); visible=false hides everything. */
  place(x: number, y: number, visible: boolean, showName: boolean): void
  update(dt: number): void
  dispose(): void
}

export interface OverlayLayer {
  createTag(): OverlayTag
  dispose(): void
}

export function createOverlayLayer(root: HTMLElement): OverlayLayer {
  if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
    const st = document.createElement('style')
    st.id = STYLE_ID
    st.textContent = CSS
    document.head.appendChild(st)
  }
  const layer = document.createElement('div')
  layer.className = 'ap-ov-layer'
  layer.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;${styleVars()}`
  root.appendChild(layer)
  const O = RENDER.overlay

  return {
    createTag() {
      const tag = document.createElement('div')
      tag.className = 'ap-ov-tag'
      tag.style.display = 'none'
      layer.appendChild(tag)
      let bubbleEl: HTMLDivElement | null = null
      let bubbleT = 0
      let hasName = false
      return {
        setName(text, color) {
          hasName = !!text
          tag.textContent = text ?? ''
          if (color) tag.style.setProperty('--ap-tag-color', color)
        },
        bubble(text, ms) {
          if (!bubbleEl) {
            bubbleEl = document.createElement('div')
            bubbleEl.className = 'ap-ov-bubble'
            layer.appendChild(bubbleEl)
          }
          bubbleEl.textContent = text
          bubbleEl.style.animation = 'none'
          void bubbleEl.offsetWidth
          bubbleEl.style.animation = ''
          bubbleEl.style.display = ''
          bubbleT = ms / 1000
        },
        place(x, y, visible, showName) {
          const nameOn = visible && showName && hasName
          tag.style.display = nameOn ? '' : 'none'
          if (nameOn) tag.style.transform = `translate(${Math.round(x)}px, ${Math.round(y - O.nameOffsetPx)}px) translate(-50%, -100%)`
          if (bubbleEl) {
            const on = visible && bubbleT > 0
            bubbleEl.style.display = on ? '' : 'none'
            const lift = nameOn ? O.bubbleOffsetPx + tag.offsetHeight : O.bubbleOffsetPx
            if (on) bubbleEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y - lift)}px) translate(-50%, -100%)`
          }
        },
        update(dt) {
          if (bubbleT > 0) {
            bubbleT -= dt
            if (bubbleT <= 0 && bubbleEl) bubbleEl.style.display = 'none'
          }
        },
        dispose() { tag.remove(); bubbleEl?.remove() },
      }
    },
    dispose() { layer.remove() },
  }
}
