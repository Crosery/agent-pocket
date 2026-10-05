// Sprite helpers for screens: animated character-sheet walkers, portraits (with sheet-frame fallback) and
// creature images. Sheet geometry comes from CONTENT.config.sprites; animation timing from content/screens.json.
import type { Dir } from '../../../shared/types.ts'
import type { AssetStore } from '../../contracts.ts'
import { CONTENT } from '../../../shared/content/index.ts'
import { el } from '../widgets.ts'
import { SCREENS } from './config.ts'
import { characterFrames, createCharacterAnimation } from '../../render/character-animation.ts'
import { prepareCharacterSheet, type CharacterSheet } from '../../render/character-idle.ts'

const sheets = new Map<string, Promise<CharacterSheet | null>>()

function loadSheet(assets: AssetStore, sheetId: string): Promise<CharacterSheet | null> {
  const url = assets.characterImageUrl(sheetId)
  let p = sheets.get(url)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.decoding = 'async'
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(prepareCharacterSheet(img))
      img.onerror = () => resolve(null)
      img.src = url
    })
    sheets.set(url, p)
  }
  return p
}

export interface Walker {
  readonly el: HTMLCanvasElement
  update(dtSec: number): void
  setWalking(on: boolean): void
  setDir(dir: Dir): void
}

/** A character sheet cell drawn into a cell-sized canvas; walks in place, turning through `dirs`. */
export function createWalker(assets: AssetStore, sheetId: string, opts?: { dirs?: Dir[]; walking?: boolean; className?: string }): Walker {
  const sp = CONTENT.config.sprites
  const cell = sp.sheetCell
  const cv = el('canvas', { class: `aps-walker${opts?.className ? ` ${opts.className}` : ''}`, attrs: { 'aria-hidden': 'true' } })
  cv.width = cell
  cv.height = cell
  const dirs = opts?.dirs?.length ? opts.dirs : SCREENS.newGame.previewDirs
  let sheet: CharacterSheet | null = null
  let walking = opts?.walking ?? true
  let layout = characterFrames(0, sp)
  const animation = () => createCharacterAnimation(layout.walkFrames, layout.walkStart, {
    frames: layout.idleFrames, fps: sp.idleFps, settleMs: sp.idleSettleMs,
  })
  let gait = animation()
  let turnT = 0
  let dirIndex = 0
  let fixedDir: Dir | null = null
  let lastKey = ''
  const draw = () => {
    if (!sheet) return
    const dir = fixedDir ?? dirs[dirIndex % dirs.length]
    const frame = gait.frame
    const key = `${dir}|${frame}`
    if (key === lastKey) return
    lastKey = key
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, cell, cell)
    ctx.drawImage(sheet, frame * cell, sp.sheetRows[dir] * cell, cell, cell, 0, 0, cell, cell)
  }
  void loadSheet(assets, sheetId).then((img) => {
    sheet = img
    layout = characterFrames(img?.width ?? 0, sp)
    gait = animation()
    lastKey = ''
    draw()
  })
  return {
    el: cv,
    update(dt) {
      const previousPhase = gait.phase
      gait.update(dt, walking, SCREENS.anim.walkFps * layout.walkFrames / sp.sheetFrames)
      if (walking) turnT += dt * 1000
      if (walking && !fixedDir && turnT >= SCREENS.anim.walkTurnMs && gait.phase < previousPhase) {
        turnT %= SCREENS.anim.walkTurnMs
        dirIndex++
      }
      draw()
    },
    setWalking(on) {
      if (walking === on) return
      walking = on
      gait.reset()
      if (!on && !fixedDir) { dirIndex = 0; turnT = 0 }
      lastKey = ''
      draw()
    },
    setDir(dir) {
      if (fixedDir === dir) return
      fixedDir = dir
      gait.reset()
      turnT = 0
      lastKey = ''
      draw()
    },
  }
}

/** Portrait image (assets.portraitUrl) or, when absent, the first standing frame of the character sheet. */
export function portraitEl(assets: AssetStore, id: string, className = 'aps-portrait'): HTMLElement {
  const url = assets.portraitUrl(id)
  if (url) {
    const img = el('img', { class: className, attrs: { alt: '', draggable: 'false', decoding: 'async' } })
    img.src = url
    return img
  }
  const w = createWalker(assets, id, { walking: false, className })
  w.setDir(SCREENS.newGame.previewDirs[0] ?? 'down')
  w.update(0)
  void loadSheet(assets, id).then(() => w.update(0))
  return w.el
}

/** Pixel creature image. Shiny variants get the .is-shiny treatment (CSS) plus a sparkle. */
export function creatureImg(assets: AssetStore, speciesId: string, opts?: { shiny?: boolean; silhouette?: boolean; className?: string }): HTMLImageElement {
  const img = el('img', {
    class: `aps-sprite${opts?.shiny ? ' is-shiny' : ''}${opts?.silhouette ? ' is-silhouette' : ''}${opts?.className ? ` ${opts.className}` : ''}`,
    attrs: { alt: '', draggable: 'false', decoding: 'async' },
  })
  img.src = assets.creatureImageUrl(speciesId)
  return img
}
