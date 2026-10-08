#!/usr/bin/env node
// Daily issue sweep (docs/conventions/TRACKING.md §1). issue-lifecycle.yml runs it with --apply.
//
//   node scripts/issue-sweep.mjs [--repo <owner/name>]            read-only: print what would be done, change nothing
//   node scripts/issue-sweep.mjs --apply [--repo <owner/name>]    do it: close issues, leave tracking comments (GH_TOKEN needs issues: write)
//   optional: --idle-days <n> (default 14), --closed-days <n> (default 14)
//
// Three jobs; the result is a Markdown table on stdout (the workflow appends it to the run summary):
//   1. close: an open issue whose linked PR has merged into stage (head is task/<issue>/…, or the body says
//      Closes #<issue>; a hotfix/<issue>/… PR merged into main counts too). close-on-merge should have closed it; if it
//      did not (workflow failed, PR was not a task branch) close it here with a "closed" record. Not closed here:
//        - it was reopened after the latest merge (time = the last REOPENED_EVENT on the timeline; stateReason stays
//          REOPENED for as long as the issue is open, so it only proves a reopen happened, not when; if the time cannot
//          be read, count it as reopened after the merge), or a "closed" record was left after the merge;
//        - another open PR links the same issue.
//      Such an issue is reported as overdue once idle, and the record says which PR merged and why it was not closed.
//      PRs merged less than an hour ago are skipped: that is close-on-merge's job, and two records would result.
//   2. overdue: any other open issue with no activity (GitHub updatedAt) for idle-days gets an "overdue" record. A
//      comment refreshes updatedAt, so one issue gets at most one per idle-days.
//   3. unrecorded: an issue closed within closed-days with neither a merged PR nor a "closed" record gets one
//      "unrecorded" record asking whoever closed it to write the record. It is never reopened.
// Only issue state and comments are touched through gh; no code, branches or PRs. The decisions live in the pure
// planSweep, covered by tests/issue-sweep.test.ts.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closingIssues, hotfixFromBranch, issueFromBranch } from './pr-contract.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
/** PRs merged more recently than this are left to close-on-merge */
export const MERGE_GRACE_MS = 60 * 60 * 1000
/** gh issue list returns at most this many comments per issue; at that count the rest is fetched page by page */
export const COMMENT_PAGE = 100
export const DEFAULT_IDLE_DAYS = 14
export const DEFAULT_CLOSED_DAYS = 14
/** Tracking record header (docs/conventions/TRACKING.md §3) */
export const TRACK_RE = /^<!-- ap:track v1 kind=([a-z]+) stage=([a-z]+) -->/
const STATE_REASON = { COMPLETED: '完成', NOT_PLANNED: '不做', DUPLICATE: '重复' }

// pure functions

/** ISO time -> Beijing time "YYYY-MM-DD HH:MM" */
export function beijing(iso) {
  return new Date(Date.parse(iso) + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16)
}

/** A PR that counts as finishing its issue: into stage, or a hotfix branch into main. A PR without a base is taken as stage. */
export function closesOnMerge(pr) {
  if (!pr.baseRefName || pr.baseRefName === 'stage') return true
  return pr.baseRefName === 'main' && hotfixFromBranch(pr.headRefName) !== null
}

/** Issues a PR is linked to: its task/hotfix branch number plus Closes/Fixes/Resolves #n in the body */
export function linkedIssues(pr) {
  const issues = new Set(closingIssues(pr.body))
  for (const fromBranch of [issueFromBranch(pr.headRefName), hotfixFromBranch(pr.headRefName)]) if (fromBranch !== null) issues.add(fromBranch)
  return [...issues]
}

/** Tracking records among the comments: [{ kind, stage, createdAt }] in the original order */
export function trackRecords(comments = []) {
  return comments.flatMap((comment) => {
    const match = TRACK_RE.exec(String(comment.body ?? '').trimStart())
    return match ? [{ kind: match[1], stage: match[2], createdAt: comment.createdAt }] : []
  })
}

