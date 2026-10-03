// Procedural chibi pixel painter shared by creature sprites and character walk sheets.
// Parts are cel-shaded with hue-shifted ramps, separated by inner contours and wrapped in a selective outline.
import type { ChibiDims, MotifDef, PlaceholdersFile, StampDef } from './placeholders-data.ts'
import type { PixelImage, RGB } from './pixel.ts'
import { alphaAt, blendPx, createImage, getRgb, hexToRgb, makeRamp, mix, setPx, shift } from './pixel.ts'

export type ChibiView = 'front' | 'back' | 'side'

export interface ResolvedMotif { def: MotifDef; color: RGB }

export interface ChibiLook {
  skin: RGB
  hair: RGB
  hairStyle: string
  eyes: RGB
  eyeStyle: string
  mouth: string
  top: RGB
  trim: RGB
  topStyle: string
  bottom: RGB
  bottomStyle: string
  shoes: RGB
  hat: { style: string; color: RGB } | null
  ears: string
  tail: string
  /** Procedural accessories (glasses, headphones, scarf, backpack, cape, beard, wings, ...) + stamps. */
  motifs: ResolvedMotif[]
  /** Deterministic per-character variation 0..1 used for small asymmetries. */
  seed: number
}

interface Geo {
  w: number; h: number; cx: number
  ground: number; legTop: number; torsoTop: number; waist: number
  headCy: number; rx: number; ry: number
  eyeY: number; browY: number
  bob: number
}

type Put = (x: number, y: number, c: RGB) => void
type Blend = (x: number, y: number, c: RGB, alpha: number) => void

/** Cel-shaded tone of a ramp for a normalised surface position (light direction from the style). */
function celTone(ph: PlaceholdersFile, r: RGB[], nx: number, ny: number, base = Math.floor(r.length / 2)): RGB {
  const { light, bright, light1, shade1, shade2 } = ph.cel
  const dot = light[0] * nx + light[1] * ny
  if (dot > bright && base + 2 < r.length) return r[base + 2]
  if (dot > light1 && base + 1 < r.length) return r[base + 1]
  if (dot < shade2 && base - 2 >= 0) return r[base - 2]
  if (dot < shade1 && base - 1 >= 0) return r[base - 1]
  return r[base]
}

/** Draws one chibi (one sprite-sheet cell) and returns the finished, outlined cell image. */
export function drawChibi(size: { w: number; h: number }, dims: ChibiDims, look: ChibiLook, view: ChibiView, frame: number, ph: PlaceholdersFile): PixelImage {
  // Side sprites are authored facing left; mirror for right.
  return finish(paint(size, dims, look, view, frame, ph), ph)
}

function finish(p: { img: PixelImage; mask: Uint8Array }, ph: PlaceholdersFile): PixelImage {
  const { img, mask } = p
  // Inner contours: a pixel that touches a part drawn in front of it is darkened.
  const src = new Uint8ClampedArray(img.data)
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const m = mask[y * img.w + x]
      if (!m) continue
      let front = false
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue
        const n = mask[ny * img.w + nx]
        if (n > m) { front = true; break }
      }
      if (!front) continue
      const i = (y * img.w + x) * 4
      const c: RGB = [src[i], src[i + 1], src[i + 2]]
      setPx(img, x, y, shift(c, ph.contour.lightness, ph.contour.hue))
    }
  }
  // Selective outer outline.
  const dark = hexToRgb(ph.outline.dark)
  const copy: PixelImage = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) }
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (alphaAt(copy, x, y)) continue
      let n: RGB | null = null
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (alphaAt(copy, x + dx, y + dy) > 127) { n = getRgb(copy, x + dx, y + dy); break }
      }
      if (n) setPx(img, x, y, mix(shift(n, ph.outline.lightness, ph.outline.hue), dark, ph.outline.mix))
    }
  }
  return img
}

