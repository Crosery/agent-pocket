// Layout audit for every screen at 1280x720, 1920x1080 and the phone viewports 390x844, 360x780 (portrait) and 844x390,
// 932x430 (landscape), all at DPR 3 with touch emulation (issues #29, #33, #37).
// Run through ego-browser against a dev server (?dev=1) in its own TaskSpace and an isolated save slot:
//   ego-browser nodejs <<'JS'
//   const { runLayoutAudit } = await import('file:///<repo>/scripts/qa-layout-audit.mjs')
//   await runLayoutAudit({ task: await taskSpace(<id>), base: 'http://127.0.0.1:<port>', phase: 'after' })
//   JS
// Writes output/29/<phase>/<viewport>/<screen>.png plus report.json and report.md (screen x viewport matrix).
// The in-page auditor (auditLayout) flags text that is clipped, cut by the viewport, covered, or overlapping other
// text, controls that overlap each other, model names that wrap past two lines, and pages that scroll sideways.
// Ellipsis, line clamps, rolling chat lines, tiny text and small touch targets are warnings. Also checks that name tags
// sit just above the opaque head of their actor, and worst-case battle HUD / effect inspector (status + volatiles + stages).
// 'hud-phone' (touch viewports only, incl. 932x430) shows every transient overworld HUD piece at once - region banner, toasts, tip,
// chat lines, quest card, activity chip, online badge, touch pad, DEV badge - and asserts that no two pieces overlap and none
// covers the player (padding from content/ui.json phoneHud.audit).
// Fixtures run with the first-run tips hidden (they are audited alone as 'tip'); report stats.scroll is the tallest
// scroller's content in viewport heights.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { setHUDViewport } from './qa-hud-layout.mjs'
import { auditBattleSprites } from './qa-battle-layout.mjs'

const BATTLE_UI = JSON.parse(readFileSync(new URL('../content/battle-ui.json', import.meta.url), 'utf8'))

const UI_PHONE_PAD = JSON.parse(readFileSync(new URL('../content/ui.json', import.meta.url), 'utf8')).phoneHud.audit.playerPadPx

export const VIEWPORTS = [
  { name: 'd1280', width: 1280, height: 720, dpr: 1 },
  { name: 'd1920', width: 1920, height: 1080, dpr: 1 },
  { name: 'm390', width: 390, height: 844, dpr: 3, touch: true },
  { name: 'm360', width: 360, height: 780, dpr: 3, touch: true },
  { name: 'm844', width: 844, height: 390, dpr: 3, touch: true },
  { name: 'm932', width: 932, height: 430, dpr: 3, touch: true },
]

