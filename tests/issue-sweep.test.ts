import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRACK_RE, beijing, closesOnMerge, linkedIssues, planSweep, renderReport } from '../scripts/issue-sweep.mjs'
import type { SweepAction } from '../scripts/issue-sweep.mjs'

// scripts/issue-sweep.mjs: the daily issue sweep (docs/conventions/TRACKING.md §1). Fixtures are made-up issues and PRs;
// the CLI runs against a fake gh on PATH, so nothing here touches the network.
const SCRIPT = fileURLToPath(new URL('../scripts/issue-sweep.mjs', import.meta.url))
const NOW = new Date('2026-09-26T08:00:00Z') // 16:00 Beijing
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
const track = (kind: string, stage: string, createdAt: string) => ({ body: `<!-- ap:track v1 kind=${kind} stage=${stage} -->\n**x**｜y`, createdAt })

const merged = [
  { number: 101, title: 'task branch PR', headRefName: 'task/1/done', baseRefName: 'stage', body: '### 关联\nCloses #1\n', mergedAt: daysAgo(2), mergeCommit: { oid: 'a'.repeat(40) } },
  { number: 102, title: 'not a task branch, body closes #2', headRefName: 'someone/patch', baseRefName: 'stage', body: '修好了。\n\nFixes #2，Refs #12', mergedAt: daysAgo(1), mergeCommit: { oid: 'b'.repeat(40) } },
  { number: 103, title: 'release into main does not count', headRefName: 'stage', baseRefName: 'main', body: 'Closes #6', mergedAt: daysAgo(1), mergeCommit: { oid: 'c'.repeat(40) } },
  { number: 104, title: 'PR for #3', headRefName: 'task/3/redo', baseRefName: 'stage', body: 'Closes #3', mergedAt: daysAgo(20), mergeCommit: { oid: 'd'.repeat(40) } },
  { number: 109, title: 'PR for #9', headRefName: 'task/9/x', baseRefName: 'stage', body: 'Closes #9', mergedAt: daysAgo(3), mergeCommit: { oid: 'e'.repeat(40) } },
  { number: 21, title: 'old PR', headRefName: 'task/14/old', baseRefName: 'stage', body: 'Closes #14', mergedAt: daysAgo(40), mergeCommit: { oid: 'f'.repeat(40) } },
  { number: 115, title: 'first round', headRefName: 'task/15/part', baseRefName: 'stage', body: 'Closes #15', mergedAt: daysAgo(2), mergeCommit: { oid: '1'.repeat(40) } },
  { number: 116, title: 'just merged', headRefName: 'task/16/fresh', baseRefName: 'stage', body: 'Closes #16', mergedAt: daysAgo(0.5 / 24), mergeCommit: { oid: '2'.repeat(40) } },
  { number: 120, title: 'fixed by someone after the reopen', headRefName: 'someone/patch17', baseRefName: 'stage', body: 'Closes #17', mergedAt: daysAgo(2), mergeCommit: { oid: '3'.repeat(40) } },
  { number: 118, title: 'first half of #18', headRefName: 'task/18/first', baseRefName: 'stage', body: 'Closes #18', mergedAt: daysAgo(25), mergeCommit: { oid: '4'.repeat(40) } },
  { number: 119, title: 'PR for #19', headRefName: 'task/19/x', baseRefName: 'stage', body: 'Closes #19', mergedAt: daysAgo(30), mergeCommit: { oid: '5'.repeat(40) } },
  { number: 160, title: 'hotfix into main', headRefName: 'hotfix/21/login_loop', baseRefName: 'main', body: 'Closes #21', mergedAt: daysAgo(2), mergeCommit: { oid: '8'.repeat(40) } },
]

const openPrs = [{ number: 117, headRefName: 'task/15/more', body: 'Closes #15' }, { number: 130, headRefName: 'task/18/second', body: 'Closes #18' }]

