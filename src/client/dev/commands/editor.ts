// World editor commands: the toolbar, the panel and automation all go through these.
import type { CommandRun } from '../registry.ts'

const num = (v: unknown): number => Number(v)

export const editorCommands: Record<string, CommandRun> = {
  'editor.open': (host) => host.editor.open(),
  'editor.close': (host) => host.editor.close(),
  'editor.select': (host, a) => host.editor.select(num(a.x), num(a.y), a.map === undefined ? undefined : String(a.map)),
  'editor.move': (host, a) => host.editor.move(num(a.x), num(a.y)),
  'editor.rotate': (host) => host.editor.rotate(),
  'editor.delete': (host) => host.editor.remove(),
  'editor.place': (host, a) => host.editor.place(a.prop === undefined ? null : String(a.prop), a.x === undefined ? undefined : num(a.x), a.y === undefined ? undefined : num(a.y), a.rot === undefined ? undefined : num(a.rot)),
  'editor.undo': (host) => host.editor.undo(),
  'editor.redo': (host) => host.editor.redo(),
  'editor.reload': (host) => { host.editor.reload() },
}
