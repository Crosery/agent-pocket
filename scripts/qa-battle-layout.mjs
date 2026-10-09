// Battle layout QA (issue #32): viewports, the viewport switch for battle screens, and the geometry checks that make
// the hard rules measurable: no HUD window overlaps a creature sprite, no foreign element sits on a sprite, and the
// bottom windows sit on the real screen bottom (no dead band).
//   ego-browser nodejs <<'JS'
//   const { runBattleLayoutAudit } = await import('file:///<repo>/scripts/qa-battle-layout.mjs')
//   await runBattleLayoutAudit({ task: await taskSpace(<id>), base: 'http://127.0.0.1:<port>', phase: 'layout' })
//   JS
import assert from 'node:assert/strict'

/** The seven screens the owner cares about: desktop 16:9, 16:10, 3:2, 4:3, and phones in both orientations. */
export const BATTLE_VIEWPORTS = [
  { name: 'd1280', width: 1280, height: 720, dpr: 1 },
  { name: 'd1920', width: 1920, height: 1080, dpr: 1 },
  { name: 'd1440', width: 1440, height: 900, dpr: 1 },
  { name: 'd2000', width: 2000, height: 1300, dpr: 1 },
  { name: 'd1024', width: 1024, height: 768, dpr: 1 },
  { name: 'm390', width: 390, height: 844, dpr: 2, touch: true },
  { name: 'l844', width: 844, height: 390, dpr: 2, touch: true },
]

/** Resizes the page like a device (metrics, touch emulation, touch-controls setting) and waits for the UI scale to follow. */
export async function setBattleViewport(page, vp) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: false })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: !!vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
  await page.waitForFunction(({ width, height, dpr }) => innerWidth === width && innerHeight === height && devicePixelRatio === dpr, vp)
  const expected = await page.evaluate(async (v) => {
    const { computeUIScale } = await import('/src/client/ui/scale.ts')
    const { applyDocumentSettings } = await import('/src/client/core/settings.ts')
    window.__AP.save.settings.touchControls = v.touch ? 'on' : 'off'
    applyDocumentSettings(window.__AP.save.settings)
    window.dispatchEvent(new Event('resize'))
    return computeUIScale(v.width, v.height, v.dpr)
  }, vp)
  await page.waitForFunction(({ cssPerUnit, compact }) =>
    Number(document.documentElement.style.getPropertyValue('--ap-ui-scale')) === cssPerUnit &&
    document.documentElement.classList.contains('ap-compact') === compact, expected)
}

/**
 * Runs in the page. The hard rules of the battle screen, measured on whatever is showing:
 *  - hud-over-sprite: a [data-hud] window (visible, not faded out) intersects a creature's visible pixels' bounding box;
 *  - paint-over-sprite: any other painted element (banner, badge, tooltip, marker...) sits on a creature;
 *  - off-screen: a window leaves the viewport;
 *  - bottom-gap: the bottom windows leave more than `bottomMaxGapPx` under them (a dead band);
 *  - touch-pad: the overworld touch pad is visible during battle.
 * Creature boxes come from the stage (`window.__apStage`, dev builds): the opaque pixels of each sprite.
 */
export function auditBattleSprites(opts) {
  const violations = []
  const warnings = []
  const stage = window.__apStage
  const root = document.querySelector('.apb-root')
  if (!stage || !root) return { violations, warnings, stats: { skipped: true } }
  const vw = innerWidth, vh = innerHeight
  const rectOf = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return w > 0.5 && h > 0.5 ? w * h : 0
  }
  const shown = (e) => {
    const cs = getComputedStyle(e)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05
  }
  const label = (e) => `${e.tagName.toLowerCase()}.${String(e.className).split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`
  const sprites = [0, 1].map((side) => {
    const f = stage.creatureRect(side)
    return f ? { side, box: { left: f.left * vw, right: f.right * vw, top: f.top * vh, bottom: f.bottom * vh } } : null
  }).filter(Boolean)

  const huds = [...root.querySelectorAll('[data-hud], .apb-status, .apb-msg, .apb-menu-wrap, .apb-levelup')].filter((e) => e.checkVisibility({ visibilityProperty: true }) && e.offsetWidth > 1 && shown(e))
  for (const e of huds) {
    const r = rectOf(e)
    for (const s of sprites) {
      const a = overlap(r, s.box)
      if (a > 0) violations.push({ type: 'hud-over-sprite', sel: label(e), text: '', detail: `${Math.round(a)}px² over the ${s.side === 0 ? 'own' : 'foe'} creature` })
    }
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) violations.push({ type: 'off-screen', sel: label(e), text: '', detail: `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}x${vh}` })
  }

  // any other painted element on a creature (banners, badges, tips, overlays)
  const hudSet = new Set(huds)
  const inHud = (e) => { for (let n = e; n; n = n.parentElement) if (hudSet.has(n)) return true; return false }
  const painted = (e, cs) => {
    if (/^(IMG|VIDEO|SVG|BUTTON)$/i.test(e.tagName)) return true
    const bg = cs.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]
    if ((bg[3] ?? 1) > 0.05) return true
    if (cs.backgroundImage !== 'none' || cs.borderImageSource !== 'none') return true
    return [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
  }
  for (const e of document.body.querySelectorAll('*')) {
    if (e === root || inHud(e) || e.closest('canvas') || e.tagName === 'CANVAS' || e.tagName === 'SCRIPT' || e.tagName === 'STYLE') continue
    if (!e.checkVisibility({ visibilityProperty: true })) continue
    const cs = getComputedStyle(e)
    if (!shown(e) || !painted(e, cs)) continue
    const r = rectOf(e)
    if (r.right - r.left < 2 || r.bottom - r.top < 2 || (r.right - r.left) * (r.bottom - r.top) > vw * vh * 0.5) continue
    for (const s of sprites) {
      const a = overlap(r, s.box)
      if (a > 0) violations.push({ type: 'paint-over-sprite', sel: label(e), text: (e.textContent ?? '').trim().slice(0, 24), detail: `${Math.round(a)}px² over the ${s.side === 0 ? 'own' : 'foe'} creature` })
    }
  }

  // anchored to the real bottom: no dead band under the bottom windows
  const bottoms = huds.map((e) => rectOf(e)).filter((r) => r.bottom > vh * 0.5)
  const lowest = bottoms.length ? Math.max(...bottoms.map((r) => r.bottom)) : 0
  const gap = vh - lowest
  if (bottoms.length && gap > opts.bottomMaxGapPx) violations.push({ type: 'bottom-gap', sel: '.apb-bar', text: '', detail: `${Math.round(gap)}px free under the bottom windows (limit ${opts.bottomMaxGapPx})` })
  // the overworld pad has no place in battle
  const pad = [...document.querySelectorAll('.ap-touch__btn, .ap-touch__zone')].filter((e) => e.checkVisibility({ visibilityProperty: true }))
  if (pad.length) violations.push({ type: 'touch-pad', sel: '.ap-touch', text: '', detail: `${pad.length} overworld touch control(s) visible in battle` })
  return {
    violations,
    warnings,
    stats: { viewport: `${vw}x${vh}`, sprites: sprites.map((s) => ({ side: s.side, ...Object.fromEntries(Object.entries(s.box).map(([k, x]) => [k, Math.round(x)])) })), hud: huds.length, bottomGap: Math.round(gap), composition: stage.composition },
  }
}
