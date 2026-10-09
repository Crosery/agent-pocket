// DOM pieces of the type chart screen: a type's icon and name tag, template text with tags in place of {atk} / {def},
// and the pixel loop ring (inline SVG: the type icons on a circle, an arrow along every edge in the attacker's colour).
import { CONTENT, t } from '../../../shared/content/index.ts'
import type { AssetStore } from '../../contracts.ts'
import type { LoopDef } from '../../onboarding/config.ts'
import { el } from '../widgets.ts'
import { SCREENS } from './config.ts'
import { loopEdges, ringLayout } from './typechart-logic.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, children: (Node | string)[] = []): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  for (const c of children) node.append(c)
  return node
}

/** The type's pixel icon (content/types.json `icon`) in a `size` x `size` unit box; a type-coloured disc if the art is missing. */
export function typeIcon(assets: AssetStore, typeId: string, size: number): HTMLElement {
  const def = CONTENT.typeById[typeId]
  const url = def?.icon ? assets.uiUrl(def.icon) : null
  const box = el('span', { class: `aps-tc-icon${url ? '' : ' is-missing'}`, vars: { '--sz': size, '--tc': def?.color ?? 'currentColor' }, attrs: { 'aria-hidden': 'true' } })
  if (url) box.append(el('img', { attrs: { src: url, alt: '', draggable: 'false', decoding: 'async' } }))
  return box
}

/** Icon + name on a dark plate edged in the type's colour. */
export function typeTag(assets: AssetStore, typeId: string): HTMLElement {
  const def = CONTENT.typeById[typeId]
  return el('span', { class: 'aps-tc-tag', vars: { '--tc': def?.color ?? 'currentColor' }, data: { type: typeId } }, [
    typeIcon(assets, typeId, SCREENS.typeChart.chip.icon),
    el('span', { class: 'aps-tc-tag-name', text: def?.nameZh ?? typeId }),
  ])
}

/** A text template with {name} placeholders replaced by nodes (type tags), the rest as plain text. */
export function withNodes(template: string, nodes: Record<string, Node>): (Node | string)[] {
  const out: (Node | string)[] = []
  let last = 0
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const node = nodes[m[1]]
    if (!node) continue
    if (m.index > last) out.push(template.slice(last, m.index))
    out.push(node.cloneNode(true))
    last = m.index + m[0].length
  }
  if (last < template.length) out.push(template.slice(last))
  return out
}

/** The loop as an arrow ring. Size is the configured ring box in UI units (1 SVG unit = 1 UI unit). */
export function loopRing(assets: AssetStore, loop: LoopDef): SVGSVGElement {
  const ring = SCREENS.typeChart.loops.ring
  const layout = ringLayout(loop.types, ring, ring.label)
  const root = svg('svg', { class: 'aps-tc-ring', viewBox: `0 0 ${ring.w} ${ring.h}`, role: 'img', 'aria-label': loopEdges(loop).map(([a, b]) => t('screens.typeChart.edge', { atk: CONTENT.typeById[a]?.nameZh ?? a, def: CONTENT.typeById[b]?.nameZh ?? b })).join(t('screens.typeChart.join')) })
  root.style.width = `calc(var(--u) * ${ring.w})`
  root.style.height = `calc(var(--u) * ${ring.h})`
  // Dark outline first so the arrows read against any plate behind the ring.
  for (const a of layout.arrows) {
    const color = CONTENT.typeById[a.from]?.color ?? 'currentColor'
    root.append(svg('line', { class: 'aps-tc-arrow-edge', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, 'stroke-width': ring.stroke + 2 }))
    root.append(svg('polygon', { class: 'aps-tc-arrow-edge', points: a.head.map((p) => p.join(',')).join(' '), 'stroke-width': 2 }))
    root.append(svg('line', { class: 'aps-tc-arrow', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: color, 'stroke-width': ring.stroke }))
    root.append(svg('polygon', { class: 'aps-tc-arrow-head', points: a.head.map((p) => p.join(',')).join(' '), fill: color }))
  }
  const half = ring.node / 2
  for (const n of layout.nodes) {
    const def = CONTENT.typeById[n.id]
    const url = def?.icon ? assets.uiUrl(def.icon) : null
    if (url) root.append(svg('image', { href: url, x: n.x - half, y: n.y - half, width: ring.node, height: ring.node, class: 'aps-tc-node' }))
    else root.append(svg('circle', { cx: n.x, cy: n.y, r: half - 1, fill: def?.color ?? 'currentColor', class: 'aps-tc-node' }))
    const ly = n.labelAbove ? n.y - half - 4 : n.y + half + ring.label - 3
    root.append(svg('text', { class: 'aps-tc-ring-label', x: n.x, y: ly, 'text-anchor': 'middle' }, [def?.nameZh ?? n.id]))
  }
  return root
}
