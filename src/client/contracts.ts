// Client module contracts. Each module (core/, render/, world/, battle/, ui/, net/) implements
// the interface(s) below; src/client/game.ts wires them together into a GameContext.
// Interfaces only — no implementation here.
import type * as THREE from 'three'
import type {
  BattleInit, BattleResult, BiomeId, Creature, Dir, GameMap, NpcDef, SaveData,
  Settings, SpeciesDef, TrainerDef, World, TimeOfDay, CreatureView,
  BattleAction, BattleEvent, BattleRequest, FieldWeatherKind,
} from '../shared/types.ts'
import type { Content } from '../shared/content/index.ts'
import type { ClientMsg, PlayerState, PublicProfile, ServerMsg, ChatChannel, LeaderboardEntry } from '../shared/protocol.ts'

// ---------------------------------------------------------------------------
// Game data = loaded content tables (content/**/*.json) + the generated world.
// ---------------------------------------------------------------------------

export interface GameData extends Content {
  world: World
}

// ---------------------------------------------------------------------------
// Core services (src/client/core/)
// ---------------------------------------------------------------------------

export interface GameEvents {
  'save:changed': { reason: string }
  'party:changed': {}
  'bag:changed': {}
  'money:changed': { money: number; delta: number }
  'dex:seen': { speciesId: string }
  'dex:caught': { speciesId: string }
  'map:entered': { mapId: string; x: number; y: number }
  'region:entered': { mapId: string; regionIndex: number; nameZh: string }
  'quest:updated': { questId: string; stage: number; done: boolean }
  'badge:earned': { badgeId: string }
  'battle:start': { kind: BattleKind }
  'battle:end': { kind: BattleKind; result: BattleResult }
  /** Every batch of battle events as the battle client plays it (research / roaming-legend hp tracking). */
  'battle:events': { kind: BattleKind; events: readonly BattleEvent[] }
  /** A full-screen panel opened (id = its aps-<id> class; 'online' for the multiplayer hub). Drives teaching tips. */
  'screen:opened': { screen: string }
  /** A world event became active (events-runtime). */
  'world:event': { id: string; hidden: boolean }
  /** Something the player can act on appeared (an attention source went from nothing to something; see attention/). */
  'attention:raised': { id: string }
  'settings:changed': { settings: Settings }
  'net:status': { status: NetStatus }
  'chat:message': { from: string; name: string; channel: ChatChannel; text: string; at: number }
  'toast': { text: string; kind?: 'info' | 'success' | 'warn' | 'error' }
}

export interface EventBus<E = GameEvents> {
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void
  once<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void
  emit<K extends keyof E>(type: K, payload: E[K]): void
}

export type InputAction =
  | 'up' | 'down' | 'left' | 'right'
  | 'confirm'      // Z / Space / Enter / gamepad A / touch A
  | 'cancel'       // X / Backspace / gamepad B / touch B
  | 'menu'         // Esc / Tab / gamepad Start / touch Menu
  | 'run'          // Shift / gamepad X (held)
  | 'map'          // M
  | 'chat'         // T (Enter when chat focused sends)
  | 'minimap'      // N toggles minimap size
  | 'bike'         // B
  | 'bag'          // touch button only (opens the field bag)
  | 'quickSave'    // F5
  | 'debug'        // F3

export interface Input {
  /** Movement vector in screen space (x right, y down), magnitude 0..1. */
  axis(): { x: number; y: number }
  held(a: InputAction): boolean
  /** True only on the frame the action went down (also fires on key-repeat for directions when `repeat` true). */
  pressed(a: InputAction, repeat?: boolean): boolean
  released(a: InputAction): boolean
  /** Marks an edge as consumed so later readers in the same frame don't also react. */
  consume(a: InputAction): void
  /** Call once per frame after all systems ran. */
  endFrame(): void
  /** While true (DOM text field focused) gameplay actions are suppressed. */
  setTextInputActive(active: boolean): void
  readonly lastDevice: 'keyboard' | 'gamepad' | 'touch'
  /** Show/hide on-screen touch controls (virtual stick + A/B/Menu). */
  setTouchControlsVisible(visible: boolean): void
  /** Re-places the touch pad after a settings change (hand, size) or a rotation; publishes the --ap-touch-* insets. */
  refreshTouchLayout(): void
  /** A short, still touch on the game surface (client px). Fires only while the touch pad owns the screen. */
  onWorldTap(fn: (p: { x: number; y: number }) => void): () => void
}

