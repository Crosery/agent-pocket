// World map: a pannable / zoomable view of the whole overworld — the core continent and the infinite frontier —
// under the fog of war (SaveData.explored pages). Map tiles are baked lazily per level of detail (64 px each,
// LRU cache shared across openings, a per-frame time budget, coarser tiles stand in while finer ones bake);
// only explored cells are sampled, so the unexplored infinite void costs nothing. Overlay: discovered places
// (towns, hamlets, landmarks, dungeons), frontier province names with danger stars, core region names and the
// player. Arrow keys / stick / drag pan; zoom keys / wheel / pinch / buttons zoom; places snap to the centre
// cursor. In fly mode the selected fly target (visited town or discovered place) resolves its id; in anchor mode an
// activated teleport anchor does (discovered-but-inactive anchors are pinned grey); else null.
import type { ChunkProvider, GameMap, RegionDef, TownDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { isInfinite } from '../../../shared/world/worldapi.ts'
import { anchorSpotFromId, type AnchorSpot } from '../../../shared/world/anchors.ts'
import { anchorGroup, anchorName, anchorPlace, isUnlocked, travelDestinations } from '../../world/anchors.ts'
import { EXPLORE, type PlaceKind } from '../../world/explore-config.ts'
import { fogPagesFor, isFlyTarget, knownPlaces, placeKindOf } from '../../world/explore.ts'
import { mapPings } from '../../world/places.ts'
import { UI_CONFIG } from '../config.ts'
import { FogPages, fogGrid } from '../fog.ts'
import { decodeExplored } from '../minimap.ts'
import { bakeChunkPixels, bakeMapPixels, regionCentroids, shadeTile, terrainColor, type RegionLabel } from '../mapbake.ts'
import { parseColor, type Bitmap, type RGBA } from '../pixel.ts'
import { getUIScale, onUIScaleChange } from '../scale.ts'
import { button, el } from '../widgets.ts'
import { provincesIn, quickSample, regionUnder, type ProvinceLabel } from '../worldgeo.ts'
import { backPressed, frame, icon, meterIcons, openScreen, pressed, setChildren, uiSfx, type Hint, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { overworldPosition } from './logic.ts'
import { humanDistance, placeFacts } from './placeinfo.ts'
import './gameplay.css'

const WM = EXPLORE.worldMap

interface TileEntry { cv: HTMLCanvasElement; stamp: number; full: boolean }
interface MapCache { tiles: Map<string, TileEntry>; core: Bitmap | null; regions: RegionLabel[] | null }

/** Per-overworld caches (core bake, region centroids, LOD tiles) kept across openings. */
const CACHES = new WeakMap<GameMap, MapCache>()

function cacheFor(map: GameMap): MapCache {
  let c = CACHES.get(map)
  if (!c) { c = { tiles: new Map(), core: null, regions: null }; CACHES.set(map, c) }
  return c
}

/** Hash of the fog pages overlapping a tile rect (changes whenever a cell inside is revealed). */
function fogHash(fog: FogPages, x0: number, y0: number, x1: number, y1: number): number {
  const span = fog.cell * fog.pageCells
  let h = 17
  for (let py = Math.floor(y0 / span); py <= Math.floor((y1 - 1) / span); py++) {
    for (let px = Math.floor(x0 / span); px <= Math.floor((x1 - 1) / span); px++) h = (Math.imul(h, 31) + fog.pageVersion(px, py)) | 0
  }
  return h
}

/** Explored flag per pixel of a T×T map tile whose pixels are `span` tiles wide. */
function fogMask(fog: FogPages, x0: number, y0: number, span: number, T: number): Uint8Array {
  const mask = new Uint8Array(T * T)
  const C = fog.cell
  const size = T * span
  fog.forEachCell(Math.floor(x0 / C), Math.floor(y0 / C), Math.ceil((x0 + size) / C), Math.ceil((y0 + size) / C), (cx, cy) => {
    const a = Math.max(0, Math.floor((cx * C - x0) / span)), b = Math.min(T - 1, Math.floor(((cx + 1) * C - 1 - x0) / span))
    const c = Math.max(0, Math.floor((cy * C - y0) / span)), d = Math.min(T - 1, Math.floor(((cy + 1) * C - 1 - y0) / span))
    for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) mask[y * T + x] = 1
  })
  return mask
}

interface BakeEnv { map: GameMap; provider: ChunkProvider | null; core: Bitmap; fog: FogPages }

/** Bakes one LOD tile: core pixels from the core bake (dimmed under fog), explored frontier sampled, rest void. */
function bakeTile(env: BakeEnv, L: number, i: number, j: number): TileEntry {
  const T = WM.tilePx, span = 2 ** L, size = T * span
  const x0 = i * size, y0 = j * size
  const fog = env.fog
  const stamp = fogHash(fog, x0, y0, x0 + size, y0 + size)
  const mask = fog.anyPage(x0, y0, x0 + size, y0 + size) ? fogMask(fog, x0, y0, span, T) : null
  const data = new Uint8ClampedArray(T * T * 4)
  const voidCol = parseColor(WM.unexploredColor)
  const fogCol = parseColor(UI_CONFIG.minimap.fog.color)
  const fogA = UI_CONFIG.minimap.fog.alpha
  const core = env.core
  const p = env.provider
  let chunk: Bitmap | null = null
  let full = true
  const prev = new Int16Array(T).fill(-1)
  const cur = new Int16Array(T).fill(-1)
  for (let py = 0; py < T; py++) {
    for (let px = 0; px < T; px++) {
      const tx = x0 + px * span, ty = y0 + py * span
      const explored = !!mask && mask[py * T + px] === 1
      let col: RGBA = voidCol
      cur[px] = -1
      if (tx >= 0 && ty >= 0 && tx < core.width && ty < core.height) {
        const o = (ty * core.width + tx) * 4
        const c: RGBA = [core.data[o], core.data[o + 1], core.data[o + 2], 255]
        col = explored ? c : WM.coreFogTerrain
          ? [c[0] + (fogCol[0] - c[0]) * fogA, c[1] + (fogCol[1] - c[1]) * fogA, c[2] + (fogCol[2] - c[2]) * fogA, 255]
          : voidCol
      } else if (explored && p) {
        if (L === 0 && T === p.size) {
          if (!chunk) { const r = bakeChunkPixels(p, i, j); chunk = r.bmp; full = r.full }
          const o = (py * T + px) * 4
          col = [chunk.data[o], chunk.data[o + 1], chunk.data[o + 2], 255]
        } else {
          const s = quickSample(p, tx, ty)
          cur[px] = s.elevation
          const nw = px > 0 && prev[px - 1] >= 0 ? prev[px - 1] : s.elevation
          const north = prev[px] >= 0 ? prev[px] : s.elevation
          col = shadeTile(terrainColor(s.terrain), tx, ty, s.elevation, nw, north)
        }
      }
      const o = (py * T + px) * 4
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255
    }
    prev.set(cur)
  }
  const cv = document.createElement('canvas')
  cv.width = T
  cv.height = T
  cv.getContext('2d')!.putImageData(new ImageData(data, T, T), 0, 0)
  return { cv, stamp, full }
}

type MarkKind = PlaceKind | 'anchor' | 'anchorGrand'

/**
 * Place or teleport-anchor marker. A place keeps its pin and wears its anchor (`anchor`, `on`); an anchor in the
 * wild is a pin of its own. `fly`: the place can be flown to once the mode allows it.
 */
interface PlaceMark { id: string; name: string; x: number; y: number; kind: MarkKind; place: TownDef | null; anchor: AnchorSpot | null; on: boolean; fly: boolean; el: HTMLButtonElement }

export function worldMapScreen(env: ScreenEnv, opts: { fly: boolean; anchors?: boolean }): Promise<string | null> {
  const { ctx } = env
  const world = ctx.data.world
  const map = world.maps[world.startMap]
  if (!map) return Promise.resolve(null)
  const cfg = SCREENS.worldMap
  const provider = map.infinite ?? null
  const cache = cacheFor(map)
  if (!cache.core) cache.core = bakeMapPixels(map)
  const core = cache.core

  // Fog: the live fog pages of the infinite overworld; finite overworlds rebuild them from the minimap bitset.
  const cell = CONTENT.config.world.chunk
  let fog: FogPages
  if (isInfinite(map)) fog = fogPagesFor(ctx.save, world)
  else {
    fog = new FogPages(cell, EXPLORE.fog.pageCells)
    const live = ctx.overworld.player.map === map.id ? ctx.minimap.exploredBits() : null
    const bits = live ?? decodeExplored(ctx.save.exploredChunks[map.id], map)
    if (bits) fog.importGrid(bits, fogGrid(map.width, map.height, cell))
  }
  const player = overworldPosition(world, ctx.overworld.player.map, ctx.overworld.player.x, ctx.overworld.player.y)
  if (player) fog.revealAround(player.x, player.y, UI_CONFIG.minimap.fog.revealRadiusChunks)

  const places: Omit<PlaceMark, 'el'>[] = knownPlaces(world, ctx.save, fog).map((place) => ({
    id: place.id, name: place.nameZh, x: place.x, y: place.y, kind: placeKindOf(world, place), place, anchor: null, on: false, fly: isFlyTarget(world, ctx.save, place),
  }))
  // Teleport anchors: every one seen (grey until activated); in fly-only mode they would be pins nobody can use.
  const anchorsOn = !!opts.anchors
  const pins: Omit<PlaceMark, 'el'>[] = []
  if (!opts.fly || anchorsOn) {
    const hosts = new Map(places.map((m) => [m.id, m]))
    for (const id of new Set([...(ctx.save.anchors?.seen ?? []), ...(ctx.save.anchors?.unlocked ?? [])])) {
      const spot = anchorSpotFromId(id)
      if (!spot) continue
      const host = hosts.get(anchorPlace(world, spot)?.id ?? '')
      if (host && !host.anchor) { host.anchor = spot; host.on = isUnlocked(ctx.save, id); continue }
      pins.push({ id, name: anchorName(world, spot), x: spot.cx - 0.5, y: spot.cy - 0.5, kind: spot.kind === 'grand' ? 'anchorGrand' : 'anchor', place: null, anchor: spot, on: isUnlocked(ctx.save, id), fly: false })
    }
  }
  const travel = opts.fly || anchorsOn
  const byAnchor = (m: Pick<PlaceMark, 'anchor' | 'on'>) => anchorsOn && !!m.anchor && m.on
  const byFly = (m: Pick<PlaceMark, 'place' | 'fly'>) => opts.fly && !!m.place && m.fly
  /** Can this marker be picked as the destination in the current mode? */
  const goes = (m: PlaceMark | Omit<PlaceMark, 'el'>) => byAnchor(m) || byFly(m)
  /** What picking it resolves: its anchor (works without the town-fly gate) or its place. */
  const target = (m: PlaceMark) => (byAnchor(m) ? m.anchor!.id : m.id)
  const pickable = [...places, ...pins].filter(goes)
  if (travel && !pickable.length) {
    ctx.ui.toast(t(anchorsOn ? 'screens.map.noTargets' : 'screens.map.noFlyTargets'), 'warn')
    return Promise.resolve(null)
  }
  const homeDest = anchorsOn ? travelDestinations(world, ctx.save, player ?? map.spawn).home : null
  if (!cache.regions) cache.regions = regionCentroids(map).filter((r) => map.regions[r.index]?.nameZh && !map.regions[r.index].isTown && r.tiles >= cfg.minLabelTiles)
  const coreRegions = cache.regions

  return openScreen<string | null>(env, `aps-map${travel ? ' is-fly' : ''}`, (api) => {
    const f = frame(env, { title: t(anchorsOn ? 'screens.map.anchorTitle' : opts.fly ? 'screens.map.flyTitle' : 'screens.map.title'), glyph: 'map', onClose: api.guard(() => api.close(null)) })
    const cv = el('canvas', 'aps-map-canvas')
    const labels = el('div', 'aps-map-labels')
    const markers = el('div', 'aps-map-marks')
    const cursor = el('div', 'aps-map-cursor', [icon(WM.cursorGlyph)])
    const tools = el('div', 'aps-map-tools')
    const stage = el('div', 'aps-map-stage is-free', [cv, labels, markers, cursor, tools])
    const view = el('div', 'aps-map-view ap-panel', [stage])
    const side = el('div', 'aps-map-side ap-panel')
    const P = cfg.panel
    f.body.append(el('div', {
      class: 'aps-map-layout',
      vars: { '--wm-side': P.widthUnits, '--wm-desc-open': P.descLinesOpen },
    }, [view, side]))
    // Key caps and pad names mean nothing to a finger: touch gets no footer (the close button, pins and the action button do the work).
    let hintDevice = ctx.input.lastDevice
    const paintHints = () => {
      hintDevice = ctx.input.lastDevice
      if (hintDevice === 'touch') { f.setHints([]); return }
      const hints: Hint[] = [
        ['lr', t('screens.map.hint.pan')], ['minimap', t('screens.map.hint.zoomIn')], ['bike', t('screens.map.hint.zoomOut')],
        ['run', t('screens.map.hint.next')], ...(travel ? [['confirm', t(anchorsOn ? 'screens.map.hint.warp' : 'screens.map.hint.fly')] as Hint] : []),
        ['cancel', t('screens.hint.back')],
      ]
      f.setHints(hints)
    }
    paintHints()
    api.root.append(f.el)

    // ------------------------------------------------------------------ camera
    let zoomIdx = Math.max(0, Math.min(WM.zooms.length - 1, WM.initialZoom))
    let cam = player ? { x: player.x + 0.5, y: player.y + 0.5 } : { x: map.spawn.x + 0.5, y: map.spawn.y + 0.5 }
    let cssW = 1, cssH = 1, dpr = 1
    let dirty = true
    let overlayDirty = true
    let panAxis = { x: 0, y: 0 }
    let sel: PlaceMark | null = null
    let sideT = 0
    let declutterT = 0
    let firstPlaced = false
    const zoom = () => WM.zooms[zoomIdx]

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      cssW = Math.max(1, stage.clientWidth)
      cssH = Math.max(1, stage.clientHeight)
      cv.width = Math.max(1, Math.round(cssW * dpr))
      cv.height = Math.max(1, Math.round(cssH * dpr))
      dirty = overlayDirty = true
    }

    const setZoom = (idx: number, anchor?: { sx: number; sy: number }) => {
      const next = Math.max(0, Math.min(WM.zooms.length - 1, idx))
      if (next === zoomIdx) return
      if (anchor) {
        // Keep the world point under the pointer fixed.
        const wx = cam.x + (anchor.sx - cssW / 2) / zoom(), wy = cam.y + (anchor.sy - cssH / 2) / zoom()
        zoomIdx = next
        cam = { x: wx - (anchor.sx - cssW / 2) / zoom(), y: wy - (anchor.sy - cssH / 2) / zoom() }
      } else zoomIdx = next
      uiSfx(env, 'move')
      dirty = overlayDirty = true
    }

    // ------------------------------------------------------------------ tiles
    const bakeEnv: BakeEnv = { map, provider, core, fog }
    let queue: { L: number; i: number; j: number; d: number }[] = []
    const lodNow = () => {
      const tilesPerDevPx = 1 / (zoom() * dpr)
      return Math.max(0, Math.min(WM.maxLod, Math.floor(Math.log2(Math.max(1, tilesPerDevPx)))))
    }
    const keyOf = (L: number, i: number, j: number) => `${L}:${i}:${j}`
    const lookup = (L: number, i: number, j: number): TileEntry | null => {
      const k = keyOf(L, i, j)
      const e = cache.tiles.get(k)
      if (!e) return null
      cache.tiles.delete(k)
      cache.tiles.set(k, e)
      return e
    }
    const fresh = (L: number, i: number, j: number, e: TileEntry): boolean => {
      const size = WM.tilePx * 2 ** L
      if (e.stamp !== fogHash(fog, i * size, j * size, (i + 1) * size, (j + 1) * size)) return false
      if (!e.full && provider) {
        const S = provider.size
        if (provider.peek(i, j) && provider.peek(i - 1, j) && provider.peek(i, j - 1) && provider.peek(i - 1, j - 1) && S === WM.tilePx && L === 0) return false
      }
      return true
    }
    const store = (L: number, i: number, j: number, e: TileEntry) => {
      cache.tiles.set(keyOf(L, i, j), e)
      while (cache.tiles.size > WM.cacheTiles) cache.tiles.delete(cache.tiles.keys().next().value!)
    }

    const render = () => {
      const g = cv.getContext('2d')!
      g.imageSmoothingEnabled = false
      g.fillStyle = WM.unexploredColor
      g.fillRect(0, 0, cv.width, cv.height)
      const z = zoom() * dpr
      const L = lodNow()
      const size = WM.tilePx * 2 ** L
      const vx0 = cam.x - cv.width / 2 / z, vy0 = cam.y - cv.height / 2 / z
      const vx1 = vx0 + cv.width / z, vy1 = vy0 + cv.height / z
      const missing: typeof queue = []
      for (let j = Math.floor(vy0 / size); j <= Math.floor(vy1 / size); j++) {
        for (let i = Math.floor(vx0 / size); i <= Math.floor(vx1 / size); i++) {
          const dx = Math.floor((i * size - vx0) * z), dy = Math.floor((j * size - vy0) * z)
          const dw = Math.ceil(size * z) + 1
          const e = lookup(L, i, j)
          if (e) g.drawImage(e.cv, dx, dy, dw, dw)
          if (e && fresh(L, i, j, e)) continue
          missing.push({ L, i, j, d: Math.hypot((i + 0.5) * size - cam.x, (j + 0.5) * size - cam.y) })
          if (e) continue
          // A coarser cached tile stands in until this one is baked.
          for (let up = L + 1; up <= WM.maxLod; up++) {
            const k = 2 ** (up - L)
            const ci = Math.floor(i / k), cj = Math.floor(j / k)
            const c = cache.tiles.get(keyOf(up, ci, cj))
            if (!c) continue
            const sw = WM.tilePx / k
            g.drawImage(c.cv, (i - ci * k) * sw, (j - cj * k) * sw, sw, sw, dx, dy, dw, dw)
            break
          }
        }
      }
      // Faint coordinate grid: the world goes on beyond what was explored.
      const gs = WM.gridEveryTiles
      if (gs > 0 && gs * z >= 24) {
        g.strokeStyle = WM.gridColor
        g.lineWidth = 1
        g.beginPath()
        for (let x = Math.ceil(vx0 / gs) * gs; x <= vx1; x += gs) { const sx = Math.round((x - vx0) * z) + 0.5; g.moveTo(sx, 0); g.lineTo(sx, cv.height) }
        for (let y = Math.ceil(vy0 / gs) * gs; y <= vy1; y += gs) { const sy = Math.round((y - vy0) * z) + 0.5; g.moveTo(0, sy); g.lineTo(cv.width, sy) }
        g.stroke()
      }
      queue = missing.sort((a, b) => a.d - b.d)
    }

    const bakeSome = () => {
      if (!queue.length) return
      const start = performance.now()
      while (queue.length && performance.now() - start < WM.budgetMs) {
        const q = queue.shift()!
        store(q.L, q.i, q.j, bakeTile(bakeEnv, q.L, q.i, q.j))
        dirty = true
      }
    }

    // ------------------------------------------------------------------ overlay
    const toScreen = (x: number, y: number) => ({ sx: (x - cam.x) * zoom() + cssW / 2, sy: (y - cam.y) * zoom() + cssH / 2 })
    const inView = (s: { sx: number; sy: number }, m = 40) => s.sx > -m && s.sy > -m && s.sx < cssW + m && s.sy < cssH + m
    const place = (node: HTMLElement, x: number, y: number): boolean => {
      const s = toScreen(x, y)
      const show = inView(s)
      node.hidden = !show
      if (show) { node.style.left = `${Math.round(s.sx)}px`; node.style.top = `${Math.round(s.sy)}px` }
      return show
    }

    const marks: PlaceMark[] = [...places, ...pins].map((p) => {
      const pin = !p.place
      const palette = pin
        ? WM.anchorPalettes[p.on ? 'on' : 'off']
        : p.fly ? WM.placePalettes.fly : opts.fly ? WM.placePalettes.locked : WM.placePalettes.known
      const glyph = p.place ? WM.placeGlyphs[p.kind as PlaceKind] ?? cfg.townGlyph : WM.anchorGlyphs[p.anchor!.kind]
      const dim = pin ? travel && !p.on : opts.fly && !p.fly
      const node = el('button', {
        class: `aps-map-town is-${p.kind}${p.fly ? ' is-visited' : ''}${dim ? ' is-locked' : ''}${p.anchor ? ` has-anchor ${p.on ? 'is-on' : 'is-off'}` : ''}${pin ? ' is-anchor' : ''}`,
        attrs: { type: 'button', 'aria-label': p.name },
      }, [
        icon(glyph, { palette }),
        !pin && p.anchor ? icon(WM.anchorGlyphs.minor, { className: 'aps-map-town-badge', palette: WM.anchorPalettes[p.on ? 'on' : 'off'] }) : null,
        el('span', { class: 'aps-map-town-name', text: p.name }),
      ])
      const mark: PlaceMark = { ...p, el: node }
      node.addEventListener('click', api.guard(() => {
        if (sel === mark && goes(mark)) { void fly(); return }
        focusPlace(mark)
      }))
      return mark
    })
    markers.append(...marks.map((m) => m.el))
    const playerEl = player ? el('div', { class: 'aps-map-player', vars: { '--blink': `${SCREENS.anim.mapBlinkMs}ms` } }, [icon(cfg.playerGlyph)]) : null
    if (playerEl) markers.append(playerEl)
    // World-event pings (roaming legends' fuzzy areas, active events, MYTHIC chain steps, places revealed by events).
    const pings = mapPings({ world, save: ctx.save, minutes: ctx.save.clockMinutes, player }).filter((p) => p.map === map.id)
      .map((p) => ({ p, el: el('div', { class: `aps-map-ping is-${p.kind}`, vars: { '--pc': p.color }, attrs: { title: p.label } }, [el('span', 'aps-map-ping-ring'), el('span', { class: 'aps-map-ping-label', text: p.label })]) }))
    markers.append(...pings.map((x) => x.el))

    const regionEls = new Map<number, HTMLElement>()
    const provinceEls = new Map<string, HTMLElement>()
    const regionEl = (r: RegionLabel) => {
      let n = regionEls.get(r.index)
      if (!n) { n = el('div', { class: 'aps-map-region', text: map.regions[r.index].nameZh }); regionEls.set(r.index, n); labels.append(n) }
      return n
    }
    const provinceEl = (pv: ProvinceLabel) => {
      let n = provinceEls.get(pv.key)
      if (!n) {
        n = el('div', { class: `aps-map-region is-province is-danger-${pv.danger}` }, [
          el('span', { class: 'aps-map-pname', text: pv.nameZh }),
          el('span', { class: 'aps-map-stars', text: EXPLORE.banner.starOn.repeat(Math.min(EXPLORE.banner.dangerTiers, pv.danger + 1)) }),
        ])
        provinceEls.set(pv.key, n)
        labels.append(n)
      }
      return n
    }

    /** Wild anchor pins yield to places, to stronger pins (selected, grand, activated) and to the map tools. */
    const declutterPins = () => {
      const touch = document.documentElement.dataset.touchControls === 'on'
      const sp = Math.max(WM.pinSpacingUnits * getUIScale().screenCssPerUnit, touch ? WM.pinTouchPx : 0)
      const cellOf = (v: number) => Math.floor(v / sp)
      const taken = new Map<string, { sx: number; sy: number }[]>()
      const take = (sx: number, sy: number) => {
        const k = `${cellOf(sx)},${cellOf(sy)}`
        const list = taken.get(k)
        if (list) list.push({ sx, sy }); else taken.set(k, [{ sx, sy }])
      }
      const near = (sx: number, sy: number) => {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          for (const o of taken.get(`${cellOf(sx) + dx},${cellOf(sy) + dy}`) ?? []) if (Math.hypot(o.sx - sx, o.sy - sy) < sp) return true
        }
        return false
      }
      const stage0 = stage.getBoundingClientRect()
      const tool = tools.getBoundingClientRect()
      const rect = { l: tool.left - stage0.left - sp, t: tool.top - stage0.top - sp, r: tool.right - stage0.left + sp, b: tool.bottom - stage0.top + sp }
      const pinsLeft: PlaceMark[] = []
      const placeBoxes: DOMRect[] = []
      for (const m of marks) {
        if (m.el.hidden) continue
        const s = toScreen(m.x + 0.5, m.y + 0.5)
        if (m.place) {
          take(s.sx, s.sy)
          placeBoxes.push(m.el.getBoundingClientRect())
        } else pinsLeft.push(m)
      }
      const onPlace = (m: PlaceMark) => {
        const r = m.el.getBoundingClientRect()
        return placeBoxes.some((l) => r.left < l.right && r.right > l.left && r.top < l.bottom && r.bottom > l.top)
      }
      const rank = (m: PlaceMark) => (m === sel ? 0 : m.kind === 'anchorGrand' ? 1 : m.on ? 2 : 3)
      for (const m of pinsLeft.sort((a, b) => rank(a) - rank(b))) {
        const s = toScreen(m.x + 0.5, m.y + 0.5)
        const underTool = s.sx >= rect.l && s.sx <= rect.r && s.sy >= rect.t && s.sy <= rect.b
        if (m !== sel && (underTool || near(s.sx, s.sy) || onPlace(m))) { m.el.hidden = true; continue }
        take(s.sx, s.sy)
      }
    }

    const layoutOverlay = () => {
      const z = zoom()
      const showNames = z >= WM.placeNameMinZoom
      for (const m of marks) {
        place(m.el, m.x + 0.5, m.y + 0.5)
        m.el.classList.toggle('is-named', showNames || m === sel)
      }
      declutterPins()
      if (playerEl && player) place(playerEl, player.x + 0.5, player.y + 0.5)
      for (const pg of pings) {
        place(pg.el, pg.p.x + 0.5, pg.p.y + 0.5)
        pg.el.style.setProperty('--pd', `${Math.round(pg.p.radius * 2 * z)}px`)
        pg.el.classList.toggle('is-named', showNames)
      }
      const vx0 = cam.x - cssW / 2 / z, vy0 = cam.y - cssH / 2 / z, vx1 = cam.x + cssW / 2 / z, vy1 = cam.y + cssH / 2 / z
      const regionsOn = z >= WM.regionLabelMinZoom
      for (const r of coreRegions) {
        const visible = regionsOn && r.x >= vx0 && r.y >= vy0 && r.x < vx1 && r.y < vy1 && fog.tileExplored(r.x, r.y)
        const n = visible ? regionEl(r) : regionEls.get(r.index)
        if (!n) continue
        if (visible) place(n, r.x + 0.5, r.y + 0.5)
        else n.hidden = true
      }
      const shown = new Set<string>()
      if (provider && z >= WM.provinceLabelMinZoom) {
        for (const pv of provincesIn(provider, vx0, vy0, vx1, vy1)) {
          const r = Math.max(fog.cell * 2, Math.floor(fog.cell * fog.pageCells / 4))
          if (!fog.anyPage(pv.x - r, pv.y - r, pv.x + r, pv.y + r) || !fog.anyExplored(pv.x - r, pv.y - r, pv.x + r, pv.y + r)) continue
          shown.add(pv.key)
          place(provinceEl(pv), pv.x + 0.5, pv.y + 0.5)
        }
      }
      for (const [k, n] of provinceEls) if (!shown.has(k)) n.hidden = true
      declutterT = 0.12
    }

    // Labels yield to place names, the player marker and each other (core regions after provinces).
    const declutter = () => {
      // The zoom / home / legend buttons sit over the map: no label may end up half behind them.
      const toolBox = tools.getBoundingClientRect()
      const placed: DOMRect[] = toolBox.width ? [new DOMRect(toolBox.left - 4, toolBox.top - 4, toolBox.width + 8, toolBox.height + 8)] : []
      const clear = (r: DOMRect) => r.left < toolBox.right + 4 && r.right > toolBox.left - 4 && r.top < toolBox.bottom + 4 && r.bottom > toolBox.top - 4
      for (const n of markers.querySelectorAll<HTMLElement>('.aps-map-town-name')) n.classList.toggle('is-cluttered', n.offsetParent !== null && clear(n.getBoundingClientRect()))
      // Event-ping labels are cut by the map's edge or sit behind the tools: show them only when whole.
      const box = stage.getBoundingClientRect()
      for (const pg of pings) {
        const label = pg.el.querySelector<HTMLElement>('.aps-map-ping-label')
        if (!label || label.offsetParent === null) continue
        const r = label.getBoundingClientRect()
        pg.el.classList.toggle('is-cluttered', r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom || clear(r))
      }
      const hits = (r: DOMRect) => placed.some((p) => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top)
      for (const n of markers.querySelectorAll<HTMLElement>('.aps-map-town:not([hidden]) .ap-glyph, .aps-map-town.is-named:not([hidden]) .aps-map-town-name, .aps-map-player:not([hidden])')) {
        const r = n.getBoundingClientRect()
        if (r.width && r.height) placed.push(r)
      }
      for (const n of [...provinceEls.values(), ...regionEls.values()]) {
        if (n.hidden) continue
        n.classList.remove('is-cluttered')
        const r = n.getBoundingClientRect()
        if (hits(r)) n.classList.add('is-cluttered')
        else placed.push(r)
      }
    }

    /** Selects the mark under the cursor; true when the selection changed (its name shows, so pins re-declutter). */
    const snap = (): boolean => {
      let best: PlaceMark | null = null
      let bd = WM.snapPx
      for (const m of travel ? marks.filter(goes) : marks) {
        const s = toScreen(m.x + 0.5, m.y + 0.5)
        const d = Math.hypot(s.sx - cssW / 2, s.sy - cssH / 2)
        if (d <= bd) { bd = d; best = m }
      }
      if (best !== sel) {
        sel?.el.classList.remove('is-active')
        sel = best
        sel?.el.classList.add('is-active')
        sideT = 0
        return true
      }
      return false
    }

    const focusPlace = (m: PlaceMark) => {
      cam = { x: m.x + 0.5, y: m.y + 0.5 }
      uiSfx(env, 'move')
      dirty = overlayDirty = true
    }

    const nextPlace = () => {
      const list = (travel ? marks.filter(goes) : marks).slice()
      if (!list.length) return
      const from = player ?? cam
      list.sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))
      const at = sel ? list.indexOf(sel) : -1
      focusPlace(list[(at + 1) % list.length])
    }

    const home = () => {
      if (!player) return
      cam = { x: player.x + 0.5, y: player.y + 0.5 }
      uiSfx(env, 'move')
      dirty = overlayDirty = true
    }

    // ------------------------------------------------------------------ side panel
    const nearest = (list: PlaceMark[]) => {
      const o = player ?? cam
      return list.sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))
    }
    const flyList = opts.fly && !anchorsOn ? nearest(marks.filter(goes)).slice(0, WM.flyList) : []
    let lastInfoKey = ''

    const anchorBtns: HTMLElement[] = []
    if (anchorsOn) {
      if (homeDest) {
        const b = button('', api.guard(() => { void pickAnchor(homeDest.id, homeDest.name) }), { className: 'aps-map-anchorbtn is-home' })
        b.append(icon(WM.anchorGlyphs.grand), el('span', { text: t('screens.anchor.home') }))
        anchorBtns.push(b)
      }
      const b = button('', api.guard(() => {
        void api.run(async () => {
          const id = await ctx.screens.anchorPicker({})
          if (id) api.close(id)
        })
      }), { className: 'aps-map-anchorbtn' })
      b.append(icon(WM.anchorGlyphs.minor), el('span', { text: t('screens.map.anchorList') }))
      anchorBtns.push(b)
    }

    // ------------------------------------------------------------------ side panel: what the cursor is on, nothing more
    let descOpen = false
    const chip = (glyph: string | null, text: string, cls = '', palette?: Record<string, string>) =>
      el('span', { class: `aps-fact${cls ? ` ${cls}` : ''}` }, [glyph ? icon(glyph, palette ? { palette } : undefined) : null, el('span', { text })])
    const levelsChip = (r: [number, number] | undefined | null) =>
      r ? chip(P.glyphs.levels, t('screens.map.fact.levels', { min: r[0], max: r[1] })) : null
    const stars = (r: RegionDef | null) => r && r.danger !== undefined
      ? el('span', 'aps-wm-danger', [meterIcons(Math.min(EXPLORE.banner.dangerTiers, r.danger + 1), EXPLORE.banner.dangerTiers, 'star', 'starOff')])
      : null

    /** "You are in {region}, near {place}": one line, from where the player really stands. */
    const youLine = (): string => {
      if (!player) return t('screens.map.youAway')
      const region = regionUnder(map, Math.floor(player.x), Math.floor(player.y))?.nameZh
      let near: PlaceMark | null = null
      let best = P.nearRadius
      for (const m of marks) {
        if (!m.place) continue
        const d = Math.hypot(m.x - player.x, m.y - player.y)
        if (d <= best) { best = d; near = m }
      }
      if (region && near && near.name !== region) return t('screens.map.youNear', { region, place: near.name })
      return t('screens.map.youIn', { region: region ?? near?.name ?? '' })
    }

    const selectedCard = (m: PlaceMark): HTMLElement[] => {
      const reg = regionUnder(map, Math.floor(m.x), Math.floor(m.y))
      const facts = m.place ? placeFacts(world, ctx.save, m.place) : null
      const isVisited = !!m.place && ctx.save.visitedTowns.includes(m.id)
      const known = !m.place || m.fly || isVisited || m.kind !== 'town'
      const chips: (HTMLElement | null)[] = [
        m.fly ? el('span', { class: 'aps-tag is-ok', text: t('screens.map.flyable') }) : null,
        m.place && !m.fly && m.kind === 'town' ? el('span', { class: 'aps-tag is-bad', text: t(isVisited ? 'screens.map.visited' : 'screens.map.notVisited') }) : null,
        ...(facts?.services.map((id) => {
          const sv = P.services.find((x) => x.id === id)!
          return chip(sv.glyph, t(sv.text))
        }) ?? []),
        facts?.gym ? chip(P.glyphs.gym, t(facts.gym.won ? 'screens.map.fact.gymWon' : 'screens.map.fact.gymOpen'), facts.gym.won ? 'is-ok' : '') : null,
        m.anchor ? chip(P.glyphs.anchor, t(m.on ? 'screens.map.fact.anchorOn' : 'screens.map.fact.anchorOff'), m.on ? 'is-ok' : 'is-off', WM.anchorPalettes[m.on ? 'on' : 'off']) : null,
        facts?.quest ? chip(P.glyphs.quest, t('screens.map.fact.quest'), 'is-quest') : null,
        levelsChip(facts?.levels ?? reg?.levelRange),
      ]
      const away = player ? el('span', { class: 'aps-wm-away ap-dim', text: t('screens.map.away', { distance: humanDistance(Math.hypot(m.x - player.x, m.y - player.y)) }) }) : null
      const act = goes(m) ? button(t(anchorsOn ? 'screens.map.hint.warp' : 'screens.map.hint.fly'), api.guard(() => { void fly() }), { className: 'aps-wm-act' }) : null
      const text = m.place
        ? (known ? m.place.description : t('screens.map.unknownTown'))
        : t(m.on ? 'screens.map.anchorDesc' : 'screens.map.anchorLockedDesc', { region: anchorGroup(world, m.anchor!) })
      const desc = el('p', { class: `aps-wm-desc${descOpen ? ' is-open' : ''}`, text, attrs: { title: text, 'data-expandable': '' } })
      desc.addEventListener('click', api.guard(() => { descOpen = !descOpen; lastInfoKey = ''; sideT = 0 }))
      return [
        el('div', 'aps-wm-head', [el('span', { class: 'aps-wm-name ap-gold', text: m.name }), el('span', { class: 'aps-tag', text: t(`screens.map.kind.${m.kind}`) })]),
        el('div', 'aps-wm-chips', chips),
        el('div', 'aps-wm-row', [away, act]),
        desc,
      ]
    }

    /** Nothing selected: the area under the cursor. */
    const areaCard = (tx: number, ty: number): HTMLElement[] => {
      if (!fog.tileExplored(tx, ty)) return [el('div', { class: 'aps-wm-name ap-dim', text: t('screens.map.unexplored') })]
      const r = regionUnder(map, tx, ty)
      if (!r) return []
      return [
        el('div', 'aps-wm-head', [el('span', { class: 'aps-wm-name ap-gold', text: r.nameZh }), stars(r)]),
        el('div', 'aps-wm-chips', [levelsChip(r.levelRange)]),
      ]
    }

    const paintSide = () => {
      const tx = Math.floor(cam.x), ty = Math.floor(cam.y)
      const key = `${sel?.id ?? ''}|${descOpen ? 1 : 0}|${tx >> 3}|${ty >> 3}|${fog.version}`
      if (key === lastInfoKey) return
      lastInfoKey = key
      const parts: (HTMLElement | null)[] = []
      if (anchorBtns.length) parts.push(el('div', 'aps-map-anchorbar', anchorBtns))
      parts.push(el('div', 'aps-wm-card', sel ? selectedCard(sel) : areaCard(tx, ty)))
      if (flyList.length) {
        parts.push(el('div', 'aps-map-flylist', flyList.slice(0, P.flyChips).map((m) => {
          const b = button('', api.guard(() => { if (sel === m) void fly(); else focusPlace(m) }), { className: `aps-map-flyitem${m === sel ? ' is-active' : ''}` })
          b.append(icon(WM.placeGlyphs[m.kind as PlaceKind], { palette: WM.placePalettes.fly }), el('span', { text: m.name }))
          return b
        })))
      }
      parts.push(el('div', { class: 'aps-wm-you ap-dim', text: youLine() }))
      setChildren(side, [el('div', 'aps-map-sidebody', parts)])
    }

    const fly = () => api.run(async () => {
      if (!sel || !goes(sel)) { uiSfx(env, 'error'); return }
      await pickMark(sel)
    })
    const pickMark = async (m: PlaceMark) => {
      const ask = byAnchor(m) ? t('screens.map.anchorConfirm', { name: m.name }) : t('screens.map.flyConfirm', { town: m.name })
      if (await ctx.ui.confirm(ask)) api.close(target(m))
    }
    const pickAnchor = (id: string, name: string) => api.run(async () => {
      if (await ctx.ui.confirm(t('screens.map.anchorConfirm', { name }))) api.close(id)
    })

    // ------------------------------------------------------------------ tools + pointer
    const zin = button('+', api.guard(() => setZoom(zoomIdx - 1)), { className: 'aps-map-tool' })
    const zout = button('-', api.guard(() => setZoom(zoomIdx + 1)), { className: 'aps-map-tool' })
    const homeBtn = button('', api.guard(home), { className: 'aps-map-tool' })
    homeBtn.append(icon(cfg.playerGlyph))
    zin.setAttribute('aria-label', t('screens.map.zoomIn'))
    zout.setAttribute('aria-label', t('screens.map.zoomOut'))
    homeBtn.setAttribute('aria-label', t('screens.map.home'))
    // The legend is one tap away instead of a block of the panel: a "?" among the tools opens an icon key over the map.
    const legendItems: (HTMLElement | null)[] = [
      el('span', 'ap-legend-item', [icon(cfg.townGlyph, { palette: WM.placePalettes.fly }), t(opts.fly ? 'screens.map.legendFly' : 'screens.map.legendVisited')]),
      el('span', 'ap-legend-item', [icon(cfg.townGlyph, { palette: opts.fly ? WM.placePalettes.locked : WM.placePalettes.known }), t(opts.fly ? 'screens.map.legendUnvisited' : 'screens.map.legendKnown')]),
      marks.some((m) => m.anchor && m.on) ? el('span', 'ap-legend-item', [icon(WM.anchorGlyphs.minor, { palette: WM.anchorPalettes.on }), t('screens.map.legendAnchorOn')]) : null,
      marks.some((m) => m.anchor && !m.on) ? el('span', 'ap-legend-item', [icon(WM.anchorGlyphs.minor, { palette: WM.anchorPalettes.off }), t('screens.map.legendAnchorOff')]) : null,
      player ? el('span', 'ap-legend-item', [icon(cfg.playerGlyph), t('screens.map.legendPlayer')]) : null,
      ...[...new Map(pings.map((x) => [x.p.kind === 'legend' ? 'legend' : 'event', x.p.color])).entries()].map(([k, color]) => el('span', 'ap-legend-item', [el('span', { class: 'aps-legend-ping', vars: { '--pc': color } }), t(`hud.minimap.legend.${k}`)])),
    ]
    const legendPop = el('div', 'aps-map-legendpop ap-panel', legendItems)
    legendPop.hidden = true
    const legendBtn = button('?', api.guard(() => { legendPop.hidden = !legendPop.hidden; legendBtn.classList.toggle('is-on', !legendPop.hidden) }), { className: 'aps-map-tool' })
    legendBtn.setAttribute('aria-label', t('screens.map.legend'))
    tools.append(zin, zout, homeBtn, legendBtn, legendPop)

    const pointers = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; moved: boolean } | null = null
    let pinch = 0
    const local = (e: PointerEvent | WheelEvent) => {
      const r = stage.getBoundingClientRect()
      return { sx: e.clientX - r.left, sy: e.clientY - r.top }
    }
    stage.addEventListener('pointerdown', api.guard((e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      stage.setPointerCapture(e.pointerId)
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false }
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = Math.hypot(a.x - b.x, a.y - b.y)
        drag = null
      }
    }))
    stage.addEventListener('pointermove', (e: PointerEvent) => {
      if (!pointers.has(e.pointerId) || api.busy) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2 && pinch > 0) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d / pinch > 1.35) { setZoom(zoomIdx - 1); pinch = d }
        else if (d / pinch < 0.74) { setZoom(zoomIdx + 1); pinch = d }
        return
      }
      if (!drag) return
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < WM.dragThreshold) return
      drag.moved = true
      cam = { x: cam.x - dx / zoom(), y: cam.y - dy / zoom() }
      drag.x = e.clientX
      drag.y = e.clientY
      dirty = overlayDirty = true
    })
    const release = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      pointers.delete(e.pointerId)
      if (drag && !drag.moved && pointers.size === 0 && !api.busy) {
        // Click on the map: centre the cursor there.
        const s = local(e)
        cam = { x: cam.x + (s.sx - cssW / 2) / zoom(), y: cam.y + (s.sy - cssH / 2) / zoom() }
        dirty = overlayDirty = true
      }
      if (pointers.size < 2) pinch = 0
      if (pointers.size === 0) drag = null
    }
    stage.addEventListener('pointerup', release)
    stage.addEventListener('pointercancel', release)
    stage.addEventListener('wheel', api.guard((e: WheelEvent) => {
      e.preventDefault()
      setZoom(zoomIdx + (e.deltaY > 0 ? WM.wheelStep : -WM.wheelStep), local(e))
    }), { passive: false })

    // Name widths change when the pixel font arrives: labels must be placed again.
    void document.fonts?.ready.then(() => { overlayDirty = true })
    const offScale = onUIScaleChange(() => requestAnimationFrame(resize))
    const onResize = () => resize()
    window.addEventListener('resize', onResize)

    // Fly mode starts on the nearest fly target; the view mode on the player.
    if (flyList.length) cam = { x: flyList[0].x + 0.5, y: flyList[0].y + 0.5 }
    requestAnimationFrame(resize)

    return {
      onInput(input) {
        if (backPressed(input) || pressed(input, 'map')) { api.close(null); return }
        const a = input.axis()
        panAxis = { x: a.x, y: a.y }
        if (pressed(input, 'minimap')) setZoom(zoomIdx - 1)
        else if (pressed(input, 'bike')) setZoom(zoomIdx + 1)
        else if (pressed(input, 'run')) nextPlace()
        else if (pressed(input, 'confirm')) {
          if (travel) void fly()
          else if (sel) focusPlace(sel)
          else home()
        }
      },
      update(dt) {
        if (Math.hypot(panAxis.x, panAxis.y) > 0.05) {
          const k = (WM.panSpeed * dt) / zoom()
          cam = { x: cam.x + panAxis.x * k, y: cam.y + panAxis.y * k }
          dirty = overlayDirty = true
        }
        panAxis = { x: 0, y: 0 }
        bakeSome()
        if (dirty) { dirty = false; render() }
        if (overlayDirty) {
          overlayDirty = false
          layoutOverlay()
          if (snap()) layoutOverlay()
          // The first picture is already tidy; later passes wait for the pan / zoom to settle (declutterT).
          if (!firstPlaced && cssW > 1) { firstPlaced = true; declutter() }
        }
        if (declutterT > 0) { declutterT -= dt; if (declutterT <= 0) declutter() }
        if (ctx.input.lastDevice !== hintDevice) paintHints()
        sideT -= dt
        if (sideT <= 0) { sideT = 0.12; paintSide() }
      },
      onShow() { requestAnimationFrame(resize) },
      dispose() { offScale(); window.removeEventListener('resize', onResize) },
    }
  }, () => null)
}
