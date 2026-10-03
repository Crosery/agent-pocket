// Typed view of content/screens.json (menus, tabs, filters, credits, key help, layout tunables, pixel icons).
// Pure module: no DOM access, safe to import from node tests.
import screensJson from '../../../../content/screens.json' with { type: 'json' }
import type { ItemCategory, KeyItemKind, Settings } from '../../../shared/types.ts'
import type { InputAction } from '../../contracts.ts'
import type { Content } from '../../../shared/content/index.ts'
import type { GlyphDef } from '../config.ts'

export interface MenuEntry { id: string; label: string }

export type PauseAction = 'dex' | 'party' | 'bag' | 'map' | 'quests' | 'research' | 'intel' | 'online' | 'save' | 'settings' | 'title'
export type TitleChoice = 'continue' | 'new' | 'import' | 'settings'
export type SettingsKey = keyof Settings

export interface SettingsField {
  key: SettingsKey
  kind: 'slider' | 'toggle' | 'choice'
  section: string
  min?: number
  max?: number
  step?: number
  options?: (string | number)[]
  /** Text key used to display numeric option values ({value}). */
  format?: string
}

export interface ParticleConfig {
  count: number; speedMin: number; speedMax: number; sizeMin: number; sizeMax: number
  swayUnits: number; swayHz: number; twinkleHz: number; colors: string[]
}

export interface RidgeConfig { color: string; base: number; amp: number; freq: number; seed: number }

export interface TitleSceneConfig {
  sky: string[]
  stars: number
  starColors: string[]
  /** Fraction of the height (from the top) where stars may appear. */
  starBand: number
  sun: { x: number; y: number; radius: number; color: string; glow: string }
  ridges: RidgeConfig[]
  haze: string
  hazeAlpha: number
}

export interface TitleArtFit {
  /** Used when viewport width / height >= minAspect (first match; sorted high to low, the last one 0). */
  minAspect: number
  /** Image point [x, y] (fractions of the art) centred in the viewport when `keep` allows. */
  focus: [number, number]
  /** Art rect [x0, y0, x1, y1] (fractions) kept on screen through the whole pan whenever it fits. */
  keep: [number, number, number, number]
  /** Zoom over the cover scale (>= 1). */
  zoom?: number
}

export interface TitleArtConfig {
  /** Ken Burns end state (start = identity): translate as a fraction of the viewport, scale >= 1,
   * |x| and |y| <= (scale - 1) / 2 so no edge is ever exposed. */
  pan: { x: number; y: number; scale: number }
  fits: TitleArtFit[]
}

export interface TitleVignetteConfig {
  /** Radial clear area: [width %, height %, centre x %, centre y %]. */
  ellipse: [number, number, number, number]
  /** Radial stop (0-1) where darkening starts, and its alpha at the ellipse edge. */
  clearTo: number
  corner: number
  /** Top band alpha fading out at `topTo`; bottom band starting at `bottomFrom` reaching `bottom` (0-1). */
  top: number
  topTo: number
  bottomFrom: number
  bottom: number
}

export interface KeyItemAction {
  /** Screen opened by the item (capability id). */
  open?: 'worldMap' | 'dex' | 'badges'
  /** Text key shown as a hint ({key} = label of `action`). */
  hint?: string
  action?: InputAction
}

