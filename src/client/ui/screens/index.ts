// High-level screens (Screens contract). Every method is its own module; all labels, menus, tabs, filters,
// credits and tunables come from content/screens.json + t('screens.*').
import type { SaveData } from '../../../shared/types.ts'
import type { GameContext, Screens } from '../../contracts.ts'
import { t } from '../../../shared/content/index.ts'
import type { ScreenEnv, ScreenInternals } from './base.ts'
import { titleScreen } from './title.ts'
import { newGameScreen } from './newgame.ts'
import { starterScreen } from './starter.ts'
import { badgeCaseScreen, pauseScreen } from './pause.ts'
import { partyScreen } from './party.ts'
import { summaryScreen } from './summary.ts'
import { bagScreen } from './bag.ts'
import { dexScreen } from './dex.ts'
import { shopScreen } from './shop.ts'
import { exchangeScreen } from './exchange.ts'
import { manualScreen } from './manual.ts'
import { boxScreen } from './box.ts'
import { worldMapScreen } from './worldmap.ts'
import { anchorPickerScreen } from './anchorpicker.ts'
import { questsScreen, questHudText } from './quests.ts'
import { settingsScreen } from './settings.ts'
import { learnMoveScreen } from './learnmove.ts'
import { promptSaveCode } from './savecode.ts'
import './screens.css'

export interface ScreensHandle extends Screens {
  /** Paste-a-save-code dialog (title "import"): resolves the validated save, or null if cancelled. */
  importSave(): Promise<SaveData | null>
  /** Badge case (also reachable from the badge-case key item). */
  badges(): Promise<void>
}

export { questHudText }

type OnlineModule = { openOnline?: (ctx: GameContext) => Promise<void> | void }

/** Vite resolves this to {} when ./online.ts is absent, so the menu entry degrades to a toast. */
function onlineLoaders(): Record<string, () => Promise<unknown>> {
  try {
    // @ts-ignore -- import.meta.glob is provided by Vite; node tests never call this
    return import.meta.glob('./online.ts') as Record<string, () => Promise<unknown>>
  } catch {
    return {}
  }
}

export function createScreens(ctx: GameContext): ScreensHandle {
  const internal: ScreenInternals = {
    party: (mode, opts) => partyScreen(env, mode, opts),
    summaryOf: (list, index) => summaryScreen(env, list, index),
    badges: () => badgeCaseScreen(env),
  }
  const screens: ScreensHandle = {
    title: (hasSave) => titleScreen(env, hasSave),
    newGame: () => newGameScreen(env),
    starter: (options) => starterScreen(env, options),
    pauseMenu: () => pauseScreen(env),
    party: (mode, opts) => partyScreen(env, mode, opts),
    summary: (creature) => {
      const i = ctx.save.party.indexOf(creature)
      return i >= 0 ? summaryScreen(env, ctx.save.party, i) : summaryScreen(env, [creature], 0)
    },
    bag: (mode) => bagScreen(env, mode),
    dex: () => dexScreen(env),
    shop: (itemIds, opts) => shopScreen(env, itemIds, opts),
    exchange: (desk) => exchangeScreen(env, desk),
    manual: () => manualScreen(env),
    box: () => boxScreen(env),
    worldMap: (opts) => worldMapScreen(env, opts),
    anchorPicker: (opts) => anchorPickerScreen(env, opts),
    quests: () => questsScreen(env),
    settings: () => settingsScreen(env),
    async online() {
      const load = Object.values(onlineLoaders())[0]
      try {
        const mod = load ? ((await load()) as OnlineModule) : null
        if (mod?.openOnline) { await mod.openOnline(ctx); return }
      } catch (err) {
        console.warn('[screens] online module failed', err)
      }
      ctx.ui.toast(t('screens.pause.onlineMissing'), 'warn')
    },
    learnMove: (creature, moveId) => learnMoveScreen(env, creature, moveId),
    importSave: () => promptSaveCode(env),
    badges: () => badgeCaseScreen(env),
  }
  const env: ScreenEnv = { ctx, screens, internal, state: { depth: 0, leave: false, after: null } }
  return screens
}
