// Learn-move: the creature knows the maximum number of moves; pick one to forget (resolves its slot) or give up
// on the new move (-1). With a free slot it resolves that slot immediately. Does not mutate the creature.
import type { Creature } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { creatureName } from '../../../shared/creature.ts'
import { createRowMenu } from '../menu.ts'
import { creatureIcon, el, typeChip } from '../widgets.ts'
import { backPressed, frame, H, openScreen, type ScreenEnv } from './base.ts'
import { moveDetail } from './summary.ts'

export function learnMoveScreen(env: ScreenEnv, creature: Creature, moveId: string): Promise<number> {
  const { ctx } = env
  const max = CONTENT.config.party.maxMoves
  const newMove = CONTENT.moves[moveId]
  if (!newMove) return Promise.resolve(-1)
  if (creature.moves.length < max) return Promise.resolve(creature.moves.length)
  return openScreen<number>(env, 'aps-learn', (api) => {
    const name = creatureName(creature)
    const f = frame(env, { title: t('screens.learn.title'), onClose: api.guard(() => void giveUp()), hints: [H.select(), H.back()] })
    const items = [
      ...creature.moves.map((slot) => {
        const m = CONTENT.moves[slot.id]
        return { label: m?.nameZh ?? slot.id, sub: t('screens.move.ppValue', { pp: slot.pp, max: slot.ppMax }) }
      }),
      { label: t('screens.learn.newRow', { move: newMove.nameZh }), sub: t('screens.move.ppValue', { pp: newMove.pp, max: newMove.pp }) },
    ]
    const detail = el('div', 'aps-learn-detail ap-panel')
    const menu = createRowMenu(items, {
      visibleRows: items.length,
      initial: items.length - 1,
      wrap: true,
      audio: ctx.audio,
      onChange: (i) => paint(i),
      onPick: api.guard((i: number) => void pick(i)),
    })
    const rowsWithChips = menu.el.querySelectorAll('.ap-row')
    rowsWithChips.forEach((row, i) => {
      const id = i < creature.moves.length ? creature.moves[i].id : moveId
      const m = CONTENT.moves[id]
      if (m) row.insertBefore(typeChip(m.type), row.firstChild)
      if (i === creature.moves.length) row.classList.add('aps-learn-new')
    })
    f.body.append(el('div', 'aps-learn-layout', [
      el('div', 'aps-learn-head', [
        creatureIcon(ctx.assets.creatureImageUrl(creature.speciesId), creature.shiny),
        el('p', { class: 'aps-learn-msg', text: t('screens.learn.message', { name, move: newMove.nameZh, max }) }),
      ]),
      el('div', 'aps-learn-body', [el('div', 'aps-learn-list ap-panel', [menu.el]), detail]),
    ]))
    api.root.append(f.el)

    const paint = (i: number) => {
      const slot = creature.moves[i]
      detail.replaceChildren(slot ? moveDetail(CONTENT.moves[slot.id], slot) : moveDetail(newMove))
    }
    const giveUp = () => api.run(async () => {
      if (await ctx.ui.confirm(t('screens.learn.giveUpConfirm', { name, move: newMove.nameZh }))) api.close(-1)
    })
    const pick = (i: number) => api.run(async () => {
      if (i >= creature.moves.length) {
        if (await ctx.ui.confirm(t('screens.learn.giveUpConfirm', { name, move: newMove.nameZh }))) api.close(-1)
        return
      }
      const old = CONTENT.moves[creature.moves[i].id]?.nameZh ?? creature.moves[i].id
      if (await ctx.ui.confirm(t('screens.learn.forgetConfirm', { name, old, move: newMove.nameZh }))) api.close(i)
    })
    paint(menu.index)
    return {
      onInput(input) {
        if (backPressed(input)) { void giveUp(); return }
        if (menu.handleInput(input) === 'confirm') void pick(menu.index)
      },
    }
  })
}
