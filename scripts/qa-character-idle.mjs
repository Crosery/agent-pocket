// Run in ego-browser with the existing TaskSpace and a confirmed-empty development save slot.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../output/idle-qa/', import.meta.url))

export async function runCharacterIdleQA({ task, slot, first = 0, count = 33 }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot, /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  await mkdir(output, { recursive: true })
  await page.evaluate(() => window.__AP.net.disconnect())
  const playerOrder = await page.evaluate(async () => {
    const { RENDER } = await import('/src/client/render/config.ts')
    return RENDER.actors.renderOrder.player
  })
  const characters = await page.evaluate(() => window.__AP.data.characters.map(c => ({ id: c.id, name: c.nameZh })))
  const directions = [['up', 'ArrowUp'], ['left', 'ArrowLeft'], ['down', 'ArrowDown'], ['right', 'ArrowRight']]
  const reports = []
  for (const character of characters.slice(first, first + count)) {
    await page.evaluate(c => {
      const ctx = window.__AP
      ctx.save.avatar = c.id
      ctx.save.name = c.name
      ctx.save.settings.autoRun = false
      ctx.overworld.refresh()
    }, character)
    await page.waitForFunction(({ id, playerOrder }) => {
      const ctx = window.__AP
      const mesh = ctx.world.scene.getObjectsByProperty('name', `actor:${id}`).find(m => m.renderOrder === playerOrder)
      return ctx.overworld.free && mesh?.material.map.image.width === 1024 && mesh.parent.position.x > 0
    }, { id: character.id, playerOrder }, { timeout: 10000 })
    if (first === 0 && character.id === characters[0].id) await page.evaluate(() => {
      const stream = window.__AP.renderer.canvas.captureStream(20)
      const chunks = []
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      window.__IDLE_QA_RECORDING = { recorder, chunks, stream }
      recorder.start()
    })
    for (const [dir, key] of directions) {
      const start = await page.evaluate(() => window.__AP.overworld.player)
      await page.keyboard.down(key)
      try {
        await page.waitForFunction(({ start, dir }) => {
          const p = window.__AP.overworld.player
          return p.facing === dir && Math.hypot(p.x - start.x, p.y - start.y) > 0.15
        }, { start, dir }, { timeout: 5000 })
      } finally {
        await page.keyboard.up(key)
      }
      const report = await page.evaluate(async ({ id, dir, playerOrder }) => {
        const ctx = window.__AP
        const mesh = ctx.world.scene.getObjectsByProperty('name', `actor:${id}`).find(m => m.renderOrder === playerOrder)
        const seen = new Set(), rows = new Set()
        const positions = new Set(), scales = new Set(), lifts = new Set()
        const end = performance.now() + 3200
        await new Promise(resolve => {
          const sample = () => {
            const uv = mesh.geometry.attributes.uv
            seen.add(Math.round(uv.getX(0) * 16))
            rows.add(Math.round((1 - uv.getY(0)) * 4))
            const p = mesh.parent.position
            positions.add([p.x.toFixed(5), p.y.toFixed(5), p.z.toFixed(5)].join(','))
            scales.add(mesh.scale.toArray().join(','))
            lifts.add(mesh.position.y)
            if (performance.now() < end) requestAnimationFrame(sample)
            else resolve()
          }
          // The native game loop, not the QA callback, advances Actor.update.
          requestAnimationFrame(() => requestAnimationFrame(sample))
        })
        return { id, dir, frames: [...seen].sort((a, b) => a - b), rows: [...rows], positions: [...positions],
          scales: [...scales], lifts: [...lifts], expectedRow: ctx.data.config.sprites.sheetRows[dir],
          errors: (window.__AP_LOG ?? []).filter(s => /uncaught|rejection|WebGL.*(error|invalid)/i.test(s)) }
      }, { id: character.id, dir, playerOrder })
      assert.deepEqual(report.frames, [0, 1, 2, 3, 4, 5, 6, 7], `${character.id}/${dir}: idle playback`)
      assert.deepEqual(report.rows, [report.expectedRow], `${character.id}/${dir}: facing`)
      assert.equal(report.positions.length, 1, `${character.id}/${dir}: ground drift`)
      assert.deepEqual(report.scales, ['1,1,1'], `${character.id}/${dir}: whole-card squash`)
      assert.deepEqual(report.lifts, [0], `${character.id}/${dir}: whole-card bob`)
      assert.deepEqual(report.errors, [])
      reports.push(report)
      if (character.id === characters[0].id) await page.screenshot({ path: `${output}game-idle-${dir}.png` })
    }
    console.log(`${character.id}: all four native-game idle loops PASS`)
    if (first === 0 && character.id === characters[0].id) {
      const video = await page.evaluate(async () => {
        const { recorder, chunks, stream } = window.__IDLE_QA_RECORDING
        await new Promise(resolve => { recorder.onstop = resolve; recorder.stop() })
        const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
        stream.getTracks().forEach(track => track.stop())
        delete window.__IDLE_QA_RECORDING
        let text = ''
        for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
        return btoa(text)
      })
      await writeFile(`${output}main-game-four-idles.webm`, Buffer.from(video, 'base64'))
    }
    await writeFile(`${output}world-runtime-${first}.json`, `${JSON.stringify(reports, null, 2)}\n`)
  }
  return { characters: reports.length / 4, directions: reports.length }
}