/** Runs inside the page (serialised by page.evaluate): must not reference anything outside itself. */
export function auditLayout(opts) {
  const { scopeSel, ignoreSel, minFont } = opts
  const vw = innerWidth, vh = innerHeight
  const eps = 1.5
  const ROLLING = '.ap-chat-log' // windows that roll old lines off by design
  const violations = [], warnings = []
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
  }
  const shown = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
    const r = el.getBoundingClientRect()
    return r.width > 0.5 && r.height > 0.5
  }
  const roots = (scopeSel ? [...document.querySelectorAll(scopeSel)] : [document.body]).filter(shown)
  if (!roots.length) return { violations: [{ type: 'no-scope', sel: scopeSel ?? 'body', detail: 'scope element missing or hidden' }], warnings, stats: { texts: 0, controls: 0 } }
  const inScope = (el) => roots.some((r) => r.contains(el))
  const ignored = (el) => !!ignoreSel && !!el.closest(ignoreSel)
  const box = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })
  const inter = (a, b) => ({ w: Math.min(a.r, b.r) - Math.max(a.l, b.l), h: Math.min(a.b, b.b) - Math.max(a.t, b.t) })
  const clips = (el) => {
    const out = []
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      const hx = ['hidden', 'clip'].includes(cs.overflowX), hy = ['hidden', 'clip'].includes(cs.overflowY)
      const soft = ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)
      if (!hx && !hy && !soft) continue
      const r = a.getBoundingClientRect()
      out.push({ a, hx, hy, box: { l: r.left + a.clientLeft, t: r.top + a.clientTop, r: r.left + a.clientLeft + a.clientWidth, b: r.top + a.clientTop + a.clientHeight } })
    }
    return out
  }
  const visiblePart = (b, cl) => {
    let v = { ...b }
    for (const c of cl) {
      v = { l: Math.max(v.l, c.box.l), t: Math.max(v.t, c.box.t), r: Math.min(v.r, c.box.r), b: Math.min(v.b, c.box.b) }
      if (v.r <= v.l || v.b <= v.t) return null
    }
    return v
  }
  const hitStyle = document.createElement('style')
  hitStyle.textContent = '* { pointer-events: auto !important }'
  document.head.append(hitStyle)
  // Whether an element draws anything of its own (transparent wrappers and fade layers cover nothing).
  const paints = (el) => {
    const cs = getComputedStyle(el)
    if (Number(cs.opacity) < 0.05 || cs.visibility === 'hidden') return false
    if (['IMG', 'SVG', 'VIDEO', 'CANVAS'].includes(el.tagName.toUpperCase())) return true
    const bg = cs.backgroundColor.match(/[\d.]+/g) ?? []
    if (bg.length >= 4 ? Number(bg[3]) > 0.05 : bg.length === 3) return true
    if (cs.backgroundImage !== 'none' || cs.borderImageSource !== 'none') return true
    if (['top', 'right', 'bottom', 'left'].some((k) => parseFloat(cs[`border${k[0].toUpperCase()}${k.slice(1)}Width`]) > 0 && !/rgba\(\d+, \d+, \d+, 0\)/.test(cs[`border${k[0].toUpperCase()}${k.slice(1)}Color`]))) return true
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
  }
  const texts = []
  const all = roots.flatMap((r) => [r, ...r.querySelectorAll('*')])
  for (const el of all) {
    if (['SCRIPT', 'STYLE', 'CANVAS', 'NOSCRIPT'].includes(el.tagName) || ignored(el)) continue
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
    if (!own.length || !shown(el)) continue
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
    const lines = []
    for (const n of own) {
      const rg = document.createRange()
      rg.selectNodeContents(n)
      for (const q of rg.getClientRects()) {
        if (q.width < 0.5 || q.height < 0.5) continue
        // Glyph boxes are taller than tight line-heights: shrink them so touching lines do not read as overlapping.
        const pad = q.height * 0.14
        lines.push({ l: q.left, t: q.top + pad, r: q.right, b: q.bottom - pad })
        l = Math.min(l, q.left); t = Math.min(t, q.top + pad); r = Math.max(r, q.right); b = Math.max(b, q.bottom - pad)
      }
    }
    if (!isFinite(l)) continue
    const er = el.getBoundingClientRect()
    if (er.width < 2 || er.height < 2) continue
    const cl = clips(el)
    const full = { l, t, r, b }
    const vis = visiblePart(full, cl)
    const cvis = lines.map((q) => visiblePart(q, cl)).filter(Boolean)
    const text = own.map((n) => n.textContent.trim()).join(' ').slice(0, 40)
    texts.push({ el, full, vis, cl, text, lines: cvis, raw: lines })
  }
  for (const x of texts) {
    const { el, full, vis, cl, text } = x
    const sel = label(el)
    const cs = getComputedStyle(el)
    const selfTrim = cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none'
    // Walk the clipping ancestors from the inside out, line by line, on what is still visible: a soft scroller between
    // the text and a hard clip already took its share. A line cut in half is a defect; whole lines rolled out of a
    // window (chat history, clamped text) are only reported.
    let cur = x.raw
    for (const c of cl) {
      if (c.hx || c.hy) {
        let partial = 0, hidden = 0, worst = 0, hiddenSideways = false
        for (const q of cur) {
          const overX = c.hx ? Math.max(c.box.l - q.l, q.r - c.box.r) : 0
          const overY = c.hy ? Math.max(c.box.t - q.t, q.b - c.box.b) : 0
          const over = Math.max(overX, overY)
          if (over <= eps) continue
          if (!visiblePart(q, [c])) { hidden++; if (overX > overY) hiddenSideways = true; continue }
          partial++; worst = Math.max(worst, over)
        }
        if (partial || (hidden && hidden < cur.length)) {
          if (c.a === el && selfTrim) warnings.push({ type: cs.textOverflow === 'ellipsis' ? 'ellipsis' : 'line-clamp', sel, text, detail: `${worst.toFixed(0)}px beyond the box` })
          else if (partial || hiddenSideways) violations.push({ type: 'clipped', sel, text, detail: `cut by ${label(c.a)} by ${worst.toFixed(1)}px` })
          else if (c.a.matches(ROLLING)) warnings.push({ type: 'hidden-lines', sel, text, detail: `${hidden} line(s) rolled out of ${label(c.a)}` })
          else violations.push({ type: 'clipped', sel, text, detail: `${hidden} line(s) cut off by ${label(c.a)}` })
        } else if (hidden && hiddenSideways) {
          violations.push({ type: 'clipped', sel, text, detail: `fully cut by ${label(c.a)}` })
        }
      }
      cur = cur.map((q) => visiblePart(q, [c])).filter(Boolean)
      if (!cur.length) break
    }
    if (el.classList.contains('ap-model-name')) {
      const rows = new Set(x.lines.map((q) => Math.round((q.t + q.b) / 2 / 3)))
      if (rows.size > 2) violations.push({ type: 'name-lines', sel, text, detail: `model name wraps to ${rows.size} lines` })
    }
    if (vis && (vis.l < -eps || vis.t < -eps || vis.r > vw + eps || vis.b > vh + eps)) violations.push({ type: 'offscreen', sel, text, detail: `[${Math.round(vis.l)},${Math.round(vis.t)} .. ${Math.round(vis.r)},${Math.round(vis.b)}] in ${vw}x${vh}` })
    if (!vis) continue
    const fs = parseFloat(cs.fontSize)
    if (fs < minFont) warnings.push({ type: 'small-text', sel, text, detail: `${fs.toFixed(1)}px` })
    // Five probes over the first and last visible line: text half hidden under something is as bad as fully hidden.
    const first = x.lines[0], last = x.lines[x.lines.length - 1]
    const probes = [[(first.l + first.r) / 2, (first.t + first.b) / 2], [first.l + 2, first.t + 2], [first.r - 2, first.b - 2], [last.l + 2, last.b - 2], [last.r - 2, last.t + 2]]
    let coveredBy = null
    for (const [qx, qy] of probes) {
      if (qx < 0 || qy < 0 || qx >= vw || qy >= vh) continue
      for (const top of document.elementsFromPoint(qx, qy)) {
        if (top === el || el.contains(top) || top.contains(el)) break
        if (ignored(top) || !paints(top)) continue
        coveredBy = top
        break
      }
      if (coveredBy) break
    }
    if (coveredBy) violations.push({ type: 'covered', sel, text, detail: `under ${label(coveredBy)}${coveredBy.textContent.trim() ? ' "' + coveredBy.textContent.trim().slice(0, 20) + '"' : ''}` })
  }
  const seen = new Set()
  const vt = texts.filter((x) => x.vis)
  for (let i = 0; i < vt.length; i++) {
    for (let j = i + 1; j < vt.length; j++) {
      const a = vt[i], b = vt[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      let hit = null
      for (const p of a.lines) {
        for (const q of b.lines) {
          const o = inter(p, q)
          if (o.w >= 3 && o.h >= 3 && (!hit || o.w * o.h > hit.w * hit.h)) hit = o
        }
      }
      if (!hit) continue
      const key = `${label(a.el)}|${label(b.el)}|${a.text}|${b.text}`
      if (seen.has(key)) continue
      seen.add(key)
      violations.push({ type: 'text-overlap', sel: label(a.el), text: a.text, detail: `with ${label(b.el)} "${b.text}" (${hit.w.toFixed(0)}x${hit.h.toFixed(0)}px)` })
    }
  }
  const controls = []
  for (const el of all) {
    if (!el.matches('button, a[href], input, select, textarea, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])') || ignored(el) || !shown(el)) continue
    const r = el.getBoundingClientRect()
    const vis = visiblePart(box(r), clips(el.parentElement ?? el))
    if (vis) controls.push({ el, vis, w: r.width, h: r.height })
  }
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const o = inter(a.vis, b.vis)
      if (o.w < 3 || o.h < 3) continue
      const small = Math.min((a.vis.r - a.vis.l) * (a.vis.b - a.vis.t), (b.vis.r - b.vis.l) * (b.vis.b - b.vis.t))
      if (o.w * o.h < 0.15 * small) continue
      violations.push({ type: 'control-overlap', sel: label(a.el), text: a.el.textContent.trim().slice(0, 20), detail: `with ${label(b.el)} "${b.el.textContent.trim().slice(0, 20)}"` })
    }
  }
  if (document.documentElement.scrollWidth > vw + 1) violations.push({ type: 'page-overflow', sel: 'html', text: '', detail: `scrollWidth ${document.documentElement.scrollWidth} > ${vw}` })
  const touch = matchMedia('(pointer: coarse)').matches
  if (touch) for (const c of controls) if (c.w < 44 || c.h < 44) warnings.push({ type: 'small-target', sel: label(c.el), text: c.el.textContent.trim().slice(0, 20), detail: `${c.w.toFixed(0)}x${c.h.toFixed(0)}px` })
  hitStyle.remove()
  const uniq = (list) => { const m = new Map(); for (const v of list) { const k = `${v.type}|${v.sel}|${v.text}|${v.detail}`; if (!m.has(k)) m.set(k, v) } return [...m.values()] }
  // How much of the screen's content sits behind a scroll: the tallest scroller's content height in viewport heights.
  let scroll = null
  for (const el of all) {
    const cs = getComputedStyle(el)
    if (!['auto', 'scroll'].includes(cs.overflowY) || !shown(el) || el.scrollHeight <= el.clientHeight + 4) continue
    const screens = el.scrollHeight / vh
    if (!scroll || screens > scroll.screens) scroll = { sel: label(el), screens: Math.round(screens * 100) / 100 }
  }
  return { violations: uniq(violations), warnings: uniq(warnings), stats: { texts: texts.length, controls: controls.length, scroll } }
}

