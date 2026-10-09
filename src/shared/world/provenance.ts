// Where a placed object came from (ADR 0002 §3.3). While buildWorld() runs with a sink, the stampers report every
// building, prop, sign and anchor that comes from a layout template: which JSON file and pointer holds it, and the
// transform that turns template coordinates into map coordinates. Generated content (routes, scatter, frontier) is
// never reported, so the editor shows it as read-only. With no sink nothing is recorded and nothing changes.
export interface ProvTransform {
  /** Map tile where the template's (0, 0) lies. */
  ox: number
  oy: number
  /** The town is stamped from the horizontally mirrored template. */
  mirror: boolean
  /** Template width. */
  tw: number
  /** Footprint width of the object as placed (mirrored x = tw - x' - fw). 1 for signs and anchors. */
  fw: number
}

export interface ProvEntry {
  kind: 'building' | 'prop' | 'sign' | 'anchor'
  /** Map the object stands on. */
  map: string
  /** Top-left tile and size of the object's footprint as placed. */
  x: number
  y: number
  w: number
  h: number
  /** Prop id (building, prop), sign slot, or anchor name. */
  label: string
  /** Rotation as placed (0 for signs and anchors). */
  rot: number
  /** Template id inside the file; shared by every town or building stamped from it. */
  template: string
  /** Repo-relative JSON file and RFC 6901 pointer of the object inside it. */
  file: string
  pointer: string
  transform: ProvTransform
}

/** A rectangle of a map that one template instance covers (a stamped town, a whole interior): where objects can be placed into it. */
export interface ProvRegion {
  map: string
  template: string
  file: string
  /** Tile rectangle on the map. */
  x: number
  y: number
  w: number
  h: number
  mirror: boolean
}

export interface ProvenanceSink {
  add(entry: ProvEntry): void
  region(region: ProvRegion): void
}

let active: ProvenanceSink | null = null

/** Runs `fn` with `sink` receiving the reports (no-op wrapper without a sink). */
export function withProvenance<T>(sink: ProvenanceSink | undefined, fn: () => T): T {
  if (!sink) return fn()
  const before = active
  active = sink
  try { return fn() } finally { active = before }
}

export const provenanceSink = (): ProvenanceSink | null => active

/** Template coordinates of a map-space point: the inverse of the stamp (and of mirrorTownTemplate). */
export function toTemplate(t: ProvTransform, x: number, y: number): { x: number; y: number } {
  const lx = x - t.ox
  return { x: t.mirror ? t.tw - lx - t.fw : lx, y: y - t.oy }
}

/** Map-space tile of template coordinates (the forward stamp). */
export function fromTemplate(t: ProvTransform, x: number, y: number): { x: number; y: number } {
  return { x: t.ox + (t.mirror ? t.tw - x - t.fw : x), y: t.oy + y }
}
