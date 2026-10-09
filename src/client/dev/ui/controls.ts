// The panel's building blocks. Every actionable element carries data-dev-cmd (a registry command id, or panel.* for
// the panel's own chrome) so automation and tests can find it, and data-dev-args when the command has fixed arguments.
import { CONTENT, t } from '../../../shared/content/index.ts'
import type { DevAcceptance } from '../../../shared/types.ts'
import { getPointer } from '../../../shared/dev/diff.ts'
import type { DevHost } from '../kit.ts'
import { listEntries, type ListEntry } from '../lists.ts'
import { CONSOLE, type ArgSpec, type CommandArgs, type CommandInfo, type PanelControl } from '../registry.ts'
import type { Section } from '../state.ts'
import { EDITOR } from '../editor/config.ts'
import { h } from './dom.ts'

export interface PanelEnv {
  host: DevHost
  commands: ReadonlyMap<string, CommandInfo>
  meta: typeof CONSOLE.commands
  /** Runs a command through the registry and prints the outcome in the panel's output area. */
  exec(id: string, args: CommandArgs): Promise<void>
}

/** A built control and what to do when the underlying state may have changed. */
export interface Built { el: HTMLElement; refresh?(doc: Record<string, unknown>): void }

const SECTION_NAMES: readonly Section[] = ['save', 'runtime', 'world']

/** The state section a readout pointer reads from (its first path segment). */
export const readoutSection = (pointer: string): Section | null => {
  const s = pointer.split('/')[1] as Section
  return SECTION_NAMES.includes(s) ? s : null
}

const show = (v: unknown): string => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? t(v ? 'dev.ui.yes' : 'dev.ui.no') : String(v))

function readout(c: Extract<PanelControl, { kind: 'readout' }>): Built {
  const value = h('b', { class: 'apd-ro__v', 'data-dev-readout': c.pointer }, '—')
  return {
    el: h('div', { class: 'apd-ro' }, h('span', { class: 'apd-ro__k' }, t(c.labelKey)), value),
    refresh(doc) { value.textContent = show(getPointer(doc, c.pointer).value) },
  }
}

const tagsFor = (env: PanelEnv, id: string): HTMLElement[] => {
  const m = env.meta[id]
  return [
    ...(m?.mutates ? [h('span', { class: 'apd-tag apd-tag--warn' }, t('dev.ui.mutates'))] : []),
    ...(m?.needs === 'reload' || m?.needs === 'rebuildWorld' ? [h('span', { class: 'apd-tag apd-tag--info' }, t('dev.ui.needsReload'))] : []),
  ]
}

function preset(env: PanelEnv, c: Extract<PanelControl, { kind: 'preset' }>): Built {
  const b = h('button', { type: 'button', class: 'apd-btn', 'data-dev-cmd': c.cmd, 'data-dev-args': JSON.stringify(c.args) }, t(c.labelKey))
  b.addEventListener('click', () => { void env.exec(c.cmd, c.args) })
  return { el: b }
}

const pickLabel = (e: ListEntry): string => (e.label === e.id ? e.id : `${e.label} · ${e.id}`)
const infoText = (e: ListEntry): string => Object.entries(e.info ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' ')