const open = [
  { number: 1, title: 'merged but still open', updatedAt: daysAgo(2), comments: [track('progress', 'dev', daysAgo(5))] },
  { number: 2, title: 'linked through a Fixes in the body', updatedAt: daysAgo(1), comments: [] },
  { number: 3, title: 'closed after the merge, reopened | not fixed', updatedAt: daysAgo(15), comments: [track('closed', 'merged', daysAgo(20)), track('rework', 'review', daysAgo(15))] },
  { number: 4, title: 'nobody touched it for two weeks', updatedAt: daysAgo(20), comments: [track('plan', 'dev', daysAgo(20))] },
  { number: 5, title: 'just filed', updatedAt: daysAgo(3), comments: [] },
  { number: 6, title: 'only mentioned by a PR into main', updatedAt: daysAgo(1), comments: [] },
  { number: 12, title: 'only Refs', updatedAt: daysAgo(14), comments: [] },
  // closed in plain text long ago (no ap:track header), then reopened: must not be closed again from the old PR
  { number: 14, title: 'reopened after an old-style close', updatedAt: daysAgo(20), stateReason: 'REOPENED', reopenedAt: daysAgo(30), comments: [{ body: '已由 PR #21 合并进 stage，关闭。', createdAt: daysAgo(40) }] },
  { number: 15, title: 'another PR is still open', updatedAt: daysAgo(2), comments: [] },
  { number: 16, title: 'PR just merged', updatedAt: daysAgo(20), comments: [] },
  // stateReason stays REOPENED while open: reopened before the latest merge and not since, so close it
  { number: 17, title: 'reopened, then fixed', updatedAt: daysAgo(2), stateReason: 'REOPENED', reopenedAt: daysAgo(10), comments: [] },
  { number: 18, title: 'half merged, a PR still open', updatedAt: daysAgo(20), comments: [] },
  // reopen time unreadable: treated as reopened after the merge, not closed
  { number: 19, title: 'reopen time unknown', updatedAt: daysAgo(20), stateReason: 'REOPENED', reopenedAt: null, comments: [] },
  { number: 21, title: 'hotfix merged into main, still open', updatedAt: daysAgo(2), comments: [] },
]

const closed = [
  // no PR and no "closed" record; the comment has CRLF line breaks and must still be read as a record header
  { number: 7, title: 'closed without a record', closedAt: daysAgo(0.1), stateReason: 'COMPLETED', comments: [{ body: '<!-- ap:track v1 kind=progress stage=dev -->\r\n**进展**｜开工', createdAt: daysAgo(0.2) }] },
  { number: 8, title: 'closed with a record', closedAt: daysAgo(1), stateReason: 'NOT_PLANNED', comments: [{ body: '<!-- ap:track v1 kind=closed stage=closed -->\r\n**关闭**｜不做了', createdAt: daysAgo(1) }] },
  { number: 9, title: 'closed by the merge', closedAt: daysAgo(3), stateReason: 'COMPLETED', comments: [] },
  { number: 10, title: 'closed too long ago', closedAt: daysAgo(30), stateReason: 'COMPLETED', comments: [] },
  { number: 11, title: 'already flagged', closedAt: daysAgo(2), stateReason: 'COMPLETED', comments: [track('unrecorded', 'closed', daysAgo(1))] },
  { number: 13, title: 'not planned, no reason given', closedAt: daysAgo(5), stateReason: 'NOT_PLANNED', comments: [] },
  { number: 22, title: 'closed by GitHub from a hotfix PR into main', closedAt: daysAgo(2), stateReason: 'COMPLETED', comments: [] },
]

const hotfixPr = { number: 161, title: 'hotfix #22', headRefName: 'hotfix/22/crash', baseRefName: 'main', body: 'Closes #22', mergedAt: daysAgo(2), mergeCommit: { oid: '9'.repeat(40) } }

