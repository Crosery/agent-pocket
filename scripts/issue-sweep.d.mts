export const MERGE_GRACE_MS: number
export const COMMENT_PAGE: number
export const DEFAULT_IDLE_DAYS: number
export const DEFAULT_CLOSED_DAYS: number
export const TRACK_RE: RegExp

export interface SweepComment {
  body: string
  createdAt: string
}

export interface SweepIssue {
  number: number
  title: string
  updatedAt?: string
  closedAt?: string
  stateReason?: string
  reopenedAt?: string | null
  comments?: SweepComment[]
}

export interface SweepPullRequest {
  number: number
  title?: string
  headRefName: string
  baseRefName?: string
  body?: string
  mergedAt: string
  mergeCommit?: { oid: string }
}

export interface SweepAction {
  type: 'close' | 'overdue' | 'unrecorded'
  issue: SweepIssue
  pr?: SweepPullRequest
  body: string
  reason: string
}

export interface SweepResult {
  action: SweepAction
  error?: string
}

export function beijing(iso: string): string
export function closesOnMerge(pr: { baseRefName?: string; headRefName: string }): boolean
export function linkedIssues(pr: { headRefName: string; body?: string }): number[]
export function trackRecords(comments?: SweepComment[]): Array<{ kind: string; stage: string; createdAt: string }>
export function closeNote(pr: SweepPullRequest): string
export function reopenedAfterMerge(issue: SweepIssue, pr: SweepPullRequest | undefined | null): 'timeline' | 'record' | 'unknown' | null
export function overdueNote(input: { updatedAt: string; idleDays: number; stage: string; days: number; context?: string }): string
export function unrecordedNote(issue: { closedAt: string; stateReason?: string }): string
export function planSweep(input: {
  open: SweepIssue[]
  closed: SweepIssue[]
  merged: SweepPullRequest[]
  openPrs?: Array<{ number: number; headRefName: string; body?: string }>
  now?: Date
  idleDays?: number
  closedDays?: number
}): SweepAction[]
export function renderReport(results: SweepResult[], options: { apply: boolean; now?: Date }): string
