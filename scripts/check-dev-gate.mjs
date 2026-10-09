// Fails when the production bundle carries developer tooling, or when the devtools bundle does not (ADR 0002 §5).
//   node scripts/check-dev-gate.mjs [--prod dist] [--devtools <dir>]
// Without --devtools a devtools build is made in a temp directory. Run after `npm run build`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devtoolsProblems, productionProblems } from './dev-gate.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : fallback
}

const prodDir = opt('--prod', resolve(root, 'dist'))
if (!existsSync(prodDir)) {
  console.error(`check-dev-gate: ${prodDir} does not exist; run \`npm run build\` first`)
  process.exit(2)
}

let devDir = opt('--devtools', null)
let tmp = null
if (!devDir) {
  tmp = mkdtempSync(join(tmpdir(), 'ap-devgate-'))
  devDir = tmp
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'devtools', '--outDir', devDir, '--emptyOutDir'], { cwd: root, stdio: 'ignore' })
}

try {
  const problems = [...productionProblems(prodDir), ...devtoolsProblems(devDir)]
  if (problems.length) {
    for (const p of problems) console.error(`check-dev-gate: ${p}`)
    process.exit(1)
  }
  console.log('check-dev-gate: ok (production bundle is clean, devtools bundle carries the tooling)')
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
