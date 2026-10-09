// The developer panel (ADR 0002 §5): a right drawer on wide screens, a bottom sheet on narrow ones. Its layout comes from
// content/dev/console.json (`panel`), every action is a registry command, and while it is open the game ignores the
// keyboard and the on-screen touch controls are hidden.
import { t } from '../../../shared/content/index.ts'
import type { DevHost } from '../kit.ts'
import { CONSOLE, type CommandArgs, type CommandInfo, type Registry } from '../registry.ts'
import type { Section } from '../state.ts'
import { buildControl, readoutSection, type Built, type PanelEnv } from './controls.ts'
import { h } from './dom.ts'
import '../dev.css'

export interface Panel {
  readonly isOpen: boolean
  open(): void
  close(): void
  toggle(): void
  /** Refreshes the badge and, when open, the readouts and pick lists. */
  refresh(): void
  /** Opens the tab with that id. */
  tab(id: string): void
  destroy(): void
}

interface OutLine { ok: boolean; text: string }

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One line for a command result; scenario.check gets a readable summary because its failures are what matters. */
function summarize(id: string, result: unknown): string {
  if (id === 'scenario.check') {
    const r = result as { scenario: string | null; ok: boolean; results: { path: string; ok: boolean }[] }
    if (!r.scenario) return t('dev.ui.noScenario')
    const bad = r.results.filter((x) => !x.ok)
    return bad.length ? t('dev.ui.checkFail', { n: bad.length, list: bad.map((x) => x.path).join(', ') }) : t('dev.ui.checkAllOk', { n: r.results.length })
  }
  return result === null || result === undefined ? t('dev.ui.ok') : JSON.stringify(result)
}