export function closeNote(pr) {
  const sha = pr.mergeCommit?.oid ?? ''
  const base = pr.baseRefName ?? 'stage'
  const next = base === 'stage'
    ? '随下一个 `vX.Y.Z-rc.N` 发到预发布，由所有者验收（docs/RELEASING.md）。'
    : '按 docs/RELEASING.md 发布上线，上线后立刻把 `main` 合回 `stage`。'
  return [
    '<!-- ap:track v1 kind=closed stage=merged -->',
    `**关闭**｜PR #${pr.number} 已合并进 \`${base}\`，巡检补关这个 issue`,
    '',
    `**现状**：PR #${pr.number}「${pr.title ?? ''}」在 ${beijing(pr.mergedAt)}（北京时间）合并${sha ? `，合并提交 ${sha}` : ''}；合并时这个 issue 没有关上（close-on-merge 没跑成，或者 PR 不是从 task 分支来的），巡检补关。`,
    `**下一步**：${next}`,
    `**引用**：#${pr.number}${sha ? ` · ${sha.slice(0, 12)}` : ''}`,
  ].join('\n')
}

/**
 * Whether the issue counts as reopened after the latest merge, and on what evidence:
 * "timeline" the last reopen on the timeline is later than the merge; "record" a "closed" record was left after the
 * merge and the issue is open again; "unknown" it says REOPENED but the time cannot be read, so do not close it;
 * null never reopened (or there is no merged PR).
 */
export function reopenedAfterMerge(issue, pr, records = trackRecords(issue.comments)) {
  if (!pr) return null
  const merged = Date.parse(pr.mergedAt)
  if (issue.stateReason === 'REOPENED' && issue.reopenedAt && Date.parse(issue.reopenedAt) > merged) return 'timeline'
  if (records.some((record) => record.kind === 'closed' && Date.parse(record.createdAt) >= merged)) return 'record'
  if (issue.stateReason === 'REOPENED' && !issue.reopenedAt) return 'unknown'
  return null
}

/**
 * How an overdue issue relates to its PRs, for the "现状" line of the overdue record. `pr` is the linked merged PR (or
 * null), `reopened` is the result of reopenedAfterMerge, `reopenedAt` the reopen time from the timeline,
 * `openPrNumbers` the open PRs linked to the issue.
 */
export function situation({ pr = null, reopened = null, reopenedAt = null, openPrNumbers = [] }) {
  const open = openPrNumbers.map((number) => `#${number}`).join('、')
  const target = pr?.baseRefName ?? 'stage'
  const merged = pr ? `关联的 PR #${pr.number} 在 ${beijing(pr.mergedAt)} 合并进 ${target}` : ''
  if (pr && reopened === 'timeline') return `${merged}，之后这个 issue 在 ${beijing(reopenedAt)} 又被重开，巡检不再补关`
  if (pr && reopened === 'record') return `${merged}，之后留过「关闭」记录，这个 issue 又被重开，巡检不再补关`
  if (pr && reopened === 'unknown') return `${merged}，这个 issue 被重开过（查不到重开时间，按合并后重开处理），巡检不再补关`
  if (pr && open) return `关联的 PR #${pr.number} 已合并进 ${target}，但还有开着的 PR ${open} 关联它，巡检不补关`
  if (open) return `关联的 PR ${open} 还开着，stage 上没有关联它的已合并 PR`
  return 'stage 上没有关联它的已合并 PR'
}

export function overdueNote({ updatedAt, idleDays, stage, days, context = situation({}) }) {
  return [
    `<!-- ap:track v1 kind=overdue stage=${stage} -->`,
    `**超期**｜${idleDays} 天没有动静，请负责人决定关掉、拆出外部等待，还是接着做`,
    '',
    `**现状**：还开着，${context}；最后一次更新在 ${beijing(updatedAt)}（北京时间），已经 ${days} 天。`,
    '**下一步**：按 docs/conventions/TRACKING.md §1 三选一：做完了（运维操作、决定不做、被别的改动顺带解决）就写一条「关闭」记录并关掉；只剩外部等待就关掉这个 issue，把剩下的一步开成新 issue、写明负责人；还要接着做就留一条「进展」，写清卡在哪、谁在做。',
  ].join('\n')
}

export function unrecordedNote({ closedAt, stateReason }) {
  const reason = STATE_REASON[stateReason] ?? stateReason ?? '未注明'
  return [
    '<!-- ap:track v1 kind=unrecorded stage=closed -->',
    '**缺记录**｜关闭了，但没有合并的 PR，也没有「关闭」记录',
    '',
    `**现状**：${beijing(closedAt)}（北京时间）以「${reason}」关闭；stage 上没有关联这个 issue 的已合并 PR（head 是 task/<issue>/…，或正文写了 Closes #<issue>），评论里也没有「关闭」记录。巡检不重开。`,
    '**下一步**：关闭的人补一条「关闭」记录（docs/conventions/TRACKING.md §3）：做了什么、在哪里验证的、剩下的事交给了哪个 issue；其实还没做完就重开，再写一条「进展」。',
  ].join('\n')
}

