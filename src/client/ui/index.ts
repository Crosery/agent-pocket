// Public surface of the UI kit (src/client/ui). Screens live in ./screens/ (separate module).
export { createUIKit, type UIKitHandle } from './kit.ts'
export { createHUD, type HUDHandle } from './hud.ts'
export { createMinimap, bakeMapImage, encodeExplored, decodeExplored, type MinimapHandle } from './minimap.ts'
export { createChatUI, type ChatUIHandle } from './chat.ts'
export { installEscapeFallback, releaseButtonFocusAfterClick } from './focus.ts'
export { createEscapeStack } from './focus-guard.ts'
export {
  el, append, panel, button, hpBar, expBar, typeChip, statusChip, rarityBadge, creatureIcon, statRadar, tabs,
  createGridNav, keyHint, actionKeyLabel, nameTag, speechBubble, tooltip, glyphEl, formatNumber,
  type PanelHandle, type BarHandle, type RadarHandle, type TabsHandle, type GridNav, type ElProps, type Child,
} from './widgets.ts'
export { ensureUIEnvironment, getUIScale, onUIScaleChange, setUIBottomInset, computeUIScale, type UIScale } from './scale.ts'
export { UI_CONFIG, type UIConfig, type ToastKind } from './config.ts'
export { createRowMenu, type RowMenu } from './menu.ts'
