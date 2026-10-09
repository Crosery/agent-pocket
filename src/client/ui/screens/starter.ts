// Starter choice: one card per option (big sprite, types, rarity), a detail strip (dex entry, personality,
// company) and the cry on highlight. Cannot be cancelled; resolves the chosen species id after confirmation.
import type { SpeciesDef } from '../../../shared/types.ts'
import { CONTENT, t } from '../../../shared/content/index.ts'
import { createGridNav, el, rarityBadge, typeChip } from '../widgets.ts'
import { frame, H, openScreen, pressed, uiSfx, type ScreenEnv } from './base.ts'
import { SCREENS } from './config.ts'
import { extraEnglishName } from './logic.ts'
import { creatureImg } from './sprites.ts'

export function starterScreen(env: ScreenEnv, options: SpeciesDef[]): Promise<string> {
  const { ctx } = env
  const list = options.filter((s) => CONTENT.species[s.id])
  if (!list.length) return Promise.resolve(options[0]?.id ?? '')
  return openScreen<string>(env, 'aps-starter', (api) => {
    const f = frame(env, { title: t('screens.starter.title'), hints: [['lr', t('screens.starter.hintPick')], H.confirm()] })
    const intro = el('p', { class: 'aps-starter-intro', text: t('screens.starter.intro') })
    const cards = list.map((sp, i) => {
      const glow = CONTENT.typeById[sp.types[0]]?.color
      const card = el('button', { class: 'aps-starter-card aps-card', attrs: { type: 'button', 'aria-label': sp.nameZh }, vars: glow ? { '--glow': glow, '--i': i } : { '--i': i } }, [
        el('div', 'aps-starter-stage', [el('div', 'aps-starter-pedestal'), creatureImg(ctx.assets, sp.id, { className: 'aps-starter-sprite' })]),
        el('div', { class: 'aps-starter-name ap-model-name', text: sp.nameZh, title: sp.nameZh, attrs: { 'aria-label': sp.nameZh } }),
        extraEnglishName(sp) ? el('div', { class: 'aps-starter-en ap-dim ap-model-name', text: sp.nameEn, title: sp.nameEn, attrs: { 'aria-label': sp.nameEn } }) : null,
        el('div', 'aps-chips', [...sp.types.map((ty) => typeChip(ty)), rarityBadge(sp.rarity)]),
      ])
      card.addEventListener('mouseenter', api.guard(() => { if (nav.index !== i) { nav.index = i; uiSfx(env, 'move'); paint() } }))
      card.addEventListener('click', api.guard(() => { if (nav.index !== i) { nav.index = i; paint() } void choose() }))
      return card
    })
    const detail = el('div', 'aps-starter-detail ap-panel')
    f.body.append(el('div', 'aps-starter-layout', [intro, el('div', { class: 'aps-starter-cards', attrs: { role: 'listbox' }, vars: { '--stagger': `${SCREENS.anim.cardStaggerMs}ms` } }, cards), detail]))
    api.root.append(f.el)

    const nav = createGridNav({ count: list.length, cols: list.length, audio: ctx.audio, onChange: () => paint() })
    const paint = () => {
      const sp = list[nav.index]
      cards.forEach((c, k) => { c.classList.toggle('is-active', k === nav.index); c.setAttribute('aria-selected', String(k === nav.index)) })
      ctx.audio.playCry(sp.id)
      detail.replaceChildren(
        el('div', 'aps-starter-dhead', [
          el('span', { class: 'ap-gold', text: t('screens.starter.dexNo', { n: String(sp.dexNo).padStart(3, '0') }) }),
          el('span', { class: 'aps-starter-dname ap-model-name', text: sp.nameZh, title: sp.nameZh }),
          el('span', { class: 'ap-dim', text: t('screens.starter.company', { company: sp.company }) }),
        ]),
        el('p', { class: 'aps-starter-entry', text: sp.dexEntry }),
        el('p', { class: 'aps-starter-persona' }, [el('span', { class: 'ap-gold', text: t('screens.starter.personality') }), sp.personality]),
      )
    }
    const choose = () => api.run(async () => {
      const sp = list[nav.index]
      const ok = await ctx.ui.confirm(t('screens.starter.confirm', { name: sp.nameZh }))
      if (ok) api.close(sp.id)
    })
    paint()
    return {
      onInput(input) {
        if (pressed(input, 'confirm')) { void choose(); return }
        nav.handle(input)
      },
    }
  })
}