// ---- name tags ---------------------------------------------------------------------------------------------------------

/**
 * Independent check that every visible name tag sits just above the opaque head of its actor: projects the first opaque
 * texel row of each character sprite with the vertex shader's pose and compares it with the tag's DOM box.
 */
export async function measureNameTags(page) {
  return page.evaluate(async () => {
    const ctx = window.__AP
    const { RENDER } = await import('/src/client/render/config.ts')
    const { cameraPitch, sheetLayout } = await import('/src/client/render/sprite-utils.ts')
    const pitch = cameraPitch(ctx.world.camera)
    const lean = pitch * RENDER.camera.billboard.lean
    const rest = Math.max(Math.cos(pitch - lean), 0.05)
    const stretch = 1 + (1 / rest - 1) * RENDER.camera.billboard.compensate
    const canvasH = ctx.renderer.canvas.clientHeight
    const tags = [...document.querySelectorAll('.ap-ov-tag')].filter((n) => n.checkVisibility() && n.textContent.trim())
    const out = []
    ctx.world.scene.traverse((obj) => {
      if (!obj.name?.startsWith('actor:') || !obj.isMesh || !obj.visible) return
      const map = obj.material?.map
      const image = map?.image
      if (!image?.width) return
      const layout = sheetLayout(ctx.data, map)
      const uv = obj.geometry.getAttribute('uv')
      const col = Math.round(uv.getX(0) * layout.cols)
      const row = Math.round((1 - uv.getY(0)) * layout.rows)
      const cell = image.width / layout.cols
      const cv = document.createElement('canvas')
      cv.width = cv.height = cell
      const g = cv.getContext('2d')
      g.drawImage(image, col * cell, row * cell, cell, cell, 0, 0, cell, cell)
      const { data } = g.getImageData(0, 0, cell, cell)
      let top = cell
      for (let y = 0; y < cell && top === cell; y++) for (let x = 0; x < cell; x++) if (data[(y * cell + x) * 4 + 3] >= RENDER.actors.alphaTest * 255) { top = y; break }
      const y = ((cell - top - RENDER.actors.footInset) / cell) * RENDER.actors.height * stretch
      const head = obj.position.clone().set(0, y * Math.cos(lean), -y * Math.sin(lean) * obj.scale.y / obj.scale.z)
      obj.localToWorld(head)
      head.project(ctx.world.camera)
      if (head.z > 1 || Math.abs(head.x) > 1 || Math.abs(head.y) > 1) return
      const hx = (head.x * 0.5 + 0.5) * ctx.renderer.canvas.clientWidth, hy = (0.5 - head.y * 0.5) * canvasH
      // the tag closest above this head
      let best = null
      for (const t of tags) {
        const r = t.getBoundingClientRect()
        const dx = Math.abs((r.left + r.right) / 2 - hx), dy = hy - r.bottom
        if (dx < 40 && dy > -12 && dy < 80 && (!best || dy < best.gap)) best = { text: t.textContent, gap: dy }
      }
      if (best) out.push({ actor: obj.name, ...best })
    })
    return { expected: RENDER.overlay.nameOffsetPx, tags: out }
  })
}