function paint(size: { w: number; h: number }, d: ChibiDims, look: ChibiLook, view: ChibiView, frame: number, ph: PlaceholdersFile): { img: PixelImage; mask: Uint8Array } {
  const img = createImage(size.w, size.h)
  const mask = new Uint8Array(size.w * size.h)
  let part = 0
  /** Structural parts get increasing ids (draw order = depth). Details keep the underlying id. */
  const beginPart = () => { part = Math.min(0x7f, part + 1) }
  const put: Put = (x, y, c) => {
    x = Math.floor(x); y = Math.floor(y)
    if (x < 0 || y < 0 || x >= size.w || y >= size.h) return
    setPx(img, x, y, c)
    mask[y * size.w + x] = part
  }
  const detail: Put = (x, y, c) => setPx(img, Math.floor(x), Math.floor(y), c)
  const blend: Blend = (x, y, c, a) => { if (alphaAt(img, Math.floor(x), Math.floor(y))) blendPx(img, Math.floor(x), Math.floor(y), c, a) }

  const ramp = (c: RGB) => makeRamp(c, ph.shading)
  const skinRamp = (c: RGB) => makeRamp(c, ph.skinShading)
  const baseIdx = ph.shading.tones.findIndex(([l, h, s]) => l === 0 && h === 0 && s === 0)
  const B = baseIdx >= 0 ? baseIdx : Math.floor(ph.shading.tones.length / 2)
  const cel = (r: RGB[], nx: number, ny: number): RGB => celTone(ph, r, nx, ny, B)
  const ellipse = (cx: number, cy: number, rx: number, ry: number, r: RGB[], keep?: (x: number, y: number) => boolean) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry
        if (nx * nx + ny * ny > 1) continue
        if (keep && !keep(x, y)) continue
        put(x, y, cel(r, nx, ny))
      }
    }
  }
  const rect = (x0: number, y0: number, w: number, h: number, r: RGB[], lightSide: -1 | 0 | 1 = 0) => {
    for (let y = Math.floor(y0); y < Math.floor(y0 + h); y++) {
      for (let x = Math.floor(x0); x < Math.floor(x0 + w); x++) {
        const nx = w > 1 ? ((x - x0 + 0.5) / w) * 2 - 1 : 0
        const ny = h > 1 ? ((y - y0 + 0.5) / h) * 2 - 1 : 0
        put(x, y, cel(r, nx * 0.9 + lightSide * 0.3, ny * 0.6))
      }
    }
  }
  const poly = (pts: [number, number][], r: RGB[]) => {
    const ys = pts.map((p) => p[1]), xs = pts.map((p) => p[0])
    const minY = Math.min(...ys), maxY = Math.max(...ys), minX = Math.min(...xs), maxX = Math.max(...xs)
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const sy = y + 0.5
      const hits: number[] = []
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) hits.push(ax + ((sy - ay) / (by - ay)) * (bx - ax))
      }
      hits.sort((a, b) => a - b)
      for (let i = 0; i + 1 < hits.length; i += 2) {
        for (let x = Math.round(hits[i]); x < Math.round(hits[i + 1]); x++) {
          const nx = ((x + 0.5 - minX) / Math.max(1, maxX - minX)) * 2 - 1
          const ny = ((y + 0.5 - minY) / Math.max(1, maxY - minY)) * 2 - 1
          put(x, y, cel(r, nx, ny))
        }
      }
    }
  }

  // --- geometry -----------------------------------------------------------
  const walking = frame % 2 === 1
  const bob = walking ? 1 : 0
  const cx = size.w / 2
  const ground = d.ground
  const legTop = ground - d.legH
  const torsoTop = legTop - d.torsoH + bob
  const headCy = torsoTop - d.headRy + d.neckOverlap
  const eyeY = Math.round(headCy + d.eyeDy)
  const g: Geo = {
    w: size.w, h: size.h, cx, ground, legTop: legTop + bob, torsoTop, waist: Math.round(torsoTop + d.torsoH * 0.6),
    headCy, rx: d.headRx, ry: d.headRy, eyeY, browY: eyeY - 1, bob,
  }
  const lean = view === 'side' ? -1 : 0
  const skinR = skinRamp(look.skin), hairR = ramp(look.hair), topR = ramp(look.top), trimR = ramp(look.trim)
  const bottomR = ramp(look.bottom), shoeR = ramp(look.shoes)
  const stepA = frame === 1, stepB = frame === 3
  const motif = (id: string) => look.motifs.find((m) => m.def.draw === id)

  // --- back layer ---------------------------------------------------------
  beginPart()
  const cape = motif('cape')
  if (cape) {
    const cr = ramp(cape.color)
    if (view === 'side') poly([[cx + 1, torsoTop + 1], [cx + 4, torsoTop + 1], [cx + 7 + (walking ? 1 : 0), g.ground - 1], [cx + 1, g.ground - 2]], cr)
    else poly([[cx - d.torsoW / 2, torsoTop], [cx + d.torsoW / 2, torsoTop], [cx + d.torsoW / 2 + 3, g.ground - 1], [cx - d.torsoW / 2 - 3, g.ground - 1]], cr)
  }
  const wings = motif('wings')
  if (wings && view !== 'side') {
    beginPart()
    const wr = ramp(wings.color)
    for (const s of [-1, 1]) {
      const wx = cx + s * (d.torsoW / 2 + d.armW + 3)
      ellipse(wx, torsoTop + 2, 5, 7, wr)
      ellipse(wx + s * 3, torsoTop - 2, 4, 5, wr)
    }
  }
  drawTail(look, g, view, beginPart, ellipse, put, ramp, ph)
  beginPart()
  drawBackHair(look, g, d, view, hairR, ellipse, rect, put)

  // --- legs ---------------------------------------------------------------
  beginPart()
  const legY = g.legTop
  const legLen = g.ground - legY
  const legsDrawn: { x: number; lift: number; dx: number }[] = []
  if (view === 'side') {
    const swing = stepA ? 2 : stepB ? -2 : 0
    legsDrawn.push({ x: cx - d.legW / 2 + 1 + swing, lift: 0, dx: 0 }, { x: cx - d.legW / 2 - swing, lift: stepA || stepB ? 1 : 0, dx: 0 })
  } else {
    legsDrawn.push({ x: cx - d.legGap / 2 - d.legW, lift: stepB ? 2 : 0, dx: -1 }, { x: cx + d.legGap / 2, lift: stepA ? 2 : 0, dx: 1 })
  }
  for (const leg of legsDrawn) {
    const len = legLen - leg.lift
    const shortsCut = look.bottomStyle === 'shorts' ? Math.max(1, Math.round((len - d.shoeH) * 0.45)) : look.bottomStyle === 'pants' ? len : 0
    rect(leg.x, legY, d.legW, Math.max(0, shortsCut), bottomR)
    rect(leg.x, legY + shortsCut, d.legW, Math.max(0, len - d.shoeH - shortsCut), skinR)
    const shoeX = view === 'side' ? leg.x - 1 : leg.x + (leg.dx < 0 ? -1 : 0)
    rect(shoeX, legY + len - d.shoeH, d.legW + 1, d.shoeH, shoeR)
  }

  // --- arms behind torso (side view far arm) -------------------------------
  if (view === 'side') {
    beginPart()
    const swing = stepA ? -2 : stepB ? 2 : 0
    rect(cx - 1 - swing, torsoTop + 1, d.armW, d.armH - 2, ramp(shift(look.top, -0.08)))
  }

  // --- torso --------------------------------------------------------------
  beginPart()
  const tw = view === 'side' ? Math.max(4, Math.round(d.torsoW * 0.7)) : d.torsoW
  const tl = cx - tw / 2 + lean * 0.5
  const tb = g.legTop + (look.bottomStyle === 'skirt' || look.topStyle === 'dress' ? 0 : 1)
  const long = look.topStyle === 'coat' || look.topStyle === 'robe'
  // Lower garment (skirt flares over the legs).
  if (look.bottomStyle === 'skirt' || look.topStyle === 'dress') {
    const skirtR = look.topStyle === 'dress' ? topR : bottomR
    poly([[tl, g.waist], [tl + tw, g.waist], [tl + tw + 2, g.legTop + 3], [tl - 2, g.legTop + 3]], skirtR)
  } else {
    rect(tl, g.waist, tw, tb - g.waist, bottomR)
  }
  if (long) {
    const hem = look.topStyle === 'robe' ? g.ground - 1 : g.ground - d.shoeH - 1
    if (view === 'side') poly([[tl, torsoTop + 1], [tl + tw, torsoTop + 1], [tl + tw + 2, hem], [tl - 1, hem]], topR)
    else {
      poly([[tl, g.waist - 1], [tl + 3, g.waist - 1], [tl + 1, hem], [tl - 2, hem]], topR)
      poly([[tl + tw - 3, g.waist - 1], [tl + tw, g.waist - 1], [tl + tw + 2, hem], [tl + tw - 1, hem]], topR)
    }
  }
  poly([[tl + 1, torsoTop], [tl + tw - 1, torsoTop], [tl + tw, g.waist + (look.topStyle === 'dress' ? 1 : 0)], [tl, g.waist + (look.topStyle === 'dress' ? 1 : 0)]], topR)
  drawTopDetails(look, g, view, tl, tw, trimR, put, detail, ph)

  // --- arms ---------------------------------------------------------------
  beginPart()
  if (view === 'side') {
    const swing = stepA ? 2 : stepB ? -2 : 0
    const ax = cx - 1 + swing
    rect(ax, torsoTop + 1, d.armW, d.armH - 2, topR)
    rect(ax, torsoTop + d.armH - 1, d.armW, 2, skinR)
  } else {
    for (const s of [-1, 1] as const) {
      const swing = (stepA ? 1 : stepB ? -1 : 0) * s
      const ax = s < 0 ? tl - d.armW + 1 : tl + tw - 1
      const ay = torsoTop + 1 + swing
      rect(ax, ay, d.armW, d.armH - 2, topR, s < 0 ? -1 : 1)
      rect(ax, ay + d.armH - 2, d.armW, 2, skinR)
    }
  }

  // --- head ---------------------------------------------------------------
  beginPart()
  const headCx = cx + lean
  ellipse(headCx, headCy, d.headRx, d.headRy, skinR)
  drawEars(look, g, headCx, view, beginPart, ellipse, poly, put, ramp, ph)

  // --- front hair ---------------------------------------------------------
  beginPart()
  drawFrontHair(look, g, headCx, view, hairR, put, ph)

  // --- face ---------------------------------------------------------------
  if (view !== 'back') drawFace(look, g, d, headCx, view, ph, detail, blend)

  // --- headwear & accessories -----------------------------------------------
  if (look.hat) { beginPart(); drawHat(look.hat.style, ramp(look.hat.color), g, headCx, view, put, ellipse, rect, ramp(hexToRgb(ph.details.goggleBand))) }
  for (const m of look.motifs) {
    if (!m.def.draw) continue
    beginPart()
    drawAccessory(m.def.draw, m.color, look, g, d, headCx, view, tl, tw, ramp, put, ellipse, rect, poly, detail, ph)
  }
  // Stamps (held items, emblems, floating icons) — front view only.
  if (view === 'front') {
    for (const m of look.motifs) {
      if (!m.def.stamp) continue
      const st = ph.stamps[m.def.stamp]
      if (!st) continue
      beginPart()
      const [ax, ay] = anchorPoint(m.def.anchor ?? 'chest', g, d, tl, tw, look.seed)
      stamp(st, ax, ay, m.color, ph, put)
    }
  }
  return { img, mask }
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function anchorPoint(anchor: string, g: Geo, d: ChibiDims, tl: number, tw: number, seed: number): [number, number] {
  switch (anchor) {
    case 'hand': return [Math.round(tl + tw + d.armW - 1), Math.round(g.torsoTop + d.armH - 1)]
    case 'handLeft': return [Math.round(tl - d.armW), Math.round(g.torsoTop + d.armH - 1)]
    case 'headTop': return [Math.round(g.cx), Math.round(g.headCy - g.ry - 1)]
    case 'headSide': return [Math.round(g.cx + g.rx * 0.75), Math.round(g.headCy - g.ry * 0.55)]
    case 'floatLeft': return [Math.round(g.cx - g.rx - 6), Math.round(g.headCy - g.ry * 0.7)]
    case 'floatRight': return [Math.round(g.cx + g.rx + 6), Math.round(g.headCy - g.ry * 0.7)]
    case 'floatTop': return [Math.round(g.cx + (seed > 0.5 ? 1 : -1) * g.rx * 0.9), Math.round(g.headCy - g.ry - 5)]
    case 'belt': return [Math.round(g.cx), Math.round(g.waist)]
    default: {
      const top = Math.max(g.torsoTop, g.headCy + g.ry)
      return [Math.round(g.cx), Math.round(top + (g.waist - top) * 0.5)]
    }
  }
}

