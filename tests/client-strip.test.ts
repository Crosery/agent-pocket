import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { loadStripRules, stripFields } from '../scripts/client-strip.ts'

test('stripFields drops the named fields from every row, whatever the container', () => {
  assert.deepEqual(JSON.parse(stripFields('[{"id":"a","designPrompt":"x","n":1},{"id":"b"}]', ['designPrompt'])), [{ id: 'a', n: 1 }, { id: 'b' }])
  assert.deepEqual(JSON.parse(stripFields('{"a":{"keep":1,"drop":2}}', ['drop'])), { a: { keep: 1 } })
})

test('content/build.json: every clientStrip rule names a real content file and fields the client never reads', () => {
  const rules = loadStripRules()
  assert.ok(rules.length > 0)
  for (const r of rules) {
    const text = readFileSync(new URL(`../content/${r.file}`, import.meta.url), 'utf8')
    const stripped = stripFields(text, r.fields)
    assert.ok(stripped.length < text.length, `${r.file}: nothing was stripped`)
    for (const f of r.fields) {
      assert.ok(!stripped.includes(`"${f}"`), `${r.file}: ${f} survived`)
      // the client reads content through src/client and src/shared; only the type declaration may mention the field
      const readers = ['client', 'shared'].flatMap((d) => readdirSync(new URL(`../src/${d}/`, import.meta.url), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && file !== 'types.ts' && new RegExp(`\\b${f}\\b`).test(readFileSync(new URL(`../src/${d}/${file}`, import.meta.url), 'utf8')))
        .map((file) => `${d}/${file}`))
      assert.deepEqual(readers, [], `${f} is read by the client`)
    }
  }
})
