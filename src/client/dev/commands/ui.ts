// Opening screens and cards without clicking through the menus: lets a scenario's `then` land on the UI under review.
// The UI modules pull in stylesheets, which the Node tests cannot load, so they are imported when a command runs.
import type { ScreensHandle } from '../../ui/screens/index.ts'
import type { DevHost } from '../kit.ts'
import { DevError, type CommandRun } from '../registry.ts'

export const SCREENS = ['party', 'summary', 'summaryStats', 'box', 'boxGrade', 'bag', 'settings', 'nature'] as const
type ScreenId = (typeof SCREENS)[number]

const member = (host: DevHost, index: unknown) => {
  const i = Math.floor((index as number | undefined) ?? 0)
  const cr = host.ctx.save.party[i]
  if (!cr) throw new DevError('dev.err.noMember', { index: String(i) })
  return cr
}

/** The overworld freezes behind a fire-and-forget screen: the command returns at once, like the battle commands. */
const fire = (p: Promise<unknown>, what: string): void => { p.catch((err) => console.error(`[dev] ${what} failed`, err)) }

export const uiCommands: Record<string, CommandRun> = {
  'screen.open': async (host, a) => {
    const id = String(a.screen) as ScreenId
    if (!SCREENS.includes(id)) throw new DevError('dev.err.badArg', { arg: 'screen', why: SCREENS.join(' / ') })
    const { ctx } = host
    const s = ctx.screens as ScreensHandle
    switch (id) {
      case 'party': fire(s.party('view'), id); break
      case 'summary': fire(s.summary(member(host, a.index)), id); break
      case 'summaryStats': fire(s.summaryAt(member(host, a.index), 1), id); break
      case 'box': fire(s.box(), id); break
      case 'boxGrade': {
        const { boxToolbar } = await import('../../ui/screens/box.ts')
        boxToolbar.sortByGrade = true
        boxToolbar.onlyTop = true
        fire(s.box(), id)
        break
      }
      case 'bag': fire(s.bag('field'), id); break
      case 'settings': fire(s.settings(), id); break
      case 'nature': fire(s.pickNature(member(host, a.index)), id); break
    }
    return { screen: id }
  },
  /** The appraisal of party member `index` as the full card or the one-line chip. */
  'reveal.show': async (host, a) => {
    const cr = member(host, a.index)
    const { showReveal } = await import('../../ui/reveal.ts')
    fire(showReveal(host.ctx, cr, { full: a.full !== false }), 'reveal')
    return { uid: cr.uid, full: a.full !== false }
  },
}
