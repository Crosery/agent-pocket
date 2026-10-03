// Field HUD: region plate + clock (time-of-day glyph) + money, region banner, quest tracker, net status,
// and the overlay layer world/ uses for name tags & speech bubbles (see widgets.nameTag / speechBubble).
import type { TimeOfDay } from '../../shared/types.ts'
import type { HUD, NetStatus } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { UI_CONFIG } from './config.ts'
import { glyphEl } from './glyphs.ts'
import { ensureUIEnvironment, prepareRoot } from './scale.ts'
import { el, formatNumber } from './widgets.ts'

export interface HUDHandle extends HUD {
  readonly el: HTMLElement
  dispose(): void
}

export function createHUD(root: HTMLElement): HUDHandle {
  ensureUIEnvironment()
  prepareRoot(root)
  const cfg = UI_CONFIG.hud

  const overlay = el('div', { class: 'ap-layer ap-l-overlay', attrs: { 'aria-hidden': 'true' } })

  const regionText = el('span', { text: t('hud.region.unknown') })
  const region = el('div', 'ap-region', [glyphEl('diamond'), regionText])
  const todHost = el('span', 'ap-tod')
  const clockText = el('span', { class: 'ap-clock', text: t('hud.clock.placeholder') })
  const clock = el('span', 'ap-hud-stat', [todHost, clockText])
  const moneyVal = el('span', { class: 'ap-money-val', text: '0' })
  const money = el('span', { class: 'ap-hud-stat', title: t('common.money') }, [glyphEl('coin'), el('span', { class: 'ap-lbl', text: t('common.money') }), moneyVal])
  const plate = el('div', 'ap-plate', [region, el('div', 'ap-hud-stats', [clock, money])])

  const questText = el('div', 'ap-quest-text')
  const quest = el('div', { class: 'ap-quest', attrs: { role: 'status' } }, [
    el('div', 'ap-quest-title', [glyphEl('quest'), el('span', { text: t('hud.quest.title') })]),
    questText,
  ])
  quest.hidden = true

  const bannerTitle = el('div', 'ap-banner-title')
  const bannerSub = el('div', 'ap-banner-sub')
  const banner = el('div', { class: 'ap-banner', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    el('div', 'ap-banner-row', [el('div', 'ap-banner-line'), glyphEl('diamond'), bannerTitle, glyphEl('diamond'), el('div', 'ap-banner-line is-right')]),
    bannerSub,
  ])

  const netDot = el('span', 'ap-net-dot')
  const netText = el('span')
  const net = el('div', { class: 'ap-net', data: { status: 'offline' } }, [netDot, netText])

  const hud = el('div', 'ap-layer ap-l-hud ap-hud', [el('div', 'ap-hud-tl', [plate, quest]), banner, net])
  root.append(overlay, hud)

  let regionName = ''
  let regionTimer = 0
  let bannerTimer = 0
  let tod: TimeOfDay | null = null
  let moneyShown = 0
  let moneyTarget = 0
  let moneyRaf = 0
  let questValue: string | null = null

  const api: HUDHandle = {
    el: hud,
    overlay,
    setVisible(v: boolean) { hud.classList.toggle('is-hidden', !v) },
    setRegion(nameZh: string) {
      const name = nameZh || t('hud.region.unknown')
      if (name === regionName) return
      const first = regionName === ''
      regionName = name
      if (regionTimer) clearTimeout(regionTimer)
      if (first) { regionText.textContent = name; return }
      region.classList.add('is-swapping')
      regionTimer = window.setTimeout(() => {
        regionTimer = 0
        regionText.textContent = regionName
        region.classList.remove('is-swapping')
      }, cfg.regionFadeMs)
    },
    showBanner(title: string, subtitle?: string) {
      bannerTitle.textContent = title
      bannerSub.textContent = subtitle ?? ''
      banner.classList.remove('is-on')
      void banner.offsetWidth
      banner.classList.add('is-on')
      if (bannerTimer) clearTimeout(bannerTimer)
      bannerTimer = window.setTimeout(() => { bannerTimer = 0; banner.classList.remove('is-on') }, cfg.bannerMs)
    },
    setClock(label: string, next: TimeOfDay) {
      if (clockText.textContent !== label) clockText.textContent = label
      if (next !== tod) {
        tod = next
        const glyph = cfg.todGlyph[next]
        todHost.replaceChildren(...(glyph ? [glyphEl(glyph)] : []))
        clock.title = t(`hud.tod.${next}`)
      }
    },
    setMoney(value: number) {
      moneyTarget = value
      if (moneyRaf) return
      if (cfg.moneyTweenMs <= 0 || moneyShown === moneyTarget) {
        moneyShown = moneyTarget
        moneyVal.textContent = formatNumber(moneyShown)
        return
      }
      const from = moneyShown
      const start = performance.now()
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / cfg.moneyTweenMs)
        moneyShown = Math.round(from + (moneyTarget - from) * (1 - (1 - k) * (1 - k)))
        moneyVal.textContent = formatNumber(moneyShown)
        if (k < 1) moneyRaf = requestAnimationFrame(step)
        else {
          moneyRaf = 0
          if (moneyShown !== moneyTarget) api.setMoney(moneyTarget)
        }
      }
      moneyRaf = requestAnimationFrame(step)
    },
    setQuest(text: string | null) {
      if (text === questValue) return
      questValue = text
      quest.hidden = !text
      if (!text) return
      questText.textContent = text
      quest.style.animation = 'none'
      void quest.offsetWidth
      quest.style.animation = ''
    },
    setNetStatus(status: NetStatus, online: number) {
      net.dataset.status = status
      netText.textContent = status === 'online' ? t('hud.net.count', { n: online }) : t(`hud.net.${status}`)
      net.title = t(`hud.net.${status}`)
    },
    dispose() {
      if (moneyRaf) cancelAnimationFrame(moneyRaf)
      if (bannerTimer) clearTimeout(bannerTimer)
      if (regionTimer) clearTimeout(regionTimer)
      overlay.remove()
      hud.remove()
    },
  }
  api.setNetStatus('offline', 0)
  return api
}
