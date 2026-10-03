// All promo data (data/*.json) loaded once before any scene is built. Code reads data only through `D`.
import { hexToLinear } from './util';

export interface Species { id: string; dexNo: number; nameZh: string; nameEn: string; company: string; country: string; rarity: string; types: string[]; releaseDate: string }
export interface Rarity { id: string; nameZh: string; color: string; order: number; aura: boolean }
export interface TypeDef { id: string; nameZh: string; color: string }
export interface Copy { zh: string; en: string }
export interface PlateDef { id: string; scene: string; from: number; to: number | 'end'; cues?: Record<string, any>; params?: Record<string, any> }

export interface Data {
  style: {
    palette: Record<string, string>;
    fonts: { pixel: { family: string; url: string; designPx: number; ascentPx: number }; mono: { family: string; url: string; urlMedium: string } };
    type: { zhScale: number; zhLabelScale: number; enPx: number; enTracking: number; monoSmallPx: number; lineGapPx: number; narratorScale: number; narratorEnPx: number; overPicture: { outline: string; outlineAlpha: number; enShadow: number }; pixelSpacing: { zhGapPx: number; dotGapPx: number; dotPx: number; bodyRef: string } };
    layout: { safe: number; heroY: number; labelY: number; copyY: number; copyEnGap: number };
    post: Record<string, number>;
    motion: { hopPx: number; squash: number; typeCharBeats: number };
    [plate: string]: any;
  };
  copy: Record<string, any>;
  cast: Record<string, any>;
  timeline: { plates: PlateDef[] };
  game: { species: Species[]; rarities: Rarity[]; types: TypeDef[] };
  world: Record<string, any>;
}

export let D!: Data;
const byId = new Map<string, Species>();

export async function loadData() {
  const get = async (f: string) => {
    const r = await fetch(`data/${f}.json`);
    if (!r.ok) throw new Error(`data/${f}.json: ${r.status}`);
    return r.json();
  };
  const [style, copy, cast, timeline, game, world] = await Promise.all(['style', 'copy', 'cast', 'timeline', 'game', 'world'].map(get));
  D = { style, copy, cast, timeline, game, world };
  for (const s of D.game.species) byId.set(s.id, s);
  return D;
}

export function species(id: string): Species {
  const s = byId.get(id);
  if (!s) throw new Error(`unknown species "${id}" (data/cast.json vs data/game.json)`);
  return s;
}
/** On-screen name of a species: data/cast.json displayNames override (promo-only, e.g. drop a bracketed gloss), else nameZh. */
export const displayName = (id: string) => (D.cast.displayNames?.[id] as string | undefined) ?? species(id).nameZh;
export const rarity = (id: string) => D.game.rarities.find((r) => r.id === id)!;
export const typeDef = (id: string) => D.game.types.find((t) => t.id === id)!;

/** Copy entry with {count} etc. filled in. */
export function copy(key: string, vars: Record<string, string> = {}): Copy {
  const c = D.copy[key] as Copy;
  if (!c) throw new Error(`data/copy.json: no "${key}"`);
  const fill = (s: string) => s.replace(/\{count\}/g, String(D.game.species.length)).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return { zh: fill(c.zh), en: fill(c.en) };
}

/** Palette colour: sRGB hex string, or linear rgb for GL. */
export const hex = (name: string) => {
  const c = D.style.palette[name];
  if (!c) throw new Error(`palette: no "${name}"`);
  return c;
};
export const lin = (nameOrHex: string): [number, number, number] => hexToLinear(nameOrHex.startsWith('#') ? nameOrHex : hex(nameOrHex));
export const rgba = (nameOrHex: string, a = 1) => {
  const h = nameOrHex.startsWith('#') ? nameOrHex : hex(nameOrHex);
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
