// Boss contract screen (签约): after a story-tier boss fight the player picks a ball and signs. The card is rolled and
// filed at the moment of signing (contract.ts), then the screen plays the throw, the level rolling back to Lv1 and the
// boss's contract line; any tap / confirm skips ahead, the last one closes it. Then the boss-version appraisal opens.
// It is a full-screen panel (aps-screen), so the battle and the story stand still behind it (battle-ui pause.selectors).
// Timings and sfx: content/battle-ui.json (contract); texts: t('battleui.capture.*'), t('boss.<id>.contract').
import type { Creature } from '../../shared/types.ts'
import type { GameContext, Input, UIPanel } from '../contracts.ts'
import { CONTENT, t } from '../../shared/content/index.ts'
import { creatureName } from '../../shared/creature.ts'
import { showReveal } from '../ui/reveal.ts'
import { creatureImg } from '../ui/screens/sprites.ts'
import { actionKeyLabel, button, el, panel } from '../ui/widgets.ts'
import { BATTLE_UI } from './config.ts'
import { ballChoices, signContract, type BallChoice, type Signed } from './contract.ts'
import './capture.css'

export interface ContractOptions {
  bossId: string
  tierId: string
  /** The boss as it was fought (its species, shiny state and level before the roll back). */
  foe: Creature
  /** Success chance shown (the tier's `capture.first`, 0..1). */
  chance: number
}

/** The boss's contract line: `contractWake` when the story woke it, else `contract`. */
function contractLine(ctx: GameContext, bossId: string): string {
  const wake = `boss.${bossId}.contractWake`
  return ctx.save.flags['ds:approach'] === 'wake' && wake in CONTENT.text ? t(wake) : t(`boss.${bossId}.contract`)
}

interface PanelArgs extends ContractOptions {
  choices: BallChoice[]
  /** Signs with the chosen ball (files the card and saves); null when nothing could be signed. */
  commit: (ballId: string) => Signed | null
}

