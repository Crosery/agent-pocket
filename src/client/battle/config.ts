// Typed view of content/battle-ui.json (battle client tunables) + validation. Pure module: no DOM.
import type { MoveCategory, Settings } from '../../shared/types.ts'
import type { BattleKind } from '../contracts.ts'
import type { Content } from '../../shared/content/index.ts'
import battleUiJson from '../../../content/battle-ui.json' with { type: 'json' }

export type TransitionKind = 'fade' | 'battle' | 'iris'
export type IntroKind = 'wild' | 'trainer' | 'pvp' | 'legend'
export type CommandId = 'fight' | 'bag' | 'party' | 'run' | 'forfeit'
export type EffCategory = 'immune' | 'weak' | 'normal' | 'super'
type TextSpeed = Settings['textSpeed']

export interface BattleUiConfig {
  transition: {
    /** Played by the runner itself when the caller did not already cover the screen (e.g. PvP). */
    selfCover: { kind: TransitionKind; ms: number; sfx: string }
    /** Uncovering the battle scene (from a fully covered screen). */
    reveal: { kind: TransitionKind; ms: number }
    exit: { fadeMs: number }
    /** DOM fade-in of whatever the caller shows after the battle. */
    returnFadeMs: number
  }
  stage: { indoorMapKinds: string[]; maxDtSec: number }
  introByKind: Record<BattleKind, IntroKind>
  music: { fadeMs: number; victory: string; victoryKinds: BattleKind[]; evolution: string }
  message: {
    charsPerSecond: Record<TextSpeed, number>
    autoAdvanceMs: Record<TextSpeed, number>
    autoAdvance: boolean
    /** Splits "Name: 「line」" into the speaker (group 1) and the quoted line: the speaker gets a plate in the message window. */
    speakerPattern: string
    pause: { chars: string; ms: number }
    blip: { sfx: string; everyChars: number; volume: number; pitch: number }
  }
  timing: {
    afterIntroMs: number
    abilityBannerMs: number
    levelUpPanelMs: number
    endHoldMs: number
    faintSettleMs: number
    pvpTimerWarnSec: number
    /** Wall-clock cap for any single stage animation (soft-lock guard). */
    stageGuardMs: number
  }
  channel: { maxAutoSteps: number }
  sfx: {
    hit: Record<EffCategory, string>
    crit: string; miss: string; faint: string; throwBall: string; catch: string; catchFail: string; heal: string
    levelUp: string; item: string; money: string; evolveStart: string; evolveDone: string; evolveCancel: string
    run: string; statUp: string; statDown: string; status: string; learn: string; ability: string
    select: string; confirm: string; cancel: string; error: string; advance: string
  }
  cry: { onSendOut: boolean; onFaint: boolean; faintPitch: number; evolvePitch: number }
  /**
   * Window geometry in UI pixels (CSS reads it from --apb-* variables set by view.ts). `syncSec` is how often the HUD's
   * rectangles are re-measured for the stage composition; `bottomMaxGapPx` is the most space the bottom windows may leave
   * under them (QA: no dead band).
   */
  layout: {
    syncSec: number; margin: number; gap: number; barHeight: number
    foeWidth: number; ownWidth: number; cmdWidth: number
    compactFoeWidth: number; compactOwnWidth: number; compactCmdWidth: number
    detailWidth: number; bottomMaxGapPx: number
  }
  hud: {
    hpBarWidth: number; expBarWidth: number; foeHpNumbers: boolean; ownHpNumbers: boolean
    showTypes: boolean; showStages: boolean
    /** Boss meter tiles: display width of the label kept (wide characters count 2), cells of the pip row, and how long a tapped tile's full reading stays up. */
    meterLabelWidth: number; meterPipCells: number; meterReadoutMs: number
  }
  /** Pixel icons (files under `base`, named icon-<id>.png); type badges use each type's own `icon` file under `typeBase`. */
  icons: {
    base: string
    commands: Record<CommandId, string>
    effects: string[]
    meterTones: Record<'neutral' | 'good' | 'warn' | 'bad', string>
    typeBase: string
  }
  commands: { normal: CommandId[]; pvp: CommandId[]; columns: number }
  moves: { columns: number; hintRequiresSeen: boolean; categoryColors: Record<MoveCategory, string> }
  catch: { nicknamePrompt: boolean }
  evolve: { startHoldMs: number; endHoldMs: number }
}

export const BATTLE_UI: BattleUiConfig = battleUiJson as unknown as BattleUiConfig