/** Runs inside the page: every transient HUD piece that is showing, pairwise overlaps, and what covers the player. */
export function auditHudZones(opts) {
  const { pad } = opts
  const PIECES = [
    ['plate', '.ap-plate'], ['banner', '.ap-banner'], ['quest', '.ap-quest'], ['objective', '.ap-objective'],
    ['events', '.ap-evchips'], ['minimap', '.ap-minimap'], ['online', '.ap-net'], ['toast', '.ap-toast'],
    ['tip', '.ap-tip:not(.is-inline)'], ['chat-log', '.ap-chat:not(.is-open) .ap-chat-log'], ['chat-button', '.ap-chat-bar'],
    ['dev-badge', '.apd-badge'], ['stick', '.ap-touch__stick'], ['button', '.ap-touch__btn'],
  ]
  const items = []
  for (const [name, sel] of PIECES) {
    for (const el of document.querySelectorAll(sel)) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const label = name === 'button' ? `button:${el.dataset.action ?? '?'}` : name
      items.push({ name: label, box: { l: r.left, t: r.top, r: r.right, b: r.bottom } })
    }
  }
  const violations = []
  const inter = (a, b) => ({ w: Math.min(a.r, b.r) - Math.max(a.l, b.l), h: Math.min(a.b, b.b) - Math.max(a.t, b.t) })
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const o = inter(items[i].box, items[j].box)
    if (o.w > 2 && o.h > 2) violations.push({ type: 'hud-overlap', sel: `${items[i].name} x ${items[j].name}`, text: '', detail: `${o.w.toFixed(0)}x${o.h.toFixed(0)}px` })
  }
  const A = window.__AP, p = A.overworld.player
  const head = A.world.worldToScreen(p.x, p.elev + 1.7, p.y), foot = A.world.worldToScreen(p.x, p.elev, p.y)
  const body = { l: Math.min(head.x, foot.x) - 14 - pad.x, t: head.y - pad.top, r: Math.max(head.x, foot.x) + 14 + pad.x, b: foot.y + pad.bottom }
  for (const it of items) {
    const o = inter(it.box, body)
    if (o.w > 0 && o.h > 0) violations.push({ type: 'hud-over-player', sel: it.name, text: '', detail: `${o.w.toFixed(0)}x${o.h.toFixed(0)}px over the character` })
  }
  const kinds = {}
  for (const it of items) kinds[it.name.split(':')[0]] = (kinds[it.name.split(':')[0]] ?? 0) + 1
  const chat = document.querySelector('.ap-chat'), log = chat?.querySelector('.ap-chat-log')
  const chatState = chat && log ? { cls: chat.className, lines: log.children.length, opacity: getComputedStyle(log).opacity, visibility: getComputedStyle(log).visibility } : null
  return { violations, warnings: [], stats: { pieces: items.length, kinds, player: [body.l, body.t, body.r, body.b].map(Math.round), chat: chatState } }
}

// ---- save fixture ----------------------------------------------------------------------------------------------------

/** Longest-named creatures in the party, a stocked bag and box, a full dex: the worst case for every list. */
async function prepareSave(page) {
  await page.evaluate(async () => {
    const ctx = window.__AP
    // The first-use stick hint is decorative and timed; a stable layout run starts without it (checked on its own).
    try { localStorage.setItem('ap.touch.hintDone', '1') } catch { /* private mode */ }
    document.querySelector('.ap-touch__hint')?.classList.remove('is-on')
    ctx.net.disconnect()
    const { createCreature } = await import('/src/shared/creature.ts')
    const { Rng } = await import('/src/shared/rng.ts')
    const weight = (s) => Math.max([...s.nameZh].length, s.nameEn.length * 0.6)
    const sp = [...ctx.data.speciesList].sort((a, b) => weight(b) - weight(a))
    const mk = (s, i) => createCreature(s.id, 12 + ((i * 7) % 60), { rng: new Rng(i + 3), shiny: i === 2 }, ctx.data)
    ctx.save.party = sp.slice(0, 6).map(mk)
    ctx.save.party[3].nickname = '超长昵称测试一二三四'
    ctx.save.party[4].status = 'poison'
    ctx.save.party[5].hp = 0
    ctx.save.boxes[0] = sp.slice(6, 36).map(mk)
    ctx.save.boxes[1] = sp.slice(36, 60).map(mk)
    const ids = ctx.data.speciesList.map((s) => s.id)
    ctx.save.dexSeen = ids
    ctx.save.dexCaught = ids
    const items = Object.values(ctx.data.items)
    for (const it of items) ctx.save.bag[it.id] = 7 + (it.id.length % 13)
    ctx.save.money = 123456
    ctx.save.settings.showTips = false
    ctx.save.settings.autoRun = false
  })
}

async function toLab(page) {
  const target = await page.evaluate(async () => {
    const ctx = window.__AP
    ctx.save.badges = []
    ctx.save.quests.main = { stage: 1, done: false }
    ctx.save.trackedQuest = 'main'
    const { worldAnchors } = await import('/src/shared/world/index.ts')
    const lab = worldAnchors(ctx.data.world)['town:origin:lab']
    const tg = { map: lab.map, x: lab.x + 0.5, y: lab.y + 2.5 }
    void window.__ap.tp(lab.x, lab.y + 2, lab.map)
    return tg
  })
  await page.waitForFunction((tg) => {
    const p = window.__AP.overworld.player
    return window.__AP.overworld.free && p.map === tg.map && Math.hypot(p.x - tg.x, p.y - tg.y) <= 0.1
  }, target, { timeout: 40000 })
  await page.evaluate(() => document.fonts.ready)
}

/** Backs out of whatever is open; false when something modal refuses to close (the caller reloads the page). */
async function closeAll(page) {
  for (let i = 0; i < 8; i++) {
    const open = await page.evaluate(() => window.__AP.ui.isBlocking() || !!document.querySelector('.apb-root') || !!document.querySelector('.ap-kit-stack > *'))
    if (!open) return true
    await page.keyboard.press('KeyX')
    await page.waitForTimeout(250)
  }
  return false
}

// ---- screens ---------------------------------------------------------------------------------------------------------