/** Opens the screen; resolves when the player has seen it through. */
function contractPanel(ctx: GameContext, a: PanelArgs): Promise<void> {
  const C = BATTLE_UI.contract
  const touch = ctx.input.lastDevice === 'touch'
  const species = CONTENT.species[a.foe.speciesId]
  const bossName = species?.nameZh ?? a.foe.speciesId
  const fromLevel = a.foe.level
  const toLevel = CONTENT.quality.bossCard.startLevel
  let picked = 0
  let phase: 'pick' | 'sign' | 'line' | 'done' = 'pick'
  const timers: number[] = []
  const later = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)) }
  const clearTimers = () => { while (timers.length) window.clearTimeout(timers.pop()) }
  const sfx = (id: string) => ctx.audio.playSfx(id)
  // The sign button is built before the sequence that it starts.
  let doSign: () => void = () => {}

  const levelEl = el('span', { class: 'aps-ct-lv', text: t('screens.common.level', { level: fromLevel }) })
  const rateFill = el('span', 'aps-ct-ratefill')
  rateFill.style.setProperty('--rate', String(Math.max(0, Math.min(1, a.chance))))
  const rateRow = el('div', 'aps-ct-rate', [
    el('span', { class: 'aps-ct-ratek', text: t('battleui.capture.rate') }),
    el('span', 'aps-ct-ratebar', [rateFill]),
    el('span', { class: 'aps-ct-ratev', text: t('battleui.capture.rateValue', { pct: Math.round(a.chance * 100) }) }),
  ])
  const signedRow = el('div', 'aps-ct-signed', [
    el('span', { class: 'aps-ct-signedv', text: t('battleui.capture.signed') }),
    el('span', { class: 'aps-ct-signedk', text: t('battleui.capture.reset') }),
  ])
  const sprite = creatureImg(ctx.assets, a.foe.speciesId, { shiny: a.foe.shiny, className: 'aps-ct-sprite' })

  const ballButtons = a.choices.map((c, i) => {
    const item = CONTENT.items[c.id]
    const b = el('button', { class: 'aps-ct-ball', attrs: { type: 'button', role: 'radio', 'aria-label': item?.nameZh ?? c.id } }, [
      el('img', { attrs: { src: ctx.assets.itemIconUrl(c.id), alt: '', draggable: 'false' } }),
      el('span', { class: 'aps-ct-ballname', text: item?.nameZh ?? c.id }),
      el('span', { class: 'aps-ct-ballqty', text: c.owned > 0 ? t('battleui.capture.owned', { n: c.owned }) : t('battleui.capture.gift') }),
    ])
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.addEventListener('click', () => { if (phase !== 'pick') return; picked = i; paintPick(); sfx(BATTLE_UI.sfx.select) })
    return b
  })
  const signBtn = button(t('battleui.capture.sign'), () => doSign(), { primary: true, className: 'aps-ct-signbtn' })
  signBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
  const pickBlock = el('div', 'aps-ct-pick', [el('div', { class: 'aps-ct-balls', attrs: { role: 'radiogroup', 'aria-label': t('battleui.capture.pick') } }, ballButtons), signBtn])

  const throwBall = el('img', { class: 'aps-ct-throwball', attrs: { src: ctx.assets.itemIconUrl(a.choices[0].id), alt: '', draggable: 'false' } })
  const throwBlock = el('div', 'aps-ct-throw', [throwBall])
  const lineBlock = el('div', 'aps-ct-line', [
    el('div', { class: 'aps-ct-speaker', text: bossName }),
    el('div', { class: 'aps-ct-said', text: contractLine(ctx, a.bossId) }),
  ])
  const hint = el('div', 'aps-ct-hint')

  const card = panel(t('battleui.capture.title'), { className: 'aps-ct-card' })
  card.body.append(
    el('div', 'aps-ct-top', [
      el('div', 'aps-ct-who', [sprite]),
      el('div', 'aps-ct-info', [
        el('div', { class: 'aps-ct-name ap-model-name', text: t('battleui.capture.bossTier', { name: bossName, tier: t(`boss.${a.bossId}.tier.${a.tierId}`) }) }),
        el('div', 'aps-ct-lvline', [levelEl]),
        rateRow,
        signedRow,
      ]),
    ]),
    el('div', 'aps-ct-stage', [pickBlock, throwBlock, lineBlock]),
    hint,
  )

  const setPhase = (p: typeof phase) => { phase = p; root.dataset.phase = p; paintHint() }
  const paintPick = () => {
    ballButtons.forEach((b, i) => { b.classList.toggle('is-picked', i === picked); b.setAttribute('aria-checked', String(i === picked)) })
    throwBall.src = ctx.assets.itemIconUrl(a.choices[picked].id)
  }
  const paintHint = () => {
    const key = actionKeyLabel('confirm', ctx.input.lastDevice)
    hint.textContent = phase === 'pick'
      ? (touch ? t('battleui.capture.hintTouch') : t('battleui.capture.hintKey', { key }))
      : (touch ? t('battleui.capture.skipTouch') : t('battleui.capture.skipKey', { key }))
  }
  const setLevel = (n: number) => { levelEl.textContent = t('screens.common.level', { level: n }) }

  const root = el('div', { class: 'aps-screen aps-contract', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('battleui.capture.title') } }, [card.el])
  root.style.setProperty('--ct-shakes', String(C.shakes))
  root.style.setProperty('--ct-shake-ms', `${C.shakeMs}ms`)
  root.style.setProperty('--ct-flash-ms', `${C.flashMs}ms`)
  root.style.setProperty('--ct-line-ms', `${C.lineMs}ms`)

  return new Promise<void>((resolve) => {
    let idle = 0
    const close = () => {
      if (phase === 'done') return
      phase = 'done'
      clearTimers()
      window.clearTimeout(idle)
      ctx.ui.popPanel(panelApi)
      resolve()
    }
    const armIdle = () => { window.clearTimeout(idle); idle = window.setTimeout(() => { if (phase === 'line') close() }, C.autoCloseMs) }

    /** Final look of the signed screen: Lv1, the line up. */
    const showLine = () => {
      clearTimers()
      root.classList.remove('is-rolling', 'is-flash')
      root.classList.add('is-signed')
      setLevel(toLevel)
      setPhase('line')
      armIdle()
    }
    const roll = () => {
      sfx(C.sfx.roll)
      root.classList.add('is-rolling')
      const steps = Math.max(1, fromLevel - toLevel)
      const each = Math.max(16, C.rollMs / steps)
      for (let k = 1; k <= steps; k++) later(each * k, () => setLevel(Math.max(toLevel, fromLevel - k)))
      later(each * steps + 80, () => { showLine(); sfx(C.sfx.line) })
    }
    const sign = () => {
      if (phase !== 'pick') return
      const choice = a.choices[picked]
      sfx(C.sfx.throw)
      a.commit(choice.id)
      setPhase('sign')
      for (let k = 1; k <= C.shakes; k++) later(C.shakeMs * k, () => sfx(C.sfx.shake))
      const thrown = C.shakeMs * (C.shakes + 1)
      later(thrown, () => { root.classList.add('is-flash'); root.classList.add('is-signed'); sfx(C.sfx.sign) })
      later(thrown + C.flashMs, roll)
    }
    doSign = sign
    const advance = () => {
      if (phase === 'sign') showLine()
      else if (phase === 'line') close()
    }
    const panelApi: UIPanel = {
      el: root,
      onInput(input: Input) {
        if (phase === 'pick') {
          if (input.pressed('left', true) || input.pressed('up', true)) { input.consume('left'); input.consume('up'); picked = (picked + a.choices.length - 1) % a.choices.length; paintPick(); sfx(BATTLE_UI.sfx.select) }
          else if (input.pressed('right', true) || input.pressed('down', true)) { input.consume('right'); input.consume('down'); picked = (picked + 1) % a.choices.length; paintPick(); sfx(BATTLE_UI.sfx.select) }
          else if (input.pressed('confirm')) { input.consume('confirm'); sign() }
          return true
        }
        if (input.pressed('confirm') || input.pressed('cancel') || input.pressed('menu')) {
          input.consume('confirm'); input.consume('cancel'); input.consume('menu')
          advance()
        }
        return true
      },
    }
    root.addEventListener('pointerdown', (e) => { e.preventDefault(); advance() })
    paintPick()
    setPhase('pick')
    ctx.ui.pushPanel(panelApi)
  })
}