export interface AudioManager {
  /** Must be called from a user gesture once (browsers block autoplay). */
  unlock(): void
  playBgm(id: string, opts?: { fadeMs?: number }): void
  stopBgm(fadeMs?: number): void
  readonly currentBgm: string | null
  playSfx(id: string, opts?: { volume?: number; pitch?: number }): void
  /** Procedural creature cry derived deterministically from species id. */
  playCry(speciesId: string, opts?: { pitch?: number }): void
  setVolumes(bgm: number, sfx: number): void
  /** Low-pass + duck BGM (e.g. during menus). */
  setMuffled(on: boolean): void
}

export interface GameClock {
  /** In-game minutes since day 0 (persisted to save.clockMinutes). */
  minutes: number
  readonly minutesOfDay: number
  readonly timeOfDay: TimeOfDay
  /** Advance by real seconds. */
  update(dtSec: number): void
  /** "HH:MM" */
  label(): string
}

export interface AssetManifest {
  creatures: string[]; characters: string[]; portraits: string[]; textures: string[]
  models: string[]; items: string[]; bgm: string[]; ui: string[]
}

export interface AssetStore {
  readonly manifest: AssetManifest
  /** Loads /assets/manifest.json (missing file => everything falls back to procedural placeholders). */
  init(): Promise<void>
  has(kind: keyof AssetManifest, id: string): boolean
  /** Nearest-filtered sRGB texture. Never rejects: returns a procedural placeholder when missing. */
  creatureTexture(speciesId: string): THREE.Texture
  /** URL usable in <img> (real file or generated data URL placeholder). */
  creatureImageUrl(speciesId: string): string
  characterTexture(sheetId: string): THREE.Texture
  characterImageUrl(sheetId: string): string
  portraitUrl(id: string): string | null
  terrainTexture(key: string): THREE.Texture
  textureUrl(path: string): string | null
  itemIconUrl(itemId: string): string
  loadModel(modelId: string): Promise<THREE.Object3D | null>
  bgmUrl(id: string): string | null
  uiUrl(id: string): string | null
}

export interface SaveManager {
  hasSave(slot?: number): boolean
  load(slot?: number): SaveData | null
  /** Persists the given save (localStorage). Returns false on quota/serialization failure. */
  write(save: SaveData, slot?: number): boolean
  newGame(opts: { name: string; avatar: string }): SaveData
  exportCode(save: SaveData): string
  importCode(code: string): SaveData | null
  defaultSettings(): Settings
  /** Migrates/validates foreign data into a well-formed SaveData. */
  sanitize(raw: unknown): SaveData | null
}

// ---------------------------------------------------------------------------
// Rendering (src/client/render/)
// ---------------------------------------------------------------------------

export interface PostParams {
  dof: boolean
  focusDistance: number       // world units from camera (auto-set from focus target)
  tiltShift: number           // 0..1 strength of top/bottom blur
  bokehScale: number
  bloom: boolean
  bloomStrength: number
  bloomThreshold: number
  vignette: number            // 0..1
  saturation: number          // 1 = neutral
  contrast: number
  warmth: number              // -1..1 color temperature shift
  exposure: number
  pixelScale: number          // internal res divisor
  flash: number               // 0..1 white flash overlay (animated by flash())
  /** Split toning: RGB multipliers for shadows / highlights blended by `split` (0 = off, 1 = full). */
  shadowTint?: [number, number, number]
  highlightTint?: [number, number, number]
  split?: number
}

export interface RenderView {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** World-space point the DOF focuses on (usually the player). */
  focus?: THREE.Vector3
  post?: Partial<PostParams>
}

export interface HD2DRenderer {
  readonly canvas: HTMLCanvasElement
  readonly gl: THREE.WebGLRenderer
  readonly post: PostParams
  resize(width: number, height: number): void
  applySettings(s: Settings): void
  render(view: RenderView, dtSec: number): void
  flash(color?: string, ms?: number): void
  shake(intensity: number, ms: number): void
  /** Screen-space transition overlay rendered in the post chain (0 = none, 1 = fully covered). */
  setTransition(kind: 'fade' | 'battle' | 'iris' | 'none', amount: number): void
}

export interface ActorOptions {
  sheet: string               // character sheet id
  name?: string
  nameColor?: string
  kind: 'player' | 'npc' | 'remote'
}