/** Every transient overworld HUD piece at once, in the open overworld; `withTip` keeps the first-run tip card up (it hides the chat ticker). */
const phoneHudOpen = (withTip) => async (page) => {
    await page.evaluate(() => window.__ap.tp(513, 877, 'overworld'))
    await page.waitForFunction(() => { const p = window.__AP.overworld.player; return window.__AP.overworld.free && p.map === 'overworld' && Math.hypot(p.x - 513.5, p.y - 877.5) <= 0.2 }, undefined, { timeout: 40000 })
    await page.waitForTimeout(1500)
    await page.evaluate(async () => {
      const ctx = window.__AP
      ctx.save.settings.showTips = true
      ctx.save.quests.main = { stage: 1, done: false }
      ctx.save.trackedQuest = 'main'
      for (const id of ['national-day', 'api-rate-limit', 'gpu-shortage']) window.__ap.gameplay.start(id)
      ctx.hud.showBanner('模型蒸馏潮', '大模型们把知识蒸馏给了小模型——草丛里突然冒出一堆小巧玲珑的初级形态，经验值也更容易拿。')
      ctx.ui.toast('蒸馏潮来了！草丛里冒出了好多小巧的智灵。', 'info')
      ctx.ui.toast('价目牌翻到了红色一面：高峰时段，全场价格翻倍。', 'warn')
      for (const text of ['欢迎来到智灵口袋！和其他训练家一起探索、交换与对战吧。', '系统: 少年训练家 进入了智灵世界', '另一条用来撑满聊天栏的系统消息。']) {
        ctx.chat.addMessage({ name: '', channel: 'system', text: `${text} #${Date.now() % 10000}`, at: Date.now() })
      }
      window.__apOnboarding.debugShow('move')
    })
    await page.waitForTimeout(1200)
  if (!withTip) {
    await page.evaluate(() => document.querySelector('.ap-tip-close')?.click())
    await page.waitForTimeout(700)
  }
}

const run = (fn) => async (page) => { await page.evaluate(fn) }

/** Phones: the screens before this one were closed with keys, which makes the game think a keyboard is in use; a tap on the empty header corner restores touch. */
async function touchActivity(page) {
  if (!(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) return
  await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 2, y: 2, id: 1 }] })
  await page.waitForTimeout(90)
  await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(200)
}

const openChart = (o) => async (page) => {
  await page.evaluate(({ view, last }) => { void window.__AP.screens.typeChart({ view, type: last ? window.__AP.data.types.at(-1).id : undefined }) }, o)
  await page.waitForTimeout(600)
  await touchActivity(page)
}

export const SCREENS = [
  { id: 'hud', keepToasts: true, scope: null, ignore: '.ap-l-overlay canvas', open: async (page) => {
    await page.evaluate(async () => {
      const ctx = window.__AP
      const { regionSubtitle } = await import('/src/client/world/explore.ts')
      for (const id of ['national-day', 'api-rate-limit', 'gpu-shortage']) window.__ap.gameplay.start(id)
      ctx.hud.showBanner(ctx.overworld.region.nameZh, regionSubtitle(ctx.data.world, ctx.overworld.region))
      ctx.save.settings.showTips = true
      window.__apOnboarding.debugShow('menuHint')
    })
    await page.waitForTimeout(1800)
  } },
  // Touch viewports only: see auditHudZones.
  { id: 'hud-phone', touchOnly: true, keepToasts: true, scope: null, ignore: '.ap-l-overlay canvas', tip: true, hudZones: true, after: toLab, open: phoneHudOpen(true) },
  { id: 'hud-phone-chat', touchOnly: true, keepToasts: true, scope: null, ignore: '.ap-l-overlay canvas', tip: true, hudZones: true, noReshow: true, after: toLab, open: phoneHudOpen(false) },
  { id: 'hud-events', scope: '.ap-evdetails', open: async (page) => { await page.evaluate(() => document.querySelector('.ap-evtoggle')?.click()) }, closeKey: 'Escape' },
  { id: 'pause', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.pauseMenu() }) },
  { id: 'party', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.party('view') }) },
  { id: 'party-select', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.party('select', { title: '选择要出战的智灵' }) }) },
  { id: 'summary', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.summary(window.__AP.save.party[3]) }) },
  { id: 'summary-2', scope: '.ap-kit-stack > *:last-child', open: async (page) => { await page.evaluate(() => { void window.__AP.screens.summary(window.__AP.save.party[0]) }); await page.waitForTimeout(600); await page.keyboard.press('ArrowRight') } },
  { id: 'bag', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.bag('field') }) },
  { id: 'bag-battle', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.bag('battle') }) },
  { id: 'dex', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.dex() }) },
  { id: 'dex-detail', scope: '.ap-kit-stack > *:last-child', open: async (page) => { await page.evaluate(() => { void window.__AP.screens.dex() }); await page.waitForTimeout(700); await page.keyboard.press('KeyZ') } },
  { id: 'box', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.box() }) },
  { id: 'shop', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.shop(Object.keys(window.__AP.data.items).slice(0, 40)) }) },
  { id: 'map', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.worldMap({ fly: false }) }) },
  { id: 'quests', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.quests() }) },
  { id: 'settings', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.settings() }) },
  // 属性克制表 (issue #37): the three views, the grid with the cursor on its last row (scrolled, sticky headers), and the manual page that links to it.
  { id: 'typechart-type', scope: '.ap-kit-stack > *:last-child', open: openChart({ view: 'type' }) },
  { id: 'typechart-grid', scope: '.ap-kit-stack > *:last-child', open: openChart({ view: 'grid' }) },
  { id: 'typechart-grid-end', scope: '.ap-kit-stack > *:last-child', open: openChart({ view: 'grid', last: true }) },
  { id: 'typechart-loops', scope: '.ap-kit-stack > *:last-child', open: openChart({ view: 'loops' }) },
  { id: 'manual-chart', scope: '.ap-kit-stack > *:last-child', open: async (page) => {
    await page.evaluate(() => { void window.__AP.screens.manual() })
    await page.waitForTimeout(700)
    await page.evaluate(() => { [...document.querySelectorAll('.aps-manual .ap-tab')][1]?.click() })
    await page.waitForTimeout(400)
    await page.evaluate(() => { [...document.querySelectorAll('.aps-manual .ap-row')].find((r) => r.textContent.includes('属性克制'))?.click() })
    await page.waitForTimeout(400)
  } },
  { id: 'online', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.online() }) },
  { id: 'learn-move', scope: '.ap-kit-stack > *:last-child', open: run(() => {
    const cr = window.__AP.save.party[0]
    const moveId = Object.values(window.__AP.data.moves).find((m) => !cr.moves.some((s) => s.id === m.id))?.id
    void window.__AP.screens.learnMove(cr, moveId)
  }) },
  { id: 'newgame', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.screens.newGame() }) },
  { id: 'starter', scope: '.ap-kit-stack > *:last-child', open: run(() => {
    const ctx = window.__AP
    const weight = (s) => Math.max([...s.nameZh].length, s.nameEn.length * 0.6)
    void ctx.screens.starter([...ctx.data.speciesList].sort((a, b) => weight(b) - weight(a)).slice(0, 3))
  }) },
  { id: 'dialogue', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.ui.say([{ speaker: '图灵博士', text: '欢迎来到智灵世界！这里的每一只智灵都是由数据与想象力凝结而成的伙伴。它们有的擅长推理，有的擅长创作，还有的会在你意想不到的时候给你带来惊喜。准备好了吗？' }, '第二句话也很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长。']) }) },
  { id: 'choose', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.ui.choose('你想要选择哪一条路线继续旅程？', ['沿着 1 号道路前往开源林镇', '穿过古老的数据洞窟抵达研究所', '乘坐飞行智灵直接前往下一座城镇并且领取奖励', '先回家休息一下']) }) },
  { id: 'confirm', scope: '.ap-kit-stack > *:last-child', open: run(() => { void window.__AP.ui.confirm('确定要把这只智灵放生吗？放生后将无法找回，它携带的道具也会一并消失，请再确认一次。') }) },
  { id: 'toasts', keepToasts: true, scope: null, open: run(() => { for (const [k, t] of [['info', '提示：这是一条很长很长很长很长很长很长很长的信息提示文字'], ['success', '收服成功！'], ['warn', '背包快满了，请及时整理'], ['error', '网络连接失败，请稍后重试']]) window.__AP.ui.toast(t, k) }) },
  { id: 'toast-screen', keepToasts: true, scope: null, ignore: '.ap-l-hud, .ap-l-minimap, .ap-l-chat, .ap-l-overlay', open: async (page) => {
    await page.evaluate(() => { void window.__AP.screens.party('view') })
    await page.waitForTimeout(700)
    await page.evaluate(() => { for (const [k, t] of [['info', 'MiniMax Speech 2.6 的研究有了进展（+7.2 点）'], ['success', '研究等级提升到了 Lv.1！'], ['info', '打开菜单里的「智灵研究」就能领取等级奖励。'], ['warn', '黄金周开始啦！出门旅行的训练家获得的经验和奖金都增加了。']]) window.__AP.ui.toast(t, k) })
  } },
  { id: 'toast-dialogue', keepToasts: true, scope: null, ignore: '.ap-l-hud, .ap-l-minimap, .ap-l-chat, .ap-l-overlay', open: async (page) => {
    await page.evaluate(() => { void window.__AP.ui.say(['这是一段对话文字，底部的对话框不应被通知遮挡。']) })
    await page.waitForTimeout(500)
    await page.evaluate(() => { for (const [k, t] of [['info', 'MiniMax Speech 2.6 的研究有了进展（+7.2 点）'], ['success', '研究等级提升到了 Lv.1！'], ['info', '打开菜单里的「智灵研究」就能领取等级奖励。']]) window.__AP.ui.toast(t, k) })
  } },
  { id: 'chat', scope: '.ap-chat', open: async (page) => { await page.keyboard.press('KeyT'); await page.waitForTimeout(700) }, closeKey: 'Escape' },
  // The tutorial layer on top of the live HUD (whole page; statGlossary is the longest field-phase tip): the card must not cover HUD cards, minimap, chat or touch controls.
  { id: 'tip-world', scope: null, ignore: '.ap-l-overlay canvas', tip: true, open: async (page) => { await page.evaluate(() => { window.__AP.save.settings.showTips = true; window.__apOnboarding.debugShow('statGlossary') }); await page.waitForTimeout(1200) } },
  { id: 'tip', scope: '.ap-tip', open: async (page) => { await page.evaluate(() => { window.__AP.save.settings.showTips = true; window.__apOnboarding.debugShow('menuHint') }); await page.waitForTimeout(1200) } },
]

