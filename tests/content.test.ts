import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT, validateContent, t, timeOfDayAt, typeEffectiveness } from '../src/shared/content/index.ts'

test('content tables load and cross-reference cleanly', () => {
  const errs = validateContent()
  assert.deepEqual(errs, [], errs.join('\n'))
  assert.ok(CONTENT.speciesList.length > 0)
  assert.ok(CONTENT.terrain.length > 0)
})

test('helpers read from content', () => {
  assert.equal(typeof typeEffectiveness(CONTENT.types[0].id, [CONTENT.types[1].id]), 'number')
  assert.equal(timeOfDayAt(CONTENT.config.time.phases.find((p) => p.id === 'night')!.from), 'night')
  assert.equal(t('nonexistent.key'), 'nonexistent.key')
  assert.equal(t('common.level', { level: 7 }), CONTENT.text['common.level'].replace('{level}', '7'))
})
