import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_SECTIONS, checkPullRequest, closingIssues, hotfixFromBranch, issueFromBranch, sections } from '../scripts/pr-contract.mjs'

// scripts/pr-contract.mjs: the PR body contract (docs/conventions/PULL-REQUESTS.md). Pure checks, no network.
const SCRIPT = fileURLToPath(new URL('../scripts/pr-contract.mjs', import.meta.url))
const template = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8')
const BRANCH = 'task/14/issue_pr_lifecycle'

/** A filled-in body: every section of the contract has content */
function filled(overrides: Record<string, string> = {}): string {
  const text: Record<string, string> = {
    目的: '#14：issue 合并后不会自动关闭，进展也没有固定格式。',
    关联: 'Closes #14',
    变更范围: '.github/、scripts/、docs/conventions/。不做：发布与部署流程。',
    解决链路: '1. 复现：合并 PR #6 后 #5 仍开着。\n2. 定位：GitHub 只在合进 main 时按 Closes 关闭。\n3. 修复：stage 上的工作流自己关。',
    验证命令与结果: 'npm run typecheck 通过；npm test 通过',
    验收证据: '证据 1｜1280×720｜![after](https://github.com/user-attachments/assets/0b1c2d3e)',
    人工验收步骤: '1. 合并本 PR 到 stage\n2. 打开 #14\n3. 应看到 issue 已关闭，两边各有一条「关闭」记录',
    审查结论: '审查人：Claude\n\n**结论：通过**',
    风险与回滚: 'revert 合并提交即可',
    ...overrides,
  }
  return REQUIRED_SECTIONS.map((name: string) => `### ${name}\n${text[name] ?? ''}\n`).join('\n')
}

const errorsOf = (input: Parameters<typeof checkPullRequest>[0]) => checkPullRequest(input).errors.join('\n')

test('branch numbers: only task/<n>/<slug> carries an issue', () => {
  assert.equal(issueFromBranch('task/14/issue_pr_lifecycle'), 14)
  assert.equal(issueFromBranch('task/14-issue'), null)
  assert.equal(issueFromBranch('task/14/Bad-Slug'), null)
  assert.equal(issueFromBranch('dev/crosery'), null)
  assert.equal(issueFromBranch('stage'), null)
  assert.equal(hotfixFromBranch('hotfix/3/login_loop'), 3)
  assert.equal(hotfixFromBranch('task/3/login_loop'), null)
})

test('closing keywords: Closes/Fixes/Resolves count, Refs and HTML comments do not', () => {
  assert.deepEqual(closingIssues('Closes #3\nfixes #4, Resolved #5\nCloses: #7\nRefs #6').sort(), [3, 4, 5, 7])
  assert.deepEqual(closingIssues('<!-- Closes #9 -->\nRefs #9'), [])
})