/**
 * Work out what the sweep should do.
 * @param {{
 *   open: Array<{ number: number, title: string, updatedAt: string, stateReason?: string, reopenedAt?: string | null, comments?: Array<{ body: string, createdAt: string }> }>,
 *     reopenedAt: time of the last reopen on the timeline, looked up by load when stateReason is REOPENED; null when unreadable
 *   closed: Array<{ number: number, title: string, closedAt: string, stateReason?: string, comments?: Array<{ body: string, createdAt: string }> }>,
 *   merged: Array<{ number: number, title?: string, headRefName: string, baseRefName?: string, body?: string, mergedAt: string, mergeCommit?: { oid: string } }>,
 *   openPrs?: Array<{ number: number, headRefName: string, body?: string }>,
 *   now?: Date, idleDays?: number, closedDays?: number,
 * }} input
 * @returns {Array<{ type: "close" | "overdue" | "unrecorded", issue: object, pr?: object, body: string, reason: string }>}
 */
export function planSweep({ open, closed, merged, openPrs = [], now = new Date(), idleDays = DEFAULT_IDLE_DAYS, closedDays = DEFAULT_CLOSED_DAYS }) {
  const mergedFor = new Map()
  for (const pr of merged) {
    if (!closesOnMerge(pr)) continue
    for (const issue of linkedIssues(pr)) {
      const previous = mergedFor.get(issue)
      if (!previous || Date.parse(pr.mergedAt) > Date.parse(previous.mergedAt)) mergedFor.set(issue, pr)
    }
  }

  const openPrsFor = new Map()
  for (const pr of openPrs) for (const issue of linkedIssues(pr)) openPrsFor.set(issue, [...(openPrsFor.get(issue) ?? []), pr.number])

  const actions = []
  for (const issue of [...open].sort((a, b) => a.number - b.number)) {
    const records = trackRecords(issue.comments)
    const pr = mergedFor.get(issue.number)
    if (pr && now.getTime() - Date.parse(pr.mergedAt) < MERGE_GRACE_MS) continue
    const reopened = reopenedAfterMerge(issue, pr, records)
    const openPrNumbers = openPrsFor.get(issue.number) ?? []
    if (pr && !reopened && !openPrNumbers.length) {
      actions.push({ type: 'close', issue, pr, body: closeNote(pr), reason: `PR #${pr.number} 已合并进 ${pr.baseRefName ?? 'stage'}，issue 还开着` })
      continue
    }
    const days = Math.floor((now.getTime() - Date.parse(issue.updatedAt)) / DAY_MS)
    if (days >= idleDays) {
      const stage = records.at(-1)?.stage ?? 'triage'
      const context = situation({ pr, reopened, reopenedAt: issue.reopenedAt ?? null, openPrNumbers })
      actions.push({ type: 'overdue', issue, body: overdueNote({ updatedAt: issue.updatedAt, idleDays, stage, days, context }), reason: `${days} 天没有动静` })
    }
  }

  const since = now.getTime() - closedDays * DAY_MS
  for (const issue of [...closed].sort((a, b) => a.number - b.number)) {
    if (Date.parse(issue.closedAt) < since || mergedFor.has(issue.number)) continue
    const kinds = trackRecords(issue.comments).map((record) => record.kind)
    if (kinds.includes('closed') || kinds.includes('unrecorded')) continue
    actions.push({ type: 'unrecorded', issue, body: unrecordedNote(issue), reason: '关闭了，没有已合并的 PR，也没有「关闭」记录' })
  }
  return actions
}

