// Fog-of-war bitset over map chunks (chunk size = CONTENT.config.world.chunk). Pure; no DOM.
// Bit layout: chunk index i = cy * cols + cx; byte i >> 3, bit i & 7 (LSB first).

export interface FogGrid { cols: number; rows: number; chunk: number; bytes: number }

export function fogGrid(width: number, height: number, chunk: number): FogGrid {
  const c = Math.max(1, Math.floor(chunk))
  const cols = Math.max(1, Math.ceil(width / c))
  const rows = Math.max(1, Math.ceil(height / c))
  return { cols, rows, chunk: c, bytes: Math.ceil((cols * rows) / 8) }
}

export function hasBit(bits: Uint8Array, i: number): boolean {
  return ((bits[i >> 3] ?? 0) & (1 << (i & 7))) !== 0
}

export function setBit(bits: Uint8Array, i: number): void {
  bits[i >> 3] |= 1 << (i & 7)
}

export function chunkIndexAt(g: FogGrid, x: number, y: number): number {
  const cx = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.chunk)))
  const cy = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.chunk)))
  return cy * g.cols + cx
}

/** True if the tile lies in an explored chunk (tiles outside the map count as unexplored). */
export function isTileExplored(bits: Uint8Array, g: FogGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= g.cols * g.chunk || y >= g.rows * g.chunk) return false
  return hasBit(bits, chunkIndexAt(g, x, y))
}

/** Reveals the chunk containing (x,y) plus `radius` chunks around it. Returns the newly revealed chunk indices. */
export function revealAround(bits: Uint8Array, g: FogGrid, x: number, y: number, radius: number): number[] {
  const cx = Math.floor(x / g.chunk)
  const cy = Math.floor(y / g.chunk)
  const added: number[] = []
  const r = Math.max(0, Math.floor(radius))
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue
      const i = ny * g.cols + nx
      if (!hasBit(bits, i)) { setBit(bits, i); added.push(i) }
    }
  }
  return added
}

/** Returns a bitset sized for the grid, copying `src` when compatible (wrong sizes are discarded, not trusted). */
export function normalizeBits(g: FogGrid, src: Uint8Array | null | undefined): Uint8Array {
  const out = new Uint8Array(g.bytes)
  if (src && src.length === g.bytes) out.set(src)
  // Clear padding bits beyond the last chunk so equality/encoding stays canonical.
  const total = g.cols * g.rows
  for (let i = total; i < g.bytes * 8; i++) out[i >> 3] &= ~(1 << (i & 7))
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 encoding of a bitset (for SaveData.exploredChunks). */
export function encodeBits(bits: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bits.length; i += 3) {
    const n = (bits[i] << 16) | ((bits[i + 1] ?? 0) << 8) | (bits[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bits.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bits.length ? B64[n & 63] : '='
  }
  return out
}

/** Decodes encodeBits output; returns null for malformed input or a length mismatch. */
export function decodeBits(s: string, expectedBytes: number): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0) return null
  const out: number[] = []
  for (let i = 0; i < s.length; i += 4) {
    const q = s.slice(i, i + 4)
    const v = [...q].map((ch) => (ch === '=' ? 0 : B64.indexOf(ch)))
    if (v.some((x) => x < 0)) return null
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3]
    out.push((n >> 16) & 255)
    if (q[2] !== '=') out.push((n >> 8) & 255)
    if (q[3] !== '=') out.push(n & 255)
  }
  if (out.length !== expectedBytes) return null
  return Uint8Array.from(out)
}

// ---------------------------------------------------------------------------
// Sparse fog of war for unbounded maps (SaveData.explored). Cells are `cell` tiles wide (the same cell size as
// the finite bitset); cells are grouped into square pages of `pageCells`² bits stored only once touched.
// Encoding: "p<pageCells>|<px>,<py>:<base64 bits>;..." (pages sorted, empty pages omitted). Cell (cx, cy) lives
// in page (⌊cx / P⌋, ⌊cy / P⌋), bit (cy mod P) * P + (cx mod P) — negative coordinates included.
// ---------------------------------------------------------------------------

export class FogPages {
  readonly cell: number
  readonly pageCells: number
  private readonly pages = new Map<string, Uint8Array>()
  private readonly versions = new Map<string, number>()
  /** Bumped on every newly revealed cell (cheap change detection for renderers). */
  version = 0

  constructor(cell: number, pageCells: number) {
    this.cell = Math.max(1, Math.floor(cell))
    this.pageCells = Math.max(8, Math.floor(pageCells / 8) * 8)
  }

  get pageCount(): number { return this.pages.size }

  private page(px: number, py: number, create: boolean): Uint8Array | null {
    const k = `${px},${py}`
    let p = this.pages.get(k)
    if (!p && create) { p = new Uint8Array((this.pageCells * this.pageCells) / 8); this.pages.set(k, p) }
    return p ?? null
  }

  /** Version of one page (0 = never touched); changes whenever a cell inside it is revealed. */
  pageVersion(px: number, py: number): number { return this.versions.get(`${px},${py}`) ?? 0 }

  hasCell(cx: number, cy: number): boolean {
    const P = this.pageCells
    const px = Math.floor(cx / P), py = Math.floor(cy / P)
    const p = this.page(px, py, false)
    return !!p && hasBit(p, (cy - py * P) * P + (cx - px * P))
  }

