// Validates an edited layout file before it is written (ADR 0002 §3.3): builds the world twice, with the files as they
// are and with the candidate, and reports whether the edit added build problems or content errors.
//   node scripts/dev/validate-edit.ts --root <repo or copy> --file <repo-relative json> --candidate <abs path of the patched json>
// Prints one JSON line: { ok, before, after, fresh, error? }.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAYOUT_FILES, WORLD_CONTENT, mergeInteriors } from '../../src/shared/world/data.ts'
import { buildWorld, worldBuildInfo } from '../../src/shared/world/index.ts'
import { validateWorldContent } from '../../src/shared/world/validate.ts'
import { newProblems } from '../../src/shared/dev/editor.ts'
import type { InteriorTemplate, LayoutFile, TownTemplate } from '../../src/shared/world/schema.ts'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

const root = arg('root')
const file = arg('file')
const candidate = JSON.parse(readFileSync(arg('candidate'), 'utf8')) as unknown
const read = <T>(rel: string): T => JSON.parse(readFileSync(join(root, rel), 'utf8')) as T

interface Measure { problems: string[]; content: string[] }

function measure(patched: boolean): Measure {
  const pick = <T>(rel: string): T => (patched && rel === file ? (candidate as T) : read<T>(rel))
  WORLD_CONTENT.townLayouts = pick<LayoutFile<TownTemplate>>(LAYOUT_FILES.towns)
  WORLD_CONTENT.interiorLayouts = mergeInteriors(pick<LayoutFile<InteriorTemplate>>(LAYOUT_FILES.interiors), pick<LayoutFile<InteriorTemplate>>(LAYOUT_FILES.gyms))
  return { problems: worldBuildInfo(buildWorld()).problems, content: validateWorldContent() }
}

try {
  const before = measure(false)
  const after = measure(true)
  const fresh = [...newProblems(before.problems, after.problems), ...newProblems(before.content, after.content)]
  const ok = after.problems.length <= before.problems.length && after.content.length <= before.content.length
  console.log(JSON.stringify({ ok, before: { problems: before.problems.length, content: before.content.length }, after: { problems: after.problems.length, content: after.content.length }, fresh }))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String((err as Error).message ?? err), fresh: [] }))
}