/** A search box over a pick list; every result is a button that runs the command with that entry. */
function list(env: PanelEnv, c: Extract<PanelControl, { kind: 'list' }>): Built {
  const input = h('input', { type: 'search', class: 'apd-in', placeholder: t('dev.ui.search'), 'data-dev-search': c.source, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
  const rows = h('div', { class: 'apd-list' })
  const limit = Math.min(c.limit, CONSOLE.panel.listLimit)
  const fill = () => {
    const found = listEntries(env.host, c.source, input.value, limit)
    rows.replaceChildren(...(found.length ? found.map((e) => {
      const b = h('button', { type: 'button', class: 'apd-row', 'data-dev-cmd': c.cmd, 'data-dev-args': JSON.stringify({ ...c.args, [c.argName]: e.id }) },
        h('span', { class: 'apd-row__t' }, pickLabel(e)), h('span', { class: 'apd-row__i' }, infoText(e)))
      b.addEventListener('click', () => { void env.exec(c.cmd, { ...c.args, [c.argName]: e.id }) })
      return b
    }) : [h('div', { class: 'apd-empty' }, t('dev.ui.empty'))]))
  }
  input.addEventListener('input', fill)
  fill()
  const title = t(`dev.list.${c.source}`)
  return { el: h('div', { class: 'apd-pick' }, h('div', { class: 'apd-cmd__head' }, h('span', { class: 'apd-cmd__t' }, title), ...tagsFor(env, c.cmd)), input, rows), refresh: fill }
}

function field(env: PanelEnv, spec: ArgSpec, info: CommandInfo): { el: HTMLElement; read(): unknown } {
  const label = t(spec.labelKey ?? `dev.arg.${spec.name}`)
  const options = info.args.find((a) => a.name === spec.name)?.options
  let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  const common = { name: spec.name, 'data-dev-arg': spec.name }
  if (options) {
    control = h('select', { ...common, class: 'apd-in' }, ...(spec.optional ? [h('option', { value: '' }, t('dev.ui.unset'))] : []), ...options.map((o) => h('option', { value: o }, o)))
  } else if (spec.type === 'boolean') {
    control = h('select', { ...common, class: 'apd-in' }, ...(spec.optional ? [h('option', { value: '' }, t('dev.ui.unset'))] : []), h('option', { value: 'true' }, t('dev.ui.yes')), h('option', { value: 'false' }, t('dev.ui.no')))
  } else if (spec.type === 'json') {
    control = h('textarea', { ...common, class: 'apd-in apd-in--json', rows: 2, spellcheck: 'false' })
  } else {
    control = h('input', { ...common, class: 'apd-in', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: spec.type === 'integer' ? 'numeric' : spec.type === 'number' ? 'decimal' : 'text' })
  }
  const wrap = h('label', { class: 'apd-field' }, h('span', { class: 'apd-field__k' }, label + (spec.optional ? '' : ' *')), control)
  if (spec.list && control instanceof HTMLInputElement) {
    const source = spec.list
    const sugg = h('div', { class: 'apd-list apd-list--inline', hidden: true })
    const fill = () => {
      const q = control.value
      const found = listEntries(env.host, source, q, CONSOLE.panel.listLimit).filter((e) => e.id !== q).slice(0, 8)
      sugg.hidden = found.length === 0
      sugg.replaceChildren(...found.map((e) => {
        const b = h('button', { type: 'button', class: 'apd-row', 'data-dev-pick': e.id }, h('span', { class: 'apd-row__t' }, pickLabel(e)), h('span', { class: 'apd-row__i' }, infoText(e)))
        b.addEventListener('click', () => { control.value = e.id; sugg.hidden = true; control.focus() })
        return b
      }))
    }
    control.addEventListener('input', fill)
    control.addEventListener('focus', fill)
    control.placeholder = t('dev.ui.pick')
    wrap.append(sugg)
  }
  return { el: wrap, read: () => control.value }
}

/** A form for one command: a field per argument and a run button. */
function cmd(env: PanelEnv, c: Extract<PanelControl, { kind: 'cmd' }>): Built {
  const info = env.commands.get(c.cmd)
  const form = h('form', { class: 'apd-cmd', 'data-dev-form': c.cmd, novalidate: true })
  if (!info) { form.append(h('div', { class: 'apd-empty' }, c.cmd)); return { el: form } }
  const fields = env.meta[c.cmd].args.map((spec) => ({ spec, ...field(env, spec, info) }))
  const run = h('button', { type: 'submit', class: 'apd-btn apd-btn--go', 'data-dev-cmd': c.cmd }, t('dev.ui.run'))
  form.append(h('div', { class: 'apd-cmd__head' }, h('span', { class: 'apd-cmd__t' }, info.title), ...tagsFor(env, c.cmd)),
    ...fields.map((f) => f.el), run)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const args: CommandArgs = {}
    for (const f of fields) { const v = f.read(); if (v !== '') args[f.spec.name] = v }
    void env.exec(c.cmd, args)
  })
  return { el: form }
}

/** The scenarios an issue shipped with (content/dev/acceptance/*.json): load in place, reopen through the URL, check expectations. */
function acceptance(env: PanelEnv): Built {
  const { scenarios, acceptance: issues } = env.host.content
  const btn = (id: string, args: CommandArgs, label: string, extra = '') => {
    const b = h('button', { type: 'button', class: `apd-btn ${extra}`.trim(), 'data-dev-cmd': id, 'data-dev-args': JSON.stringify(args) }, label)
    b.addEventListener('click', () => { void env.exec(id, args) })
    return b
  }
  const block = (a: DevAcceptance) => h('div', { class: 'apd-acc' },
    h('div', { class: 'apd-cmd__head' }, h('span', { class: 'apd-cmd__t' }, t('dev.ui.issue', { issue: a.issue, title: t(a.titleKey) }))),
    ...a.scenarios.map((id) => h('div', { class: 'apd-acc__row', 'data-dev-scenario': id },
      h('span', { class: 'apd-row__t' }, scenarios[id] ? t(scenarios[id].titleKey) : id, h('small', { class: 'apd-row__i' }, id)),
      btn('scenario.load', { id }, t('dev.ui.load')), btn('scenario.open', { id }, t('dev.ui.open')))))
  return { el: h('div', { class: 'apd-accs' }, btn('scenario.check', {}, t('dev.ui.check'), 'apd-btn--go'), ...issues.map(block)) }
}

/** The editor's prop palette (content/dev/editor.json): each button arms placement of that prop. */
function palette(env: PanelEnv): Built {
  const cats = EDITOR.palette.map((cat) => h('div', { class: 'apd-pal' },
    h('div', { class: 'apd-cmd__head' }, h('span', { class: 'apd-cmd__t' }, t(cat.titleKey))),
    h('div', { class: 'apd-sec__c' }, ...cat.props.map((prop) => {
      const b = h('button', { type: 'button', class: 'apd-btn', 'data-dev-cmd': 'editor.place', 'data-dev-args': JSON.stringify({ prop }) }, CONTENT.props[prop]?.nameZh ?? prop)
      b.addEventListener('click', () => { void env.exec('editor.place', { prop }) })
      return b
    }))))
  return { el: h('div', { class: 'apd-accs' }, ...cats) }
}

export function buildControl(env: PanelEnv, c: PanelControl): Built {
  switch (c.kind) {
    case 'readout': return readout(c)
    case 'preset': return preset(env, c)
    case 'list': return list(env, c)
    case 'cmd': return cmd(env, c)
    case 'acceptance': return acceptance(env)
    case 'palette': return palette(env)
  }
}
