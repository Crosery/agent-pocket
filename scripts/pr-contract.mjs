#!/usr/bin/env node
// PR body contract (docs/conventions/PULL-REQUESTS.md): one issue = one task branch = one PR.
//
//   node scripts/pr-contract.mjs check --branch <head ref> --body-file <path> [--issue-state-file <path>]
//   node scripts/pr-contract.mjs issue --branch <head ref>     # print the issue number a task branch belongs to
//
// `check` only judges text (checkPullRequest is pure, tests/pr-contract.test.ts). The workflow reads the issue state
// with gh and hands it over as JSON, so a local run and CI reach the same verdict.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** task/<issue>/<slug>, same shape as the branch-guard job in ci.yml */
export const TASK_BRANCH_RE = /^task\/([0-9]+)\/[a-z0-9]+(?:_[a-z0-9]+)*$/
export const HOTFIX_BRANCH_RE = /^hotfix\/([0-9]+)\/[a-z0-9]+(?:_[a-z0-9]+)*$/
/** After a hotfix ships, main is merged back into stage; that PR has no issue of its own (docs/RELEASING.md). */
export const BACK_MERGE_BRANCH = 'main'

/**
 * Sections a PR body must have (`### <name>`), in any order. The name must match exactly; a parenthesised note after
 * it is fine, e.g. `### 验证命令与结果（HEAD abc123）`.
 */
export const REQUIRED_SECTIONS = ['目的', '关联', '变更范围', '解决链路', '验证命令与结果', '验收证据', '人工验收步骤', '审查结论', '风险与回滚']

/** What counts as evidence: an embedded image/video, a GitHub attachment, a URL to media, or an explicit "无界面变化". */
const EVIDENCE_RE = /!\[[^\]]*\]\([^)]+\)|<img\s[^>]*src=|<video\s|https:\/\/github\.com\/[^\s)]+\/(?:assets|files)\/|https:\/\/user-images\.githubusercontent\.com\/|https?:\/\/\S+\.(?:png|jpe?g|webp|gif|mp4|webm|mov)\b|无界面变化[:：]/i

const COMMENT_RE = /<!--[\s\S]*?-->/g
const stripComments = (text) => String(text ?? '').replace(COMMENT_RE, '')

/** Split a body at `### heading`; text after the first `（` or `(` in a heading is a note and is dropped. HTML comments are ignored. */
export function sections(body) {
  const out = new Map()
  let current = null
  for (const line of stripComments(body).replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = heading[1].replace(/[（(].*$/, '').trim()
      out.set(current, '')
      continue
    }
    if (current !== null) out.set(current, `${out.get(current)}${line}\n`)
  }
  return out
}

/** Issue numbers GitHub would close from the body: closes/fixes/resolves #n (any case, optional colon). */
export function closingIssues(body) {
  const found = new Set()
  for (const match of stripComments(body).matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#([0-9]+)\b/gi)) found.add(Number(match[1]))
  return [...found]
}

export function issueFromBranch(branch) {
  const match = TASK_BRANCH_RE.exec(String(branch ?? ''))
  return match ? Number(match[1]) : null
}

export function hotfixFromBranch(branch) {
  const match = HOTFIX_BRANCH_RE.exec(String(branch ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * Check one PR into stage. `issue` is what gh returned for the branch's issue, `{ number, state, title }` with state
 * OPEN or CLOSED; pass null to judge the text alone. Returns { ok, errors, issue, exempt }; every error is a Chinese
 * sentence that says how to fix it. `exempt` is set when the PR is not subject to the contract.
 * @param {{ branch: string, body: string, issue?: { number: number, state: string, title?: string } | null }} input
 */
export function checkPullRequest({ branch, body, issue = null }) {
  if (branch === BACK_MERGE_BRANCH) return { ok: true, errors: [], issue: null, exempt: 'back-merge' }
  const errors = []
  const number = issueFromBranch(branch)
  if (number === null) {
    errors.push(`分支 ${branch} 不是 task/<issue>/<slug>：进入 stage 的 PR 只能来自对应 issue 的 task 分支（docs/RELEASING.md）。`)
  }
  const closes = closingIssues(body)
  if (number !== null) {
    if (!closes.includes(number)) errors.push(`正文没有 \`Closes #${number}\`：分支 ${branch} 对应 issue #${number}，「关联」段要写 Closes #${number}。`)
    const extra = closes.filter((n) => n !== number)
    if (extra.length) errors.push(`正文关闭了分支以外的 issue（${extra.map((n) => `#${n}`).join('、')}）：一个 PR 只处理一个 issue，其它 issue 用「Refs #n」引用，不要用 Closes。`)
  }
  const parts = sections(body)
  for (const name of REQUIRED_SECTIONS) {
    const text = parts.get(name)
    if (text === undefined) errors.push(`缺少段落「### ${name}」（PR 模板 .github/pull_request_template.md）。`)
    else if (!text.trim()) errors.push(`段落「### ${name}」是空的：删掉模板里的注释后要写实际内容。`)
  }
  const evidence = parts.get('验收证据')
  if (evidence !== undefined && evidence.trim() && !EVIDENCE_RE.test(evidence)) {
    errors.push('「验收证据」里没有截图、录屏或附件链接（本机路径别人看不到，不算）：界面改动要放改前改后截图或录屏；确实没有界面变化时写「无界面变化：<理由>」。')
  }
  const review = parts.get('审查结论') ?? ''
  if (review.trim() && !/\*\*结论：(?:通过|有条件通过|阻塞)/.test(review)) errors.push('「审查结论」没有 `**结论：通过**`／`**结论：有条件通过**`／`**结论：阻塞**` 这一行（docs/conventions/CODE-REVIEW.md）。')
  if (issue) {
    if (number !== null && issue.number !== number) errors.push(`取回的 issue 是 #${issue.number}，与分支里的 #${number} 不一致。`)
    else if (String(issue.state).toUpperCase() !== 'OPEN') errors.push(`issue #${issue.number} 已经关闭：先重新打开它（或新开一个 issue 并改分支名），再提 PR。`)
  }
  return { ok: errors.length === 0, errors, issue: number, exempt: null }
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : undefined
}

function main() {
  const command = process.argv[2]
  const branch = arg('branch')
  if (command === 'issue') {
    const number = issueFromBranch(branch)
    if (number === null) process.exitCode = 1
    else console.log(number)
    return
  }
  if (command !== 'check') throw new Error('用法：node scripts/pr-contract.mjs check --branch <ref> --body-file <path> [--issue-state-file <path>]')
  const bodyFile = arg('body-file')
  if (!bodyFile) throw new Error('缺少 --body-file')
  const stateFile = arg('issue-state-file')
  const issue = stateFile ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  const result = checkPullRequest({ branch, body: readFileSync(bodyFile, 'utf8'), issue })
  if (result.exempt) {
    console.log(`PR 来自 ${branch}：这是热修复上线后把 main 合回 stage 的 PR，不套用正文契约（docs/RELEASING.md）。`)
    return
  }
  if (result.ok) {
    console.log(`PR 正文契约通过：分支 ${branch} ↔ issue #${result.issue}，${REQUIRED_SECTIONS.length} 个段落齐全，有验收证据。`)
    return
  }
  for (const error of result.errors) console.log(`::error title=PR 正文契约::${error}`)
  console.error(`PR 正文契约未通过（${result.errors.length} 项），按上面逐条改 PR 描述后会自动重跑。`)
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
