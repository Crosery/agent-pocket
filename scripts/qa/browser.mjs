// The browser half of the QA runner. scripts/qa/run.mjs prepends `const CONFIG = {...}` and pipes this file into
// `ego-browser nodejs`. It drives the page only through window.__ap.v1 and the developer panel's data-dev-* selectors.
const page = (await (CONFIG.space ? taskSpace(CONFIG.space) : taskSpace('ap-qa'))).page('p1')
const emit = (o) => console.log('QA-RESULT ' + JSON.stringify(o))
const ev = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg))
const sub = (v, vars) => (typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `\${${k}}`)) : Array.isArray(v) ? v.map((x) => sub(x, vars)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x, vars)])) : v)

let loaded = null
async function boot(url, viewport) {
  const vp = CONFIG.viewports[viewport]
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: vp.mobile })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: vp.touch })
  await page.goto(CONFIG.base + url)
  await page.waitForFunction(() => window.__ap && window.__ap.v1 && window.__ap.v1.info, undefined, { timeout: 90000 })
  loaded = `${viewport} ${url}`
}

const fileHash = (file) => ev(async (f) => {
  const token = document.querySelector('meta[name="ap-dev-token"]').content
  const r = await fetch('/__ap/dev/content?file=' + encodeURIComponent(f), { headers: { 'x-ap-dev-token': token } })
  return (await r.json()).hash
}, file)

async function step(s, c) {
  if (s.wait) {
    const [k, v] = Object.entries(s.wait)[0]
    await ev(async ([k, v]) => { const w = window.__ap.v1.wait; if (k === 'event') await w.event(v[0], v[1]); else await w[k](v === true ? undefined : v) }, [k, v])
  } else if (s.cmd) {
    await ev((a) => window.__ap.v1.cmd(a.id, a.args), { id: s.cmd, args: s.args ?? {} })
  } else if (s.expect) {
    const [k, v] = Object.entries(s.expect)[0]
    await ev(async ([k, v]) => {
      const e = window.__ap.v1.expect
      if (k === 'state') return e.state(v[0], v[1])
      if (k === 'noErrors') return e.noErrors()
      if (k === 'layout') return e.layout(v === true ? undefined : v)
      if (k === 'scenario') {
        // The scenario's own settling (a battle opening, the net coming up) may still be going: poll, then fail with the unmet expectations.
        const end = Date.now() + 15000
        for (;;) {
          const bad = window.__ap.v1.scenario.check().filter((x) => !x.ok)
          if (!bad.length) return true
          if (Date.now() > end) throw new Error('scenario expectations failed: ' + JSON.stringify(bad))
          await new Promise((ok) => setTimeout(ok, 200))
        }
      }
      throw new Error('unknown expect ' + k)
    }, [k, v])
  } else if (s.input) {
    const [k, v] = Object.entries(s.input)[0]
    await ev(async ([k, v]) => window.__ap.v1.input[k](...(Array.isArray(v) ? v : [v])), [k, v])
  } else if (s.panel) {
    await ev(async (p) => {
      const root = document.querySelector('[data-dev-panel]')
      if (p.close) { if (root.dataset.open === 'true') document.querySelector("[data-dev-cmd='panel.close']").click(); return }
      if (root.dataset.open !== 'true') document.querySelector("[data-dev-cmd='panel.toggle']").click()
      if (p.tab) document.querySelector(`[data-dev-tab='${p.tab}']`).click()
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    }, s.panel)
  } else if (s.shot) {
    const prep = await ev((o) => window.__ap.v1.shot.prepare({ hideDev: o.hideDev !== false, hideHud: o.hideHud === true }), s.shot)
    const path = `${CONFIG.out}/${sub(c.shotPath, { ...c.vars, name: s.shot.name })}`
    await page.screenshot({ path })
    await ev(() => window.__ap.v1.shot.release())
    c.shots.push({ path, digest: prep.digest })
  } else if (s.record) {
    c.rec[s.record.as] = await fileHash(s.record.fileHash)
  } else if (s.assert) {
    const [k, [a, b]] = Object.entries(s.assert)[0]
    const same = c.rec[a] === c.rec[b]
    if ((k === 'equal') !== same) {
      const x = String(c.rec[a]), y = String(c.rec[b])
      let i = 0
      while (i < x.length && x[i] === y[i]) i++
      throw new Error(`${k} ${a} ${b}: differ at char ${i}: ...${x.slice(Math.max(0, i - 40), i + 60)} vs ...${y.slice(Math.max(0, i - 40), i + 60)}`)
    }
  } else if (s.reload) {
    await boot(c.url, c.viewport)
  } else if (s.digest) {
    c.rec[s.digest.as] = JSON.stringify(await ev((d) => {
      const api = window.__ap.v1, dump = api.state.dump()
      const get = (p) => p.split('/').slice(1).reduce((o, k) => (o == null ? o : o[k]), dump)
      return { values: d.pointers.map(get), events: api.events.since(0).events.filter((e) => d.events.includes(e.type)).map((e) => e.payload) }
    }, s.digest))
  } else throw new Error('unknown step ' + JSON.stringify(s))
}

for (const c of CONFIG.cases) {
  const t0 = Date.now()
  const run = { ...c, shots: [], rec: {} }
  try {
    if (loaded !== `${c.viewport} ${c.url}`) await boot(c.url, c.viewport)
    for (const s of c.steps) await step(s, run)
    emit({ suite: CONFIG.suite, case: c.id, viewport: c.viewport, ok: true, ms: Date.now() - t0, shots: run.shots })
  } catch (err) {
    emit({ suite: CONFIG.suite, case: c.id, viewport: c.viewport, ok: false, ms: Date.now() - t0, shots: run.shots, error: String(err && err.message ? err.message : err).slice(0, 600) })
    loaded = null
  }
}
console.log('QA-DONE')
