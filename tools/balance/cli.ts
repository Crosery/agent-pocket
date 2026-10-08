// Balance toolkit CLI.  node tools/balance/cli.ts <command> [--n 200] [--seed 1] [--level 50] [--json]
//   types    type chart coverage and health
//   stats    BST per rarity/stage, evolution steps, outliers
//   moves    move value vs PP, outliers
//   matrix   archetype win-rate matrix (Monte Carlo on the shared engine)
//   curve    exp curve, trainer/gym level curve, economy
//   all      everything except the (slow) matrix
import { RULES, pct, table } from './lib.ts'
import * as types from './typechart.ts'
import * as stats from './stats.ts'
import * as moves from './moves.ts'
import { ARCHETYPES, judgeMatrix, runMatrix, teamBst } from './sim.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'all'
const opt = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const flag = (name: string): boolean => args.includes(`--${name}`)

function matrixReport(): string {
  const n = opt('n', RULES.sim.battles)
  const seed = opt('seed', RULES.sim.seed)
  const level = opt('level', RULES.sim.level)
  const m = runMatrix(ARCHETYPES.teams, n, seed, undefined, level)
  const v = judgeMatrix(m)
  const lines: string[] = [`== archetype win-rate matrix (row beats column), ${n} battles per pairing, level ${level}, seed ${seed} ==`]
  lines.push(table(['', ...m.ids, 'field'], m.ids.map((id, i) => [id, ...m.rate[i].map((r, j) => (i === j ? '--' : pct(r))), pct(v.fieldWin[i])])))
  lines.push('', `mean battle length ${m.meanTurns.toFixed(1)} turns, max draw rate ${pct(v.maxDraw)}`)
  lines.push(`team BST: ${ARCHETYPES.teams.map((t) => `${t.id} ${teamBst(t)}`).join(', ')}`)
  lines.push(`dominant (min win > ${pct(RULES.sim.maxAllOpponentsWin)}): ${v.dominant.join(', ') || 'none'}`)
  lines.push(`no favourable matchup: ${v.noPrey.join(', ') || 'none'}; no unfavourable matchup: ${v.noCounter.join(', ') || 'none'}`)
  lines.push(`field average outside [${pct(RULES.sim.minFieldWin)}, ${pct(RULES.sim.maxFieldWin)}]: ${v.offBand.join(', ') || 'none'}`)
  lines.push(`counter-cycle present: ${v.cycle}; verdict: ${v.ok ? 'OK' : 'NOT OK'}`)
  return lines.join('\n')
}

const sections: Record<string, () => string> = {
  types: types.report,
  stats: stats.report,
  moves: moves.report,
  matrix: matrixReport,
}

if (cmd === 'all') {
  for (const k of ['types', 'stats', 'moves']) console.log(sections[k](), '\n')
} else if (sections[cmd]) {
  console.log(sections[cmd]())
} else {
  console.error(`unknown command "${cmd}"; use: ${Object.keys(sections).join(', ')}, all`)
  process.exit(2)
}
void flag
