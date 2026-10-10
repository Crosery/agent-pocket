// One rule for "a full-screen panel or overlay owns the phone display" (issue #64): everything full-screen carries the
// .ap-fullscreen marker, a single CSS rule hides the touch pad and zeroes the bottom inset for it, and no screen patches
// that on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const files = walk('src/client')
const css = files.filter((f) => f.endsWith('.css'))
const ts = files.filter((f) => f.endsWith('.ts'))
const rules = (file: string): { selector: string; body: string }[] =>
  [...readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }))

test('every full-screen panel root carries the shared .ap-fullscreen marker', () => {
  let roots = 0
  for (const f of ts) {
    for (const m of readFileSync(f, 'utf8').matchAll(/class:\s*[`']([^`']*\baps-screen\b[^`']*)[`']/g)) {
      roots++
      assert.match(m[1], /\bap-fullscreen\b/, `${f}: "${m[1]}" is a full-screen root without .ap-fullscreen`)
    }
  }
  assert.ok(roots >= 2, 'openScreen and the reveal card are the roots')
})

test('the touch pad is hidden by the one .ap-fullscreen rule, not by per-screen rules', () => {
  const hides = css.flatMap((f) => rules(f).filter((r) => /(^|[^\w-])\.ap-touch\b(?!__)/.test(r.selector) && /(visibility:\s*hidden|display:\s*none)/.test(r.body)).map((r) => ({ f, ...r })))
  const allowed = hides.filter((h) => /\.ap-fullscreen\b/.test(h.selector) || h.selector === 'html.ap-battle-on .ap-touch')
  assert.deepEqual(hides.filter((h) => !allowed.includes(h)).map((h) => `${h.f}: ${h.selector}`), [])
  assert.ok(hides.some((h) => /\.ap-fullscreen\b/.test(h.selector)), 'the shared rule exists')
})

test('screens do not zero the bottom inset one by one', () => {
  for (const f of css.filter((x) => x.includes('/screens/') || x.endsWith('typechart.css'))) {
    assert.deepEqual(rules(f).filter((r) => /--ap-bottom-inset:\s*0/.test(r.body)).map((r) => r.selector), [], `${f} patches --ap-bottom-inset itself`)
  }
  const shared = css.flatMap((f) => rules(f)).find((r) => r.selector === '.ap-fullscreen')
  assert.match(shared?.body ?? '', /--ap-bottom-inset:\s*0px/)
})
