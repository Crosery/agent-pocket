// Preview ships the devtools build, production the plain build behind check:devgate (ADR 0002 §9 item 2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('deploy.yml builds preview with --mode devtools and production with the plain build plus check:devgate', () => {
  const step = text('.github/workflows/deploy.yml').split('- name: Build\n')[1].split('- name: Release stamp')[0]
  const [preview, production] = step.split('else')
  assert.match(preview, /"\$ENVIRONMENT" = preview/)
  assert.match(preview, /npm run build -- --mode devtools/)
  assert.doesNotMatch(preview, /check:devgate/)
  assert.match(production, /npm run build\s/)
  assert.match(production, /npm run check:devgate/)
  assert.doesNotMatch(production, /--mode devtools/)
})

test('the release stamp records whether the build carries devtools, and the deploy script warns when the env lacks AP_DEV', () => {
  assert.match(text('.github/workflows/deploy.yml'), /devtools:e\.DEVTOOLS==="true"/)
  const script = text('deploy/remote-deploy.sh')
  assert.match(script, /"devtools":true/)
  assert.match(script, /AP_DEV=\(1\|true\|yes\|on\)/)
  assert.match(script, /WARNING:/)
})
