# Agent Pocket · 智灵口袋 — Design & Architecture

HD-2D (Octopath-style) open-world pixel creature-collecting RPG in the browser. Creatures are today's AI
models/products (CN + international) rendered as cute chibi anime pixel personifications. Multiplayer via WebSocket.

## Stack

- Client: Vite 8 + TypeScript 7 + three.js r186 (WebGLRenderer + EffectComposer post chain). DOM overlay UI.
- Server: Node ≥ 23.6 running `.ts` directly (type stripping) + `ws`. Serves `dist/` in production.
- Shared: pure TS (`src/shared/`) used by client, server and `node --test` tests. JSON is imported with
  `import x from '…json' with { type: 'json' }` (works in Node, Vite and tsc). **Erasable syntax only**
  (no `enum`, no `namespace`, no parameter properties). Relative imports **must include `.ts`**.

## Data-driven rule (non-negotiable)

**No game data in code.** Every table, name, tunable number and player-facing string lives in `content/**/*.json`:

| file | contents |
|---|---|
| `content/config.json` | every tunable number (speeds, formulas' constants, party/box sizes, time of day, net limits, camera, render, default settings) |
| `content/types.json` | type list, type chart, status immunities |
| `content/rarities.json`, `stats.json`, `statuses.json`, `volatiles.json`, `weathers.json` | battle taxonomy; statuses/volatiles/weathers are fully parameterised |
| `content/abilities.json` | abilities as a declarative effect DSL (`AbilityEffect`) interpreted generically by the engine |
| `content/moves.json`, `items.json`, `species.json` | moves, items, the AI creature roster (learnsets, evolutions, stats, dex text, design prompts) |
| `content/biomes.json`, `terrain.json`, `props.json`, `characters.json`, `audio.json` | presentation tables |
| `content/world/**` | world layout parameters, towns, routes, regions, interiors, NPCs, trainers, quests, dialogue scripts |
| `content/text/zh-CN/<ns>.json` | UI & system strings, looked up with `t('<ns>.<key>', params)` |

Code reads data only via `CONTENT` / `t()` from `src/shared/content/index.ts` (or the world loader for `content/world/**`).
Code may contain: logic, schemas (`src/shared/types.ts`), algorithms, rendering/VFX implementations keyed by
capability ids (e.g. `MoveAnim`), and CSS. Adding a species/move/item/NPC/town/quest/string must require **only
JSON edits**. `tests/content.test.ts` runs `validateContent()`; keep it green. Format JSON with
`python3 tools/content_fmt.py <files>`.

## Commands

| | |
|---|---|
| `npm run dev` | server (8787, watch) + vite (5173, proxies `/ws` and `/api`) |
| `npm run build && npm start` | production: server serves `dist/` + ws on `PORT` (default 8787) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `node --test tests/**/*.test.ts` |

## Directory ownership

```
src/shared/types.ts, contracts.ts, protocol.ts, content/index.ts   CONTRACTS (do not change without integration owner)
content/*.json                                                  data owners per file (see workflow scopes)
src/shared/rng.ts, creature.ts, battle/                        battle-engine
src/shared/world/ + content/world/                              world (generator code + layout/story data)
src/client/core/                                               core (events, input, audio, save, clock, assets+placeholders, settings)
src/client/render/                                             renderer (HD2D renderer, WorldView, actors, battle stage, vfx)
src/client/ui/                                                 ui-kit (kit, hud, minimap, chat, styles) ; ui/screens/ → ui-screens
src/client/world/                                              overworld controller (player, npc, encounters, scripts)
src/client/battle/                                             battle client (scene, menus, catch, evolution)
src/client/net/  + src/server/                                 net
src/client/game.ts, main.ts                                    integration
tools/  public/assets/                                         assets pipeline
tests/                                                         per-module tests: tests/<module>.test.ts
```

## Core rules (gameplay)

- 13 types (`TYPE_IDS`), 6 rarities N/R/SR/SSR/UR/MYTHIC, 6 stats mapped to AI capabilities
  (上下文 hp / 推理 atk / 稳健 def / 创造 spa / 知识 spd / 速度 spe).
- Damage: standard Pokémon gen-5 formula; STAB 1.5; crit 1.5 (stage 0 = 1/24); random 0.85–1.0.
- Status: 过热 burn, 宕机 paralysis, 限流 sleep, 数据污染 poison, 死锁 freeze; volatile 幻觉 confusion etc.
- Catch formula: gen-3 style using species catchRate, hp ratio, ball multiplier, status bonus; rarity lowers catchRate.
- Exp: growth curves fast/medium/slow; exp shared to participants; evolution by level after battle.

## World

- Tile grid, 1 tile = 1 world unit (X east, Z = map y south). Elevation levels × `LEVEL_HEIGHT` (0.75).
- One big seamless overworld (`overworld`, ≤ 320×320) with 10 biomes/regions + interiors (centers, shops, houses,
  lab, 8 gyms, temple). Generated deterministically by `buildWorld(WORLD_SEED)` → identical on client & server.
- Towns are stamped templates; routes connect them; regions carry encounter tables derived from species habitats.

## HD-2D look

Low internal resolution (pixelScale) with nearest upscale, pixel-art textures (nearest, no mips), cylindrical
billboard sprites with real shadows, tilt-shift DOF focused on player, bloom on lights/emissives, vignette + warm
grade, fog, day/night lighting with point lights at night, weather particles, instanced swaying grass.

## Assets (all optional — every asset has a procedural fallback)

| kind | path | spec |
|---|---|---|
| creature | `/assets/creatures/<speciesId>.png` | RGBA 128×128, transparent, feet bottom-center |
| character sheet | `/assets/characters/<id>.png` | 256×256: 4 rows (down,left,right,up) × 4 frames, 64×64 cells |
| portrait | `/assets/portraits/<id>.png` | 256×256 RGBA bust |
| terrain texture | `/assets/textures/terrain/<key>.png` | 32×32 (or 64×64) pixel tile, wraps with mirrored repeat |
| model | `/assets/models/<model>.glb` | glTF binary, 1 unit = 1 tile, origin at footprint center on ground, facade +Z |
| item icon | `/assets/items/<itemId>.png` | 32×32 RGBA |
| bgm | `/assets/audio/bgm/<track>.mp3` | loopable |
| ui | `/assets/ui/<id>.png` | title.png (key art), logo.png |

`public/assets/manifest.json` lists present files (generated by `tools/build_manifest.py`).