const BATTLE_SCREENS = [
  { id: 'battle-command', scope: '.apb-root', open: async (page) => { await waitCommand(page); await waitHud(page) } },
  { id: 'battle-moves', scope: '.apb-root', open: async (page) => { await waitCommand(page); await page.keyboard.press('KeyZ'); await page.waitForTimeout(700) } },
  // The longest battle-phase tip (typeMatchup) docked in the top strip, audited with the whole battle UI (status windows, message box, command bar).
  { id: 'battle-tip', scope: null, ignore: '.ap-l-chat, .ap-l-overlay canvas', tip: true, open: async (page) => {
    await closeInspector(page)
    await page.evaluate(() => { window.__AP.save.settings.showTips = true; window.__apOnboarding.debugShow('typeMatchup') })
    await page.waitForTimeout(1200)
  } },
  { id: 'battle-effects', scope: '.apb-effects-dialog', open: async (page) => { await page.keyboard.press('KeyX'); await page.waitForTimeout(300); await page.keyboard.press('Tab'); await page.waitForTimeout(700) } },
  // Worst case: a status, four volatiles and all seven stat stages on both sides, built on real status panels.
  { id: 'battle-hud-heavy', scope: '.apb-root', open: async (page) => { await closeInspector(page); await mountHeavy(page, false) } },
  { id: 'battle-effects-heavy', scope: '.apb-effects-dialog', open: async (page) => { await closeInspector(page); await mountHeavy(page, true) } },
]

async function closeInspector(page) {
  for (let i = 0; i < 2; i++) {
    if (!(await page.evaluate(() => !!document.querySelector('.apb-effects-dialog')))) break
    await page.keyboard.press('KeyX')
    await page.waitForTimeout(350)
  }
}

