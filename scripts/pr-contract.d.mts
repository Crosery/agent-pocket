export const TASK_BRANCH_RE: RegExp
export const HOTFIX_BRANCH_RE: RegExp
export const BACK_MERGE_BRANCH: string
export const REQUIRED_SECTIONS: string[]

export interface IssueState {
  number: number
  state: string
  title?: string
}

export interface PullRequestCheck {
  ok: boolean
  errors: string[]
  issue: number | null
  exempt: 'back-merge' | null
}

export function sections(body: string | null | undefined): Map<string, string>
export function closingIssues(body: string | null | undefined): number[]
export function issueFromBranch(branch: string | null | undefined): number | null
export function hotfixFromBranch(branch: string | null | undefined): number | null
export function checkPullRequest(input: { branch: string; body: string; issue?: IssueState | null }): PullRequestCheck