/** Pixel stamp: X main, x shade, h light, other chars via the stamp palette, '.' transparent. */
export function stamp(st: StampDef, ax: number, ay: number, color: RGB, ph: PlaceholdersFile, put: Put): void {
  const main = color, shade = shift(color, -0.16, -8), light = shift(color, 0.14, 8)
  st.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.' || ch === ' ') return
      const c = ch === 'X' ? main : ch === 'x' ? shade : ch === 'h' ? light : ph.stampPalette[ch] ? hexToRgb(ph.stampPalette[ch]) : null
      if (c) put(ax - st.pivot[0] + x, ay - st.pivot[1] + y, c)
    })
  })
}

type EllipseFn = (cx: number, cy: number, rx: number, ry: number, r: RGB[], keep?: (x: number, y: number) => boolean) => void
type RectFn = (x0: number, y0: number, w: number, h: number, r: RGB[], lightSide?: -1 | 0 | 1) => void
type PolyFn = (pts: [number, number][], r: RGB[]) => void

function drawTail(look: ChibiLook, g: Geo, view: ChibiView, beginPart: () => void, ellipse: EllipseFn, put: Put, ramp: (c: RGB) => RGB[], ph: PlaceholdersFile): void {
  if (look.tail === 'none') return
  beginPart()
  const r = ramp(look.hair)
  const side = view === 'side' ? 1 : look.seed > 0.5 ? 1 : -1
  const baseX = g.cx + side * (view === 'side' ? 3 : 5)
  const baseY = g.waist + 1
  if (look.tail === 'fox') {
    ellipse(baseX + side * 5, baseY - 4, 4, 6, r)
    ellipse(baseX + side * 7, baseY - 9, 2.5, 2.5, ramp(hexToRgb(ph.details.foxTailTip)))
  } else if (look.tail === 'cat') {
    for (let i = 0; i < 9; i++) {
      const x = baseX + side * (2 + i * 0.8)
      const y = baseY - i * 1.1 + Math.sin(i * 0.9) * 1.2
      put(x, y, r[Math.min(r.length - 1, 3)]); put(x, y + 1, r[2])
    }
  } else if (look.tail === 'robot') {
    for (let i = 0; i < 8; i++) put(baseX + side * (2 + i), baseY + Math.round(Math.sin(i * 0.8)), hexToRgb(ph.details.robotCable))
    ellipse(baseX + side * 10, baseY, 1.6, 1.6, ramp(hexToRgb(ph.details.robotPlug)))
  } else if (look.tail === 'dragon') {
    for (let i = 0; i < 7; i++) ellipse(baseX + side * (2 + i * 1.2), baseY - i * 0.6, Math.max(1, 2.6 - i * 0.3), Math.max(1, 2.6 - i * 0.3), r)
  }
}