export interface ScreensConfig {
  sfx: Record<'useItem' | 'heal' | 'buy' | 'sell' | 'save' | 'learn' | 'levelUp' | 'release' | 'toss' | 'start' | 'pick' | 'drop' | 'error' | 'shiny' | 'press', string>
  anim: { walkFps: number; walkTurnMs: number; cardStaggerMs: number; pressBlinkMs: number; artPanSeconds: number; mapBlinkMs: number; creditsScrollUnits: number }
  glyphs: Record<string, GlyphDef>
  /** Extra palette entries merged over content/ui.json glyphPalette. */
  glyphPalette: Record<string, string>
  title: {
    music: string
    keyArt: string
    logo: string
    /** Logo image width: min(maxVw vw, units UI px). */
    logoSize: { units: number; maxVw: number }
    art: TitleArtConfig
    vignette: TitleVignetteConfig
    menu: (MenuEntry & { id: TitleChoice; needsSave?: boolean })[]
    particles: ParticleConfig
    scene: TitleSceneConfig
  }
  newGame: { previewDirs: ('down' | 'left' | 'right' | 'up')[]; cols: number; compactCols: number }
  pause: {
    entries: (MenuEntry & { action: PauseAction; glyph?: string; requires?: 'party' })[]
    /** Cancelable window event dispatched before returning to the title (integration may intercept). */
    titleEvent: string
  }
  party: { viewMenu: MenuEntry[]; cols: number; compactCols: number; iconSize: number; hpBarWidth: number; expBarWidth: number }
  summary: { pages: MenuEntry[]; ivStars: number; friendshipHearts: number; friendshipMax: number; radarSize: number }
  bag: {
    tabs: (MenuEntry & { categories: ItemCategory[]; battle: boolean })[]
    itemMenu: MenuEntry[]
    consumeChip: boolean
    keyItems: Partial<Record<KeyItemKind, KeyItemAction>>
    tossMax: number
    visibleRows: number
    compactVisibleRows: number
  }
  dex: {
    cols: number; compactCols: number; rows: number; compactRows: number
    countries: { id: string; label: string; codes?: string[]; exclude?: string[] }[]
    filters: ('type' | 'rarity' | 'country' | 'company' | 'caught')[]
    caughtOptions: ('caught' | 'seen' | 'unseen')[]
    searchMaxLen: number
    companiesFromSeenOnly: boolean
    /** Base-stat value that fills a detail bar completely. */
    statBarMax: number
    radarSize: number
    cryOnOpen: boolean
  }
  shop: { tabs: MenuEntry[]; qtyMax: number; qtyBigStep: number; visibleRows: number; compactVisibleRows: number }
  box: { cols: number; wallpapers: [string, string][]; menu: MenuEntry[]; cellIconSize: number; partyIconSize: number }
  worldMap: {
    townGlyph: string
    playerGlyph: string
    visitedPalette: Record<string, string>
    unvisitedPalette: Record<string, string>
    minLabelTiles: number
    padUnits: number
  }
  quests: { tabs: (MenuEntry & { kinds: ('main' | 'side')[]; done: boolean })[]; visibleRows: number; compactVisibleRows: number }
  moveCategoryColors: Record<'physical' | 'special' | 'status', string>
  badges: { tintLight: number; tintDark: number; cols: number; compactCols: number }
  settings: {
    tabs: MenuEntry[]
    fields: SettingsField[]
    saveActions: MenuEntry[]
    codeMaxLen: number
    reloadAfterImport: boolean
    keyHelp: InputAction[]
    credits: { role: string; names: string[] }[]
  }
}

export const SCREENS: ScreensConfig = screensJson as unknown as ScreensConfig

const ITEM_CATEGORIES: readonly ItemCategory[] = ['ball', 'medicine', 'battle', 'key', 'chip', 'evolution', 'misc']
const PAUSE_ACTIONS: readonly PauseAction[] = ['dex', 'party', 'bag', 'map', 'quests', 'research', 'intel', 'online', 'save', 'settings', 'title']