/**
 * The whole contract after a story-tier win: the screen, the saved card, the "joined" toast and the appraisal card.
 * Returns the signed card (null when the tier signs nothing).
 */
export async function contractFlow(ctx: GameContext, o: ContractOptions): Promise<Signed | null> {
  const choices = ballChoices(ctx)
  let signed: Signed | null = null
  let tried = false
  const commit = (ballId: string): Signed | null => {
    if (tried) return signed
    tried = true
    signed = signContract(ctx, o.bossId, o.tierId, ballId)
    // Saved before anything else is shown: closing the tab on the next screen cannot lose or reroll the card.
    if (signed) ctx.persist('boss-sign')
    return signed
  }
  try {
    await contractPanel(ctx, { ...o, choices, commit })
  } catch (err) {
    console.error('[battle] contract screen failed', err)
  }
  // However the screen ended, a first clear always signs.
  if (!tried) commit(choices[0].id)
  if (!signed) return null
  const { card, where } = signed
  const name = creatureName(card)
  ctx.ui.toast(where === 'party' ? t('battleui.catch.toParty', { name }) : t('battleui.catch.toBox', { name, box: ctx.save.boxes.findIndex((b) => b.includes(card)) + 1 }), 'success')
  await showReveal(ctx, card, { full: true })
  return signed
}