function drawBackHair(look: ChibiLook, g: Geo, d: ChibiDims, view: ChibiView, r: RGB[], ellipse: EllipseFn, rect: RectFn, put: Put): void {
  const { cx, headCy, rx, ry } = g
  const st = look.hairStyle
  if (st === 'long' || (view === 'back' && st === 'bob')) {
    const bottom = st === 'long' ? g.waist + 2 : headCy + ry + 2
    const w = (view === 'side' ? rx * 1.2 : rx * 2 - 1)
    const x0 = view === 'side' ? cx - 1 : cx - w / 2
    rect(x0, headCy, w, bottom - headCy, r)
    for (let x = Math.floor(x0); x < x0 + w; x++) if ((x & 1) === 0) put(x, bottom, r[1])
  }
  if (st === 'twintails') {
    const sides = view === 'side' ? [1] : [-1, 1]
    for (const s of sides) {
      const tx = cx + s * (view === 'side' ? 3 : rx + 1.5)
      ellipse(tx, headCy + ry * 0.7, 3.2, ry * 0.9 + 2, r)
      ellipse(tx + s * 0.5, headCy + ry * 1.6, 2.4, 3, r)
    }
  }
  if (st === 'ponytail') {
    if (view === 'back') { ellipse(cx, headCy + ry * 0.8, 3, ry * 0.8, r); return }
    const s = view === 'side' ? 1 : look.seed > 0.5 ? 1 : -1
    ellipse(cx + s * (rx * 0.75), headCy - ry * 0.35, 3, 3, r)
    ellipse(cx + s * (rx * 0.95), headCy + ry * 0.35, 2.6, ry * 0.7, r)
  }
  if (st === 'bob' && view !== 'back') ellipse(cx + (view === 'side' ? 2 : 0), headCy + 2, rx + 1.5, ry, r)
  if (st === 'buns') {
    for (const s of view === 'side' ? [1] : [-1, 1]) ellipse(cx + s * rx * 0.72, headCy - ry * 0.82, 3.6, 3.4, r)
  }
  void d
}