  /** Marks a cell explored; true when it was new. */
  setCell(cx: number, cy: number): boolean {
    const P = this.pageCells
    const px = Math.floor(cx / P), py = Math.floor(cy / P)
    const p = this.page(px, py, true)!
    const i = (cy - py * P) * P + (cx - px * P)
    if (hasBit(p, i)) return false
    setBit(p, i)
    const k = `${px},${py}`
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1)
    this.version++
    return true
  }

  tileExplored(x: number, y: number): boolean {
    return this.hasCell(Math.floor(x / this.cell), Math.floor(y / this.cell))
  }

  /** True when any cell overlapping the tile rect [x0, x1) × [y0, y1) is explored. */
  anyExplored(x0: number, y0: number, x1: number, y1: number): boolean {
    const c = this.cell
    for (let cy = Math.floor(y0 / c); cy <= Math.floor((y1 - 1) / c); cy++) {
      for (let cx = Math.floor(x0 / c); cx <= Math.floor((x1 - 1) / c); cx++) if (this.hasCell(cx, cy)) return true
    }
    return false
  }

  /** True when a page overlapping the tile rect has ever been touched (fast reject for large rects). */
  anyPage(x0: number, y0: number, x1: number, y1: number): boolean {
    const span = this.cell * this.pageCells
    for (let py = Math.floor(y0 / span); py <= Math.floor((y1 - 1) / span); py++) {
      for (let px = Math.floor(x0 / span); px <= Math.floor((x1 - 1) / span); px++) if (this.pages.has(`${px},${py}`)) return true
    }
    return false
  }

  /** Calls fn for every explored cell of the cell rect [cx0, cx1) × [cy0, cy1) (page by page; empty pages skipped). */
  forEachCell(cx0: number, cy0: number, cx1: number, cy1: number, fn: (cx: number, cy: number) => void): void {
    const P = this.pageCells
    for (let py = Math.floor(cy0 / P); py <= Math.floor((cy1 - 1) / P); py++) {
      for (let px = Math.floor(cx0 / P); px <= Math.floor((cx1 - 1) / P); px++) {
        const p = this.pages.get(`${px},${py}`)
        if (!p) continue
        const ax = Math.max(cx0, px * P), bx = Math.min(cx1, (px + 1) * P)
        const ay = Math.max(cy0, py * P), by = Math.min(cy1, (py + 1) * P)
        for (let cy = ay; cy < by; cy++) {
          const row = (cy - py * P) * P - px * P
          for (let cx = ax; cx < bx; cx++) if (hasBit(p, row + cx)) fn(cx, cy)
        }
      }
    }
  }

  /** Reveals the cell under (x, y) and `radius` cells around it; returns the number of newly revealed cells. */
  revealAround(x: number, y: number, radius: number): number {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell)
    const r = Math.max(0, Math.floor(radius))
    let n = 0
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (this.setCell(cx + dx, cy + dy)) n++
    return n
  }

  /** Copies a finite bitset (fogGrid layout, origin at tile 0,0) into the pages. */
  importGrid(bits: Uint8Array, g: FogGrid): void {
    if (g.chunk !== this.cell) return
    for (let cy = 0; cy < g.rows; cy++) for (let cx = 0; cx < g.cols; cx++) if (hasBit(bits, cy * g.cols + cx)) this.setCell(cx, cy)
  }

  encode(): string {
    const parts: string[] = []
    const keys = [...this.pages.keys()].sort()
    for (const k of keys) {
      const p = this.pages.get(k)!
      if (p.some((b) => b !== 0)) parts.push(`${k}:${encodeBits(p)}`)
    }
    return `p${this.pageCells}|${parts.join(';')}`
  }

  /** Parses encode() output; null when malformed. Pages beyond `maxPages` are ignored. */
  static decode(s: unknown, cell: number, pageCells: number, maxPages = Infinity): FogPages | null {
    if (typeof s !== 'string') return null
    const bar = s.indexOf('|')
    if (bar < 0 || s[0] !== 'p') return null
    const P = Number(s.slice(1, bar))
    if (!Number.isInteger(P) || P < 8 || P % 8 !== 0) return null
    const out = new FogPages(cell, P)
    const body = s.slice(bar + 1)
    if (!body) return P === out.pageCells ? out : FogPages.repage(out, cell, pageCells)
    const bytes = (P * P) / 8
    for (const part of body.split(';')) {
      if (out.pages.size >= maxPages) break
      const m = /^(-?\d+),(-?\d+):([A-Za-z0-9+/=]+)$/.exec(part)
      if (!m) return null
      const bits = decodeBits(m[3], bytes)
      if (!bits) return null
      const k = `${Number(m[1])},${Number(m[2])}`
      out.pages.set(k, bits)
      out.versions.set(k, 1)
    }
    out.version = out.pages.size
    return P === Math.max(8, Math.floor(pageCells / 8) * 8) ? out : FogPages.repage(out, cell, pageCells)
  }

  /** Same explored cells with another page size (content/explore.json fog.pageCells changed). */
  private static repage(src: FogPages, cell: number, pageCells: number): FogPages {
    const out = new FogPages(cell, pageCells)
    const P = src.pageCells
    for (const [k, p] of src.pages) {
      const [px, py] = k.split(',').map(Number)
      for (let i = 0; i < P * P; i++) if (hasBit(p, i)) out.setCell(px * P + (i % P), py * P + Math.floor(i / P))
    }
    return out
  }
}
