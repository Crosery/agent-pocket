// The in-game editor (ADR 0002 §3.3): select, drag, rotate, delete and place the objects that layout templates put
// into towns and interiors, and write the result back to the JSON files. The model lives in ./session.ts; this file
// is the screen side: an SVG overlay over the canvas, pointer handling, a floating toolbar and the command-facing API.
import * as THREE from 'three'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { propSize } from '../../../shared/world/collision.ts'
import { LAYOUT_DOCS } from '../../../shared/world/data.ts'
import { buildWorld, worldBuildInfo } from '../../../shared/world/index.ts'
import type { ProvEntry, ProvRegion } from '../../../shared/world/provenance.ts'
import { validateWorldContent } from '../../../shared/world/validate.ts'
import type { DevHost } from '../kit.ts'
import { DevError } from '../registry.ts'
import type { InputGate } from '../ui/gate.ts'
import { h } from '../ui/dom.ts'
import { fetchHash, writeBack } from './api.ts'
import { EDITOR } from './config.ts'
import { EditorSession, type EditResult } from './session.ts'

export interface EditorInfo {
  active: boolean
  busy: boolean
  /** The tool that is armed to place a prop on the next tap. */
  armed: string | null
  selected: { kind: string; label: string; x: number; y: number; w: number; h: number; rot: number; template: string; sharedBy: number } | null
  canUndo: boolean
  canRedo: boolean
  lastDrop: { x: number; y: number } | null
  /** Something was written: the running game shows the old world until the page is reloaded. */
  written: boolean
}

export interface Editor {
  info(): EditorInfo
  open(): Promise<EditorInfo>
  close(): EditorInfo
  select(x: number, y: number, map?: string): EditorInfo
  move(x: number, y: number): Promise<EditorInfo>
  rotate(): Promise<EditorInfo>
  remove(): Promise<EditorInfo>
  /** With a position: places now. Without: arms the tool for the next tap (or disarms with prop null). */
  place(prop: string | null, x?: number, y?: number, rot?: number): Promise<EditorInfo>
  undo(): Promise<EditorInfo>
  redo(): Promise<EditorInfo>
  reload(): void
  destroy(): void
}

/** Why an edit was refused, in words. */
function explain(res: Exclude<EditResult, { ok: true }>): DevError {
  const list = (res.problems ?? []).slice(0, EDITOR.problemLines).join('；')
  switch (res.reason) {
    case 'nothing': return new DevError('dev.ed.err.nothing')
    case 'unknown': return new DevError('dev.ed.err.unknown')
    case 'readonly': return new DevError('dev.ed.err.readonly')
    case 'patch': return new DevError('dev.ed.err.patch', { why: res.message ?? '' })
    case 'problems': return new DevError('dev.ed.err.problems', { list })
    case 'write':
      if (res.status === 403) return new DevError('dev.ed.err.forbidden')
      if (res.status === 409) return new DevError('dev.ed.err.conflict')
      if (res.status === 422) return new DevError('dev.ed.err.rejected', { list })
      return new DevError('dev.ed.err.write', { why: res.message ?? String(res.status) })
  }
}

const propHeight = (e: ProvEntry): number => (e.kind === 'prop' || e.kind === 'building' ? CONTENT.props[e.label]?.height ?? 1 : 0)

