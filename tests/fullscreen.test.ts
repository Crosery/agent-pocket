import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fullscreenAvailable, isFullscreen, toggleFullscreen } from '../src/client/core/fullscreen.ts'

type G = { document?: unknown; window?: unknown }
const g = globalThis as unknown as G

function stub(opts: { enabled: boolean; displayModeFullscreen?: boolean; reject?: boolean }) {
  const log: string[] = []
  const doc: Record<string, unknown> = {
    fullscreenEnabled: opts.enabled,
    fullscreenElement: null,
    documentElement: {
      requestFullscreen: async () => {
        log.push('enter')
        if (opts.reject) throw new Error('denied')
        doc.fullscreenElement = doc.documentElement
      },
    },
    exitFullscreen: async () => { log.push('exit'); doc.fullscreenElement = null },
  }
  g.document = doc
  g.window = { matchMedia: (q: string) => ({ matches: !!opts.displayModeFullscreen && q.includes('display-mode: fullscreen') }) }
  return log
}

test('fullscreen toggle enters and leaves, and reports the resulting state', async () => {
  const log = stub({ enabled: true })
  assert.equal(fullscreenAvailable(), true)
  assert.equal(isFullscreen(), false)
  assert.equal(await toggleFullscreen(), true)
  assert.equal(await toggleFullscreen(), false)
  assert.deepEqual(log, ['enter', 'exit'])
})

test('fullscreen is hidden where the API is missing or the app already runs fullscreen', async () => {
  stub({ enabled: false })
  assert.equal(fullscreenAvailable(), false)
  stub({ enabled: true, displayModeFullscreen: true })
  assert.equal(fullscreenAvailable(), false)
  const log = stub({ enabled: true, reject: true })
  assert.equal(await toggleFullscreen(), false, 'a refused request leaves the state unchanged')
  assert.deepEqual(log, ['enter'])
  delete g.document
  delete g.window
  assert.equal(fullscreenAvailable(), false)
})
