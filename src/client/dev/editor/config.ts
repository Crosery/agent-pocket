import editorJson from '../../../../content/dev/editor.json' with { type: 'json' }

export interface EditorConfig {
  files: string[]
  endpoint: { path: string; tokenHeader: string; tokenMeta: string; maxBodyBytes: number; maxOps: number; validateTimeoutMs: number }
  undoDepth: number
  pick: { searchRadiusTiles: number }
  /** How many problem lines a refusal shows. */
  problemLines: number
  palette: { id: string; titleKey: string; props: string[] }[]
}

export const EDITOR: EditorConfig = editorJson as unknown as EditorConfig