export async function runPreviewIdleQA({ task, label = 'desktop', first = 0, count = 6 }) {
  const page = task.page('p1')
  await page.waitForSelector('.aps-ng-live-stage canvas')
  const characters = await page.evaluate(() => window.__AP.data.characters.filter(c => c.playable).map(c => ({ id: c.id, name: c.nameZh })))
  if (await page.evaluate(() => document.querySelector('.aps-ng-motion').getAttribute('aria-pressed') === 'true')) {
    await page.click('.aps-ng-motion')
  }
  const reports = []
  for (const character of characters.slice(first, first + count)) {
    await page.hover(`.aps-ng-card[aria-label="${character.name}"]`, { label: 'select character preview' })
    await page.waitForFunction(name => {
      const card = [...document.querySelectorAll('.aps-ng-card')].find(e => e.getAttribute('aria-label') === name)
      return card?.getAttribute('aria-pressed') === 'true' && document.querySelector('.aps-ng-name')?.textContent === name
    }, character.name)
    // UI sheets and world textures load independently, particularly after a cold mobile reload.
    await page.waitForFunction(id => window.__AP.assets.characterTexture(id).image.width === 1024, character.id, { timeout: 10000 })
    for (const [dir, name] of [['up', '朝后'], ['down', '朝前'], ['left', '朝左'], ['right', '朝右']]) {
      await page.click(`.aps-ng-direction[aria-label="${name}"]`, { label: 'inspect directional idle' })
      await page.waitForFunction(name => {
        const button = [...document.querySelectorAll('.aps-ng-direction')].find(e => e.getAttribute('aria-label') === name)
        return button?.getAttribute('aria-pressed') === 'true'
      }, name)
      await page.waitForFunction(() => {
        const cv = document.querySelector('.aps-ng-live-stage canvas')
        return cv && cv.getContext('2d').getImageData(0, 0, 64, 64).data.some((v, i) => i % 4 === 3 && v)
      })
      const report = await page.evaluate(async ({ id, dir }) => {
        const ctx = window.__AP
        const hash = data => {
          let h = 2166136261
          for (const v of data) h = Math.imul(h ^ v, 16777619)
          return h >>> 0
        }
        const expected = new Set()
        const probe = document.createElement('canvas')
        probe.width = 64; probe.height = 64
        const g = probe.getContext('2d', { willReadFrequently: true })
        const image = ctx.assets.characterTexture(id).image
        const row = ctx.data.config.sprites.sheetRows[dir]
        for (let col = 0; col < 8; col++) {
          g.clearRect(0, 0, 64, 64)
          g.drawImage(image, col * 64, row * 64, 64, 64, 0, 0, 64, 64)
          expected.add(hash(g.getImageData(0, 0, 64, 64).data))
        }
        const cv = document.querySelector('.aps-ng-live-stage canvas')
        const seen = new Set(), foreign = new Set(), soles = new Set()
        const visibility = new Set()
        const start = performance.now()
        let samples = 0, last = start, maxGapMs = 0
        await new Promise(resolve => {
          const sample = () => {
            const now = performance.now()
            maxGapMs = Math.max(maxGapMs, now - last)
            last = now
            samples++
            visibility.add(document.visibilityState)
            const data = cv.getContext('2d').getImageData(0, 0, 64, 64).data
            const value = hash(data)
            seen.add(value)
            if (!expected.has(value)) foreign.add(value)
            soles.add(hash(data.subarray(56 * 64 * 4)))
            const complete = now - start >= 3200 && seen.size === expected.size
            if (!complete && now - start < 6500) requestAnimationFrame(sample)
            else resolve()
          }
          requestAnimationFrame(sample)
        })
        return { id, dir, poses: seen.size, expectedPoses: expected.size, foreign: [...foreign], soleVariants: soles.size,
          samples, elapsedMs: performance.now() - start, maxGapMs, visibility: [...visibility],
          overflow: document.documentElement.scrollWidth > innerWidth, viewport: [innerWidth, innerHeight],
          connected: cv.isConnected, character: document.querySelector('.aps-ng-name').textContent,
          walking: document.querySelector('.aps-ng-motion').getAttribute('aria-pressed') }
      }, { id: character.id, dir })
      assert.equal(report.connected, true, `${character.id}/${dir}: sampled a replaced preview canvas`)
      assert.equal(report.character, character.name, `${character.id}/${dir}: selected character changed during sampling`)
      assert.equal(report.walking, 'false')
      assert.deepEqual(report.visibility, ['visible'], `${character.id}/${dir}: browser paused a hidden game`)
      assert.equal(report.poses, report.expectedPoses, `${character.id}/${dir}: incomplete idle loop ${JSON.stringify(report)}`)
      assert.ok(report.poses >= 4, `${character.id}/${dir}: insufficient distinct idle poses`)
      assert.deepEqual(report.foreign, [], `${character.id}/${dir}: wrong direction or walk frames in idle preview`)
      assert.equal(report.soleVariants, 1, `${character.id}/${dir}: preview shoes moved`)
      assert.equal(report.overflow, false, `${label}: horizontal overflow`)
      reports.push(report)
    }
    console.log(`${character.id}: ${label} idle preview PASS`)
    await writeFile(`${output}preview-runtime-${label}.json`, `${JSON.stringify(reports, null, 2)}\n`)
  }
  await page.screenshot({ path: `${output}preview-${label}.png` })
  return { previews: reports.length, label }
}