const LABEL = {
  close: { plan: '将补关', done: '已补关' },
  overdue: { plan: '将留「超期」', done: '已留「超期」' },
  unrecorded: { plan: '将留「缺记录」', done: '已留「缺记录」' },
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

/** Run summary: results is [{ action, error? }]; with apply false it only lists the plan */
export function renderReport(results, { apply, now = new Date() }) {
  const lines = [`## issue 巡检（${beijing(now.toISOString())} 北京时间，${apply ? '已执行' : '只读，没有改 GitHub'}）`, '']
  if (!results.length) {
    lines.push('没有要处理的 issue。')
    return `${lines.join('\n')}\n`
  }
  lines.push('| issue | 处理 | 原因 | 标题 |', '|---|---|---|---|')
  for (const { action, error } of results) {
    const status = error ? `失败：${cell(error)}` : LABEL[action.type][apply ? 'done' : 'plan']
    lines.push(`| #${action.issue.number} | ${status} | ${cell(action.reason)} | ${cell(action.issue.title)} |`)
  }
  lines.push('', '规则见 docs/conventions/TRACKING.md §1：做完当场关；不走 PR 做完的留「关闭」记录再关；只剩外部等待的关掉原 issue，剩下的一步开新 issue 写明负责人。')
  return `${lines.join('\n')}\n`
}

// reading and writing GitHub

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/** An issue with COMMENT_PAGE comments may have more: fetch them all through the REST API */
function allComments(issue, repo) {
  if ((issue.comments?.length ?? 0) < COMMENT_PAGE) return issue
  const path = `repos/${repo ?? '{owner}/{repo}'}/issues/${issue.number}/comments?per_page=100`
  const lines = gh(['api', '--paginate', path, '--jq', '.[] | {body, createdAt: .created_at} | @json']).split('\n').filter(Boolean)
  return { ...issue, comments: lines.map((line) => JSON.parse(line)) }
}

const REOPENED_QUERY = 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } } } } }'

/** For a REOPENED issue, the time of the last reopen on the timeline; null when unreadable (planSweep then assumes a reopen after the merge and does not close it) */
function withReopenedAt(issue, nameWithOwner) {
  if (issue.stateReason !== 'REOPENED') return issue
  const [owner, name] = nameWithOwner.split('/')
  try {
    const at = gh(['api', 'graphql', '-f', `query=${REOPENED_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${issue.number}`,
      '--jq', '.data.repository.issue.timelineItems.nodes[0].createdAt // ""']).trim()
    return { ...issue, reopenedAt: at || null }
  } catch {
    return { ...issue, reopenedAt: null }
  }
}

function load({ repo, now, closedDays }) {
  const scope = repo ? ['--repo', repo] : []
  const since = new Date(now.getTime() - closedDays * DAY_MS).toISOString().slice(0, 10)
  const list = (args) => JSON.parse(gh([...args, ...scope]))
  const withComments = (issues) => issues.map((issue) => allComments(issue, repo))
  const nameWithOwner = repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
  const mergedInto = (base) => list(['pr', 'list', '--state', 'merged', '--base', base, '--limit', '500', '--json', 'number,title,headRefName,baseRefName,body,mergedAt,mergeCommit'])
  return {
    open: withComments(list(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,updatedAt,stateReason,comments']))
      .map((issue) => withReopenedAt(issue, nameWithOwner)),
    closed: withComments(list(['issue', 'list', '--state', 'closed', '--limit', '500', '--search', `closed:>=${since}`, '--json', 'number,title,closedAt,stateReason,comments'])),
    merged: [...mergedInto('stage'), ...mergedInto('main')],
    openPrs: list(['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,headRefName,body']),
  }
}

function perform(action, repo) {
  const scope = repo ? ['--repo', repo] : []
  const number = String(action.issue.number)
  if (action.type === 'close') gh(['issue', 'close', number, ...scope, '--reason', 'completed', '--comment', action.body])
  else gh(['issue', 'comment', number, ...scope, '--body', action.body])
}

function parseArgs(argv) {
  const options = { apply: false, repo: undefined, idleDays: DEFAULT_IDLE_DAYS, closedDays: DEFAULT_CLOSED_DAYS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--repo' && argv[i + 1]) options.repo = argv[++i]
    else if ((arg === '--idle-days' || arg === '--closed-days') && /^[1-9][0-9]*$/.test(argv[i + 1] ?? '')) {
      options[arg === '--idle-days' ? 'idleDays' : 'closedDays'] = Number(argv[++i])
    } else throw new Error('用法：node scripts/issue-sweep.mjs [--apply] [--repo <owner/name>] [--idle-days <n>] [--closed-days <n>]')
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const now = new Date()
  const actions = planSweep({ ...load({ ...options, now }), now, idleDays: options.idleDays, closedDays: options.closedDays })
  const results = actions.map((action) => {
    if (!options.apply) return { action }
    try {
      perform(action, options.repo)
      return { action }
    } catch (error) {
      return { action, error: String(error?.stderr || error?.message || error).trim() }
    }
  })
  process.stdout.write(renderReport(results, { apply: options.apply, now }))
  const failed = results.filter((result) => result.error)
  if (failed.length) {
    console.error(`有 ${failed.length} 个 issue 没处理成功：${failed.map((result) => `#${result.action.issue.number}`).join('、')}`)
    process.exitCode = 1
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
  } catch {
    return false
  }
}

if (isDirectRun()) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