/** A billboarded pixel character (4-dir walk sheet) placed in the world. */
export interface Actor {
  readonly object: THREE.Object3D
  /** Tile coords (float). */
  x: number
  y: number
  /** World Y (elevation, already multiplied by LEVEL_HEIGHT). */
  elev: number
  facing: Dir
  setPosition(x: number, y: number, elev: number): void
  setFacing(dir: Dir): void
  setMoving(moving: boolean, running: boolean): void
  setName(text: string | null, color?: string): void
  setSheet(sheet: string): void
  setVisible(v: boolean): void
  /** Hide lower body in tall grass. */
  setInGrass(v: boolean): void
  /** Floating bubble over head ("!", "...", emote glyph or short text). */
  bubble(text: string, ms?: number): void
  /** Hop arc + landing squash (render.json actors.hop by default). A caller that moves the body along its own arc
   * passes its duration with height 0 so the landing squash lands with it. */
  hop(opts?: { ms?: number; height?: number }): void
  update(dtSec: number): void
  dispose(): void
}

/** A billboarded creature sprite (single image) in the world, with idle bob/hop animation. */
export interface CreatureActor {
  readonly object: THREE.Object3D
  x: number
  y: number
  elev: number
  speciesId: string
  setPosition(x: number, y: number, elev: number): void
  setFacingLeft(left: boolean): void
  setMoving(moving: boolean): void
  setVisible(v: boolean): void
  setShiny(s: boolean): void
  /** Rarity aura (glow ring/particles) for SR+ wild creatures. */
  setAura(color: string | null): void
  /** The player's follower: drawn after everything but the player and never over them, however close or large. */
  setCompanion?(on: boolean): void
  bubble(text: string, ms?: number): void
  update(dtSec: number): void
  dispose(): void
}

export type WorldFx = 'exclaim' | 'question' | 'grass' | 'dust' | 'sparkle' | 'splash' | 'heart' | 'warp' | 'levelup' | 'shiny' | 'tapMarker' | 'tapBlocked'
  | 'anchorUnlock' | 'anchorUnlockGrand' | 'anchorDepart' | 'anchorArrive'

export interface WorldWeather { kind: FieldWeatherKind; intensity: number }

/** Overworld rendering of one GameMap (HD-2D diorama). */
export interface WorldView {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  loadMap(map: GameMap, opts?: { onProgress?: (p: number) => void }): Promise<void>
  readonly map: GameMap | null
  /** Per-frame update: camera follow, chunk streaming, foliage sway, water, weather, lights. */
  update(dtSec: number, focus: { x: number; y: number; elev: number }, minutesOfDay: number): void
  setWeather(w: WorldWeather): void
  /** Camera zoom preset (0 = close, 1 = default, 2 = far) — smooth. */
  setZoom(level: number): void
  createActor(opts: ActorOptions): Actor
  createCreatureActor(speciesId: string, shiny: boolean): CreatureActor
  /** World Y at tile coords (float), honoring elevation & stairs. */
  elevationAt(x: number, y: number): number
  /** Project a world point to CSS pixel coords of the canvas. */
  worldToScreen(x: number, elev: number, y: number): { x: number; y: number; visible: boolean }
  spawnFx(kind: WorldFx, x: number, y: number, elev: number): void
  /** Mark a ground item / hidden item sparkle etc. */
  setGroundItems(items: { id: string; x: number; y: number }[]): void
  /** Teleport-anchor glow: tile positions of the anchors near the player; `on` = activated (column + sparkles). */
  setBeacons(items: { id: string; x: number; y: number; style: string; on: boolean }[]): void
  /** Walkable tiles of the currently tracked, accepted quest (empty clears the trail). */
  setQuestPath(path: readonly { x: number; y: number }[]): void
  /** Hide a prop instance at tile (e.g. after cutting/item pickup). */
  renderView(): RenderView
  dispose(): void
}

// ---------------------------------------------------------------------------
// UI (src/client/ui/) — DOM overlay on top of the canvas, pixel styled.
// ---------------------------------------------------------------------------

export interface DialogueLine { text: string; speaker?: string; portrait?: string }

export interface ListItem {
  label: string
  sub?: string                // right-aligned secondary text
  icon?: string               // image URL
  disabled?: boolean
  value?: unknown
}

