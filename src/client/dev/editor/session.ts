// The editor's model (ADR 0002 §3.3), free of DOM and rendering so Node tests can drive it: provenance of what the
// templates placed, edits as RFC 6902 patches, rebuild-and-validate, write-back, undo and redo.
//
// An edit is applied to the live layout documents (the objects buildWorld() reads), the world is rebuilt with
// provenance, and only if it adds no build problem or content error is the patch written back through `write`.
// Anything else puts the documents back as they were.
import { applyPatch, deleteOps, entryAt, moveOps, newProblems, placeOps, regionAt, rotateOps, type FootprintFn, type PatchOp } from '../../../shared/dev/editor.ts'
import type { ProvEntry, ProvRegion } from '../../../shared/world/provenance.ts'

export interface Built { entries: ProvEntry[]; regions: ProvRegion[]; problems: string[]; content: string[] }

export interface EditorDeps {
  /** The layout JSON documents by repo-relative file, patched in place. */
  docs: Record<string, unknown>
  /** Builds the world with provenance and reports it (problems and content errors of that build). */
  build(): Built
  size: FootprintFn
  /** Current hash of a file, and the write-back call (the Vite endpoint in the browser). */
  hash(file: string): Promise<string>
  write(file: string, baseHash: string, ops: PatchOp[]): Promise<WriteResult>
  undoDepth: number
}

export type WriteResult = { ok: true; hash: string } | { ok: false; status: number; error: string; problems?: string[] }

export type EditResult =
  | { ok: true }
  | { ok: false; reason: 'nothing' | 'unknown' | 'readonly' | 'patch' | 'problems' | 'write'; problems?: string[]; status?: number; message?: string }

interface Step { label: string; file: string; ops: PatchOp[]; inverse: PatchOp[]; select: string | null }

export class EditorSession {
  private readonly deps: EditorDeps
  entries: ProvEntry[] = []
  regions: ProvRegion[] = []
  private baseline: Built | null = null
  private hashes = new Map<string, string>()
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  /** Pointer + file of the selected object (survives rebuilds, which replace the entry objects). */
  private selectedKey: string | null = null
  /** Something was written: the running game still shows the old world until the page is reloaded. */
  written = false

  constructor(deps: EditorDeps) { this.deps = deps }

  get ready(): boolean { return this.baseline !== null }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  /** Builds the baseline (about 2 s) and reads the current file hashes. */
  async open(): Promise<void> {
    const b = this.deps.build()
    this.baseline = b
    this.entries = b.entries
    this.regions = b.regions
    for (const file of Object.keys(this.deps.docs)) this.hashes.set(file, await this.deps.hash(file))
  }

  /** One placed instance: a template shared by several towns has one pointer but one entry per stamp. */
  private keyOf = (e: ProvEntry): string => `${e.file}#${e.pointer}@${e.map}:${e.transform.ox},${e.transform.oy}`

  get selected(): ProvEntry | null {
    return this.selectedKey ? this.entries.find((e) => this.keyOf(e) === this.selectedKey) ?? null : null
  }

  select(e: ProvEntry | null): void { this.selectedKey = e ? this.keyOf(e) : null }
  /** How many stamped places share this object's template entry (an edit changes all of them). */
  sharedBy(e: ProvEntry): number { return this.entries.filter((x) => x.file === e.file && x.pointer === e.pointer).length }
  entryAt(map: string, x: number, y: number): ProvEntry | null { return entryAt(this.entries, map, x, y) }
  regionAt(map: string, x: number, y: number): ProvRegion | null { return regionAt(this.regions, map, x, y) }

  /** Applies `ops` to the file's document, rebuilds, validates and writes. Returns why it was refused, if it was. */
  private async commit(file: string, ops: PatchOp[]): Promise<{ ok: true; inverse: PatchOp[] } | Exclude<EditResult, { ok: true }>> {
    const doc = this.deps.docs[file]
    const base = this.baseline
    if (!doc || !base) return { ok: false, reason: 'unknown' }
    let inverse: PatchOp[]
    try { inverse = applyPatch(doc, ops) } catch (err) { return { ok: false, reason: 'patch', message: (err as Error).message } }
    const revert = () => { applyPatch(doc, inverse) }
    let built: Built
    try { built = this.deps.build() } catch (err) { revert(); return { ok: false, reason: 'problems', problems: [(err as Error).message] } }
    if (built.problems.length > base.problems.length || built.content.length > base.content.length) {
      revert()
      return { ok: false, reason: 'problems', problems: [...newProblems(base.problems, built.problems), ...newProblems(base.content, built.content)] }
    }
    const baseHash = this.hashes.get(file) ?? await this.deps.hash(file)
    const res = await this.deps.write(file, baseHash, ops)
    if (!res.ok) {
      revert()
      return { ok: false, reason: 'write', status: res.status, message: res.error, ...(res.problems ? { problems: res.problems } : {}) }
    }
    this.hashes.set(file, res.hash)
    this.entries = built.entries
    this.regions = built.regions
    this.written = true
    return { ok: true, inverse }
  }

  /** A new edit: committed, then undoable; it ends any redo history. */
  private async edit(file: string, ops: PatchOp[], label: string, select: string | null): Promise<EditResult> {
    const res = await this.commit(file, ops)
    if (!res.ok) return res
    this.undoStack.push({ label, file, ops, inverse: res.inverse, select })
    if (this.undoStack.length > this.deps.undoDepth) this.undoStack.shift()
    this.redoStack = []
    return { ok: true }
  }

  private target(): ProvEntry | null { return this.selected }

  async move(x: number, y: number): Promise<EditResult> {
    const e = this.target()
    if (!e) return { ok: false, reason: 'nothing' }
    if (e.x === x && e.y === y) return { ok: true }
    return this.edit(e.file, moveOps(e, x, y), `move ${e.label}`, this.keyOf(e))
  }

  async rotate(): Promise<EditResult> {
    const e = this.target()
    if (!e) return { ok: false, reason: 'nothing' }
    if (e.kind !== 'prop') return { ok: false, reason: 'readonly' }
    return this.edit(e.file, rotateOps(e, this.deps.size), `rotate ${e.label}`, this.keyOf(e))
  }

  async remove(): Promise<EditResult> {
    const e = this.target()
    if (!e) return { ok: false, reason: 'nothing' }
    const res = await this.edit(e.file, deleteOps(e), `delete ${e.label}`, null)
    if (res.ok) this.selectedKey = null
    return res
  }

  async place(map: string, prop: string, x: number, y: number, rot = 0): Promise<EditResult> {
    const region = this.regionAt(map, x, y)
    if (!region) return { ok: false, reason: 'readonly' }
    const res = await this.edit(region.file, placeOps(region, prop, x, y, rot, this.deps.size), `place ${prop}`, null)
    if (res.ok) this.selectedKey = null
    return res
  }

  async undo(): Promise<EditResult> {
    const step = this.undoStack.pop()
    if (!step) return { ok: false, reason: 'nothing' }
    const res = await this.commit(step.file, step.inverse)
    if (!res.ok) { this.undoStack.push(step); return res }
    this.redoStack.push(step)
    this.selectedKey = step.select
    return { ok: true }
  }

  async redo(): Promise<EditResult> {
    const step = this.redoStack.pop()
    if (!step) return { ok: false, reason: 'nothing' }
    const res = await this.commit(step.file, step.ops)
    if (!res.ok) { this.redoStack.push(step); return res }
    this.undoStack.push(step)
    this.selectedKey = step.select
    return { ok: true }
  }
}