function drawFrontHair(look: ChibiLook, g: Geo, headCx: number, view: ChibiView, r: RGB[], put: Put, ph: PlaceholdersFile): void {
  const { headCy, rx, ry, browY } = g
  const st = look.hairStyle
  if (look.hat?.style === 'hood') return
  const sideLen = st === 'short' || st === 'spiky' || st === 'swept' || st === 'messy' ? 0.15 : st === 'bob' ? 0.75 : 0.55
  const capCy = headCy - 1
  const capRx = rx + 1
  const capRy = ry + 1
  const shade = (nx: number, ny: number): RGB => celTone(ph, r, nx, ny)
  for (let y = Math.floor(capCy - capRy - 1); y <= Math.ceil(headCy + ry); y++) {
    for (let x = Math.floor(headCx - capRx - 1); x <= Math.ceil(headCx + capRx + 1); x++) {
      const nx = (x + 0.5 - headCx) / capRx
      const ny = (y + 0.5 - capCy) / capRy
      if (nx * nx + ny * ny > 1) continue
      let line: number
      if (view === 'back') {
        line = headCy + ry * 0.75
      } else if (view === 'side') {
        // Facing left: hair covers the back (right) of the head fully, bangs on the forehead.
        const back = nx > 0.1
        line = back ? headCy + ry * (0.35 + sideLen * 0.5) : browY + ((x & 3) === 0 ? 1 : 0)
        if (nx < -0.75) line = Math.min(line, browY - 1)
      } else {
        const fromCenter = Math.abs(x + 0.5 - headCx)
        const outer = fromCenter > rx - 2.5
        let dip = [0, 1, 2, 1][((x - Math.floor(headCx) + 64) % 4)]
        if (st === 'swept') dip = Math.max(0, Math.round(((x - headCx) / rx) * 2 + 1))
        if (st === 'messy') dip = [1, 0, 2, 0, 1, 3][((x + 60) % 6)]
        line = outer ? headCy + ry * sideLen : browY + dip - 1
      }
      if (y >= line) continue
      put(x, y, shade(nx, ny))
    }
  }
  // Top extras.
  const top = headCy - ry - 1
  if (st === 'spiky') {
    const spikes = [-0.7, -0.25, 0.2, 0.65]
    for (const sx of spikes) {
      const bx = headCx + sx * rx
      for (let i = 0; i < 4; i++) for (let k = -2 + Math.ceil(i / 2); k <= 2 - Math.ceil(i / 2); k++) put(bx + k + i * 0.5, top - i + 2, r[Math.floor(r.length / 2) + (i > 1 ? 1 : 0)])
    }
  }
  if (st === 'messy' || st === 'ahoge' || look.seed > 0.8) {
    const ax = headCx + (look.seed - 0.5) * rx * 0.6
    put(ax, top, r[Math.floor(r.length / 2)]); put(ax + 1, top - 1, r[Math.floor(r.length / 2)]); put(ax + 2, top - 1, r[Math.floor(r.length / 2) + 1])
  }
  // Glossy hair highlight arc.
  if (view !== 'back') {
    const hl = r[r.length - 1]
    for (let i = -2; i <= 2; i++) put(headCx - rx * 0.35 + i, top + 3 + Math.abs(i) * 0.4, hl)
  }
}