async function mountHeavy(page, open) {
  await page.evaluate(async (openPanel) => {
    const ctx = window.__AP
    const { createStatusPanel } = await import('/src/client/battle/status-panel.ts')
    const { createBattleEffectsPanel } = await import('/src/client/battle/effects-panel.ts')
    const { toView } = await import('/src/shared/creature.ts')
    const root = document.querySelector('.apb-root')
    if (!window.__heavy) {
      const own = createStatusPanel(true, () => {}), foe = createStatusPanel(false, () => {})
      own.setCreature(toView(ctx.save.party[0]), 'deep-think')
      foe.setCreature(toView(ctx.save.party[1]), 'guardrails')
      for (const p of [own, foe]) {
        p.setLevel(35)
        void p.setHp(20, 40, false)
        p.setStatus('poison')
        p.setVolatiles(['confusion', 'taunt', 'leech', 'focus'])
        p.setStages({ atk: 2, def: -1, spa: 3, spd: -2, spe: 1, acc: -1, eva: 2 })
        p.setAway(false)
        p.el.dataset.heavy = '1'
      }
      // Swap them in for the live panels so the battle layout places them exactly where it places the real ones.
      document.querySelector('.apb-status.is-own').replaceWith(own.el)
      document.querySelector('.apb-status.is-foe').replaceWith(foe.el)
      window.__heavy = { own, foe, panel: createBattleEffectsPanel(root, [own, foe]) }
    }
    if (openPanel) window.__heavy.panel.show(0)
    else window.__heavy.panel.close()
  }, open)
  await page.waitForTimeout(700)
}

// The first-run tips belong to the tutorial layer; they would sit over every screen's footer, so they are audited alone ('tip').
async function hideTips(page, hide) {
  await page.evaluate((h) => {
    let st = document.getElementById('qa-hide-tips')
    if (!st) { st = document.createElement('style'); st.id = 'qa-hide-tips'; document.head.append(st) }
    // The developer badge (?dev=1) floats over the bottom centre; it is not part of the game's UI.
    st.textContent = `.apd-badge { display: none !important }${h ? ' .ap-tip { display: none !important }' : ''}`
  }, hide)
}

/** The dev panel's badge is developer tooling (absent from release builds); only the HUD zone cases keep it on screen. */
async function hideDevBadge(page, hide) {
  await page.evaluate((h) => {
    let st = document.getElementById('qa-hide-dev-badge')
    if (!st) { st = document.createElement('style'); st.id = 'qa-hide-dev-badge'; document.head.append(st) }
    st.textContent = h ? '.apd-badge { display: none !important }' : ''
  }, hide)
}

async function waitHud(page) {
  await page.waitForFunction(() => !!document.querySelector('.apb-status.is-foe:not(.is-away)'), undefined, { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(500)
}

async function waitCommand(page) {
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!document.querySelector('.apb-cmd') && !document.querySelector('.apb-moves'))) return
    await page.keyboard.press('KeyZ')
    await page.waitForTimeout(400)
  }
}

async function startBattle(page) {
  await page.evaluate(async () => {
    const ctx = window.__AP
    const { createCreature } = await import('/src/shared/creature.ts')
    const { Rng } = await import('/src/shared/rng.ts')
    const weight = (s) => Math.max([...s.nameZh].length, s.nameEn.length * 0.6)
    const sp = [...ctx.data.speciesList].sort((a, b) => weight(b) - weight(a))
    const foe = createCreature(sp[1].id, 35, { rng: new Rng(9) }, ctx.data)
    window.__battle = ctx.battle.run({
      seed: 5, sides: [{ kind: 'player', name: 'p', party: ctx.save.party }, { kind: 'wild', name: 'w', party: [foe] }],
      isWild: true, canRun: true, canCatch: true, biome: ctx.data.biomes[0].id, timeOfDay: 'day', expGain: false,
    }, { kind: 'wild' })
  })
  await page.waitForFunction(() => !!document.querySelector('.apb-root .apb-status'), undefined, { timeout: 20000 })
  await page.waitForTimeout(1500)
}

export async function measureScreen(page, screen, shot) {
  await page.waitForTimeout(500)
  // a map or scene fade that is still going would "cover" the whole page
  await page.waitForFunction(() => { const f = document.querySelector('.ap-fade'); return !f || parseFloat(getComputedStyle(f).opacity) < 0.02 }, undefined, { timeout: 8000 }).catch(() => {})
  const run = () => page.evaluate(auditLayout, { scopeSel: screen.scope, ignoreSel: screen.ignore ?? '', minFont: 9 })
  let result = await run()
  // A screen that is still sliding in is not a layout defect: look once more before calling the scope missing.
  if (result.violations.some((v) => v.type === 'no-scope')) { await page.waitForTimeout(1800); result = await run() }
  // battle screens: creatures vs windows, bottom anchoring, no overworld pad (qa-battle-layout.mjs)
  if (screen.scope === '.apb-root') {
    const sprites = await page.evaluate(auditBattleSprites, { bottomMaxGapPx: BATTLE_UI.layout?.bottomMaxGapPx ?? 24 })
    result.violations.push(...sprites.violations)
    result.warnings.push(...sprites.warnings)
    result.stats = { ...result.stats, battle: sprites.stats }
  }
  await page.screenshot({ path: shot })
  return result
}

