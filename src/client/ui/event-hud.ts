// World-event HUD: active event chips under the quest tracker, the roaming-legend "sense" pill with a direction
// arrow, and full-screen ambience overlays (one per active ambience cue; background / blend / animation come from
// content/events/client.json cues.<key>.overlay, the animations themselves are CSS capability ids).
import { cueDef, GPC } from '../world/gameplay-config.ts'
import { el } from './widgets.ts'
import './event-hud.css'

export interface EventHudChip {
  id: string
  title: string
  /** Second line (remaining time / scope). */
  sub: string
  /** Event tag (data-tag for styling). */
  tag: string
  /** Accent colour (content/events/client.json hud.tagColors). */
  color: string
}

export interface EventHudSense {
  text: string
  /** Screen-space angle (radians, 0 = east, clockwise) from the player toward the source. */
  angle: number
  color: string
}

export interface EventHud {
  setVisible(v: boolean): void
  setChips(list: readonly EventHudChip[]): void
  setSense(s: EventHudSense | null): void
  setAmbience(cues: readonly string[]): void
  dispose(): void
}

export function createEventHud(uiRoot: HTMLElement): EventHud {
  const fxLayer = el('div', { class: 'ap-layer ap-l-evfx is-hidden', attrs: { 'aria-hidden': 'true' } })
  const hudLayer = el('div', { class: 'ap-layer ap-l-evhud is-hidden' })
  const chips = el('div', { class: 'ap-evchips is-hidden', attrs: { role: 'status', 'aria-live': 'polite' } })
  const senseText = el('span', 'ap-evsense-text')
  const senseArrow = el('span', 'ap-evsense-arrow')
  const sense = el('div', 'ap-evsense', [senseArrow, senseText])
  sense.hidden = true
  hudLayer.append(sense)
  uiRoot.prepend(fxLayer)
  uiRoot.append(hudLayer)

  // Chips flow under the quest tracker when the ui-kit HUD is present; otherwise they get their own corner.
  const placeChips = () => {
    const host = uiRoot.querySelector<HTMLElement>('.ap-hud-tl')
    if (host && chips.parentElement !== host) host.append(chips)
    else if (!host && chips.parentElement !== hudLayer) { chips.classList.add('is-standalone'); hudLayer.append(chips) }
  }
  placeChips()

  const overlays = new Map<string, HTMLElement>()
  let chipKey = ''
  let visible = false

  return {
    setVisible(v) {
      if (v === visible) return
      visible = v
      fxLayer.classList.toggle('is-hidden', !v)
      hudLayer.classList.toggle('is-hidden', !v)
      chips.classList.toggle('is-hidden', !v)
      if (v) placeChips()
    },
    setChips(list) {
      const key = list.map((c) => `${c.id}|${c.title}|${c.sub}|${c.color}`).join('\n')
      if (key === chipKey) return
      chipKey = key
      chips.replaceChildren(...list.map((c) => el('div', { class: 'ap-evchip', data: { tag: c.tag }, vars: { '--evc': c.color } }, [
        el('span', { class: 'ap-evchip-title', text: c.title }),
        el('span', { class: 'ap-evchip-sub', text: c.sub }),
      ])))
      chips.hidden = list.length === 0
    },
    setSense(s) {
      sense.hidden = !s
      if (!s) return
      senseText.textContent = s.text
      sense.style.setProperty('--evc', s.color)
      senseArrow.style.transform = `rotate(${s.angle}rad)`
    },
    setAmbience(cues) {
      const want = new Set(cues.filter((k) => cueDef(k)?.overlay))
      for (const [k, node] of overlays) {
        if (want.has(k)) continue
        node.classList.add('is-out')
        overlays.delete(k)
        window.setTimeout(() => node.remove(), GPC.hud.overlayFadeMs)
      }
      for (const k of want) {
        if (overlays.has(k)) continue
        const o = cueDef(k)!.overlay!
        const node = el('div', { class: `ap-evfx is-${o.anim}`, data: { cue: k } })
        node.style.background = o.background
        node.style.mixBlendMode = o.blend
        node.style.setProperty('--evo', String(o.opacity))
        fxLayer.append(node)
        overlays.set(k, node)
      }
    },
    dispose() {
      fxLayer.remove()
      hudLayer.remove()
      chips.remove()
    },
  }
}
