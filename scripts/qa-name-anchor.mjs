import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../output/ui-reference-fusion/', import.meta.url))

export async function measureNameAnchor(page) {
  return page.evaluate(async () => {
    const ctx = window.__AP
    const { RENDER } = await import('/src/client/render/config.ts')
    const { cameraPitch, sheetLayout } = await import('/src/client/render/sprite-utils.ts')
    const mesh = ctx.world.scene.getObjectsByProperty('name', `actor:${ctx.save.avatar}`)
      .find(m => m.renderOrder === RENDER.actors.renderOrder.player)
    const image = mesh.material.map.image
    const layout = sheetLayout(ctx.data, mesh.material.map)
    const uv = mesh.geometry.getAttribute('uv')
    const col = Math.round(uv.getX(0) * layout.cols)
    const row = Math.round((1 - uv.getY(0)) * layout.rows)
    const cell = image.width / layout.cols
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = cell
    const g = canvas.getContext('2d')
    g.drawImage(image, col * cell, row * cell, cell, cell, 0, 0, cell, cell)
    const { data } = g.getImageData(0, 0, cell, cell)
    let top = cell
    for (let y = 0; y < cell && top === cell; y++) {
      for (let x = 0; x < cell; x++) {
        if (data[(y * cell + x) * 4 + 3] >= RENDER.actors.alphaTest * 255) { top = y; break }
      }
    }
    // Independently project the first opaque row with the actual vertex shader's pose.
    const pitch = cameraPitch(ctx.world.camera)
    const lean = pitch * RENDER.camera.billboard.lean
    const rest = Math.max(Math.cos(pitch - lean), 0.05)
    const stretch = 1 + (1 / rest - 1) * RENDER.camera.billboard.compensate
    const y = ((cell - top - RENDER.actors.footInset) / cell) * RENDER.actors.height * stretch
    const head = mesh.position.clone().set(0, y * Math.cos(lean), -y * Math.sin(lean) * mesh.scale.y / mesh.scale.z)
    mesh.localToWorld(head)
    head.project(ctx.world.camera)
    const headY = (0.5 - head.y * 0.5) * ctx.renderer.canvas.clientHeight
    const tag = [...document.querySelectorAll('.ap-ov-tag')].find(n => n.textContent === ctx.save.name)
    const r = tag.getBoundingClientRect()
    return { character: ctx.save.avatar, direction: ctx.overworld.player.facing, col, row, top,
      gap: headY - r.bottom, expectedGap: RENDER.overlay.nameOffsetPx, headY, tagBottom: r.bottom,
      visible: tag.checkVisibility(), errors: (window.__AP_LOG ?? []).filter(s => /uncaught|rejection|frame error/.test(s)) }
  })
}

export async function runNameAnchorQA({ task, slot, phase = 'after', characters }) {
  const page = task.page('p1')
  const url = new URL(await page.url())
  assert.equal(url.origin, 'http://127.0.0.1:5175')
  assert.equal(url.searchParams.get('dev'), '1')
  assert.match(slot, /^\d{10}$/)
  assert.equal(url.searchParams.get('slot'), slot)
  assert.match(phase, /^[a-z0-9-]+$/)
  await mkdir(output, { recursive: true })
  await page.evaluate(() => {
    window.__AP.net.disconnect()
    window.__AP.save.settings.autoRun = false
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  const ids = characters ?? await page.evaluate(() => window.__AP.data.characters.filter(c => c.playable).map(c => c.id))
  const reports = []
  for (const id of ids) {
    await page.evaluate(id => {
      const ctx = window.__AP
      ctx.save.avatar = id
      ctx.save.name = 'crosery'
      ctx.overworld.refresh()
    }, id)
    await page.waitForFunction(id => {
      const ctx = window.__AP
      return ctx.overworld.free && ctx.assets.characterTexture(id).image.width === 1024 &&
        ctx.world.scene.getObjectsByProperty('name', `actor:${id}`).some(m => m.renderOrder === 3)
    }, id)
    for (const [dir, key] of [['down', 'ArrowDown'], ['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['up', 'ArrowUp']]) {
      await page.keyboard.down(key)
      try {
        await page.waitForFunction(dir => window.__AP.overworld.player.facing === dir, dir)
      } finally {
        await page.keyboard.up(key)
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const report = await measureNameAnchor(page)
      reports.push(report)
      if (id === ids[0]) await page.screenshot({ path: `${output}${phase}-name-${dir}.png` })
    }
  }
  await writeFile(`${output}${phase}-name-report.json`, `${JSON.stringify(reports, null, 2)}\n`)
  for (const r of reports) {
    console.log(`${r.character}/${r.direction}: ${r.gap.toFixed(2)}px gap (expected ${r.expectedGap}px)`)
    assert.ok(r.visible && Math.abs(r.gap - r.expectedGap) <= 2, 'Name must stay just above the opaque head')
    assert.deepEqual(r.errors, [])
  }
  return reports
}
