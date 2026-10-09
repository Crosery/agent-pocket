// Touch players must never be told to press keys they do not have: every tutorial tip and manual page reads
// cleanly on a phone, and script dialogue switches to its `<key>Touch` text while the last input was touch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, t } from '../src/shared/content/index.ts'
import type { ScriptStep } from '../src/shared/types.ts'
import type { DialogueLine, GameContext } from '../src/client/contracts.ts'
import { TUTORIAL } from '../src/client/onboarding/config.ts'
import { createScriptRunner, type ScriptHost } from '../src/client/world/script.ts'

const KEYBOARD_WORDS = /方向键|WASD|F5|Esc|Shift|Tab|空格|回车|键盘|Enter/
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
/** The text a touch player reads: the `bodyTouch` variant when there is one. */
const touchBody = (text: string): string => CONTENT.text[`${text}.bodyTouch`] ?? CONTENT.text[`${text}.body`]
const lessons = [
  ...TUTORIAL.tips.list.map((tip) => ({ what: `tip ${tip.id}`, text: tip.text, battle: tip.trigger.kind === 'battle' })),
  ...TUTORIAL.curriculum.lessons.map((l) => ({ what: `manual ${l.id}`, text: `tutorial.manual.${l.id}`, battle: l.id === 'battle' })),
]

test('touch tips and manual pages name no keyboard keys and no controls a phone does not have', () => {
  assert.ok(lessons.length > 50)
  for (const l of lessons) {
    const body = touchBody(l.text)
    assert.ok(body, `${l.what}: no body`)
    assert.doesNotMatch(body, KEYBOARD_WORDS, `${l.what}: keyboard wording on touch`)
    // quickSave has no on-screen button (F5), the minimap has no touch toggle.
    for (const p of placeholders(body)) assert.ok(p !== 'quickSave' && p !== 'minimap', `${l.what}: {${p}} on touch`)
    // Battle screens hide the A / B buttons: the finger taps the menu directly.
    if (l.battle) for (const p of placeholders(body)) assert.ok(p !== 'confirm' && p !== 'cancel', `${l.what}: {${p}} in a battle on touch`)
  }
})

test('the keyboard wording is untouched where it still applies', () => {
  assert.match(t('tutorial.tip.save.body'), /\{quickSave\}/)
  assert.match(t('tutorial.tip.hud.body'), /\{minimap\}/)
  assert.match(t('tutorial.tip.battle.body'), /\{confirm\}.*\{cancel\}/s)
  assert.match(t('game.intro.hint'), /方向键/)
})

test('script say lines use the Touch text on touch and the keyboard text otherwise', async () => {
  assert.ok('game.intro.hintTouch' in CONTENT.text)
  assert.doesNotMatch(t('game.intro.hintTouch'), KEYBOARD_WORDS)
  const run = async (lastDevice: 'keyboard' | 'gamepad' | 'touch'): Promise<string[]> => {
    const said: string[] = []
    const ctx = {
      data: CONTENT, save: { name: '小明', flags: {} }, input: { lastDevice },
      ui: { async say(lines: DialogueLine[]) { said.push(...lines.map((l) => l.text)) } },
    } as unknown as GameContext
    const host = { ctx } as unknown as ScriptHost
    const steps: ScriptStep[] = [{ op: 'say', text: 'game.intro.hint' }, { op: 'say', text: 'game.intro.wake' }]
    await createScriptRunner(host).run(steps, null)
    return said
  }
  const touchHint = t('game.intro.hintTouch', { touchConfirm: t('audio.touch.confirm') })
  assert.match(touchHint, /右下角的 A 键/, 'the confirm button is named from the touch labels, not typed into the text')
  assert.deepEqual(await run('touch'), [touchHint, t('game.intro.wake', { name: '小明' })])
  assert.deepEqual(await run('keyboard'), [t('game.intro.hint'), t('game.intro.wake', { name: '小明' })])
  assert.deepEqual(await run('gamepad'), [t('game.intro.hint'), t('game.intro.wake', { name: '小明' })])
})