function drawEars(look: ChibiLook, g: Geo, headCx: number, view: ChibiView, beginPart: () => void, ellipse: EllipseFn, poly: PolyFn, put: Put, ramp: (c: RGB) => RGB[], ph: PlaceholdersFile): void {
  const { headCy, rx, ry } = g
  const r = ramp(look.hair)
  const inner = ramp(mix(look.skin, hexToRgb(ph.details.earInner), ph.details.earInnerMix))
  const top = headCy - ry
  const sides = view === 'side' ? [0.25] : [-1, 1]
  switch (look.ears) {
    case 'cat':
    case 'fox': {
      const tall = look.ears === 'fox' ? 8 : 6
      for (const s of sides) {
        const ex = headCx + s * rx * 0.62
        beginPart()
        poly([[ex - 4, top + 3], [ex + 4, top + 3], [ex + s * 1.5, top - tall]], r)
        if (view !== 'back') poly([[ex - 2, top + 2], [ex + 2, top + 2], [ex + s * 1.2, top - tall + 3]], inner)
      }
      break
    }
    case 'bunny':
      for (const s of sides) {
        beginPart()
        ellipse(headCx + s * rx * 0.4, top - 6, 2.6, 8, r)
        if (view !== 'back') ellipse(headCx + s * rx * 0.4, top - 5, 1.2, 5.5, inner)
      }
      break
    case 'bear':
      for (const s of sides) { beginPart(); ellipse(headCx + s * rx * 0.72, top + 1, 3.6, 3.6, r) }
      break
    case 'elf':
      if (view === 'back') break
      for (const s of view === 'side' ? [1] : [-1, 1]) {
        beginPart()
        const ex = headCx + s * (view === 'side' ? rx * 0.1 : rx - 1)
        poly([[ex, headCy - 2], [ex, headCy + 3], [ex + s * 6, headCy - 5]], ramp(look.skin))
      }
      break
    case 'robot':
      for (const s of sides) {
        beginPart()
        const ex = headCx + s * rx * 0.55
        for (let i = 0; i < 5; i++) put(ex, top - i, hexToRgb(ph.details.antenna))
        ellipse(ex, top - 6, 1.8, 1.8, ramp(look.eyes))
      }
      break
    default:
      break
  }
}

function drawFace(look: ChibiLook, g: Geo, d: ChibiDims, headCx: number, view: ChibiView, ph: PlaceholdersFile, detail: Put, blend: Blend): void {
  const lash = hexToRgb(ph.face.lash)
  const white = hexToRgb(ph.face.eyeWhite)
  const hl = hexToRgb(ph.face.highlight)
  const iris = look.eyes
  const irisDark = shift(iris, -0.22, -10, 0.05)
  const irisLight = shift(iris, 0.16, 10)
  const ew = d.eyeW, eh = d.eyeH
  const eyes = view === 'side' ? [headCx - g.rx * 0.45 - ew / 2] : [headCx - d.eyeDx - ew / 2, headCx + d.eyeDx - ew / 2]
  const y0 = g.eyeY
  const style = look.eyeStyle
  eyes.forEach((exf, idx) => {
    const ex = Math.round(exf)
    const outerLeft = view === 'side' ? true : idx === 0
    if (style === 'happy') {
      // Closed ^ ^ eyes.
      for (let i = 0; i < ew; i++) {
        const dy = Math.abs(i - (ew - 1) / 2) > ew / 4 ? 1 : 0
        detail(ex + i, y0 + 1 + dy, lash)
      }
      return
    }
    const lid = style === 'sleepy' ? Math.max(1, Math.floor(eh / 2)) : 0
    for (let y = 0; y < eh; y++) {
      for (let x = 0; x < ew; x++) {
        let c: RGB
        if (y === lid) c = lash
        else if (y < lid) continue
        else c = y < lid + Math.ceil((eh - lid) / 2) ? irisDark : irisLight
        // Rounded bottom corners.
        if (y === eh - 1 && (x === 0 || x === ew - 1) && eh > 3) c = white
        detail(ex + x, y0 + y, c)
      }
    }
    if (style === 'sharp') detail(ex + (outerLeft ? -1 : ew), y0, lash)
    else detail(ex + (outerLeft ? -1 : ew), y0 + lid + (eh > 3 ? 0 : 0), lash)
    if (eh > 3 && style !== 'sleepy') {
      const px = ex + Math.floor(ew / 2)
      detail(px, y0 + Math.floor(eh / 2), shift(irisDark, -0.15))
      if (ew > 3) detail(px - 1 + (outerLeft ? 1 : 0), y0 + Math.floor(eh / 2) + 1, shift(irisDark, -0.1))
    }
    // Highlights.
    detail(ex + (outerLeft ? 1 : ew - 2), y0 + lid + 1, hl)
    if (eh > 4) { detail(ex + (outerLeft ? 2 : ew - 3), y0 + lid + 1, hl); detail(ex + (outerLeft ? ew - 2 : 1), y0 + eh - 2, white) }
    if (style === 'sparkle' && eh > 3) detail(ex + (outerLeft ? 1 : ew - 2), y0 + lid + 2, hl)
  })
  // Blush.
  const blush = hexToRgb(ph.face.blush)
  const by = y0 + eh + (eh > 4 ? 1 : 0)
  const bw = Math.max(1, Math.floor(ew / 2))
  eyes.forEach((ex, idx) => {
    const outerLeft = view === 'side' || idx === 0
    const bx = Math.round(outerLeft ? ex - 1 : ex + ew + 1 - bw)
    for (let i = 0; i < bw; i++) blend(bx + i, by, blush, ph.face.blushAlpha)
  })
  // Mouth.
  const mouth = hexToRgb(ph.face.mouth)
  const mx = Math.round(view === 'side' ? headCx - g.rx * 0.62 : headCx)
  const my = y0 + eh + (eh > 4 ? 2 : 1)
  switch (look.mouth) {
    case 'cat':
      detail(mx - 2, my, mouth); detail(mx - 1, my + 1, mouth); detail(mx, my, mouth); detail(mx + 1, my + 1, mouth); detail(mx + 2, my, mouth)
      break
    case 'open':
      detail(mx - 1, my, mouth); detail(mx, my, mouth); detail(mx - 1, my + 1, hexToRgb(ph.details.mouthInner)); detail(mx, my + 1, hexToRgb(ph.details.mouthInner))
      break
    case 'smile':
      detail(mx - 1, my, mouth); detail(mx, my + 1, mouth); detail(mx + 1, my, mouth)
      break
    default:
      detail(mx, my, mouth)
      if (eh > 4) detail(mx - 1, my, mouth)
  }
}

