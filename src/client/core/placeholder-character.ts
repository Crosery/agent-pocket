// Procedural 4-direction x N-frame chibi walk sheet from a CharacterSheetDef description.
// Description keywords map to colours / garments through content/placeholders.json.
import type { CharacterSheetDef } from '../../shared/types.ts'
import { CONTENT } from '../../shared/content/index.ts'
import type { Content } from '../../shared/content/index.ts'
import { seededFrom } from './hash.ts'
import type { PixelImage, RGB } from './pixel.ts'
import { blit, createImage, hexToRgb, mirrorX, shift } from './pixel.ts'
import { drawChibi } from './placeholder-chibi.ts'
import type { ChibiLook, ChibiView } from './placeholder-chibi.ts'
import { PH } from './placeholders-data.ts'
import type { PlaceholdersFile } from './placeholders-data.ts'

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (w: string) => new RegExp(`(^|[^a-z])${escapeRe(w)}(?=$|[^a-z])`, 'g')

interface Hit { at: number; end: number; word: string }

/** All non-overlapping keyword occurrences (longest match wins at a position). */
function findAll(text: string, words: string[]): Hit[] {
  const hits: Hit[] = []
  for (const word of words) {
    for (const m of text.matchAll(wordRe(word))) {
      const at = (m.index ?? 0) + m[1].length
      hits.push({ at, end: at + word.length, word })
    }
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end)
  const out: Hit[] = []
  let end = -1
  for (const h of hits) if (h.at >= end) { out.push(h); end = h.end }
  return out
}

type PartKind = 'hair' | 'top' | 'bottom' | 'shoes' | 'hat' | 'extra'

export function characterLook(def: CharacterSheetDef, ph: PlaceholdersFile = PH): ChibiLook {
  const cfg = ph.character
  const rnd = seededFrom('character', def.id)
  const desc = def.desc.toLowerCase()
  const kinds = new Map<string, PartKind>()
  for (const w of cfg.hairWords) kinds.set(w, 'hair')
  for (const w of Object.keys(cfg.topWords)) kinds.set(w, 'top')
  for (const w of Object.keys(cfg.bottomWords)) kinds.set(w, 'bottom')
  for (const w of cfg.shoeWords) kinds.set(w, 'shoes')
  for (const w of Object.keys(cfg.hatWords)) kinds.set(w, 'hat')
  for (const w of Object.keys(cfg.extraWords)) kinds.set(w, 'extra')
  const colorWords = Object.keys(cfg.colors)

  let hair: RGB | null = null, hairPhrase = ''
  let top: RGB | null = null, trim: RGB | null = null, topStyle: string | null = null
  let bottom: RGB | null = null, bottomStyle: string | null = null
  let shoes: RGB | null = null
  let hat: { style: string; color: RGB | null } | null = null
  const extras: { id: string; color: RGB | null }[] = []

  for (const seg of desc.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const colors = findAll(seg, colorWords).map((h) => ({ ...h, c: hexToRgb(cfg.colors[h.word]) }))
    const parts = findAll(seg, [...kinds.keys()])
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const prevEnd = i > 0 ? parts[i - 1].end : 0
      const nextAt = i + 1 < parts.length ? parts[i + 1].at : seg.length
      const before = colors.filter((c) => c.at >= prevEnd && c.at < p.at).map((c) => c.c)
      const after = colors.filter((c) => c.at >= p.end && c.at < nextAt).map((c) => c.c)
      const main = before[0] ?? after[0] ?? null
      switch (kinds.get(p.word)) {
        case 'hair':
          if (!hairPhrase) hairPhrase = seg
          if (!hair && main) hair = main
          break
        case 'top':
          if (!topStyle) { top = main; trim = before[1] ?? (before.length ? after[0] : after[1]) ?? null; topStyle = cfg.topWords[p.word] }
          break
        case 'bottom':
          if (!bottomStyle) { bottom = main; bottomStyle = cfg.bottomWords[p.word] }
          break
        case 'shoes':
          if (!shoes) shoes = main
          break
        case 'hat':
          if (!hat) hat = { style: cfg.hatWords[p.word], color: main }
          break
        case 'extra': {
          const id = cfg.extraWords[p.word]
          if (!extras.some((e) => e.id === id)) extras.push({ id, color: main })
          break
        }
      }
    }
  }

  const styleIn = (text: string) => cfg.hairStyleWords.find(([w]) => wordRe(w).test(text))?.[1]
  const hairStyle = (hairPhrase && styleIn(hairPhrase)) || styleIn(desc) || cfg.defaultHairStyle

  let skin = hexToRgb(cfg.skin.default)
  for (const [word, hex] of Object.entries(cfg.skin.keywords)) if (wordRe(word).test(desc)) skin = hexToRgb(hex)

  const topC = top ?? hexToRgb(rnd.pick(cfg.fallback.top))
  const fallbackColor = (id: string) => hexToRgb(cfg.extraColors[id] ?? rnd.pick(cfg.fallback.shoes))
  return {
    skin,
    hair: hair ?? hexToRgb(rnd.pick(cfg.fallback.hair)),
    hairStyle,
    eyes: hexToRgb(rnd.pick(cfg.eyeColors)),
    eyeStyle: 'round',
    mouth: 'dot',
    top: topC,
    trim: trim ?? shift(topC, 0.22, 6),
    topStyle: topStyle ?? cfg.defaultTopStyle,
    bottom: bottom ?? hexToRgb(rnd.pick(cfg.fallback.bottom)),
    bottomStyle: bottomStyle ?? cfg.defaultBottomStyle,
    shoes: shoes ?? hexToRgb(rnd.pick(cfg.fallback.shoes)),
    hat: hat ? { style: hat.style, color: hat.color ?? shift(topC, -0.06) } : null,
    ears: 'none',
    tail: 'none',
    motifs: extras.map((e) => ({ def: { draw: e.id }, color: e.color ?? fallbackColor(e.id) })),
    seed: rnd.next(),
  }
}

const VIEW_OF: Record<string, ChibiView> = { down: 'front', up: 'back', left: 'side', right: 'side' }

/** Full walk sheet: rows per config.sprites.sheetRows, config.sprites.sheetFrames frames, sheetCell px cells. */
export function drawCharacterSheet(sheetId: string, c: Content = CONTENT, ph: PlaceholdersFile = PH): PixelImage {
  const { sheetCell: cell, sheetFrames: frames, sheetRows } = c.config.sprites
  const def = c.characterById[sheetId] ?? { id: sheetId, nameZh: sheetId, playable: false, desc: sheetId }
  const look = characterLook(def, ph)
  const rows = Math.max(...Object.values(sheetRows)) + 1
  const sheet = createImage(cell * frames, cell * rows)
  for (const [dir, row] of Object.entries(sheetRows)) {
    const view = VIEW_OF[dir] ?? 'front'
    for (let f = 0; f < frames; f++) {
      let img = drawChibi({ w: cell, h: cell }, ph.character.dims, look, view, f, ph)
      if (dir === 'right') img = mirrorX(img)
      blit(sheet, img, f * cell, row * cell)
    }
  }
  return sheet
}
