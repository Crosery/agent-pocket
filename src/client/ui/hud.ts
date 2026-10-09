// Field HUD: region plate + clock (time-of-day glyph) + money, region banner, quest tracker, net status,
// and the overlay layer world/ uses for name tags & speech bubbles (see widgets.nameTag / speechBubble).
import type { TimeOfDay } from '../../shared/types.ts'
import type { HUD, NetStatus } from '../contracts.ts'
import { t } from '../../shared/content/index.ts'
import { UI_CONFIG } from './config.ts'
import { glyphEl } from './glyphs.ts'
import { ensureUIEnvironment, prepareRoot } from './scale.ts'
import { attentionDot, el, formatNumber, keyHint } from './widgets.ts'

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
  const region = el('div', 'ap-region', [glyphEl('home'), regionText])
  const todHost = el('span', 'ap-tod')
  const clockText = el('span', { class: 'ap-clock', text: t('hud.clock.placeholder') })
  const clock = el('span', 'ap-hud-stat', [todHost, clockText])
  const moneyVal = el('span', { class: 'ap-money-val', text: '0' })
  const money = el('span', { class: 'ap-hud-stat', title: t('common.money') }, [glyphEl('coin'), el('span', { class: 'ap-lbl', text: t('common.money') }), moneyVal])
  const plate = el('div', 'ap-plate ap-hud-frame', [region, el('div', 'ap-hud-stats', [clock, money])])

  const questText = el('div', 'ap-quest-text')
  const questSummary = el('span', 'ap-quest-summary')
  const questDetails = el('div', { class: 'ap-quest-details', attrs: {
    id: 'ap-quest-details', role: 'region', tabindex: '0', 'aria-label': t('hud.quest.title'),
  } }, [questText])
  const questToggle = el('button', { class: 'ap-quest-toggle', attrs: {
    type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ap-quest-details',
  } }, [glyphEl('quest'), el('span', { class: 'ap-quest-title', text: t('hud.quest.title') }),
    questSummary, glyphEl('advance', { className: 'ap-quest-chevron' })])
  const quest = el('div', { class: 'ap-quest is-collapsed', attrs: { 'aria-label': t('hud.quest.title') } }, [questToggle, questDetails])
  quest.hidden = true
  questDetails.hidden = true
  const missions = el('div', 'ap-hud-missions ap-hud-frame', [quest])
  const expandQuest = (on: boolean) => {
    if (!on && !quest.hidden && questDetails.contains(document.activeElement)) questToggle.focus({ preventScroll: true })
    quest.classList.toggle('is-collapsed', !on)
    questToggle.setAttribute('aria-expanded', String(on))
    questDetails.hidden = !on
    if (on) quest.dispatchEvent(new CustomEvent('ap-hud-expand', { bubbles: true }))
  }
  questToggle.addEventListener('click', () => expandQuest(quest.classList.contains('is-collapsed')))
  questToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && quest.classList.contains('is-collapsed')) { questToggle.blur(); return }
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); expandQuest(false) }
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (!e.repeat) questToggle.click()
  })
  questDetails.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key !== 'Escape') return
    e.preventDefault()
    expandQuest(false)
    questToggle.focus()
  })
  const onDetailsOpen = (e: Event) => { if (e.target !== quest) expandQuest(false) }
  root.addEventListener('ap-hud-expand', onDetailsOpen)

  const bannerTitle = el('div', 'ap-banner-title')
  const bannerSub = el('div', 'ap-banner-sub')
  const banner = el('div', { class: 'ap-banner', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    el('div', 'ap-banner-row', [el('div', 'ap-banner-line'), glyphEl('diamond'), bannerTitle, glyphEl('diamond'), el('div', 'ap-banner-line is-right')]),
    bannerSub,
  ])
  banner.hidden = true

  const netDot = el('span', 'ap-net-dot')
  const netText = el('span')
  const net = el('div', { class: 'ap-net', data: { status: 'offline' } }, [netDot, netText])

  const menuChipKey = el('span', 'ap-menu-chip-key')
  const menuChip = el('div', { class: 'ap-menu-chip', attrs: { role: 'status' } }, [attentionDot(), menuChipKey, el('span', { text: t('hud.attention.menu') })])
  menuChip.hidden = true
  let chipDevice = ''

  const hud = el('div', 'ap-layer ap-l-hud ap-hud', [el('div', 'ap-hud-tl', [plate, menuChip, banner, missions]), net])
  root.append(overlay, hud)

  let regionName = ''
  let regionTimer = 0
  let bannerTimer = 0
  let tod: TimeOfDay | null = null
  let moneyShown = 0
  let moneyTarget = 0
  let moneyRaf = 0
  let questValue: string | null = null
  let questTitle = ''

  const api: HUDHandle = {
    el: hud,
    overlay,
    setVisible(v: boolean) { hud.classList.toggle('is-hidden', !v); if (!v) expandQuest(false) },
    setRegion(nameZh: string) {
      const name = nameZh || t('hud.region.unknown')
      if (name === regionName) return
      const first = regionName === ''
      regionName = name
      region.title = name
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
      if (bannerTimer) clearTimeout(bannerTimer)
      bannerTitle.textContent = title
      bannerSub.textContent = subtitle ?? ''
      banner.hidden = false
      banner.classList.remove('is-on')
      void banner.offsetWidth
      banner.classList.add('is-on')
      bannerTimer = window.setTimeout(() => {
        banner.classList.remove('is-on')
        bannerTimer = window.setTimeout(() => { bannerTimer = 0; banner.hidden = true }, cfg.bannerFadeMs)
      }, cfg.bannerMs)
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
    setQuest(text: string | null, summary?: string) {
      const title = summary || t('hud.quest.title')
      if (text === questValue && title === questTitle) return
      questValue = text
      questTitle = title
      expandQuest(false)
      quest.hidden = !text
      if (!text) return
      questSummary.textContent = title
      questToggle.setAttribute('aria-label', t('hud.quest.label', { quest: title }))
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
    setMenuAlert(on: boolean, device) {
      menuChip.hidden = !on
      if (!on || device === chipDevice) return
      chipDevice = device
      menuChipKey.replaceChildren(keyHint('menu', { device }))
    },
    dispose() {
      if (moneyRaf) cancelAnimationFrame(moneyRaf)
      if (bannerTimer) clearTimeout(bannerTimer)
      if (regionTimer) clearTimeout(regionTimer)
      root.removeEventListener('ap-hud-expand', onDetailsOpen)
      overlay.remove()
      hud.remove()
    },
  }
  api.setNetStatus('offline', 0)
  return api
}