const plan = () => planSweep({ open, closed, merged: [...merged, hotfixPr], openPrs, now: NOW })
const label = (action: SweepAction) => `${action.type} #${action.issue.number}`
const find = (actions: SweepAction[], number: number) => {
  const action = actions.find((candidate) => candidate.issue.number === number)
  assert.ok(action, `#${number} has an action`)
  return action
}
const closeNumbers = (actions: SweepAction[]) => actions.filter((action) => action.type === 'close').map((action) => action.issue.number)

test('links: a task/hotfix branch number or a closing keyword in the body; Refs does not link', () => {
  assert.deepEqual(linkedIssues(merged[0]), [1])
  assert.deepEqual(linkedIssues(merged[1]), [2])
  assert.deepEqual(linkedIssues({ headRefName: 'task/5/a', body: 'Closes #5\nCloses #6' }).sort(), [5, 6])
  assert.deepEqual(linkedIssues({ headRefName: 'hotfix/21/a', body: '' }), [21])
  assert.equal(closesOnMerge({ headRefName: 'task/1/a', baseRefName: 'stage' }), true)
  assert.equal(closesOnMerge({ headRefName: 'stage', baseRefName: 'main' }), false)
  assert.equal(closesOnMerge({ headRefName: 'hotfix/21/a', baseRefName: 'main' }), true)
  assert.equal(closesOnMerge({ headRefName: 'task/1/a', baseRefName: 'main' }), false)
})

test('three jobs in place: close, overdue, unrecorded; everything else is left alone', () => {
  assert.deepEqual(plan().map(label), [
    'close #1', 'close #2', 'overdue #3', 'overdue #4', 'overdue #12', 'overdue #14', 'close #17', 'overdue #18', 'overdue #19', 'close #21',
    'unrecorded #7', 'unrecorded #13',
  ])
})