/** Validates content/screens.json against the content registry. Returns human-readable problems (empty = OK). */
export function validateScreensConfig(cfg: ScreensConfig, c: Content, ui: { glyphs: Record<string, unknown>; glyphPalette: Record<string, string> }): string[] {
  const errs: string[] = []
  const text = (where: string, key: string) => { if (!(key in c.text)) errs.push(`${where}: missing text "${key}"`) }
  const sfx = new Set(c.audio.sfx)
  for (const [k, id] of Object.entries(cfg.sfx)) if (!sfx.has(id)) errs.push(`screens.sfx.${k}: unknown sfx "${id}"`)
  if (!c.audio.bgm.some((b) => b.id === cfg.title.music)) errs.push(`screens.title.music: unknown bgm "${cfg.title.music}"`)

  const palette = { ...ui.glyphPalette, ...cfg.glyphPalette }
  for (const [id, g] of Object.entries(cfg.glyphs)) {
    if (!g.rows.length) { errs.push(`screens glyph ${id}: no rows`); continue }
    const w = g.rows[0].length
    g.rows.forEach((r, i) => { if (r.length !== w) errs.push(`screens glyph ${id}: row ${i} width ${r.length} != ${w}`) })
    const pal = { ...palette, ...(g.palette ?? {}) }
    for (const r of g.rows) for (const ch of r) if (ch !== '.' && !(ch in pal)) errs.push(`screens glyph ${id}: palette has no "${ch}"`)
  }
  const glyphKnown = (id: string) => id in cfg.glyphs || id in ui.glyphs
  for (const e of cfg.pause.entries) {
    text(`pause.${e.id}`, e.label)
    if (!PAUSE_ACTIONS.includes(e.action)) errs.push(`pause.${e.id}: unknown action "${e.action}"`)
    if (e.glyph && !glyphKnown(e.glyph)) errs.push(`pause.${e.id}: unknown glyph "${e.glyph}"`)
  }
  for (const m of cfg.title.menu) text(`title.menu.${m.id}`, m.label)
  errs.push(...validateTitleArt(cfg.title.art))
  for (const m of cfg.party.viewMenu) text(`party.viewMenu.${m.id}`, m.label)
  for (const m of cfg.summary.pages) text(`summary.pages.${m.id}`, m.label)
  for (const m of cfg.bag.itemMenu) text(`bag.itemMenu.${m.id}`, m.label)
  for (const m of cfg.shop.tabs) text(`shop.tabs.${m.id}`, m.label)
  for (const m of cfg.box.menu) text(`box.menu.${m.id}`, m.label)
  for (const m of cfg.quests.tabs) text(`quests.tabs.${m.id}`, m.label)
  for (const m of cfg.settings.tabs) text(`settings.tabs.${m.id}`, m.label)
  for (const m of cfg.settings.saveActions) text(`settings.saveActions.${m.id}`, m.label)
  for (const r of cfg.settings.credits) text('settings.credits', r.role)

  const covered = new Set<string>()
  for (const tab of cfg.bag.tabs) {
    text(`bag.tabs.${tab.id}`, tab.label)
    for (const cat of tab.categories) {
      if (!ITEM_CATEGORIES.includes(cat)) errs.push(`bag.tabs.${tab.id}: unknown category "${cat}"`)
      covered.add(cat)
    }
  }
  for (const it of c.itemList) if (!covered.has(it.category)) errs.push(`bag.tabs: no tab shows category "${it.category}" (item ${it.id})`)
  for (const [kind, a] of Object.entries(cfg.bag.keyItems)) {
    if (a?.hint) text(`bag.keyItems.${kind}`, a.hint)
  }
  for (const it of c.itemList) {
    if (it.effect.kind === 'key' && !cfg.bag.keyItems[it.effect.key]) errs.push(`bag.keyItems: no action for key kind "${it.effect.key}" (item ${it.id})`)
  }

  for (const ct of cfg.dex.countries) text(`dex.countries.${ct.id}`, ct.label)
  if (cfg.dex.cols < 1 || cfg.dex.compactCols < 1 || cfg.dex.rows < 1 || cfg.dex.compactRows < 1) errs.push('dex: grid sizes must be >= 1')

  const defaults = c.config.defaultSettings as unknown as Record<string, unknown>
  const seen = new Set<string>()
  for (const f of cfg.settings.fields) {
    if (!(f.key in defaults)) errs.push(`settings.fields: unknown settings key "${f.key}"`)
    if (seen.has(f.key)) errs.push(`settings.fields: duplicate key "${f.key}"`)
    seen.add(f.key)
    if (f.kind === 'choice') {
      if (!f.options?.length) errs.push(`settings.fields.${f.key}: choice needs options`)
      else if (!f.options.includes(defaults[f.key] as string | number)) errs.push(`settings.fields.${f.key}: default value not among options`)
      if (f.format) text(`settings.fields.${f.key}.format`, f.format)
    }
    if (f.kind === 'slider' && !(f.min !== undefined && f.max !== undefined && f.step && f.max > f.min)) errs.push(`settings.fields.${f.key}: slider needs min < max and step`)
    if (f.kind === 'toggle' && typeof defaults[f.key] !== 'boolean') errs.push(`settings.fields.${f.key}: toggle on a non-boolean setting`)
  }
  for (const k of Object.keys(defaults)) if (!seen.has(k)) errs.push(`settings.fields: setting "${k}" has no field`)
  if (cfg.box.wallpapers.length === 0) errs.push('box.wallpapers must not be empty')
  if (!glyphKnown(cfg.worldMap.townGlyph)) errs.push(`worldMap.townGlyph: unknown glyph "${cfg.worldMap.townGlyph}"`)
  if (!glyphKnown(cfg.worldMap.playerGlyph)) errs.push(`worldMap.playerGlyph: unknown glyph "${cfg.worldMap.playerGlyph}"`)
  return errs
}

/** title.art: fits sorted by minAspect (last 0), fractions in 0-1, keep rects ordered, pan never exposes an edge. */
export function validateTitleArt(art: TitleArtConfig): string[] {
  const errs: string[] = []
  const frac = (v: number) => v >= 0 && v <= 1
  if (!art.fits.length) errs.push('title.art.fits must not be empty')
  art.fits.forEach((f, i) => {
    const at = `title.art.fits[${i}]`
    if (i > 0 && f.minAspect >= art.fits[i - 1].minAspect) errs.push(`${at}: minAspect must decrease`)
    if (!f.focus.every(frac)) errs.push(`${at}: focus outside 0-1`)
    const [x0, y0, x1, y1] = f.keep
    if (!f.keep.every(frac) || x0 >= x1 || y0 >= y1) errs.push(`${at}: keep must be [x0, y0, x1, y1] within 0-1`)
    if ((f.zoom ?? 1) < 1) errs.push(`${at}: zoom < 1 would not cover the screen`)
  })
  if (art.fits.length && art.fits[art.fits.length - 1].minAspect !== 0) errs.push('title.art.fits: the last fit needs minAspect 0')
  const { x, y, scale } = art.pan
  if (scale < 1 || Math.abs(x) > (scale - 1) / 2 || Math.abs(y) > (scale - 1) / 2) errs.push('title.art.pan: needs scale >= 1 and |x|, |y| <= (scale - 1) / 2')
  return errs
}
