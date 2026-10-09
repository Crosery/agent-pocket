// Layout audit (ADR 0002 §4.7, expect.layout): what is wrong with the visible UI right now. Checks the DOM only, so it
// works for every screen the game or the developer panel puts up.
export interface LayoutIssue { kind: 'offscreen' | 'overflow' | 'overlap' | 'touchTarget'; element: string; detail: string }

export interface AuditOpts {
  /** CSS selector of the subtree to audit; the whole UI layer and the developer panel by default. */
  scope?: string
  /** Smallest comfortable touch target in px (applies when touch controls are on or the viewport is compact). */
  touchMinPx: number
  /** Overlap area (px²) below which two neighbours are not reported. */
  overlapMinArea: number
  maxIssues: number
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="tab"]'

const describe = (el: Element): string => {
  const cmd = (el as HTMLElement).dataset?.devCmd
  const cls = [...el.classList].slice(0, 2).join('.')
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${cmd ? `[${cmd}]` : ''}${el.id ? `#${el.id}` : ''}`
}

const visible = (el: Element): DOMRect | null => {
  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? r : null
}

/** True when `el` sits inside a box that scrolls on its own (then being outside the viewport is expected). */
const scrolled = (el: Element, root: Element): boolean => {
  for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
    const o = getComputedStyle(p)
    if (/(auto|scroll)/.test(o.overflowX + o.overflowY) && (p.scrollWidth > p.clientWidth || p.scrollHeight > p.clientHeight)) return true
  }
  return false
}

export function auditLayout(o: AuditOpts): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const add = (i: LayoutIssue) => { if (issues.length < o.maxIssues) issues.push(i) }
  const roots = [...document.querySelectorAll(o.scope ?? '#ap-ui, .apd, .apd-ed__bar')]
  const vw = innerWidth, vh = innerHeight
  const touch = document.documentElement.dataset.touchControls === 'on' || matchMedia('(max-width: 700px)').matches
  for (const root of roots) {
    if (!visible(root) && root !== document.body) continue
    const items = [root, ...root.querySelectorAll('*')]
    const hits: { el: Element; r: DOMRect }[] = []
    for (const el of items) {
      const r = visible(el)
      if (!r) continue
      if (el.matches(INTERACTIVE)) hits.push({ el, r })
      const tight = 1.5
      if ((r.right < -tight || r.bottom < -tight || r.left > vw + tight || r.top > vh + tight || r.left < -tight || r.right > vw + tight) && el.matches(INTERACTIVE) && !scrolled(el, root)) {
        add({ kind: 'offscreen', element: describe(el), detail: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${vw}x${vh}` })
      }
      const h = el as HTMLElement
      if (/(hidden|clip)/.test(getComputedStyle(el).overflowX) && h.scrollWidth > h.clientWidth + 2 && h.clientWidth > 0 && !/(auto|scroll)/.test(getComputedStyle(el).overflowX)) {
        const cs = getComputedStyle(el)
        if (cs.textOverflow !== 'ellipsis') add({ kind: 'overflow', element: describe(el), detail: `content ${h.scrollWidth}px in ${h.clientWidth}px` })
      }
    }
    if (touch) for (const { el, r } of hits) {
      if (Math.min(r.width, r.height) < o.touchMinPx - 0.5 && !(el as HTMLInputElement).disabled) add({ kind: 'touchTarget', element: describe(el), detail: `${Math.round(r.width)}x${Math.round(r.height)} < ${o.touchMinPx}` })
    }
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i], b = hits[j]
      if (a.el.contains(b.el) || b.el.contains(a.el) || a.el.parentElement !== b.el.parentElement) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), hh = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w > 0 && hh > 0 && w * hh >= o.overlapMinArea) add({ kind: 'overlap', element: `${describe(a.el)} / ${describe(b.el)}`, detail: `${Math.round(w)}x${Math.round(hh)} px overlap` })
    }
  }
  return issues
}