export interface UIKit {
  readonly root: HTMLElement
  /** True while any modal UI owns input (world must not move). */
  isBlocking(): boolean
  /** Per-frame: routes Input to the top-most widget. */
  update(dtSec: number): void
  say(lines: (string | DialogueLine)[], opts?: { autoCloseMs?: number }): Promise<void>
  choose(prompt: string | DialogueLine | null, options: string[], opts?: { cancelIndex?: number; speaker?: string; portrait?: string }): Promise<number>
  confirm(text: string): Promise<boolean>
  prompt(text: string, initial: string, maxLen: number): Promise<string | null>
  /** Generic scrollable keyboard-navigable list in a pixel window. Resolves index or -1 on cancel. */
  list(title: string, items: ListItem[], opts?: { initial?: number; width?: number; onHighlight?: (i: number) => void; detail?: (i: number) => HTMLElement | null }): Promise<number>
  toast(text: string, kind?: 'info' | 'success' | 'warn' | 'error'): void
  fade(toBlack: boolean, ms?: number): Promise<void>
  /** Push a full-screen custom panel; returns a handle. Panel receives input via onInput while on top. */
  pushPanel(panel: UIPanel): void
  popPanel(panel: UIPanel): void
}

export interface UIPanel {
  readonly el: HTMLElement
  /** Return true if the input was handled. Called only while this panel is the top-most. */
  onInput(input: Input): boolean
  onShow?(): void
  onHide?(): void
  update?(dtSec: number): void
}

export interface HUD {
  setVisible(v: boolean): void
  setRegion(nameZh: string): void
  showBanner(title: string, subtitle?: string): void
  setClock(label: string, tod: TimeOfDay): void
  setMoney(money: number): void
  setQuest(text: string | null, summary?: string): void
  setNetStatus(status: NetStatus, online: number): void
  /** The menu has something waiting: shows (or hides) the menu chip with a red dot; `device` picks the key cap on it. */
  setMenuAlert(on: boolean, device: Input['lastDevice']): void
  /** Name tags / speech bubbles over 3D actors are positioned by world/ using this layer. */
  readonly overlay: HTMLElement
}

export interface MinimapMarker { x: number; y: number; kind: 'player' | 'other' | 'npc' | 'trainer' | 'center' | 'shop' | 'gym' | 'lab' | 'quest' | 'item' | 'wild' | 'rare' | 'warp' | 'house' | 'tower' | 'legend' | 'event'; label?: string; facing?: Dir }

export interface Minimap {
  setMap(map: GameMap, explored: Uint8Array | null): void
  update(playerX: number, playerY: number, facing: Dir, markers: MinimapMarker[], route?: readonly { x: number; y: number }[]): void
  /** Reveal fog-of-war chunk(s) around a tile. */
  reveal(x: number, y: number): void
  exploredBits(): Uint8Array | null
  setExpanded(v: boolean): void
  setVisible(v: boolean): void
}

export interface ChatUI {
  addMessage(m: { name: string; channel: ChatChannel; text: string; at: number; self?: boolean }): void
  focus(): void
  setVisible(v: boolean): void
}

export interface TypeChartOptions {
  view?: 'type' | 'grid' | 'loops'
  /** Type shown first (per-type view) or under the cursor (grid view). */
  type?: string
}

/** High-level screens (src/client/ui/screens/*). All resolve when closed. */
export interface Screens {
  title(hasSave: boolean): Promise<'continue' | 'new' | 'import' | 'settings'>
  newGame(): Promise<{ name: string; avatar: string } | null>
  starter(options: SpeciesDef[]): Promise<string>
  pauseMenu(): Promise<void>
  party(mode: 'view' | 'select' | 'battleSwitch', opts?: { title?: string; filter?: (c: Creature) => boolean }): Promise<number>   // index or -1
  summary(creature: Creature): Promise<void>
  bag(mode: 'field' | 'battle'): Promise<{ itemId: string; partyIndex?: number } | null>
  dex(): Promise<void>
  /** priceMul: buy-price multiplier per item id (active world events, e.g. sales); absent = list price. */
  shop(itemIds: string[], opts?: { priceMul?: Record<string, number> }): Promise<void>
  /** Barter screen of an exchange desk (content/exchange.json). */
  exchange(desk: string): Promise<void>
  /** 教学手册: every curriculum lesson, re-readable (content/tutorial.json curriculum). */
  manual(): Promise<void>
  /** 属性克制表: per-type matchups, the full grid and the memory loops, all read from content/types.json. */
  typeChart(opts?: TypeChartOptions): Promise<void>
  box(): Promise<void>
  /** fly: pick a town to fly to; anchors: pick an activated teleport anchor. Resolves a place id / anchor id, null when closed. */
  worldMap(opts: { fly: boolean; anchors?: boolean }): Promise<string | null>
  /** Destination picker of the teleport anchors; hereId: the anchor the player stands at. Resolves the anchor id to go to. */
  anchorPicker(opts: { hereId?: string }): Promise<string | null>
  quests(): Promise<void>
  settings(): Promise<void>
  online(): Promise<void>                                     // multiplayer hub: online list, leaderboard, trade/pvp entry
  learnMove(creature: Creature, moveId: string): Promise<number> // slot to replace or -1 to skip
}