test('close: leaves a "closed" record that cites the PR and the merge commit', () => {
  const first = find(plan(), 1)
  assert.equal(first.pr?.number, 101)
  assert.equal(first.body.split('\n')[0], '<!-- ap:track v1 kind=closed stage=merged -->')
  assert.match(first.body, /\*\*关闭\*\*｜PR #101 已合并进 `stage`，巡检补关这个 issue/)
  assert.ok(first.body.includes(`合并提交 ${'a'.repeat(40)}`))
  assert.ok(first.body.includes(`**引用**：#101 · ${'a'.repeat(12)}`))
  assert.ok(first.body.includes(`在 ${beijing(daysAgo(2))}（北京时间）合并`))
})

test('a hotfix PR merged into main also finishes its issue, and a closed one needs no "unrecorded"', () => {
  const hotfix = find(plan(), 21)
  assert.equal(hotfix.type, 'close')
  assert.match(hotfix.body, /已合并进 `main`/)
  assert.match(hotfix.body, /把 `main` 合回 `stage`/)
  assert.equal(plan().some((action) => action.issue.number === 22), false)
  assert.equal(planSweep({ open: [], closed, merged, now: NOW }).some((action) => action.issue.number === 22), true)
})

test('not closed: REOPENED after an old-style close, another PR still open, merged under an hour ago', () => {
  assert.deepEqual(closeNumbers(plan()), [1, 2, 17, 21])
  // without REOPENED the old PR would close #14 again, which is exactly what the guard prevents
  const notReopened = open.map((issue) => (issue.number === 14 ? { ...issue, stateReason: undefined, reopenedAt: undefined } : issue))
  assert.deepEqual(closeNumbers(planSweep({ open: notReopened, closed, merged, openPrs, now: NOW })), [1, 2, 14, 17, 21])
  assert.deepEqual(closeNumbers(planSweep({ open, closed, merged, now: NOW })), [1, 2, 15, 17, 18, 21])
  assert.deepEqual(closeNumbers(planSweep({ open, closed, merged, openPrs, now: new Date(NOW.getTime() + 2 * 3_600_000) })), [1, 2, 16, 17, 21])
})

test('two merges around a reopen: the latest merge decides, whatever the order of the PR list', () => {
  const issue = { number: 20, title: 'fixed, reopened, fixed again', updatedAt: daysAgo(1), stateReason: 'REOPENED', reopenedAt: daysAgo(5), comments: [] }
  const first = { number: 140, title: 'first fix', headRefName: 'task/20/first', baseRefName: 'stage', body: 'Closes #20', mergedAt: daysAgo(10), mergeCommit: { oid: '6'.repeat(40) } }
  const second = { number: 141, title: 'fix after the reopen', headRefName: 'someone/fix20', baseRefName: 'stage', body: 'Closes #20', mergedAt: daysAgo(2), mergeCommit: { oid: '7'.repeat(40) } }
  for (const order of [[first, second], [second, first]]) {
    const actions = planSweep({ open: [issue], closed: [], merged: order, now: NOW })
    assert.deepEqual(actions.map((action) => `${action.type} ${action.pr?.number}`), ['close 141'])
  }
  // only the merge before the reopen: not closed (and touched yesterday, so not overdue either)
  assert.deepEqual(planSweep({ open: [issue], closed: [], merged: [first], now: NOW }), [])
})

test('overdue records say which PR merged and why the issue was not closed', () => {
  const actions = plan()
  const body = (number: number) => find(actions, number).body
  assert.ok(body(14).includes(`关联的 PR #21 在 ${beijing(daysAgo(40))} 合并进 stage，之后这个 issue 在 ${beijing(daysAgo(30))} 又被重开，巡检不再补关`))
  assert.ok(body(19).includes(`关联的 PR #119 在 ${beijing(daysAgo(30))} 合并进 stage，这个 issue 被重开过（查不到重开时间，按合并后重开处理），巡检不再补关`))
  assert.ok(body(3).includes(`关联的 PR #104 在 ${beijing(daysAgo(20))} 合并进 stage，之后留过「关闭」记录，这个 issue 又被重开，巡检不再补关`))
  assert.ok(body(18).includes('关联的 PR #118 已合并进 stage，但还有开着的 PR #130 关联它，巡检不补关'))
  assert.ok(body(4).includes('还开着，stage 上没有关联它的已合并 PR；'))
})

test('overdue keeps the stage of the last record; an issue with no record starts at triage', () => {
  const actions = plan()
  const reopened = find(actions, 3)
  assert.equal(reopened.type, 'overdue')
  assert.equal(reopened.body.split('\n')[0], '<!-- ap:track v1 kind=overdue stage=review -->')
  const idle = find(actions, 4)
  assert.ok(idle.body.includes('**超期**｜14 天没有动静'))
  assert.ok(idle.body.includes('已经 20 天'))
  assert.equal(find(actions, 12).body.split('\n')[0], '<!-- ap:track v1 kind=overdue stage=triage -->')
})

test('unrecorded: only issues closed within closed-days; those with a merged PR, a "closed" record or an earlier flag are skipped', () => {
  const [missing, notPlanned] = plan().filter((action) => action.type === 'unrecorded')
  assert.equal(missing.body.split('\n')[0], '<!-- ap:track v1 kind=unrecorded stage=closed -->')
  assert.ok(missing.body.includes('以「完成」关闭'))
  assert.ok(missing.body.includes('巡检不重开'))
  assert.ok(notPlanned.body.includes('以「不做」关闭'))
  const wide = planSweep({ open: [], closed, merged, now: NOW, closedDays: 60 })
  assert.deepEqual(wide.map((action) => action.issue.number), [7, 10, 13, 22])
})

test('thresholds are adjustable: with idle-days 30 two quiet weeks are not overdue', () => {
  assert.deepEqual(planSweep({ open, closed: [], merged, openPrs, now: NOW, idleDays: 30 }).map((action) => action.type), ['close', 'close', 'close', 'close'])
})

test('every record has the TRACKING.md shape and a kind listed in its table; the inline workflow header agrees', () => {
  const tracking = readFileSync(new URL('../docs/conventions/TRACKING.md', import.meta.url), 'utf8')
  for (const action of plan()) {
    const [head, title, blank, ...fields] = action.body.split('\n')
    const match = TRACK_RE.exec(head)
    assert.ok(match, head)
    assert.ok(['triage', 'dev', 'review', 'merged', 'released', 'closed'].includes(match[2]), match[2])
    assert.ok(tracking.includes(`| \`${match[1]}\` |`), match[1])
    assert.match(title, /^\*\*[^*]+\*\*｜\S/)
    assert.equal(blank, '')
    for (const field of fields) assert.match(field, /^\*\*(现状|证据|下一步|引用)\*\*：/)
  }
  // close-on-merge builds its header inline in bash; it must stay readable by the sweep's parser
  const workflow = readFileSync(new URL('../.github/workflows/issue-lifecycle.yml', import.meta.url), 'utf8')
  const headers = [...workflow.matchAll(/"(<!-- ap:track v1 [^"]*-->)"/g)].map((match) => match[1])
  assert.ok(headers.length >= 2)
  for (const header of headers) assert.ok(TRACK_RE.test(header), header)
})

test('run summary: one row per issue, pipes in titles escaped, an empty run says so', () => {
  const report = renderReport(plan().map((action) => ({ action })), { apply: false, now: NOW })
  assert.ok(report.includes('只读，没有改 GitHub'))
  assert.ok(report.includes('| #1 | 将补关 | PR #101 已合并进 stage，issue 还开着 | merged but still open |'))
  assert.ok(report.includes('closed after the merge, reopened \\| not fixed'))
  assert.ok(renderReport([], { apply: true, now: NOW }).includes('没有要处理的 issue。'))
})

// CLI against a fake gh

const dirs: string[] = []
test.after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Fixtures {
  open: object[]
  closed: object[]
  merged: object[]
  mergedMain?: object[]
  openPrs?: object[]
  comments?: Record<string, object[]>
  reopenedAt?: Record<string, string>
}

/** A fake gh: list queries answer from fixtures, any other call is appended to calls.log */
function fakeGh(fixtures: Fixtures, { failOn }: { failOn?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-issue-sweep-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures))
  writeFileSync(join(dir, 'gh'), [
    `#!${process.execPath}`,
    'const { appendFileSync, readFileSync } = require("node:fs");',
    'const args = process.argv.slice(2);',
    `const fixtures = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'fixtures.json'))}, "utf8"));`,
    'const state = args[args.indexOf("--state") + 1];',
    'const base = args[args.indexOf("--base") + 1];',
    'if (args[0] === "pr" && args[1] === "list") { console.log(JSON.stringify(state === "open" ? fixtures.openPrs ?? [] : base === "main" ? fixtures.mergedMain ?? [] : fixtures.merged)); process.exit(0); }',
    'if (args[0] === "issue" && args[1] === "list") { console.log(JSON.stringify(state === "open" ? fixtures.open : fixtures.closed)); process.exit(0); }',
    // gh api graphql ... -F number=<n>: the time of that issue's last reopen (fixture reopenedAt; empty when absent, "FAIL" fails like a GitHub error).
    // The query must ask for the last REOPENED_EVENT on the timeline, otherwise the fake fails.
    'if (args[0] === "api" && args[1] === "graphql") {',
    '  const query = args.find((arg) => arg.startsWith("query=")) ?? "";',
    `  appendFileSync(${JSON.stringify(join(dir, 'graphql.log'))}, JSON.stringify(query) + "\\n");`,
    '  if (!query.includes("REOPENED_EVENT") || !query.includes("last: 1")) { console.error("fake gh: not a last-reopen timeline query"); process.exit(2); }',
    '  const at = fixtures.reopenedAt?.[args.find((arg) => arg.startsWith("number=")).slice(7)] ?? "";',
    '  if (at === "FAIL") { console.error("HTTP 502"); process.exit(1); }',
    '  console.log(at); process.exit(0);',
    '}',
    // gh api --paginate repos/<repo>/issues/<n>/comments --jq '... | @json': one comment per line
    'if (args[0] === "api") { const n = /issues\\/(\\d+)\\/comments/.exec(args.join(" "))[1]; for (const c of fixtures.comments?.[n] ?? []) console.log(JSON.stringify(c)); process.exit(0); }',
    `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(args) + "\\n");`,
    `if (${JSON.stringify(failOn ?? '')} && args[2] === ${JSON.stringify(failOn ?? '')}) { console.error("HTTP 403"); process.exit(1); }`,
    '',
  ].join('\n'))
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

const sweep = (dir: string, args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
})
const calls = (dir: string): string[][] => {
  try {
    return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

// the CLI uses the real clock, so these fixtures are built relative to it
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const live = (): Fixtures => ({
  open: [
    { number: 1, title: 'merged but still open', updatedAt: hoursAgo(0), comments: [] },
    { number: 4, title: 'nobody touched it', updatedAt: hoursAgo(20 * 24), comments: [] },
  ],
  closed: [{ number: 7, title: 'closed without a record', closedAt: hoursAgo(1), stateReason: 'COMPLETED', comments: [] }],
  merged: [{ number: 101, title: 'PR', headRefName: 'task/1/done', baseRefName: 'stage', body: 'Closes #1', mergedAt: hoursAgo(2), mergeCommit: { oid: 'a'.repeat(40) } }],
})

test('CLI without --apply is read-only: no write call reaches gh', () => {
  const dir = fakeGh(live())
  const result = sweep(dir, ['--repo', 'org/repo'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('| #1 | 将补关 |'))
  assert.deepEqual(calls(dir), [])
})

test('CLI --apply closes with `issue close --reason completed --comment`, comments otherwise, and exits 1 when one write fails', () => {
  const dir = fakeGh(live())
  const result = sweep(dir, ['--apply', '--repo', 'org/repo'])
  assert.equal(result.status, 0, result.stderr)
  const log = calls(dir)
  assert.deepEqual(log.map((args) => args.slice(0, 3).join(' ')), ['issue close 1', 'issue comment 4', 'issue comment 7'])
  assert.deepEqual(log[0].filter((arg, i) => ['--repo', '--reason', '--comment'].includes(log[0][i - 1] ?? '')).slice(0, 2), ['org/repo', 'completed'])
  assert.match(after(log[0], '--comment'), /^<!-- ap:track v1 kind=closed stage=merged -->/)
  assert.match(after(log[1], '--body'), /^<!-- ap:track v1 kind=overdue stage=triage -->/)
  assert.ok(result.stdout.includes('| #7 | 已留「缺记录」 |'))

  const failing = fakeGh(live(), { failOn: '4' })
  const partial = sweep(failing, ['--apply', '--repo', 'org/repo'])
  assert.equal(partial.status, 1)
  assert.ok(partial.stdout.includes('| #4 | 失败：HTTP 403 |'))
  assert.equal(calls(failing).length, 3) // one failure does not stop the rest
})

test('CLI reads merged PRs from both stage and main, so a hotfix into main finishes its issue', () => {
  const dir = fakeGh({
    open: [{ number: 21, title: 'hotfix merged, still open', updatedAt: hoursAgo(1), comments: [] }],
    closed: [],
    merged: [],
    mergedMain: [{ number: 160, title: 'hotfix', headRefName: 'hotfix/21/login_loop', baseRefName: 'main', body: 'Closes #21', mergedAt: hoursAgo(3), mergeCommit: { oid: 'a'.repeat(40) } }],
  })
  const result = sweep(dir, ['--repo', 'org/repo'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('| #21 | 将补关 | PR #160 已合并进 main，issue 还开着 |'))
})

test('CLI fetches every comment once an issue has 100: a "closed" record at #101 prevents a false "unrecorded"', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i + 1}`, createdAt: hoursAgo(2) }))
  const record = { body: '<!-- ap:track v1 kind=closed stage=closed -->\n**关闭**｜不做了', createdAt: hoursAgo(1) }
  const fixtures: Fixtures = {
    open: [],
    closed: [{ number: 7, title: 'long thread', closedAt: hoursAgo(1), stateReason: 'NOT_PLANNED', comments: hundred }],
    merged: [],
    comments: { 7: [...hundred, record] },
  }
  const result = sweep(fakeGh(fixtures), ['--repo', 'org/repo'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('没有要处理的 issue。'))
  const truncated = sweep(fakeGh({ ...fixtures, comments: { 7: hundred } }), ['--repo', 'org/repo'])
  assert.ok(truncated.stdout.includes('| #7 | 将留「缺记录」 |'))
})

test('CLI looks up the reopen time on the timeline for REOPENED issues: before the merge closes, after it does not', () => {
  const base: Fixtures = {
    open: [{ number: 5, title: 'reopened once', updatedAt: hoursAgo(1), stateReason: 'REOPENED', comments: [] }],
    closed: [],
    merged: [{ number: 150, title: 'PR', headRefName: 'someone/patch', baseRefName: 'stage', body: 'Closes #5', mergedAt: hoursAgo(3), mergeCommit: { oid: 'a'.repeat(40) } }],
  }
  assert.ok(sweep(fakeGh({ ...base, reopenedAt: { 5: hoursAgo(5) } }), ['--repo', 'org/repo']).stdout.includes('| #5 | 将补关 |'))
  assert.ok(sweep(fakeGh({ ...base, reopenedAt: { 5: hoursAgo(2) } }), ['--repo', 'org/repo']).stdout.includes('没有要处理的 issue。'))
  assert.ok(sweep(fakeGh(base), ['--repo', 'org/repo']).stdout.includes('没有要处理的 issue。'))
  // one lookup per REOPENED issue, always for the last REOPENED_EVENT
  const dir = fakeGh({ ...base, reopenedAt: { 5: hoursAgo(5) } })
  sweep(dir, ['--repo', 'org/repo'])
  const queries = readFileSync(join(dir, 'graphql.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(queries.length, 1)
  assert.ok(queries[0].includes('timelineItems(itemTypes: [REOPENED_EVENT], last: 1)'))
})

test('CLI treats a failed timeline lookup as reopened after the merge: no close, the overdue record says why', () => {
  const dir = fakeGh({
    open: [{ number: 5, title: 'reopened once', updatedAt: hoursAgo(20 * 24), stateReason: 'REOPENED', comments: [] }],
    closed: [],
    merged: [{ number: 150, title: 'PR', headRefName: 'task/5/x', baseRefName: 'stage', body: 'Closes #5', mergedAt: hoursAgo(30 * 24), mergeCommit: { oid: 'a'.repeat(40) } }],
    reopenedAt: { 5: 'FAIL' },
  })
  const result = sweep(dir, ['--apply', '--repo', 'org/repo'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('| #5 | 已留「超期」 |'))
  const log = calls(dir)
  assert.deepEqual(log.map((args) => args.slice(0, 3).join(' ')), ['issue comment 5'])
  assert.ok(after(log[0], '--body').includes('关联的 PR #150 在'))
  assert.ok(after(log[0], '--body').includes('这个 issue 被重开过（查不到重开时间，按合并后重开处理），巡检不再补关'))
})

test('CLI rejects unknown arguments', () => {
  const result = sweep(fakeGh(live()), ['--wat'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /用法/)
})