function drawTopDetails(look: ChibiLook, g: Geo, view: ChibiView, tl: number, tw: number, trim: RGB[], put: Put, detail: Put, ph: PlaceholdersFile): void {
  const t = trim[Math.floor(trim.length / 2)]
  const tLight = trim[Math.min(trim.length - 1, Math.floor(trim.length / 2) + 1)]
  const cx = Math.round(tl + tw / 2)
  const top = g.torsoTop
  if (view === 'back') {
    if (look.topStyle === 'hoodie') for (let x = cx - 3; x <= cx + 2; x++) put(x, top, t)
    return
  }
  switch (look.topStyle) {
    case 'jacket':
    case 'coat':
      if (view === 'front') for (let y = top + 1; y < g.waist + (look.topStyle === 'coat' ? 4 : 0); y++) { detail(cx - 1, y, t); detail(cx, y, tLight) }
      detail(cx - 2, top, t); detail(cx + 1, top, t)
      break
    case 'hoodie':
      for (let x = cx - 3; x <= cx + 2; x++) detail(x, top, t)
      if (view === 'front') {
        const ds = hexToRgb(ph.details.drawstring)
        for (const dx of [-2, 1]) for (const dy of [1, 2]) detail(cx + dx, top + dy, ds)
      }
      for (let x = cx - 3; x <= cx + 2; x++) detail(x, g.waist - 2, t)
      break
    case 'armor':
      for (let x = Math.round(tl); x < tl + tw; x++) detail(x, top + 1, tLight)
      if (view === 'front') for (let y = top + 2; y < g.waist; y++) detail(cx, y, t)
      break
    case 'suit':
      if (view === 'front') for (let i = 0; i < 4; i++) { detail(cx - 1 - i * 0.5, top + i, t); detail(cx + i * 0.5, top + i, t) }
      break
    default:
      for (let x = cx - 2; x <= cx + 1; x++) detail(x, top, t)
      if (view === 'front') detail(cx - 1, top + 1, t)
  }
  // Belt line.
  for (let x = Math.round(tl); x < tl + tw; x++) detail(x, g.waist - 1, shift(look.top, -0.18, -8))
}

function drawHat(style: string, r: RGB[], g: Geo, headCx: number, view: ChibiView, put: Put, ellipse: EllipseFn, rect: RectFn, band: RGB[]): void {
  const { headCy, rx, ry } = g
  const top = headCy - ry
  const brow = g.browY
  switch (style) {
    case 'cap': {
      ellipse(headCx, top + ry * 0.45, rx + 1, ry * 0.62, r, (_x, y) => y < brow - 1)
      if (view === 'front') rect(headCx - rx, brow - 2, rx * 2, 2, [r[1], r[1], r[1], r[2], r[2]])
      if (view === 'side') rect(headCx - rx - 4, brow - 2, rx + 2, 2, [r[1], r[1], r[1], r[2], r[2]])
      put(headCx, top - 1, r[r.length - 1])
      break
    }
    case 'sunhat':
      ellipse(headCx, top + 2, rx + (view === 'side' ? 5 : 7), 2.6, r)
      ellipse(headCx, top, rx * 0.7, ry * 0.45, r, (_x, y) => y < top + 2)
      rect(headCx - rx * 0.7, top + 0.5, rx * 1.4, 1, [r[0], r[0], r[0], r[0], r[0]])
      break
    case 'beret':
      ellipse(headCx + (view === 'side' ? 1 : 2), top + 1, rx + 1, ry * 0.38, r)
      put(headCx + 2, top - ry * 0.38, r[1])
      break
    case 'bandana':
      rect(headCx - rx, brow - 3, rx * 2, 2, r)
      if (view !== 'front') rect(headCx + rx - 1, brow - 2, 3, 3, r)
      break
    case 'goggles': {
      rect(headCx - rx, top + 4, rx * 2, 2, band)
      if (view !== 'back') for (const s of view === 'side' ? [-0.5] : [-0.45, 0.45]) ellipse(headCx + s * rx, top + 4, 3, 2.6, r)
      break
    }
    case 'hood':
      ellipse(headCx, headCy - 1, rx + 2, ry + 2, r, (x, y) => {
        if (view === 'back') return true
        const nx = (x + 0.5 - headCx) / (rx - 1.5), ny = (y + 0.5 - (headCy + 2)) / (ry - 1)
        return nx * nx + ny * ny > 1 || y < g.browY - 2
      })
      break
    case 'crown': {
      const y0 = top - 3
      for (let i = -3; i <= 3; i++) for (let k = 0; k < 3; k++) put(headCx + i, y0 + k, r[2 + (k === 0 ? 1 : 0)])
      for (const i of [-3, 0, 3]) put(headCx + i, y0 - 1, r[3])
      break
    }
    default:
      break
  }
}

