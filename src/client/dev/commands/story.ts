// Story state: flags and quest stages.
import { applyQuest } from '../../world/save-ops.ts'
import { DevError, type CommandRun } from '../registry.ts'

export const storyCommands: Record<string, CommandRun> = {
  /** Sets a flag; the value is true, a number, a string, or `null` to clear it. */
  'flag.set': ({ ctx }, a) => {
    const flag = String(a.flag)
    const raw = a.value
    if (raw === undefined || raw === null || raw === 'null') delete ctx.save.flags[flag]
    else ctx.save.flags[flag] = typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : (raw as string | number | boolean)
    return { flag, value: ctx.save.flags[flag] ?? null }
  },
  'quest.set': ({ ctx }, a) => {
    const id = String(a.quest)
    const def = ctx.data.world.quests.find((q) => q.id === id)
    if (!def) throw new DevError('dev.err.unknownQuest', { quest: id })
    const stage = Math.floor(a.stage as number)
    if (stage < 0 || stage >= def.stages.length) throw new DevError('dev.err.badArg', { arg: 'stage', why: `0-${def.stages.length - 1}` })
    // applyQuest only moves forward and pays rewards on completion; a developer may also step back.
    const done = a.done === true
    delete ctx.save.quests[id]
    applyQuest(ctx, id, stage, done)
    ctx.save.quests[id] = { stage, done }
    return { quest: id, ...ctx.save.quests[id] }
  },
  'quest.clear': ({ ctx }, a) => {
    const id = String(a.quest)
    delete ctx.save.quests[id]
    if (ctx.save.trackedQuest === id) delete ctx.save.trackedQuest
    ctx.events.emit('quest:updated', { questId: id, stage: 0, done: false })
    return { quest: id }
  },
}
