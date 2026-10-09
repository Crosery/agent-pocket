// Icon badges of the battle HUD: type badges, status / volatile icons, command icons and the boss meter tiles.
// Art files and which id uses which come from content/battle-ui.json (icons); strings through t().
import { CONTENT, t } from '../../shared/content/index.ts'
import { publicAssetUrl } from '../core/assets.ts'
import { el } from '../ui/widgets.ts'
import { BATTLE_UI, type CommandId } from './config.ts'
import type { BossChip } from './model.ts'

const iconUrl = (name: string) => publicAssetUrl(`${BATTLE_UI.icons.base}icon-${name}.png`)

function art(url: string): HTMLImageElement {
  const img = el('img', { class: 'apb-ico', attrs: { alt: '', draggable: 'false', decoding: 'async' } }) as HTMLImageElement
  img.src = url
  return img
}

/** Round type badge (the type's own pixel icon) in a ring of the type colour; the name is its tooltip. */
export function typeBadge(typeId: string): HTMLElement {
  const def = CONTENT.typeById[typeId]
  const badge = el('span', { class: 'apb-ty', title: def?.nameZh ?? t('ui.unknownType'), data: { type: typeId } })
  if (def?.color) badge.style.setProperty('--tc', def.color)
  if (def?.icon) badge.append(art(publicAssetUrl(`${BATTLE_UI.icons.typeBase}${def.icon}.png`)))
  else badge.textContent = def?.nameZh.slice(0, 1) ?? '?'
  return badge
}

/** Status / volatile condition icon, or null when it has none (the caller falls back to a text tag). */
export function effectIcon(id: string, title: string, polarity: 'buff' | 'debuff' | 'neutral'): HTMLElement | null {
  if (!BATTLE_UI.icons.effects.includes(id)) return null
  const node = el('span', { class: `apb-fx is-${polarity}`, title, attrs: { 'aria-label': title } }, [art(iconUrl(id))])
  return node
}

export function commandIcon(id: CommandId): HTMLElement {
  return el('span', { class: 'apb-cmd-ico' }, [art(iconUrl(BATTLE_UI.icons.commands[id]))])
}

/**
 * One boss mechanic as a compact tile: tone icon, a short label and a pip row (counters) or the state word. Tapping or
 * hovering it shows the full reading (chip.readout) through `onReadout`.
 */
export function meterTile(chip: BossChip, onReadout: (text: string) => void): HTMLElement {
  const H = BATTLE_UI.hud
  const label = [...chip.label.replace(/\s+/g, '')].slice(0, H.meterLabelChars).join('')
  const body: (HTMLElement | string)[] = [el('span', { class: 'apb-mt-label', text: label })]
  if (chip.alert) {
    body.push(el('span', { class: 'apb-mt-state', text: chip.readout }))
  } else if (chip.fill !== null) {
    const cells = Math.min(chip.max ?? H.meterPipCells, H.meterPipCells)
    const on = Math.ceil(chip.fill * cells - 1e-6)
    body.push(el('span', { class: 'apb-mt-pips' }, Array.from({ length: cells }, (_, i) => el('span', `apb-mt-pip${i < on ? ' is-on' : ''}`))))
  } else {
    body.push(el('span', { class: 'apb-mt-state', text: chip.stateText ?? '' }))
  }
  const tile = el('span', {
    class: `apb-mt is-${chip.tone}${chip.alert ? ' is-alert' : ''}`,
    title: chip.readout,
    attrs: { role: 'button', tabindex: '0', 'aria-label': chip.readout },
    data: { meter: chip.id },
  }, [art(iconUrl(BATTLE_UI.icons.meterTones[chip.tone])), el('span', 'apb-mt-body', body)])
  const show = () => onReadout(chip.readout)
  tile.addEventListener('pointerenter', show)
  tile.onfocus = show
  tile.addEventListener('click', (e) => { e.stopPropagation(); show() })
  return tile
}