const COMMAND_IDS: readonly CommandId[] = ['fight', 'bag', 'party', 'run', 'forfeit']
const TRANSITIONS: readonly TransitionKind[] = ['fade', 'battle', 'iris']
const INTROS: readonly IntroKind[] = ['wild', 'trainer', 'pvp', 'legend']
const KINDS: readonly BattleKind[] = ['wild', 'trainer', 'gym', 'legend', 'pvp']
const SPEEDS: readonly TextSpeed[] = ['slow', 'normal', 'fast', 'instant']
const CATEGORIES: readonly MoveCategory[] = ['physical', 'special', 'status']
const EFFS: readonly EffCategory[] = ['immune', 'weak', 'normal', 'super']

/** Problems in content/battle-ui.json against the loaded content (sfx / bgm ids, enums, numbers). */
export function validateBattleUi(c: Content, cfg: BattleUiConfig = BATTLE_UI): string[] {
  const errs: string[] = []
  const num = (where: string, v: unknown, min = 0) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) errs.push(`battle-ui ${where}: expected number >= ${min}`)
  }
  const sfx = (where: string, id: string) => { if (!c.audio.sfx.includes(id)) errs.push(`battle-ui ${where}: unknown sfx "${id}"`) }
  const bgm = (where: string, id: string) => { if (!c.audio.bgm.some((b) => b.id === id)) errs.push(`battle-ui ${where}: unknown bgm "${id}"`) }

  for (const k of ['selfCover', 'reveal'] as const) {
    if (!TRANSITIONS.includes(cfg.transition[k].kind)) errs.push(`battle-ui transition.${k}.kind invalid`)
    num(`transition.${k}.ms`, cfg.transition[k].ms)
  }
  sfx('transition.selfCover.sfx', cfg.transition.selfCover.sfx)
  num('transition.exit.fadeMs', cfg.transition.exit.fadeMs)
  num('transition.returnFadeMs', cfg.transition.returnFadeMs)
  num('stage.maxDtSec', cfg.stage.maxDtSec, Number.MIN_VALUE)
  for (const k of KINDS) if (!INTROS.includes(cfg.introByKind[k])) errs.push(`battle-ui introByKind.${k} invalid`)
  bgm('music.victory', cfg.music.victory)
  bgm('music.evolution', cfg.music.evolution)
  num('music.fadeMs', cfg.music.fadeMs)
  for (const k of cfg.music.victoryKinds) if (!KINDS.includes(k)) errs.push(`battle-ui music.victoryKinds: unknown kind "${k}"`)
  for (const s of SPEEDS) {
    num(`message.charsPerSecond.${s}`, cfg.message.charsPerSecond[s])
    num(`message.autoAdvanceMs.${s}`, cfg.message.autoAdvanceMs[s])
  }
  sfx('message.blip.sfx', cfg.message.blip.sfx)
  num('message.blip.everyChars', cfg.message.blip.everyChars, 1)
  for (const [k, v] of Object.entries(cfg.timing)) num(`timing.${k}`, v)
  num('channel.maxAutoSteps', cfg.channel.maxAutoSteps, 1)
  for (const e of EFFS) sfx(`sfx.hit.${e}`, cfg.sfx.hit[e])
  for (const [k, v] of Object.entries(cfg.sfx)) if (typeof v === 'string') sfx(`sfx.${k}`, v)
  num('cry.faintPitch', cfg.cry.faintPitch, Number.MIN_VALUE)
  num('cry.evolvePitch', cfg.cry.evolvePitch, Number.MIN_VALUE)
  num('hud.hpBarWidth', cfg.hud.hpBarWidth, 4)
  num('hud.expBarWidth', cfg.hud.expBarWidth, 4)
  for (const list of [cfg.commands.normal, cfg.commands.pvp]) {
    for (const id of list) if (!COMMAND_IDS.includes(id)) errs.push(`battle-ui commands: unknown command "${id}"`)
    if (!list.includes('fight')) errs.push('battle-ui commands: every command list needs "fight"')
  }
  num('commands.columns', cfg.commands.columns, 1)
  num('moves.columns', cfg.moves.columns, 1)
  for (const cat of CATEGORIES) if (typeof cfg.moves.categoryColors[cat] !== 'string') errs.push(`battle-ui moves.categoryColors.${cat} missing`)
  num('evolve.startHoldMs', cfg.evolve.startHoldMs)
  num('evolve.endHoldMs', cfg.evolve.endHoldMs)
  return errs
}
