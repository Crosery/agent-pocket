// Story chapters (content/world/story/chapters.json): the title card a chapter opens with (the 'chapter' script op)
// and the chapter view of the main quest in the quest log. Each chapter covers a run of main-quest stages.
// Texts: content/text/zh-CN/story.json, story.chapter.<id>.<part>.
import chaptersJson from '../../../content/world/story/chapters.json' with { type: 'json' }

export interface ChapterDef {
  id: string
  /** Town the chapter is set in; its name heads the card. */
  town: string
  /** First and last main-quest stage (inclusive) the chapter covers. */
  stages: [number, number]
}

export const CHAPTER_PARTS = ['no', 'title', 'quote', 'goal', 'recap'] as const
export type ChapterPart = (typeof CHAPTER_PARTS)[number]

export const CHAPTERS: readonly ChapterDef[] = (chaptersJson as unknown as { chapters: ChapterDef[] }).chapters

export const chapterById = (id: string): ChapterDef | undefined => CHAPTERS.find((c) => c.id === id)

export const chapterTextKey = (id: string, part: ChapterPart): string => `story.chapter.${id}.${part}`

/** Index in CHAPTERS of the chapter holding main-quest stage `stage` (past the end: the last chapter). */
export function chapterIndexOfStage(stage: number): number {
  const i = CHAPTERS.findIndex((c) => stage >= c.stages[0] && stage <= c.stages[1])
  return i >= 0 ? i : CHAPTERS.length - 1
}

/** Unique ids, known towns, every text part present, stage runs covering 0..mainStages-1 in order. */
export function validateChapters(text: Readonly<Record<string, string>>, towns: readonly string[], mainStages: number): string[] {
  const errs: string[] = []
  const seen = new Set<string>()
  let next = 0
  for (const c of CHAPTERS) {
    const where = `chapters.${c.id}`
    if (!c.id || seen.has(c.id)) errs.push(`${where}: missing or duplicate id`)
    seen.add(c.id)
    if (!towns.includes(c.town)) errs.push(`${where}: unknown town "${c.town}"`)
    for (const part of CHAPTER_PARTS) if (!text[chapterTextKey(c.id, part)]) errs.push(`${where}: missing text ${chapterTextKey(c.id, part)}`)
    const [a, b] = c.stages ?? [-1, -1]
    if (a !== next || !(b >= a)) errs.push(`${where}: stages must continue at ${next} (got ${JSON.stringify(c.stages)})`)
    next = b + 1
  }
  if (next !== mainStages) errs.push(`chapters: stages end at ${next - 1}, the main quest has ${mainStages}`)
  return errs
}
