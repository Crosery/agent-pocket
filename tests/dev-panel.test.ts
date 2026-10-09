// The panel is data (content/dev/console.json `panel`): every control must point at a real command with valid
// arguments, every string must exist, and no command may be unreachable from the panel.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../src/shared/content/index.ts'
import { buildWorld } from '../src/shared/world/index.ts'
import { createSaveManager } from '../src/client/core/save.ts'
import { RngHub } from '../src/client/core/rng-hub.ts'
import { createDevClock } from '../src/client/dev/clock.ts'
import { COMMANDS } from '../src/client/dev/commands/index.ts'
import { devEnums } from '../src/client/dev/enums.ts'
import { LIST_SOURCES, listEntries } from '../src/client/dev/lists.ts'
import { CONSOLE, createRegistry, type PanelControl } from '../src/client/dev/registry.ts'
import { installDevText } from '../src/client/dev/text.ts'
import type { DevHost } from '../src/client/dev/kit.ts'
import { devContentFromDisk } from './dev-content.ts'

const world = buildWorld()
const content = devContentFromDisk()
const mem = new Map<string, string>()
const saves = createSaveManager({ world, storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v) }, removeItem: (k) => { mem.delete(k) } } })
before(() => installDevText())

const avatar = CONTENT.characters.find((c) => c.playable)!
const host = {
  ctx: { save: saves.newGame({ name: avatar.nameZh, avatar: avatar.id }), data: { ...CONTENT, world }, saves },
  world, rng: new RngHub(5), clock: createDevClock(), content, session: { scenario: null }, tick: () => {},
  overworld: { roamerInfo: () => [] }, onboarding: { objectiveId: '' },
  run: async () => null, dump: () => ({}),
} as unknown as DevHost
const reg = createRegistry(host, COMMANDS, { enums: devEnums(content) })

const P = CONSOLE.panel
const controls: { tab: string; c: PanelControl }[] = P.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.controls.map((c) => ({ tab: tab.id, c }))))
const hasText = (key: string) => typeof CONTENT.text[key] === 'string' && CONTENT.text[key] !== ''

test('panel: layout numbers and tab/section strings are sane', () => {
  assert.ok(P.toggleCode && P.readoutMs > 0 && P.listLimit > 0 && P.outputLines > 0 && P.outputChars > 20 && P.compactMaxWidth > 320)
  const ids = P.tabs.map((x) => x.id)
  assert.equal(new Set(ids).size, ids.length, 'tab ids are unique')
  for (const tab of P.tabs) {
    assert.ok(hasText(tab.titleKey), `tab text ${tab.titleKey}`)
    assert.ok(tab.sections.length > 0, `${tab.id} has sections`)
    for (const s of tab.sections) { assert.ok(hasText(s.titleKey), `section text ${s.titleKey}`); assert.ok(s.controls.length > 0, `${s.titleKey} is empty`) }
  }
})

test('panel: every command control resolves to a real, described command', () => {
  for (const { tab, c } of controls) {
    if (c.kind !== 'cmd' && c.kind !== 'preset' && c.kind !== 'list') continue
    const meta = CONSOLE.commands[c.cmd]
    assert.ok(meta && reg.has(c.cmd), `${tab}: unknown command ${c.cmd}`)
    assert.ok(hasText(meta.titleKey), `command text ${meta.titleKey}`)
    for (const a of meta.args) assert.ok(hasText(a.labelKey ?? `dev.arg.${a.name}`), `${c.cmd}: arg label for ${a.name}`)
    if (c.kind === 'cmd') for (const a of meta.args) if (a.list) assert.ok((LIST_SOURCES as readonly string[]).includes(a.list), `${c.cmd}.${a.name}: pick list ${a.list}`)
  }
})

test('panel: presets and list entries pass the same argument validation the command would apply', () => {
  for (const { tab, c } of controls) {
    if (c.kind === 'preset') {
      assert.ok(hasText(c.labelKey), `preset text ${c.labelKey}`)
      assert.doesNotThrow(() => reg.check(c.cmd, c.args), `${tab}: preset ${c.labelKey}`)
    } else if (c.kind === 'list') {
      assert.ok((LIST_SOURCES as readonly string[]).includes(c.source), `list source ${c.source}`)
      assert.ok(hasText(`dev.list.${c.source}`), `list title dev.list.${c.source}`)
      assert.ok(CONSOLE.commands[c.cmd].args.some((a) => a.name === c.argName), `${c.cmd} has no arg ${c.argName}`)
      const all = listEntries(host, c.source, '', 100000)
      assert.ok(all.length > 0, `${c.source} list is empty`)
      for (const e of all) assert.doesNotThrow(() => reg.check(c.cmd, { ...c.args, [c.argName]: e.id }), `${c.cmd} rejects ${c.source} entry ${e.id}`)
      assert.ok(c.limit > 0 && c.limit <= P.listLimit)
    }
  }
})

test('panel: readouts read an existing state section and have labels', () => {
  for (const { c } of controls) {
    if (c.kind !== 'readout') continue
    assert.ok(hasText(c.labelKey), `readout text ${c.labelKey}`)
    assert.match(c.pointer, /^\/(save|runtime|world)(\/|$)/, c.pointer)
  }
})

test('panel: every command is reachable from the panel, and all UI strings exist', () => {
  const reachable = new Set<string>()
  for (const { c } of controls) {
    if ('cmd' in c) reachable.add(c.cmd)
    if (c.kind === 'acceptance') for (const id of ['scenario.load', 'scenario.open', 'scenario.check']) reachable.add(id)
  }
  assert.deepEqual(Object.keys(CONSOLE.commands).filter((id) => !reachable.has(id)), [], 'commands the panel cannot run')
  for (const key of ['title', 'open', 'close', 'run', 'go', 'search', 'cmdline', 'output', 'ok', 'empty', 'seed', 'scenarioTag', 'needsReload', 'mutates', 'clear', 'yes', 'no', 'unset', 'pick', 'load', 'check', 'open', 'issue', 'tabs', 'checkFail', 'checkAllOk', 'noScenario']) {
    assert.ok(hasText(`dev.ui.${key}`), `dev.ui.${key}`)
  }
})

test('panel: acceptance lists point at existing scenarios', () => {
  assert.ok(controls.some(({ c }) => c.kind === 'acceptance'), 'an acceptance tab exists')
  assert.ok(content.acceptance.length > 0)
  for (const a of content.acceptance) {
    assert.ok(hasText(a.titleKey), `acceptance text ${a.titleKey}`)
    for (const id of a.scenarios) assert.ok(content.scenarios[id], `acceptance #${a.issue}: unknown scenario ${id}`)
  }
})
