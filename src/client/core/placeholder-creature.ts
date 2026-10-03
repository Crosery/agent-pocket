// Procedural chibi personification for a species: type colours + type motifs + hash-picked features.
import { CONTENT } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import { seededFrom } from './hash.ts'
import type { SeededRandom } from './hash.ts'
import type { PixelImage, RGB } from './pixel.ts'
import { hexToRgb, rgbToHsl, shift, upscale } from './pixel.ts'
import { drawChibi } from './placeholder-chibi.ts'
import type { ChibiLook, ResolvedMotif } from './placeholder-chibi.ts'
import { PH } from './placeholders-data.ts'
import type { MotifDef, PlaceholdersFile, Weighted } from './placeholders-data.ts'

const pickW = (rnd: SeededRandom, list: Weighted[]): string => (list.length ? rnd.weighted(list, (w) => w.weight).id : 'none')

/** Motif colour keyword -> RGB. */
export function resolveMotifColor(spec: string | undefined, palette: Record<string, RGB>, fallback: RGB): RGB {
  if (!spec) return fallback
  if (spec.startsWith('#')) return hexToRgb(spec)
  return palette[spec] ?? fallback
}

export function creatureLook(speciesId: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): { look: ChibiLook; stage: number } {
  const cfg = ph.creature
  const rnd = seededFrom('creature', speciesId)
  const sp = c.species[speciesId]
  const types = sp?.types?.length ? sp.types : [c.types[Math.floor(rnd.next() * c.types.length)]?.id ?? '']
  const typeColor = (t: string | undefined): RGB | null => (t && c.typeById[t] ? hexToRgb(c.typeById[t].color) : null)
  const t1 = typeColor(types[0]) ?? hexToRgb(cfg.neutralTops[0] ?? ph.details.neutral)
  const t2raw = typeColor(types[1])
  const t2 = t2raw ?? shift(t1, cfg.secondaryShift.lightness, cfg.secondaryShift.hue)

  const hair = shift(t1, rnd.range(-cfg.hairJitter.lightness, cfg.hairJitter.lightness), rnd.range(-cfg.hairJitter.hue, cfg.hairJitter.hue))
  const top = t2raw ?? hexToRgb(rnd.pick(cfg.neutralTops))
  const trim = t2raw ? shift(t1, 0.08) : t1
  const [, sat] = rgbToHsl(t1)
  const eyes = sat >= cfg.minEyeSaturation ? shift(t1, 0.04, 18, 0.12) : hexToRgb(rnd.pick(cfg.eyeFallback))

  const look: ChibiLook = {
    skin: hexToRgb(rnd.pick(cfg.skinTones)),
    hair,
    hairStyle: pickW(rnd, cfg.hairStyles),
    eyes,
    eyeStyle: pickW(rnd, cfg.eyeStyles),
    mouth: pickW(rnd, cfg.mouths),
    top,
    trim,
    topStyle: pickW(rnd, cfg.topStyles),
    bottom: hexToRgb(rnd.pick(cfg.bottoms)),
    bottomStyle: pickW(rnd, cfg.bottomStyles),
    shoes: hexToRgb(rnd.pick(cfg.shoes)),
    hat: null,
    ears: pickW(rnd, cfg.earStyles),
    tail: pickW(rnd, cfg.tailStyles),
    motifs: [],
    seed: rnd.next(),
  }

  const stage = Math.max(0, Math.min(cfg.stages.length - 1, (sp?.stage ?? 1) - 1))
  const defs: MotifDef[] = [...(cfg.typeMotifs[types[0]] ?? cfg.defaultMotifs)]
  if (types[1]) {
    const extra = (cfg.typeMotifs[types[1]] ?? []).find((m) => m.stamp)
    if (extra) defs.push(extra)
  }
  defs.push(...(cfg.stageMotifs[stage] ?? []))
  if (sp) defs.push(...(cfg.rarityMotifs[sp.rarity] ?? []))

  const palette: Record<string, RGB> = { type: t1, type2: t2, hair, top, trim, skin: look.skin }
  const usedAnchors = new Set<string>()
  const usedDraws = new Set<string>()
  for (const def of defs) {
    if (def.set) applyOverrides(look, def.set)
    const color = resolveMotifColor(def.color, palette, t1)
    if (def.draw?.startsWith('hat:')) {
      if (!look.hat) look.hat = { style: def.draw.slice(4), color }
      continue
    }
    if (def.draw) {
      if (usedDraws.has(def.draw)) continue
      usedDraws.add(def.draw)
      look.motifs.push({ def, color })
    } else if (def.stamp) {
      const anchor = def.anchor ?? 'chest'
      if (usedAnchors.has(anchor)) continue
      usedAnchors.add(anchor)
      look.motifs.push({ def, color } satisfies ResolvedMotif)
    }
  }
  return { look, stage }
}

const LOOK_KEYS = ['hairStyle', 'eyeStyle', 'mouth', 'topStyle', 'bottomStyle', 'ears', 'tail'] as const

function applyOverrides(look: ChibiLook, set: Record<string, string>): void {
  for (const k of LOOK_KEYS) if (typeof set[k] === 'string') look[k] = set[k]
}

/** Final creature sprite at config.sprites.creatureSize (logical art upscaled with nearest). */
export function drawCreature(speciesId: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): PixelImage {
  const { look, stage } = creatureLook(speciesId, c, ph)
  const logical = ph.creature.logicalSize
  const img = drawChibi({ w: logical, h: logical }, ph.creature.stages[stage], look, 'front', 0, ph)
  return upscale(img, Math.max(1, Math.round(c.config.sprites.creatureSize / logical)))
}