export async function runLayoutAudit({ task, base, phase = 'after', viewports = VIEWPORTS, only = null, slot = '2029100001', issue = 29 }) {
  assert.match(phase, /^[a-z0-9-]+$/)
  const outDir = fileURLToPath(new URL(`../output/${issue}/${phase}/`, import.meta.url))
  await mkdir(outDir, { recursive: true })
  let page
  try { page = task.page('p1') } catch { page = await task.newPage() }
  const report = []
  for (const vp of viewports) {
    await mkdir(`${outDir}${vp.name}`, { recursive: true })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: !!vp.touch })
    const restore = async () => {
      await page.goto(`${base}/?dev=1&skipTitle=1&reset=1&slot=${slot}&map=overworld&x=526&y=873&t=720`)
      await page.waitForFunction(() => window.__ap && window.__AP && window.__ap.pos().map === 'overworld' && window.__AP.overworld.free, undefined, { timeout: 60000 })
      await page.waitForTimeout(2000)
      await prepareSave(page)
      await setHUDViewport(page, vp)
      await toLab(page)
    }
    await restore()
    const errors0 = await page.evaluate(() => (window.__AP_LOG ?? []).length)
    const record = async (screen, result, shot) => {
      report.push({ screen: screen.id, viewport: vp.name, violations: result.violations, warnings: result.warnings, stats: result.stats, shot })
      console.log(`${vp.name} ${screen.id.padEnd(14)} violations=${result.violations.length} warnings=${result.warnings.length}`)
    }
    if (!only || only.includes('name-tags')) {
      await page.waitForTimeout(1500)
      const nt = await measureNameTags(page)
      const bad = nt.tags.filter((t) => Math.abs(t.gap - nt.expected) > 3)
      const violations = bad.map((t) => ({ type: 'name-tag', sel: t.actor, text: t.text, detail: `${t.gap.toFixed(1)}px above the head, expected ${nt.expected}px` }))
      if (!nt.tags.length) violations.push({ type: 'name-tag', sel: 'actors', text: '', detail: 'no visible name tag could be measured' })
      await record({ id: 'name-tags' }, { violations, warnings: [], stats: { tags: nt.tags.length } }, '')
    }
    for (const screen of SCREENS) {
      if (only && !only.includes(screen.id)) continue
      if (screen.touchOnly && !vp.touch) continue
      try {
        if (!(await closeAll(page))) await restore()
        await screen.open(page)
        if (!screen.keepToasts) await page.evaluate(() => document.querySelectorAll('.ap-toast').forEach((n) => n.remove()))
        await hideTips(page, screen.id !== 'tip' && !screen.tip)
        await hideDevBadge(page, !screen.hudZones)
        const shot = `${outDir}${vp.name}/${screen.id}.png`
        // The zone check goes first: tips and toasts time out, and the text audit below takes seconds. The tip is shown again for it.
        const zones = screen.hudZones ? await page.evaluate(auditHudZones, { pad: UI_PHONE_PAD }) : null
        if (zones && !screen.noReshow) { await page.evaluate(() => window.__apOnboarding.debugShow('move')); await page.waitForTimeout(600) }
        const result = await measureScreen(page, screen, shot)
        if (zones) {
          result.violations.push(...zones.violations)
          result.stats = { ...result.stats, ...zones.stats }
        }
        await record(screen, result, shot)
        if (screen.closeKey) await page.keyboard.press(screen.closeKey)
        if (screen.after) await screen.after(page)
      } catch (err) {
        await record(screen, { violations: [{ type: 'harness', sel: screen.id, text: '', detail: String(err.message).slice(0, 200) }], warnings: [], stats: {} }, '')
      }
    }
    if (!only || BATTLE_SCREENS.some((s) => only.includes(s.id))) {
      // A wild battle is scripted by the game and can end on its own; one clean restart before a failure counts.
      for (let attempt = 0; attempt < 2; attempt++) {
        const rows = []
        let failed = false
        try {
          if (!(await closeAll(page))) await restore()
          await startBattle(page)
          await hideTips(page, true)
          await hideDevBadge(page, true)
          for (const screen of BATTLE_SCREENS) {
            if (only && !only.includes(screen.id)) continue
            await hideTips(page, !screen.tip)
            if (screen.open) await screen.open(page)
            const shot = `${outDir}${vp.name}/${screen.id}.png`
            const result = await measureScreen(page, screen, shot)
            if (result.violations.some((v) => v.type === 'no-scope')) failed = true
            rows.push([screen, result, shot])
          }
        } catch (err) {
          failed = true
          rows.push([{ id: 'battle' }, { violations: [{ type: 'harness', sel: 'battle', text: '', detail: String(err.message).slice(0, 200) }], warnings: [], stats: {} }, ''])
        }
        if (failed && attempt === 0) { await restore(); continue }
        for (const [screen, result, shot] of rows) await record(screen, result, shot)
        break
      }
    }
    const errors = await page.evaluate((n) => (window.__AP_LOG ?? []).slice(n).filter((s) => /uncaught|rejection|frame error/.test(s)), errors0)
    if (errors.length) report.push({ screen: 'console', viewport: vp.name, violations: errors.map((e) => ({ type: 'console-error', sel: 'window', text: '', detail: e.slice(0, 160) })), warnings: [], stats: {}, shot: '' })
  }
  await page.cdp('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await writeFile(`${outDir}report.json`, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(`${outDir}report.md`, renderMarkdown(report, viewports))
  const total = report.reduce((n, r) => n + r.violations.length, 0)
  console.log(`layout audit (${phase}): ${total} violations across ${report.length} screen/viewport checks`)
  return report
}

export function renderMarkdown(report, viewports = VIEWPORTS) {
  const screens = [...new Set(report.map((r) => r.screen))]
  const cell = (r) => (!r ? '-' : r.violations.length ? `FAIL ${r.violations.length} (${[...new Set(r.violations.map((v) => v.type))].join(',')})` : `ok${r.warnings.length ? ` +${r.warnings.length}w` : ''}${r.stats?.scroll?.screens >= 1 ? ` scroll ${r.stats.scroll.screens}x` : ''}`)
  const lines = ['| screen | ' + viewports.map((v) => `${v.name} ${v.width}x${v.height}`).join(' | ') + ' |', '|---|' + viewports.map(() => '---|').join('')]
  for (const s of screens) lines.push(`| ${s} | ` + viewports.map((v) => cell(report.find((r) => r.screen === s && r.viewport === v.name))).join(' | ') + ' |')
  lines.push('', '## Violations', '')
  for (const r of report) for (const v of r.violations) lines.push(`- ${r.viewport} ${r.screen}: **${v.type}** \`${v.sel}\` "${v.text}" ${v.detail}`)
  lines.push('', '## Warnings', '')
  for (const r of report) {
    const byType = {}
    for (const w of r.warnings) (byType[w.type] ??= []).push(`\`${w.sel}\` "${w.text}" ${w.detail}`)
    for (const [t, list] of Object.entries(byType)) lines.push(`- ${r.viewport} ${r.screen}: ${t} x${list.length} - ${list.slice(0, 3).join('; ')}`)
  }
  return lines.join('\n') + '\n'
}
