import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UI_CONFIG, validateUIConfig } from '../src/client/ui/config.ts'
import { CONTENT } from '../src/shared/content/index.ts'
import { installEscapeFallback } from '../src/client/ui/focus.ts'
import { chatFocusVerdict, createEscapeStack, createStallWatch, type EscapeLayer } from '../src/client/ui/focus-guard.ts'

test('chat stays open only while focus is inside it', () => {
  assert.equal(chatFocusVerdict(true, true), 'keep')
  assert.equal(chatFocusVerdict(true, false), 'close')
  assert.equal(chatFocusVerdict(false, false), 'keep')
  assert.equal(chatFocusVerdict(false, true), 'keep')
})

function layer(id: string, open: boolean, log: string[]): EscapeLayer & { open: boolean } {
  const l = { id, open, isOpen: () => l.open, dismiss: () => { log.push(id); l.open = false } }
  return l
}

test('Esc dismisses exactly the topmost open layer, in the configured order', () => {
  const log: string[] = []
  const stack = createEscapeStack(['chat', 'tip'])
  const tip = layer('tip', true, log)
  const chat = layer('chat', true, log)
  stack.register(tip)
  stack.register(chat)
  assert.equal(stack.dismissTop(), 'chat')
  assert.equal(stack.dismissTop(), 'tip')
  assert.equal(stack.dismissTop(), null)
  assert.deepEqual(log, ['chat', 'tip'])
})

test('closed layers are skipped and Esc falls through when nothing is open', () => {
  const log: string[] = []
  const stack = createEscapeStack(['chat', 'tip'])
  stack.register(layer('chat', false, log))
  const tip = layer('tip', true, log)
  stack.register(tip)
  assert.equal(stack.dismissTop(), 'tip')
  assert.equal(stack.dismissTop(), null)
  assert.deepEqual(log, ['tip'])
})

test('layers missing from the order rank below listed ones, then by registration', () => {
  const log: string[] = []
  const stack = createEscapeStack(['chat'])
  stack.register(layer('first', true, log))
  stack.register(layer('second', true, log))
  stack.register(layer('chat', true, log))
  assert.deepEqual([stack.dismissTop(), stack.dismissTop(), stack.dismissTop()], ['chat', 'first', 'second'])
})

test('an unregistered layer is no longer dismissed', () => {
  const log: string[] = []
  const stack = createEscapeStack(['chat'])
  const off = stack.register(layer('chat', true, log))
  off()
  assert.equal(stack.dismissTop(), null)
  assert.deepEqual(log, [])
})

test('stall watch trips only after held movement has been refused for the limit', () => {
  const watch = createStallWatch(1.5)
  for (let i = 0; i < 5; i++) assert.equal(watch.step(0.25, true, true), false, `${(i + 1) * 0.25} s is still under the limit`)
  assert.equal(watch.step(0.25, true, true), true, 'reaches 1.5 s')
  assert.equal(watch.step(0.25, true, true), false, 're-arms after tripping')
})

test('stall watch ignores frames where the player is not trying to move and resets when unblocked', () => {
  const watch = createStallWatch(1)
  assert.equal(watch.step(5, true, false), false, 'idle while blocked never trips')
  assert.equal(watch.step(0.6, true, true), false)
  assert.equal(watch.step(0.3, true, false), false, 'a pause keeps the accumulated time')
  assert.equal(watch.step(0.3, true, true), false, '0.9 s so far')
  assert.equal(watch.step(0.016, false, true), false, 'unblocked starts over')
  assert.equal(watch.step(0.9, true, true), false, 'only 0.9 s since the reset')
  assert.equal(watch.step(0.2, true, true), true)
  watch.step(0.9, true, true)
  watch.reset()
  assert.equal(watch.step(0.2, true, true), false, 'reset() clears the accumulated time')
})

function press(target: EventTarget, props: Record<string, unknown>) {
  const e = Object.assign(new Event('keydown', { cancelable: true, bubbles: true }), { key: 'Escape', isComposing: false, keyCode: 27 }, props)
  target.dispatchEvent(e)
  return e
}

test('Esc fallback swallows the key only when it dismissed something', () => {
  const target = new EventTarget()
  const log: string[] = []
  const stack = createEscapeStack(['chat'])
  const chat = layer('chat', true, log)
  stack.register(chat)
  let reachedGame = 0
  installEscapeFallback(stack, target)
  target.addEventListener('keydown', () => { reachedGame++ })

  const first = press(target, {})
  assert.equal(first.defaultPrevented, true)
  assert.equal(reachedGame, 0, 'closing the chat must not also open the game menu')
  assert.deepEqual(log, ['chat'])

  const second = press(target, {})
  assert.equal(second.defaultPrevented, false)
  assert.equal(reachedGame, 1, 'with nothing open Esc reaches the game')
})

test('Esc fallback leaves other keys and IME composition alone and can be removed', () => {
  const target = new EventTarget()
  const log: string[] = []
  const stack = createEscapeStack(['chat'])
  stack.register(layer('chat', true, log))
  const off = installEscapeFallback(stack, target)
  assert.equal(press(target, { key: 'Enter' }).defaultPrevented, false)
  assert.equal(press(target, { isComposing: true }).defaultPrevented, false)
  assert.equal(press(target, { keyCode: 229 }).defaultPrevented, false)
  assert.deepEqual(log, [])
  off()
  assert.equal(press(target, {}).defaultPrevented, false)
  assert.deepEqual(log, [])
})

test('content/ui.json focus tunables are valid and name the overlays the game registers', () => {
  assert.deepEqual(validateUIConfig(UI_CONFIG, CONTENT.audio.sfx), [])
  assert.ok(UI_CONFIG.focus.stallSec > 0)
  assert.ok(UI_CONFIG.focus.escapeOrder.includes('chat'), 'game.ts registers the chat under this id')
  assert.ok(UI_CONFIG.focus.releaseClickScopes.every((s) => typeof s === 'string' && s.length > 0))
})
