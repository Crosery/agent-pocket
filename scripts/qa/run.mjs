// QA runner (ADR 0002 §4.6): node scripts/qa/run.mjs <suite|all> [--base http://localhost:5230] [--space <taskspace id>] [--out output/qa]
// Reads content/dev/suites/<suite>.json, expands it into cases, runs them in the browser through ego-browser and
// window.__ap.v1, then writes report.json, report.md and overview.html (a contact sheet of every screenshot) to --out.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const wanted = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all'
const base = arg('base', 'http://localhost:5230')
const space = arg('space', '')
const out = resolve(root, arg('out', 'output/qa'))
const suiteDir = join(root, 'content/dev/suites')
const viewports = JSON.parse(readFileSync(join(suiteDir, 'viewports.json'), 'utf8'))
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()

/** Automation must use window.__ap.v1 only: the legacy handle and source-path imports break on every refactor. */
function checkSources() {
  const files = [join(root, 'scripts/qa/browser.mjs'), ...readdirSync(suiteDir).map((f) => join(suiteDir, f))]
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (/\b__AP\b/.test(text) || /import\(\s*['"]\/src\//.test(text)) { console.error(`qa: ${relative(root, f)} uses __AP or import('/src/...'); use window.__ap.v1`); process.exit(2) }
  }
}

function expand(suite) {
  const cases = []
  for (const vp of suite.viewports) {
    for (const c of suite.cases) {
      const lists = c.each ?? {}
      const keys = Object.keys(lists)
      const combos = keys.length ? keys.reduce((acc, k) => acc.flatMap((a) => lists[k].map((v) => ({ ...a, [k]: v }))), [{}]) : [{}]
      for (const vars of combos) {
        const all = { ...vars, viewport: vp, suite: suite.id }
        const sub = (v) => (typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m)) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v)
        const id = sub(c.id)
        cases.push({ id, viewport: vp, url: sub(c.url), steps: c.steps.map((s) => sub(s)), shotPath: suite.shotPath, vars: { ...all, case: id } })
      }
    }
  }
  return cases
}

function runBrowser(suite) {
  const config = { suite: suite.id, base, space: space ? Number(space) : null, out, viewports, cases: expand(suite) }
  const program = `const CONFIG = ${JSON.stringify(config)};\n${readFileSync(join(root, 'scripts/qa/browser.mjs'), 'utf8')}`
  return new Promise((ok, fail) => {
    // ego-browser prints the script's console output on stderr.
    const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const results = []
    let done = false
    let buf = ''
    const onData = (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^\[\w+\] /, '')
        buf = buf.slice(i + 1)
        if (line.startsWith('QA-RESULT ')) { const r = JSON.parse(line.slice(10)); results.push(r); console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.suite}/${r.case} ${r.viewport} ${r.ms}ms${r.ok ? '' : ` ${r.error}`}`) } else if (line === 'QA-DONE') done = true
        else if (line.trim()) console.log(line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', fail)
    child.on('close', (code) => (done ? ok(results) : fail(new Error(`browser script ended early (code ${code}); ${results.length} case(s) finished`))))
    child.stdin.end(program)
  })
}

function guards(suite) {
  const out = []
  for (const p of suite.guard?.cleanGit ?? []) {
    const dirty = git('status', '--porcelain', '--', p)
    out.push({ guard: `git status clean: ${p}`, ok: dirty === '', detail: dirty })
  }
  return out
}

checkSources()
mkdirSync(out, { recursive: true })
const names = wanted === 'all' ? readdirSync(suiteDir).filter((f) => f.endsWith('.json') && f !== 'viewports.json').map((f) => f.replace(/\.json$/, '')) : [wanted]
const suites = []
for (const name of names) {
  const file = join(suiteDir, `${name}.json`)
  if (!existsSync(file)) { console.error(`qa: no suite ${name}`); process.exit(2) }
  const suite = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`== ${suite.id}: ${suite.title}`)
  const results = await runBrowser(suite)
  suites.push({ id: suite.id, title: suite.title, results, guards: guards(suite) })
}

const commit = git('rev-parse', '--short', 'HEAD')
const failed = suites.flatMap((s) => [...s.results.filter((r) => !r.ok), ...s.guards.filter((g) => !g.ok)])
writeFileSync(join(out, 'report.json'), JSON.stringify({ commit, base, suites }, null, 2))
const rel = (p) => relative(out, p)
const md = [`# QA report`, '', `commit ${commit} · ${base} · ${suites.reduce((n, s) => n + s.results.length, 0)} case(s), ${failed.length} failure(s)`, '']
for (const s of suites) {
  md.push(`## ${s.id}`, '', s.title, '', '| case | viewport | result | ms | screenshot |', '|---|---|---|---|---|')
  for (const r of s.results) md.push(`| ${r.case} | ${r.viewport} | ${r.ok ? 'ok' : `FAIL: ${r.error}`} | ${r.ms} | ${r.shots.map((x) => `[${rel(x.path)}](${rel(x.path)})`).join(' ')} |`)
  for (const g of s.guards) md.push('', `${g.ok ? 'ok' : 'FAIL'}: ${g.guard}${g.detail ? `\n\n\`\`\`\n${g.detail}\n\`\`\`` : ''}`)
  md.push('')
}
writeFileSync(join(out, 'report.md'), md.join('\n'))
const shots = suites.flatMap((s) => s.results.flatMap((r) => r.shots.map((x) => ({ ...x, label: `${s.id}/${r.case} ${r.viewport}`, ok: r.ok }))))
writeFileSync(join(out, 'overview.html'), `<!doctype html><meta charset="utf-8"><title>QA overview</title><style>body{background:#111;color:#eee;font:12px monospace;display:flex;flex-wrap:wrap;gap:8px;padding:8px}figure{margin:0;width:320px}img{width:100%;display:block;border:2px solid #555}figure.bad img{border-color:#e55}</style>${shots.map((x) => `<figure class="${x.ok ? '' : 'bad'}"><img src="${rel(x.path)}" loading="lazy"><figcaption>${x.label}</figcaption></figure>`).join('')}`)
console.log(`report: ${join(out, 'report.md')} (${failed.length} failure(s))`)
process.exit(failed.length ? 1 : 0)