// ---------------------------------------------------------------------------
// Battle (client presentation, src/client/battle/) — rules live in src/shared/battle/
// ---------------------------------------------------------------------------

export type BattleKind = 'wild' | 'trainer' | 'gym' | 'legend' | 'pvp'

export interface BattleOutcome {
  result: BattleResult
  caught?: Creature
  moneyDelta: number
}

/** Abstracts where battle decisions/events come from (local engine vs server PvP). */
export interface BattleChannel {
  /** Initial view for side 0 (the local player). */
  start(): Promise<{ events: BattleEvent[]; request: BattleRequest }>
  submit(action: BattleAction): Promise<{ events: BattleEvent[]; request: BattleRequest }>
  dispose(): void
}

export interface BattleRunner {
  /** Plays a full battle (scene, UI, music, transitions). Mutates ctx.save (party hp/exp/levels, bag, money, dex). */
  run(init: BattleInit, opts: { kind: BattleKind; trainer?: TrainerDef; channel?: BattleChannel; music?: string }): Promise<BattleOutcome>
  /** Plays the evolution cutscene; returns false if cancelled by the player. */
  evolve(partyIndex: number, toSpeciesId: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Net (src/client/net/)
// ---------------------------------------------------------------------------

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface NetClient {
  readonly status: NetStatus
  readonly selfId: string | null
  readonly online: number
  connect(): void
  disconnect(): void
  send(msg: ClientMsg): void
  on<T extends ServerMsg['t']>(t: T, fn: (msg: Extract<ServerMsg, { t: T }>) => void): () => void
  /** Other players currently visible on the local player's map (interpolated). */
  remotePlayers(): Map<string, PlayerState & { rx: number; ry: number }>
  /** Throttled position report (call every frame; it sends at NET_TICK_HZ only on change). */
  reportPosition(p: { map: string; x: number; y: number; facing: Dir; moving: boolean; running: boolean }): void
  updateProfile(profile: PublicProfile): void
  leaderboard(): Promise<LeaderboardEntry[]>
}

// ---------------------------------------------------------------------------
// Game context (constructed in src/client/game.ts)
// ---------------------------------------------------------------------------

export interface GameContext {
  readonly data: GameData
  save: SaveData
  readonly events: EventBus<GameEvents>
  readonly input: Input
  readonly audio: AudioManager
  readonly assets: AssetStore
  readonly saves: SaveManager
  readonly clock: GameClock
  readonly renderer: HD2DRenderer
  readonly world: WorldView
  readonly ui: UIKit
  readonly hud: HUD
  readonly minimap: Minimap
  readonly chat: ChatUI
  readonly screens: Screens
  readonly battle: BattleRunner
  readonly net: NetClient
  /** Overworld gameplay controller (player, NPCs, encounters). */
  readonly overworld: OverworldController
  /** Persist save to localStorage (+ push public profile when online). */
  persist(reason: string): void
  /** Convenience lookups. */
  species(id: string): SpeciesDef
  creatureView(c: Creature): CreatureView
}

export interface OverworldController {
  /** Enter a map at position (with fade if `transition`). */
  enterMap(mapId: string, x: number, y: number, facing: Dir, transition?: boolean): Promise<void>
  update(dtSec: number): void
  /** Freeze/unfreeze player control (cutscenes, menus, battles). */
  setControlEnabled(on: boolean): void
  /** Current player tile position. */
  readonly player: { x: number; y: number; elev: number; facing: Dir; map: string }
  /** Runs a data script (dialogue etc.) in the context of an NPC (may be null). */
  runScript(steps: import('../shared/types.ts').ScriptStep[], npc: NpcDef | null): Promise<void>
  /** Teleport to last healing spot after a loss. */
  blackout(): Promise<void>
  /** Refresh follower creature / ground items after party or flag changes. */
  refresh(): void
}

/** Biome-specific diorama look for battles; exported by render/ for battle/ to use. */
export interface BattleStageOptions { biome: BiomeId; timeOfDay: TimeOfDay; indoor: boolean }