test('sections are split at ### headings; a note in parentheses is not part of the name', () => {
  const parts = sections('### 验证命令与结果（HEAD abc）\nnpm test\n### 关联\nCloses #1\n<!-- ### 目的 -->')
  assert.match(parts.get('验证命令与结果') ?? '', /npm test/)
  assert.match(parts.get('关联') ?? '', /Closes #1/)
  assert.equal(parts.has('目的'), false)
})

test('a compliant body on an open issue passes', () => {
  const result = checkPullRequest({ branch: BRANCH, body: filled(), issue: { number: 14, state: 'OPEN' } })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.equal(result.issue, 14)
  assert.equal(result.exempt, null)
})

test('a missing section fails and names it', () => {
  const body = filled().replace(/### 人工验收步骤[\s\S]*?(?=### )/, '')
  const result = checkPullRequest({ branch: BRANCH, body })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /缺少段落「### 人工验收步骤」/)
})

test('an empty section (only the template comment left) fails', () => {
  const body = filled({ 解决链路: '<!-- 复现 → 定位 → 修复 → 验证 -->' })
  assert.match(errorsOf({ branch: BRANCH, body }), /「### 解决链路」是空的/)
})

test('Closes that does not match the branch number fails', () => {
  assert.match(errorsOf({ branch: BRANCH, body: filled({ 关联: 'Closes #15' }) }), /没有 `Closes #14`/)
  assert.match(errorsOf({ branch: BRANCH, body: filled({ 关联: 'Refs #14' }) }), /没有 `Closes #14`/)
  const extra = errorsOf({ branch: BRANCH, body: filled({ 关联: 'Closes #14\nCloses #9' }) })
  assert.match(extra, /关闭了分支以外的 issue（#9）/)
  assert.doesNotMatch(extra, /没有 `Closes #14`/)
})

test('a closed issue fails, and so does an issue that is not the branch\'s', () => {
  assert.match(errorsOf({ branch: BRANCH, body: filled(), issue: { number: 14, state: 'CLOSED' } }), /issue #14 已经关闭/)
  assert.match(errorsOf({ branch: BRANCH, body: filled(), issue: { number: 15, state: 'OPEN' } }), /不一致/)
})

test('a non-task branch fails; only main (back-merge after a hotfix) is exempt', () => {
  for (const branch of ['dev/crosery', 'hotfix/3/login_loop', 'task/14-issue_pr_lifecycle', 'feature/x']) {
    const result = checkPullRequest({ branch, body: filled() })
    assert.equal(result.ok, false, branch)
    assert.match(result.errors.join('\n'), /不是 task\/<issue>\/<slug>/, branch)
  }
  // a stale issue number in the body cannot rescue a non-task branch
  assert.equal(checkPullRequest({ branch: 'dev/crosery', body: filled({ 关联: 'Closes #14' }) }).ok, false)
  const backMerge = checkPullRequest({ branch: 'main', body: '' })
  assert.equal(backMerge.ok, true)
  assert.equal(backMerge.exempt, 'back-merge')
})

test('evidence must be an image, video or attachment, or an explicit "no UI change"', () => {
  const evidence = (text: string) => errorsOf({ branch: BRANCH, body: filled({ 验收证据: text }) })
  assert.match(evidence('看过了，没问题'), /没有截图、录屏或附件链接/)
  assert.match(evidence('output/14/after.png'), /没有截图、录屏或附件链接/)
  assert.equal(evidence('无界面变化：只改了 CI 工作流'), '')
  assert.equal(evidence('<img src="https://github.com/o/r/assets/1/a.png" width="600">'), '')
  assert.equal(evidence('录屏 https://github.com/user-attachments/assets/aaaa-bbbb'), '')
  assert.equal(evidence('逐帧图 https://cdn.example.com/walk.gif'), '')
  assert.match(evidence('<!-- 无界面变化：理由 -->'), /是空的/)
})

test('review needs one of the three verdict lines; the template comment does not count', () => {
  assert.match(errorsOf({ branch: BRANCH, body: filled({ 审查结论: '看起来可以' }) }), /结论：通过/)
  assert.match(errorsOf({ branch: BRANCH, body: filled({ 审查结论: '看起来可以\n<!-- **结论：通过** -->' }) }), /结论：通过/)
  for (const verdict of ['通过', '有条件通过', '阻塞']) assert.equal(errorsOf({ branch: BRANCH, body: filled({ 审查结论: `**结论：${verdict}**` }) }), '', verdict)
})

test('the repo PR template carries every section and fails as submitted', () => {
  const parts = sections(template)
  for (const name of REQUIRED_SECTIONS) assert.equal(parts.has(name), true, name)
  assert.equal(checkPullRequest({ branch: BRANCH, body: template }).ok, false)
})

test('CLI: issue prints the branch number, check exits 0/1 and annotates failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-pr-contract-'))
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    const body = join(dir, 'body.md')
    const open = join(dir, 'open.json')
    const closed = join(dir, 'closed.json')
    writeFileSync(open, JSON.stringify({ number: 14, state: 'OPEN', title: 't' }))
    writeFileSync(closed, JSON.stringify({ number: 14, state: 'CLOSED', title: 't' }))

    assert.equal(run('issue', '--branch', BRANCH).stdout.trim(), '14')
    assert.equal(run('issue', '--branch', 'dev/crosery').status, 1)

    writeFileSync(body, filled())
    const ok = run('check', '--branch', BRANCH, '--body-file', body, '--issue-state-file', open)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /PR 正文契约通过/)

    const closedRun = run('check', '--branch', BRANCH, '--body-file', body, '--issue-state-file', closed)
    assert.equal(closedRun.status, 1)
    assert.match(closedRun.stdout, /^::error title=PR 正文契约::issue #14 已经关闭/m)

    writeFileSync(body, filled({ 关联: 'Closes #15' }))
    assert.equal(run('check', '--branch', BRANCH, '--body-file', body).status, 1)

    writeFileSync(body, '')
    const backMerge = run('check', '--branch', 'main', '--body-file', body)
    assert.equal(backMerge.status, 0)
    assert.match(backMerge.stdout, /不套用正文契约/)
    assert.equal(run('check', '--branch', BRANCH).status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
