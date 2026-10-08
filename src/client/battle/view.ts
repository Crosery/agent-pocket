// Battle screen DOM: status windows for both sides, weather tag, PvP turn timer, ability banners, the bottom bar
// (message window + command / move menus) and the level-up stat window. Input is routed to whatever currently
// waits for the player (stat window > menu > message). Lives inside a UIKit panel pushed by the scene.
import type { Settings, SideIndex, StatKey } from '../../shared/types.ts'
import type { AudioManager, Input } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { el, panel } from '../ui/widgets.ts'
import { BATTLE_UI } from './config.ts'
import { createBattleEffectsPanel } from './effects-panel.ts'
import { createMenus, type Menus } from './menus.ts'
import { createMessageBox, type MessageBox } from './message.ts'
import type { BossPanelInfo, StatDelta } from './model.ts'
import { createStatusPanel, type StatusPanel } from './status-panel.ts'
import './battle.css'

export interface BattleView {
  readonly root: HTMLElement
  readonly status: [StatusPanel, StatusPanel]
  readonly message: MessageBox
  readonly menus: Menus
  setWeather(id: string): void
  /** PvP decision countdown (seconds left) or null to hide. */
  setTimer(secondsLeft: number | null): void
  banner(side: SideIndex, text: string): void
  /** Boss strip of the foe window (null when it is not a boss fight). */
  setBoss(info: BossPanelInfo | null): void
  /** Level-up stat window; resolves on confirm or after the configured time. */
  levelUp(title: string, deltas: StatDelta[]): Promise<void>
  /** Hides status windows (evolution, end of battle). */
  setHudVisible(on: boolean): void
  /** Hides the bottom bar (message, menus, own status) while screens / kit dialogues are on top. */
  setBarVisible(on: boolean): void
  /** Extra handler that sees input first (e.g. evolution cancel). */
  setInterceptor(fn: ((inp: Input) => boolean) | null): void
  input(inp: Input): boolean
  update(dtSec: number): void
}

export function createBattleView(audio: AudioManager, settings: () => Settings): BattleView {
  const T = BATTLE_UI.timing
  const root = el('div', 'apb-root')
  let openDetails: (side: SideIndex) => void = () => undefined
  const status: [StatusPanel, StatusPanel] = [
    createStatusPanel(true, () => openDetails(0)),
    createStatusPanel(false, () => openDetails(1)),
  ]
  const weather = el('div', 'apb-weather')
  weather.hidden = true
  const timer = el('div', 'apb-timer')
  timer.hidden = true
  const message: MessageBox = createMessageBox(audio, settings)
  const menus: Menus = createMenus(audio)
  const bar = el('div', 'apb-bar', [message.el, menus.el, status[0].el])
  root.append(status[1].el, weather, timer, bar)
  const effects = createBattleEffectsPanel(root, status)
  openDetails = (side) => effects.show(side)
  root.addEventListener('click', () => { if (!menus.open && !effects.open) message.advance() })
  root.addEventListener('contextmenu', (e) => e.preventDefault())

  let interceptor: ((inp: Input) => boolean) | null = null
  let levelWait: { left: number; done: () => void } | null = null
  const banners: { node: HTMLElement; left: number }[] = []

  const syncMenuClass = () => bar.classList.toggle('is-moves', menus.mode === 'moves')

  const view: BattleView = {
    root,
    status,
    message,
    menus,
    setWeather(id) {
      const def = CONTENT.weatherById[id]
      weather.hidden = !def
      if (!def) return
      weather.textContent = def.nameZh
      weather.style.setProperty('--wc', def.color)
    },
    setTimer(sec) {
      timer.hidden = sec === null
      if (sec === null) return
      const s = Math.max(0, Math.ceil(sec))
      timer.textContent = t('battleui.prompt.timer', { sec: s })
      timer.classList.toggle('is-warn', s <= T.pvpTimerWarnSec)
    },
    banner(side, text) {
      const node = el('div', { class: `apb-banner ${side === 0 ? 'is-own' : 'is-foe'}`, text })
      root.append(node)
      banners.push({ node, left: T.abilityBannerMs })
    },
    setBoss(info) {
      status[1].setBoss(info)
      root.classList.toggle('has-boss', info !== null)
    },
    levelUp(title, deltas) {
      const p = panel(title, { className: 'apb-levelup ap-anim-in' })
      for (const d of deltas) {
        p.body.append(el('div', 'apb-lv-row', [
          el('span', { class: 'apb-lv-k', text: CONTENT.statByKey[d.key as StatKey]?.nameZh ?? d.key }),
          el('span', { class: 'apb-lv-v', text: String(d.after) }),
          el('span', { class: 'apb-lv-d', text: t('battleui.levelUp.delta', { n: d.after - d.before }) }),
        ]))
      }
      root.append(p.el)
      p.el.addEventListener('click', (e) => { e.stopPropagation(); levelWait?.done() })
      return new Promise<void>((resolve) => {
        levelWait = {
          left: T.levelUpPanelMs,
          done: () => {
            levelWait = null
            p.el.remove()
            resolve()
          },
        }
      })
    },
    setHudVisible(on) { root.classList.toggle('is-hud-hidden', !on) },
    setBarVisible(on) { bar.style.visibility = on ? '' : 'hidden' },
    setInterceptor(fn) { interceptor = fn },
    input(inp) {
      if (interceptor?.(inp)) return true
      if (effects.input(inp)) return true
      if (levelWait) {
        if (inp.pressed('confirm') || inp.pressed('cancel')) {
          inp.consume('confirm')
          inp.consume('cancel')
          audio.playSfx(BATTLE_UI.sfx.advance)
          levelWait.done()
        }
        return true
      }
      if (menus.input(inp)) return true
      return message.input(inp)
    },
    update(dt) {
      message.update(dt)
      syncMenuClass()
      if (levelWait) {
        levelWait.left -= dt * 1000
        if (levelWait.left <= 0) levelWait.done()
      }
      for (let i = banners.length - 1; i >= 0; i--) {
        const b = banners[i]
        b.left -= dt * 1000
        if (b.left > 0) continue
        banners.splice(i, 1)
        b.node.addEventListener('animationend', () => b.node.remove(), { once: true })
        b.node.classList.add('is-leaving')
      }
    },
  }
  return view
}