export function mountPanel(host: DevHost, registry: Registry): Panel {
  const P = CONSOLE.panel
  const commands = new Map<string, CommandInfo>(registry.describe().map((c) => [c.id, c]))
  const out: OutLine[] = []
  let isOpen = false
  let activeTab = P.tabs[0].id
  let built: Built[] = []
  let timer: ReturnType<typeof setInterval> | null = null

  const badge = h('button', { type: 'button', class: 'apd-badge', 'data-dev-cmd': 'panel.toggle', title: t('dev.ui.open'), 'aria-label': t('dev.ui.open') })
  const seeds = h('span', { class: 'apd__seeds' })
  const close = h('button', { type: 'button', class: 'apd-btn', 'data-dev-cmd': 'panel.close' }, t('dev.ui.close'))
  const tabBar = h('nav', { class: 'apd__tabs', role: 'tablist', 'aria-label': t('dev.ui.tabs') })
  const body = h('div', { class: 'apd__body' })
  const outEl = h('div', { class: 'apd__out', role: 'log', 'aria-live': 'polite', 'data-dev-output': '' })
  const lineIn = h('input', { type: 'text', class: 'apd-in', name: 'line', placeholder: t('dev.ui.cmdline'), 'data-dev-cmdline': '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
  const lineGo = h('button', { type: 'submit', class: 'apd-btn apd-btn--go', 'data-dev-cmd': 'panel.line' }, t('dev.ui.go'))
  const lineClear = h('button', { type: 'button', class: 'apd-btn', 'data-dev-cmd': 'panel.clear' }, t('dev.ui.clear'))
  const lineForm = h('form', { class: 'apd__line' }, lineIn, lineGo, lineClear)
  const root = h('aside', { class: 'apd', 'data-dev-panel': '', 'data-open': 'false', 'aria-label': t('dev.ui.title'), hidden: true },
    h('header', { class: 'apd__bar' }, h('strong', { class: 'apd__title' }, t('dev.ui.title')), seeds, close),
    tabBar, body, h('footer', { class: 'apd__foot' }, outEl, lineForm))
  // Keys typed in the panel must never reach the game's own keyboard handling.
  for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation())

  const tabButtons = P.tabs.map((tab) => {
    const b = h('button', { type: 'button', class: 'apd-tab', role: 'tab', 'data-dev-cmd': 'panel.tab', 'data-dev-tab': tab.id }, t(tab.titleKey))
    b.addEventListener('click', () => selectTab(tab.id))
    return b
  })
  tabBar.append(...tabButtons)

  function exec(id: string, args: CommandArgs): Promise<void> {
    const echo = Object.keys(args).length ? `${id} ${JSON.stringify(args)}` : id
    return registry.run(id, args).then(
      (r) => say(true, echo, summarize(id, r)),
      (e: unknown) => say(false, echo, e instanceof Error ? e.message : String(e)),
    ).then(refresh)
  }
  const env: PanelEnv = { host, commands, meta: CONSOLE.commands, exec }

  function say(ok: boolean, echo: string, text: string): void {
    out.push({ ok, text: `${ok ? '✓' : '✗'} ${echo}${text ? ` → ${text}` : ''}` })
    if (out.length > P.outputLines) out.splice(0, out.length - P.outputLines)
    outEl.replaceChildren(...out.map((l) => h('div', { class: l.ok ? 'apd__ok' : 'apd__err' }, clip(l.text, P.outputChars))))
    outEl.scrollTop = outEl.scrollHeight
  }

  function selectTab(id: string): void {
    const tab = P.tabs.find((x) => x.id === id) ?? P.tabs[0]
    activeTab = tab.id
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.devTab === tab.id))
    built = []
    body.replaceChildren(...tab.sections.map((sec) => {
      const ctls = sec.controls.map((c) => { const b = buildControl(env, c); built.push(b); return b.el })
      return h('section', { class: 'apd-sec' }, h('h3', { class: 'apd-sec__t' }, t(sec.titleKey)), h('div', { class: 'apd-sec__c' }, ...ctls))
    }))
    body.scrollTop = 0
    refresh()
  }

  function refreshBadge(): void {
    const seed = t('dev.ui.seed', { w: host.world.seed, r: host.rng.seed })
    const sc = host.session.scenario
    seeds.textContent = seed
    badge.textContent = `DEV ${seed}${sc ? ` · ${t('dev.ui.scenarioTag', { id: sc })}` : ''}`
  }

  function refresh(): void {
    refreshBadge()
    if (!isOpen) return
    const wanted = new Set<Section>()
    for (const c of P.tabs.find((x) => x.id === activeTab)?.sections.flatMap((s) => s.controls) ?? []) {
      if (c.kind === 'readout') { const s = readoutSection(c.pointer); if (s) wanted.add(s) }
    }
    const doc = host.dump([...wanted])
    for (const b of built) b.refresh?.(doc)
  }

  const html = document.documentElement
  const compact = window.matchMedia(`(max-width: ${P.compactMaxWidth}px)`)
  const layout = () => { root.classList.toggle('apd--compact', compact.matches); badge.classList.toggle('apd-badge--compact', compact.matches) }
  compact.addEventListener('change', layout)
  layout()

  function open(): void {
    if (isOpen) return
    isOpen = true
    root.hidden = false
    root.dataset.open = 'true'
    html.classList.add('apd-on')
    host.overworld.setControlEnabled(false)
    host.ctx.input.setTouchControlsVisible(false)
    selectTab(activeTab)
    timer = setInterval(refresh, P.readoutMs)
  }
  function closePanel(): void {
    if (!isOpen) return
    isOpen = false
    root.hidden = true
    root.dataset.open = 'false'
    html.classList.remove('apd-on')
    if (timer) { clearInterval(timer); timer = null }
    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) document.activeElement.blur()
    host.overworld.setControlEnabled(true)
    host.ctx.input.setTouchControlsVisible(html.dataset.touchControls === 'on')
  }
  const toggle = () => (isOpen ? closePanel() : open())

  badge.addEventListener('click', toggle)
  close.addEventListener('click', closePanel)
  lineClear.addEventListener('click', () => { out.length = 0; outEl.replaceChildren() })
  lineForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const line = lineIn.value.trim()
    if (!line) return
    lineIn.value = ''
    void registry.runLine(line).then((r) => say(true, line, summarize(line.split(/\s+/)[0], r)), (err: unknown) => say(false, line, err instanceof Error ? err.message : String(err))).then(refresh)
  })

  const editable = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
  const onKey = (e: KeyboardEvent) => {
    if (e.code === P.toggleCode && !e.ctrlKey && !e.metaKey && !e.altKey && !editable(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); toggle() } else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopImmediatePropagation(); closePanel() }
  }
  window.addEventListener('keydown', onKey, true)

  document.body.append(badge, root)
  refreshBadge()
  // The scenario id and seeds change outside the panel's own commands (scenario boot, console).
  const badgeTimer = setInterval(refreshBadge, P.readoutMs * 2)
  return {
    get isOpen() { return isOpen },
    open, close: closePanel, toggle, refresh,
    tab: (id) => { open(); selectTab(id) },
    destroy() { closePanel(); clearInterval(badgeTimer); window.removeEventListener('keydown', onKey, true); compact.removeEventListener('change', layout); badge.remove(); root.remove() },
  }
}
