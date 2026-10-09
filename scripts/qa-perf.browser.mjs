// Browser half of scripts/qa-perf.mjs (runs inside `ego-browser nodejs`; CONFIG is prepended).
// Measurements per run:
//   stand / walk: the game's own tick() driven by time.step (fixed dt, no vsync, immune to a throttled or occluded
//         window); every render() is followed by a 1-pixel readPixels so the GPU work of the frame is included
//         ("gpu" = that wait). `walk` holds a direction so chunk streaming runs.
//   raf:  requestAnimationFrame intervals as a player sees them (battle scenes run their own rAF loop, so they only
//         get this one). Intervals above CONFIG.stallMs mean the browser throttled the window; they are counted apart.
const task = await taskSpace(CONFIG.space)
const page = task.page('p1')
const ev = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg))

async function emulate(vp) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: vp.mobile })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: vp.touch, maxTouchPoints: vp.touch ? 5 : 1 })
  await page.cdp('Emulation.setCPUThrottlingRate', { rate: vp.throttle })
}

const metric = (list, name) => list.find((m) => m.name === name)?.value ?? 0

/** Wraps render()/update() with timers; results land in window.__perf. */
const INSTALL = (sync) => {
  const A = window.__AP
  const rend = A.renderer
  const ow = A.overworld
  const gl = rend.gl.getContext()
  const px = new Uint8Array(4)
  const P = (window.__perf = { renderEnd: [], render: [], gpu: [], update: [], calls: [], tris: [] })
  if (!window.__perfOrig) window.__perfOrig = { render: rend.render, update: ow.update }
  const o = window.__perfOrig
  rend.render = function (...a) {
    const s = performance.now()
    const r = o.render.apply(this, a)
    const m = performance.now()
    if (sync) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const e = performance.now()
    P.render.push(m - s); P.gpu.push(e - m); P.renderEnd.push(e)
    P.calls.push(rend.gl.info.render.calls); P.tris.push(rend.gl.info.render.triangles)
    return r
  }
  ow.update = function (...a) { const s = performance.now(); const r = o.update.apply(this, a); P.update.push(performance.now() - s); return r }
}
const UNINSTALL = () => {
  if (window.__perfOrig) { window.__AP.renderer.render = window.__perfOrig.render; window.__AP.overworld.update = window.__perfOrig.update }
}
const SUMMARY = () => {
  const P = window.__perf
  const stat = (a) => {
    const s = a.slice().sort((x, y) => x - y)
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0
    return { avg: a.reduce((p, c) => p + c, 0) / Math.max(1, a.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? 0 }
  }
  const ticks = []
  for (let i = 1; i < P.renderEnd.length; i++) ticks.push(P.renderEnd[i] - P.renderEnd[i - 1])
  const info = window.__AP.renderer.gl.info
  return {
    tick: stat(ticks), render: stat(P.render), gpu: stat(P.gpu), update: stat(P.update),
    calls: info.render.calls, triangles: info.render.triangles, points: info.render.points,
    callsAvg: P.calls.reduce((a, b) => a + b, 0) / Math.max(1, P.calls.length), trisAvg: P.tris.reduce((a, b) => a + b, 0) / Math.max(1, P.tris.length),
    textures: info.memory.textures, geometries: info.memory.geometries, programs: info.programs ? info.programs.length : 0,
    internal: { w: window.__AP.renderer.internal.width, h: window.__AP.renderer.internal.height, scale: window.__AP.renderer.internal.scale },
    quality: window.__AP.save.settings.quality, coarse: matchMedia('(pointer: coarse)').matches, dpr: devicePixelRatio,
    governor: window.__AP.renderer.governorLevel,
  }
}

let pumped = false
async function stepFrames(total, chunk = 30) {
  for (let done = 0; done < total; done += chunk) {
    const n = Math.min(chunk, total - done)
    if (pumped) await ev(PUMP_STEP, n)
    else await ev((k) => window.__ap.v1.time.step(k, 1 / 60), n)
  }
}

/** Scenes that run their own requestAnimationFrame loop (battle) cannot be stepped by the dev clock: take over rAF and call the callbacks by hand. */
const PUMP_INSTALL = () => {
  if (window.__pump) return
  const native = window.requestAnimationFrame.bind(window)
  window.__pump = { q: [], native, now: performance.now(), id: 0, nativeRaf: window.requestAnimationFrame }
  window.requestAnimationFrame = (cb) => { window.__pump.q.push(cb); return ++window.__pump.id }
}
const PUMP_STEP = (n) => {
  const p = window.__pump
  for (let i = 0; i < n; i++) {
    const cbs = p.q.splice(0)
    p.now += 1000 / 60
    for (const cb of cbs) cb(p.now)
  }
}
const PUMP_UNINSTALL = () => {
  const p = window.__pump
  if (!p) return
  window.requestAnimationFrame = p.nativeRaf
  for (const cb of p.q.splice(0)) p.native(cb)
  window.__pump = null
}

function summariseProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0)
  profile.samples.forEach((id, i) => { self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)) })
  const fnSelf = new Map()
  const fileSelf = new Map()
  for (const [id, us] of self) {
    const cf = byId.get(id).callFrame
    const file = (cf.url || '(native)').replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')
    const key = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`
    fnSelf.set(key, (fnSelf.get(key) ?? 0) + us)
    fileSelf.set(file, (fileSelf.get(file) ?? 0) + us)
  }
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const keyOf = (id) => { const cf = byId.get(id).callFrame; return `${cf.functionName || '(anon)'} ${(cf.url || '(native)').replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}` }
  const incl = new Map()
  profile.samples.forEach((id, i) => {
    const seen = new Set()
    for (let n = id; n !== undefined; n = parent.get(n)) {
      const k = keyOf(n)
      if (seen.has(k)) continue
      seen.add(k)
      incl.set(k, (incl.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0))
    }
  })
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => [k, +(us / 1000 / CONFIG.frames).toFixed(3), +((us / total) * 100).toFixed(1)])
  return { totalMsPerFrame: +(total / 1000 / CONFIG.frames).toFixed(2), functions: top(fnSelf, 50), files: top(fileSelf, 30), inclusive: top(incl, 70) }
}

// The frame-time governor remembers its level per device (localStorage); every run must start from the tier as configured.
const { identifier: cleanScript } = await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.removeItem('ap.render.governor') } catch (e) {}" })

for (const job of CONFIG.jobs) {
  try {
    await emulate(job.vp)
    await page.goto('about:blank')
    await emulate(job.vp)
    const t0 = Date.now()
    await page.goto(`${CONFIG.base}/?dev=1&scenario=${job.def.scenario}${CONFIG.urlExtra}`)
    await emulate(job.vp)
    await page.waitForFunction(() => window.__ap && window.__ap.v1 && window.__ap.v1.info, undefined, { timeout: 120000 })
    await page.waitForFunction((def) => {
      const ow = window.__AP && window.__AP.overworld
      if (!ow || !ow.mapId) return false
      return def.wait === 'battle' ? ow.battleActive || document.documentElement.classList.contains('ap-battle-on') : ow.free
    }, job.def, { timeout: 120000 })
    await ev(async (def) => { for (const [id, a] of def.setup) await window.__ap.v1.cmd(id, a) }, job.def)
    const bootMs = Date.now() - t0
    await page.waitForTimeout(CONFIG.settleMs)
    const row = { label: CONFIG.label, viewport: job.viewport, sceneId: job.scene, run: job.run, bootMs }
    const overworld = job.def.wait !== 'battle'
    pumped = false

    // collect garbage first so the heap figure is what stays alive
    await page.cdp('HeapProfiler.collectGarbage', {})
    row.heapMB = (await page.cdp('Runtime.getHeapUsage', {})).usedSize / 1048576
    await page.cdp('Performance.enable', {})

    {
      if (overworld) await ev(() => window.__ap.v1.time.pause())
      else {
        await ev(PUMP_INSTALL)
        for (let i = 0; i < 150 && !(await ev(() => window.__pump.q.length)); i++) await page.waitForTimeout(200) // not waitForFunction: it may poll on requestAnimationFrame
        pumped = true
      }
      for (const mode of overworld ? CONFIG.modes : ['stand']) {
        await ev(INSTALL, true)
        await stepFrames(20) // warm-up
        await ev(INSTALL, true)
        const m0 = (await page.cdp('Performance.getMetrics', {})).metrics
        const prof = CONFIG.profile === mode
        if (prof) {
          await page.cdp('Profiler.enable', {})
          await page.cdp('Profiler.setSamplingInterval', { interval: 250 })
          await page.cdp('Profiler.start', {})
        }
        if (mode === 'walk') await ev((a) => { window.__walk = window.__ap.v1.input.axis(a.dir[0], a.dir[1], a.n) }, { dir: job.def.dir ?? [1, 0], n: CONFIG.frames })
        const h0 = (await page.cdp('Runtime.getHeapUsage', {})).usedSize
        await stepFrames(CONFIG.frames)
        const m1 = (await page.cdp('Performance.getMetrics', {})).metrics
        if (prof) {
          const { profile } = await page.cdp('Profiler.stop', {})
          console.log('PROF ' + JSON.stringify({ viewport: job.viewport, sceneId: job.scene, run: job.run, mode, ...summariseProfile(profile) }))
        }
        const h1 = (await page.cdp('Runtime.getHeapUsage', {})).usedSize
        row[mode] = {
          ...(await ev(SUMMARY)),
          mainThreadMsPerFrame: ((metric(m1, 'TaskDuration') - metric(m0, 'TaskDuration')) * 1000) / CONFIG.frames,
          scriptMsPerFrame: ((metric(m1, 'ScriptDuration') - metric(m0, 'ScriptDuration')) * 1000) / CONFIG.frames,
          cpuMsPerFrame: ((metric(m1, 'ThreadTime') - metric(m0, 'ThreadTime')) * 1000) / CONFIG.frames,
          heapDeltaKB: (h1 - h0) / 1024,
        }
        if (mode === 'walk') await ev(() => window.__walk)
        await ev(UNINSTALL)
      }
      if (overworld) await ev(() => window.__ap.v1.time.resume())
      else { await ev(PUMP_UNINSTALL); pumped = false }
    }

    if (CONFIG.raf) try {
      await ev(INSTALL, false)
      await page.waitForTimeout(500)
      await ev(({ frames, maxMs }) => {
        window.__rafDone = null
        const deltas = []
        const states = new Set()
        let last = performance.now()
        let n = 0
        const f = (t) => {
          deltas.push(t - last); last = t
          states.add(document.visibilityState)
          if (++n < frames && t - begin < maxMs) requestAnimationFrame(f)
          else window.__rafDone = { deltas, states: [...states] }
        }
        const begin = performance.now()
        requestAnimationFrame(f)
      }, { frames: CONFIG.frames, maxMs: CONFIG.rafMaxMs })
      await page.waitForFunction(() => window.__rafDone, undefined, { timeout: CONFIG.rafMaxMs + 30000 })
      const rafRes = await ev((stallMs) => {
        const r = window.__rafDone
        const stat = (a) => {
          const s = a.slice().sort((x, y) => x - y)
          const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0
          return { avg: a.reduce((p, c) => p + c, 0) / Math.max(1, a.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? 0 }
        }
        const d = r.deltas.slice(2)
        const ok = d.filter((x) => x < stallMs)
        const P = window.__perf
        const info = window.__AP.renderer.gl.info
        return {
          frame: stat(ok), frames: ok.length, stalls: d.length - ok.length, over33: ok.filter((x) => x > 33.4).length / Math.max(1, ok.length), states: r.states,
          render: stat(P.render), update: stat(P.update),
          calls: info.render.calls, triangles: info.render.triangles, textures: info.memory.textures, geometries: info.memory.geometries,
          internal: { w: window.__AP.renderer.internal.width, h: window.__AP.renderer.internal.height, scale: window.__AP.renderer.internal.scale },
          quality: window.__AP.save.settings.quality, coarse: matchMedia('(pointer: coarse)').matches, dpr: devicePixelRatio,
          governor: window.__AP.renderer.governorLevel,
        }
      }, CONFIG.stallMs)
      row.raf = rafRes
      await ev(UNINSTALL)
    } catch (err) { row.rafError = String(err && err.message ? err.message : err).slice(0, 120) }
    console.log('PERF ' + JSON.stringify(row))
  } catch (err) {
    console.log('ERR ' + job.viewport + ' ' + job.scene + ' ' + (err && err.message ? err.message : err))
  }
}
await page.cdp('Emulation.setCPUThrottlingRate', { rate: 1 })
await page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: cleanScript })