function drawAccessory(
  id: string, color: RGB, look: ChibiLook, g: Geo, d: ChibiDims, headCx: number, view: ChibiView, tl: number, tw: number,
  ramp: (c: RGB) => RGB[], put: Put, ellipse: EllipseFn, rect: RectFn, poly: PolyFn, detail: Put, ph: PlaceholdersFile,
): void {
  const r = ramp(color)
  const { headCy, rx, ry, eyeY } = g
  switch (id) {
    case 'glasses': {
      if (view === 'back') return
      const frame = r[1]
      const xs = view === 'side' ? [headCx - rx * 0.45 - d.eyeW / 2] : [headCx - d.eyeDx - d.eyeW / 2, headCx + d.eyeDx - d.eyeW / 2]
      for (const exf of xs) {
        const ex = Math.round(exf) - 1
        const w = d.eyeW + 2, h = d.eyeH + 1
        for (let x = 0; x < w; x++) { detail(ex + x, eyeY - 1, frame); detail(ex + x, eyeY + h - 1, frame) }
        for (let y = 0; y < h; y++) { detail(ex, eyeY - 1 + y, frame); detail(ex + w - 1, eyeY - 1 + y, frame) }
      }
      if (xs.length === 2) for (let x = Math.round(xs[0] + d.eyeW + 1); x < Math.round(xs[1]) - 1; x++) detail(x, eyeY, frame)
      break
    }
    case 'headphones': {
      if (view !== 'side') {
        for (let a = 0; a <= 20; a++) {
          const t = Math.PI * (a / 20)
          put(headCx - Math.cos(t) * (rx + 1.5), headCy - 1 - Math.sin(t) * (ry + 2), r[2])
        }
        for (const s of [-1, 1]) ellipse(headCx + s * (rx + 0.5), headCy + 1, 2.6, 3.6, r)
      } else {
        for (let a = 0; a <= 12; a++) put(headCx + 1 - Math.cos(Math.PI * a / 12) * 1.5, headCy - ry - 1 + a * 0.3, r[2])
        ellipse(headCx + 2, headCy + 1, 2.2, 3, r)
      }
      break
    }
    case 'scarf': {
      rect(tl - 1, g.torsoTop - 1, tw + 2, 3, r)
      if (view !== 'back') rect(tl + tw - 4, g.torsoTop + 2, 3, 5, r)
      break
    }
    case 'backpack': {
      if (view === 'back') rect(tl + 1, g.torsoTop + 1, tw - 2, g.waist - g.torsoTop + 2, r)
      else if (view === 'side') rect(tl + tw - 1, g.torsoTop + 1, 4, g.waist - g.torsoTop + 1, r)
      else { detail(tl + 2, g.torsoTop + 1, r[1]); detail(tl + 2, g.torsoTop + 2, r[1]); detail(tl + tw - 3, g.torsoTop + 1, r[1]); detail(tl + tw - 3, g.torsoTop + 2, r[1]) }
      break
    }
    case 'beard': {
      if (view === 'back') return
      ellipse(headCx + (view === 'side' ? -rx * 0.4 : 0), headCy + ry * 0.62, rx * (view === 'side' ? 0.45 : 0.62), ry * 0.42, r, (_x, y) => y > eyeY + d.eyeH)
      break
    }
    case 'halo': {
      for (let x = -rx * 0.7; x <= rx * 0.7; x++) { put(headCx + x, headCy - ry - 5, r[3]); put(headCx + x, headCy - ry - 3, r[2]) }
      put(headCx - rx * 0.7 - 1, headCy - ry - 4, r[2]); put(headCx + rx * 0.7 + 1, headCy - ry - 4, r[2])
      break
    }
    case 'horns': {
      for (const s of view === 'side' ? [1] : [-1, 1]) poly([[headCx + s * rx * 0.35 - 2, headCy - ry + 2], [headCx + s * rx * 0.35 + 2, headCy - ry + 2], [headCx + s * rx * 0.62, headCy - ry - 5]], r)
      break
    }
    case 'visor': {
      if (view === 'back') return
      rect(headCx - rx + 1, eyeY - 1, (rx - 1) * 2, d.eyeH + 2, r.map((c) => mix(c, hexToRgb(ph.details.visorTint), ph.details.visorTintMix)))
      for (let x = 0; x < (rx - 2) * 2; x += 3) detail(headCx - rx + 2 + x, eyeY, r[r.length - 1])
      break
    }
    case 'emblemRing': {
      ellipse(g.cx, g.torsoTop + 3, 2.5, 2.5, r)
      break
    }
    default:
      void look
  }
}
