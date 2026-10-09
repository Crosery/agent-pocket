// Onboarding: replay the tutorial, pop a single tip.
import { TUTORIAL } from '../../onboarding/config.ts'
import { DevError, type CommandRun } from '../registry.ts'

const PREFIXES = (): string[] => [`tip:`, TUTORIAL.curriculum.flagPrefix, 'intro:', 'ob:']

export const onboardingCommands: Record<string, CommandRun> = {
  /** Forgets every tip, lesson and onboarding progress flag. */
  'onboard.reset': ({ ctx }) => {
    let n = 0
    for (const k of Object.keys(ctx.save.flags)) if (PREFIXES().some((p) => k.startsWith(p))) { delete ctx.save.flags[k]; n++ }
    return { cleared: n }
  },
  'onboard.show': ({ onboarding }, a) => {
    const id = String(a.tip)
    if (!TUTORIAL.tips.list.some((t) => t.id === id)) throw new DevError('dev.err.unknownTip', { tip: id })
    onboarding.debugShow(id)
    return { tip: id }
  },
}
