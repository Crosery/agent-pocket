// Balance toolkit CLI.  node tools/balance/cli.ts <command> [--n 200] [--seed 1] [--level 50] [--game-ai]
//   types    type chart coverage and health
//   stats    BST per rarity/stage, evolution steps, outliers
//   moves    move value vs PP, outliers
//   matrix   archetype win-rate matrix (Monte Carlo on the shared engine)
//   teams    the canonical team of every archetype
//   solo     1v1 tables: rarity ladder, type power, value of a type edge
//   ttk      hits-to-KO bands by matchup class
//   curve    exp curve, trainer/gym level curve, economy
//   all      everything except the slow ones (matrix, solo)
import { RULES, pct, table } from './lib.ts'
import * as types from './typechart.ts'
import * as stats from './stats.ts'
import * as moves from './moves.ts'
import * as solo from './solo.ts'
import * as ttk from './ttk.ts'
import * as curve from './curve.ts'
import { gameAi, judgeMatrix, pilotPolicy, runMatrix, type TeamSource } from './sim.ts'
import { DEFS, buildArchetype, lawProblems } from './teams.ts'
import { C } from './lib.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'all'
const opt = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}

const cache = new Map<string, ReturnType<typeof buildArchetype>>()
export const teamSource: TeamSource = (id, variant) => {
  const key = `${id}#${variant}`
  if (!cache.has(key)) cache.set(key, buildArchetype(DEFS.roles.find((r) => r.id === id)!, variant))
  const t = cache.get(key)
  if (!t) throw new Error(`archetype ${id} variant ${variant}: no team satisfies the team-building law`)
  return t
}

function matrixReport(): string {
  const n = opt('n', RULES.sim.battles)
  const seed = opt('seed', RULES.sim.seed)
  const level = opt('level', RULES.sim.level)
  const policy = args.includes('--game-ai') ? gameAi : pilotPolicy
  const ids = DEFS.roles.map((r) => r.id)
  const m = runMatrix(teamSource, ids, n, seed, policy, level)
  const v = judgeMatrix(m)
  const lines: string[] = [`== archetype win-rate matrix (row beats column), ${n} battles per pairing over ${RULES.sim.variants} team instances, level ${level}, seed ${seed}, policy ${policy === gameAi ? 'game-ai' : 'pilot'} ==`]
  lines.push(table(['', ...m.ids, 'field'], m.ids.map((id, i) => [id, ...m.rate[i].map((r, j) => (i === j ? '--' : pct(r))), pct(v.fieldWin[i])])))
  lines.push('', `mean battle length ${m.meanTurns.toFixed(1)} turns, max draw rate ${pct(v.maxDraw)}`)
  lines.push(`dominant (worst matchup above ${pct(RULES.sim.maxAllOpponentsWin)}): ${v.dominant.join(', ') || 'none'}`)
  lines.push(`no favourable matchup (>= ${pct(RULES.sim.favourableWin)}): ${v.noPrey.join(', ') || 'none'}; no unfavourable matchup (<= ${pct(RULES.sim.unfavourableWin)}): ${v.noCounter.join(', ') || 'none'}`)
  lines.push(`field average outside [${pct(RULES.sim.minFieldWin)}, ${pct(RULES.sim.maxFieldWin)}]: ${v.offBand.join(', ') || 'none'}`)
  lines.push(`counter-cycle present: ${v.cycle}; verdict: ${v.ok ? 'OK' : 'NOT OK'}`)
  return lines.join('\n')
}

function teamsReport(): string {
  const out: string[] = []
  for (const r of DEFS.roles) {
    const t = teamSource(r.id, 0)
    out.push(`${r.id} (${r.nameZh}): ${r.plan}`)
    for (const m of t.members) out.push(`  ${m.species} [${C.species[m.species].types.join('/')}] ${(m.moves ?? []).join(', ')}`)
    const p = lawProblems(t)
    if (p.length) out.push(...p.map((x) => `  !! ${x}`))
  }
  return out.join('\n')
}

const sections: Record<string, () => string> = {
  types: types.report,
  stats: stats.report,
  moves: moves.report,
  matrix: matrixReport,
  teams: teamsReport,
  solo: () => solo.report(opt('per', 6), opt('games', 4), opt('seed', RULES.sim.seed)),
  ttk: ttk.report,
  curve: curve.report,
}

if (cmd === 'all') {
  for (const k of ['types', 'stats', 'moves', 'ttk', 'curve']) console.log(sections[k](), '\n')
} else if (sections[cmd]) {
  console.log(sections[cmd]())
} else {
  console.error(`unknown command "${cmd}"; use: ${Object.keys(sections).join(', ')}, all`)
  process.exit(2)
}