export function createEditor(host: DevHost, gate: InputGate): Editor {
  const { world: wv } = host.ctx
  const canvas = host.ctx.renderer.canvas
  let session: EditorSession | null = null
  let active = false
  let busy = false
  let armed: string | null = null
  let armedRot = 0
  let status = ''
  let raf = 0
  /** Drag in progress: where the object was grabbed (offset inside it) and the footprint's current ghost tile. */
  let drag: { dx: number; dy: number; x: number; y: number; moved: boolean } | null = null
  let hover: { x: number; y: number } | null = null
  /** Where the last drag ended (tile of the footprint's top-left): what the pointer asked for, whatever came of it. */
  let lastDrop: { x: number; y: number } | null = null

  // ------------------------------------------------------------------ overlay

  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'apd-ed__svg')
  const mk = (cls: string) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); svg.append(p); return p }
  const pathAll = mk('apd-ed__all'), pathSel = mk('apd-ed__sel'), pathGhost = mk('apd-ed__ghost')
  const hit = h('div', { class: 'apd-ed__hit', 'data-dev-editor-hit': '' })
  const msg = h('div', { class: 'apd-ed__msg', role: 'status', 'aria-live': 'polite' })
  const btn = (cmd: string, labelKey: string, args: Record<string, unknown> = {}) => {
    const b = h('button', { type: 'button', class: 'apd-btn apd-ed__btn', 'data-dev-cmd': cmd, 'data-dev-args': JSON.stringify(args) }, t(labelKey))
    b.addEventListener('click', () => { void host.run({ cmd, args }).then(() => undefined, (e: unknown) => say(e instanceof Error ? e.message : String(e))) })
    return b
  }
  const bar = h('div', { class: 'apd-ed__bar', hidden: true }, msg,
    h('div', { class: 'apd-ed__btns' }, btn('editor.rotate', 'dev.ed.rotate'), btn('editor.delete', 'dev.ed.delete'), btn('editor.undo', 'dev.ed.undo'), btn('editor.redo', 'dev.ed.redo'), btn('editor.reload', 'dev.ed.reload'), btn('editor.close', 'dev.ed.exit')))
  hit.hidden = true
  svg.style.display = 'none'
  document.body.append(svg, hit, bar)

  const say = (text: string) => { status = text; msg.textContent = text }

  // ------------------------------------------------------------------ projection

  const mapId = (): string => host.overworld.mapId ?? ''
  const canvasRect = () => canvas.getBoundingClientRect()
  const project = (x: number, y: number, yy: number): { x: number; y: number } => {
    const p = wv.worldToScreen(x, yy, y)
    const r = canvasRect()
    return { x: r.left + p.x, y: r.top + p.y }
  }
  const groundY = (x: number, y: number) => wv.elevationAt(x, y)
  const quad = (x: number, y: number, w: number, hh: number, lift = 0): { x: number; y: number }[] => {
    const yy = groundY(x + w / 2, y + hh / 2) + lift
    return [[x, y], [x + w, y], [x + w, y + hh], [x, y + hh]].map(([px, py]) => project(px, py, yy))
  }
  const poly = (pts: { x: number; y: number }[]): string => `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z`

  /** Tile under a screen point, taken on the horizontal plane at the ground level of `near` (default: the player). */
  function tileAt(cx: number, cy: number, near: { x: number; y: number } = host.overworld.player): { x: number; y: number } | null {
    const r = canvasRect()
    const cam = wv.camera
    cam.updateMatrixWorld()
    const planeY = groundY(near.x, near.y)
    const dir = new THREE.Vector3(((cx - r.left) / r.width) * 2 - 1, -(((cy - r.top) / r.height) * 2 - 1), 0.5).unproject(cam).sub(cam.position).normalize()
    if (Math.abs(dir.y) < 1e-6) return null
    const k = (planeY - cam.position.y) / dir.y
    return k > 0 ? { x: cam.position.x + dir.x * k, y: cam.position.z + dir.z * k } : null
  }

  const nearby = (): ProvEntry[] => {
    if (!session) return []
    const p = host.overworld.player, m = mapId(), R = EDITOR.pick.searchRadiusTiles
    return session.entries.filter((e) => e.map === m && Math.abs(e.x + e.w / 2 - p.x) <= R && Math.abs(e.y + e.h / 2 - p.y) <= R)
  }

  /** The recorded object under a screen point: the smallest projected box (ground quad up to the prop's top) that contains it. */
  function pickEntry(cx: number, cy: number): ProvEntry | null {
    let best: ProvEntry | null = null, bestArea = Infinity
    for (const e of nearby()) {
      const pts = [...quad(e.x, e.y, e.w, e.h), ...quad(e.x, e.y, e.w, e.h, propHeight(e))]
      const pad = e.kind === 'sign' || e.kind === 'anchor' ? 14 : 0
      const x0 = Math.min(...pts.map((p) => p.x)) - pad, x1 = Math.max(...pts.map((p) => p.x)) + pad
      const y0 = Math.min(...pts.map((p) => p.y)) - pad, y1 = Math.max(...pts.map((p) => p.y)) + pad
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue
      const area = (x1 - x0) * (y1 - y0)
      if (area < bestArea) { best = e; bestArea = area }
    }
    return best
  }

  // ------------------------------------------------------------------ drawing

  function draw(): void {
    raf = active ? requestAnimationFrame(draw) : 0
    if (!session || !session.ready) return
    const sel = session.selected
    const all: string[] = []
    for (const e of nearby()) if (e !== sel) all.push(poly(quad(e.x, e.y, e.w, e.h)))
    pathAll.setAttribute('d', all.join(''))
    pathSel.setAttribute('d', sel ? poly(quad(sel.x, sel.y, sel.w, sel.h, 0.02)) : '')
    let ghost = ''
    if (drag && sel && drag.moved) ghost = poly(quad(drag.x, drag.y, sel.w, sel.h, 0.04))
    else if (armed && hover) { const [fw, fh] = propSize(armed, armedRot); ghost = poly(quad(hover.x, hover.y, fw, fh, 0.04)) }
    pathGhost.setAttribute('d', ghost)
    const info = session.selected
    if (!status && info) msg.textContent = describe(info)
  }

  const describe = (e: ProvEntry): string => {
    const shared = session?.sharedBy(e) ?? 1
    return t('dev.ed.selected', { kind: t(`dev.ed.kind.${e.kind}`), label: e.label, x: e.x, y: e.y }) + (shared > 1 ? ` ${t('dev.ed.shared', { n: shared })}` : '')
  }

  // ------------------------------------------------------------------ pointer

  const onDown = (ev: PointerEvent) => {
    if (!session?.ready || busy) return
    hit.setPointerCapture(ev.pointerId)
    if (armed) { hover = tileAt(ev.clientX, ev.clientY) ? snapHover(ev) : null; return }
    const e = pickEntry(ev.clientX, ev.clientY)
    session.select(e)
    status = ''
    if (!e) {
      const g = tileAt(ev.clientX, ev.clientY)
      const prop = g && host.world.maps[mapId()]?.props.find((p) => { const [fw, fh] = propSize(p.prop, p.rot); return g.x >= p.x && g.x < p.x + fw && g.y >= p.y && g.y < p.y + fh })
      say(prop ? t('dev.ed.generated', { prop: prop.prop }) : '')
      drag = null
      return
    }
    const g = tileAt(ev.clientX, ev.clientY, { x: e.x + e.w / 2, y: e.y + e.h / 2 })
    drag = { dx: g ? Math.floor(g.x) - e.x : 0, dy: g ? Math.floor(g.y) - e.y : 0, x: e.x, y: e.y, moved: false }
  }

  function snapHover(ev: PointerEvent): { x: number; y: number } | null {
    const g = tileAt(ev.clientX, ev.clientY)
    if (!g || !armed) return null
    const [fw, fh] = propSize(armed, armedRot)
    return { x: Math.floor(g.x) - Math.floor(fw / 2), y: Math.floor(g.y) - Math.floor(fh / 2) }
  }

  const onMove = (ev: PointerEvent) => {
    if (armed) { hover = snapHover(ev); return }
    if (!drag || !session?.selected) return
    const sel = session.selected
    const g = tileAt(ev.clientX, ev.clientY, { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 })
    if (!g) return
    drag.x = Math.floor(g.x) - drag.dx
    drag.y = Math.floor(g.y) - drag.dy
    drag.moved = drag.x !== session.selected.x || drag.y !== session.selected.y
  }

  const onUp = (ev: PointerEvent) => {
    try { hit.releasePointerCapture(ev.pointerId) } catch { /* not captured */ }
    if (armed && hover) {
      const { x, y } = hover
      void host.run({ cmd: 'editor.place', args: { prop: armed, x, y, rot: armedRot } }).then(() => undefined, (e: unknown) => say(e instanceof Error ? e.message : String(e)))
      return
    }
    const d = drag
    drag = null
    if (d?.moved) lastDrop = { x: d.x, y: d.y }
    if (d?.moved) void host.run({ cmd: 'editor.move', args: { x: d.x, y: d.y } }).then(() => undefined, (e: unknown) => say(e instanceof Error ? e.message : String(e)))
  }

  hit.addEventListener('pointerdown', onDown)
  hit.addEventListener('pointermove', onMove)
  hit.addEventListener('pointerup', onUp)
  hit.addEventListener('pointercancel', () => { drag = null })
  const onKey = (e: KeyboardEvent) => {
    if (!active || e.key !== 'Escape') return
    e.preventDefault(); e.stopImmediatePropagation()
    if (armed) armed = null
    else session?.select(null)
    status = ''
  }
  window.addEventListener('keydown', onKey, true)

  // ------------------------------------------------------------------ the API behind the commands

  const info = (): EditorInfo => {
    const e = session?.selected ?? null
    return {
      active, busy, armed,
      selected: e ? { kind: e.kind, label: e.label, x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot, template: e.template, sharedBy: session?.sharedBy(e) ?? 1 } : null,
      canUndo: !!session?.canUndo, canRedo: !!session?.canRedo, lastDrop, written: !!session?.written,
    }
  }

  async function guarded(work: () => Promise<EditResult>): Promise<EditorInfo> {
    if (!session?.ready || !active) throw new DevError('dev.ed.err.closed')
    if (busy) throw new DevError('dev.ed.err.busy')
    busy = true
    say(t('dev.ed.working'))
    try {
      const res = await work()
      if (!res.ok) { const err = explain(res); say(err.message); throw err }
      say(session.selected ? describe(session.selected) : t('dev.ed.done'))
      if (session.written) bar.classList.add('apd-ed__bar--stale')
      return info()
    } finally { busy = false }
  }

  const hot = (import.meta as unknown as { hot?: { on(event: string, cb: () => void): void } }).hot
  hot?.on('ap:content-updated', () => { if (session) session.written = true })

  return {
    info,
    async open() {
      if (active) return info()
      if (busy) throw new DevError('dev.ed.err.busy')
      busy = true
      try {
        session ??= new EditorSession({
          docs: LAYOUT_DOCS,
          build: () => {
            const entries: ProvEntry[] = [], regions: ProvRegion[] = []
            const w = buildWorld(host.world.seed, { provenance: { add: (e) => entries.push(e), region: (r) => regions.push(r) } })
            return { entries, regions, problems: worldBuildInfo(w).problems, content: validateWorldContent() }
          },
          size: propSize, hash: fetchHash, write: writeBack, undoDepth: EDITOR.undoDepth,
        })
        say(t('dev.ed.building'))
        bar.hidden = false
        // Let the message paint before the synchronous world build blocks the page for a couple of seconds.
        await new Promise((ok) => setTimeout(ok, 30))
        try { await session.open() } catch (err) { bar.hidden = true; session = null; throw new DevError('dev.ed.err.endpoint', { why: (err as Error).message }) }
        active = true
        gate.hold('editor')
        hit.hidden = false
        svg.style.display = ''
        say(t('dev.ed.ready', { n: session.entries.length }))
        raf = requestAnimationFrame(draw)
        return info()
      } finally { busy = false }
    },
    close() {
      active = false
      armed = null; drag = null; hover = null
      hit.hidden = true; bar.hidden = true; svg.style.display = 'none'
      gate.release('editor')
      session?.select(null)
      status = ''
      return info()
    },
    select(x, y, map) {
      if (!session?.ready || !active) throw new DevError('dev.ed.err.closed')
      const e = session.entryAt(map ?? mapId(), Math.floor(x), Math.floor(y))
      session.select(e)
      if (e) say(describe(e)); else say(t('dev.ed.none'))
      return info()
    },
    move: (x, y) => guarded(() => session!.move(Math.floor(x), Math.floor(y))),
    rotate: () => guarded(() => session!.rotate()),
    remove: () => guarded(() => session!.remove()),
    async place(prop, x, y, rot = 0) {
      if (!session?.ready || !active) throw new DevError('dev.ed.err.closed')
      if (prop === null) { armed = null; return info() }
      if (!CONTENT.props[prop]) throw new DevError('dev.ed.err.unknownProp', { prop })
      if (x === undefined || y === undefined) { armed = prop; armedRot = rot; say(t('dev.ed.armed', { prop })); return info() }
      const out = await guarded(() => session!.place(mapId(), prop, Math.floor(x), Math.floor(y), rot))
      return out
    },
    undo: () => guarded(() => session!.undo()),
    redo: () => guarded(() => session!.redo()),
    reload() {
      host.ctx.persist('dev')
      location.reload()
    },
    destroy() { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey, true); svg.remove(); hit.remove(); bar.remove() },
  }
}
