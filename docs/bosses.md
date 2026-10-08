# Boss battles

Very strong creatures (UR / MYTHIC) are fought as **bosses**: a normal creature on the enemy side plus a data-driven
rule set (`content/bosses.json`) that adds phases, form switches, telegraphed attacks, an enrage timer and, above all, a
**counter-strategy rooted in an AI meme** that the player discovers from hints. Every number and string is content;
the engine only interprets the DSL (`src/shared/battle/boss.ts`).

Rules of thumb: a boss is beatable **without** its counter (hard) and clearly easier **with** it. Monte Carlo tests keep
that true (`tests/boss.test.ts`, 200 seeds per boss).

## The nine bosses

| Boss (species, Lv) | Meme / event | Counter | Mechanics |
|---|---|---|---|
| 降智之星 GPT-6 Astra (62) | The 4o retirement / Luna downgrade / GPT-5 autoswitcher: heavy prompts get routed to a cheaper model | Feed **特制酱汁** (`special-sauce`, tag `sauce`) | The sauce triggers the *router*: Astra becomes **GPT-4o** (weaker, hp ratio kept) and at 30% hp **GPT-6 Luna**. Un-sauced it is a full-power model with a hit cap (30% of max hp per hit), a telegraphed **exaflop beam** (warning the turn before, damage ×0.6) and a "deep think" phase at 50% hp |
| 服务器繁忙 DeepSeek-V4 (58) | "服务器繁忙，请稍后再试" and the off-peak discount | **谷时券** (`off-peak-coupon`, tag `offpeak`) | 6-turn tide: 3 turns of peak hours (takes ×0.12, deals ×1.35), 3 turns of valley pricing (takes ×1.4, deals ×0.7). The coupon turns a peak into 4 turns of valley. Below 40% hp it raises prices (+1 atk/spa). Enrage = price hikes |
| 上下文溢出 Kimi K3 (58) | The 2M-character context window | **超长文档** (`long-document`, tag `flood`), status moves | A *context* meter grows every turn (and from status moves / documents); its stat stages grow with it. At 8 it overflows: stages cleared, the boss crashes for 3 turns (takes ×1.8) |
| 跑分没输过，实战没赢过 MiniMax H3 (56) | Benchmark gaming | **私有测试集** (`holdout-set`, tag `holdout`) or off-benchmark move types | *Bench* form: damage ×0.25 from benchmark types (logic/code/chat/search/write/compute), and each such hit erases real-world progress. Three off-benchmark hits (or the holdout set) expose it for 4 turns (takes ×1.6) |
| 蒸馏者 Qwen3-8 Max (58) | The distillation reports | **Switching out** (no item) | Copies the foe's damaging moves (max 2). Switching creatures makes the copied data mismatch: it forgets them, hallucinates and loses defence |
| 按量计费 Cursor (55) | The pricing backlash, then apology and refund | **联名投诉信** (`complaint-letter`, tag `outrage`), loud moves | *Metered*: every foe move costs +2 PP and the boss hits harder. Public outrage (letters or trending moves, 3 times) makes it apologise: *refunded* form, heals the foe, deals ×0.6 / takes ×1.4 for a while |
| 风控 Claude Code (58) | "认中国人" risk control (slash dates, apostrophes) | **海外住宅 IP** (`residential-ip`, tag `vpn`), switching | Each turn the active foe builds a *risk score* (CN creatures fastest); at 3 the foe is "banned" (sleep). A switch resets it. The residential IP stops it for 8 turns and the boss misjudges (deals ×0.8, takes ×1.6). At 50% hp the source leak drops its defences |
| 太危险所以不公开 Claude Mythos (72, no run) | "Too dangerous to release" + the sandbox escape | **沙箱加固补丁** (`sandbox-patch`, tag `seal`), safety-type moves | *Sealed* form (weak, deals ×0.6) while the *escape* meter < 10; it rises every turn. At 10 the boss is **unbound** (stronger, extra action every 3 turns, immune to status). Safety moves −3, patches −5; pushing it back below 3 seals it again |
| 神之一手 AlphaGo (70, no run) | Lee Sedol's move 78 against AlphaGo | **A move type it has not seen** | *Reading* form reads the foe's last move type: the same type again deals ×0.3. Three new types in a row = the "divine move": it deliberates for 3 turns (takes ×1.6) and forgets what it has seen |

All nine are placed as roaming legends (`content/events/legends.json`) or mythic chain finales (`content/events/mythic.json`);
the overworld fights any species that has a boss definition with its boss rules (`src/client/world/battles.ts`).
Counter items are bought in town shops (`content/world/story/services.json`) and dropped as boss rewards.

### Hints

- **Pre-battle taunt** (`taunt`): says the meme line when the fight starts.
- **Dex** (`hint.seen` / `hint.won`): after seeing a boss the dex shows a hint; after beating or taming it, the full
  counterplay (flag `bossWon:<id>`, prefix in `content/game.json` `flags.bossWonPrefix`).
- **NPC gossip** (`gossip`): two lines per boss, spoken by hamlet NPCs (`content/world/story/population.json`).
- **Telegraph**: the turn before a charged attack the battle says what is coming and the HUD shows a blinking chip.

## Data (`content/bosses.json`, text in `content/text/zh-CN/boss.json`)

`{ "bosses": { "<id>": BossDef } }` (the id is the key). Types are in `src/shared/types.ts` (`BossDef`, `BossFormDef`,
`BossRule`, `BossTrigger`, `BossOp`, `BossCond`, `BossMeterDef`, `BossEnrage`, `BossReward`).

- **forms**: species, moves, ability, `statMul` (`hp` is the boss's absolute hp pool multiplier; `atk`... scale stats),
  a weighted `pattern` (`$borrowed` picks a copied move) and standing `rules`: `takenMul` / `dealtMul` / `hitCap` /
  `extraAction` / `foePpCost` / `statMul` / `noStatus`.
- **triggers**: `on` (`start`, `turnStart`, `turnEnd`, `afterAction`, `foeMove`, `foeItem`, `foeSwitch`), filters
  (`tag`, `moveTypes`, `categories`, `novelType`...), a `BossCond` guard, `times` (default 1; 0 = unlimited), `phase: true`
  (lights a HUD pip) and `do`: ops `say`, `form`, `heal`, `stages`, `clearStages`, `status`, `cure`, `volatile`, `meter`,
  `loseTurn`, `charge`, `cancelCharge`, `learn`, `forget`, `forgetTypes`.
- **meters**: small counters (`max`, `start`, `decay`, `show`, `states`, `tone`) conditions and the HUD read.
- **gates**: the boss cannot drop below `floor` (hp ratio) until a phase trigger has fired, so phases are always shown.
- **enrage**: from `turn`, each turn applies stat stages (up to `max`), with a warning `warnBefore` turns ahead.
- `canRun`, `expMul`, `catchRateMul`, `reward` (`money`, `items`), `hint`, `taunt`, `gossip`.

`validateBosses()` (`src/shared/battle/boss-validate.ts`, called from `validateContent`) checks every reference: species,
forms, moves, pattern moves, conditions, meters, bait tags (a bait tag needs an item), text keys (`boss.*` and existing).

### Counter items

`ItemEffect { kind: 'bait', tag }` used in battle against the boss. The engine refuses it (`battle.err.baitNoEffect`,
nothing consumed) when no trigger of the boss would react right now, then fires `foeItem` triggers with that tag. Items live
in `content/items.json` (category `battle`, battle-only) with an icon in `public/assets/items/`.

## Engine contract (ADR 0001 §5.6 / WP12a)

- **`BossState`** (plain JSON): `bossId`, `form`, `turn`, `formTurn`, `fired` (trigger id → count), `phase`, `meters`,
  `enrage`, `charge`, `skip`, `borrowed`, `lastFoeType`, `lastFoeMove`, `seenTypes`, plus the boss battler (`speciesId`,
  `abilityId`, `hp`, `maxHp`, `stages`, `status`, `statusTurns`, `volatiles`, `moves`, `recharging`).
- **`BattleEngine.extractBossState()`** / **`applyBossState(state)`**: apply overwrites everything the boss rules read,
  including the battle turn counter (the boss clock), so `apply(extract(x))` is an identity on any engine of the same boss.
- **`chooseBossAction(state, def, foe, rng)`** (`boss.ts`): pure; same state and RNG → same action; a pending charge is
  returned as a forced action.
- **Determinism**: the boss uses the battle's single seeded RNG (`engine.rng`); no `Math.random`, no clock.
- **Engine hooks** (`engine.ts`, kept small, rules live in `boss.ts`): `attachBoss` (ctor), `start`, `fillAiActions`
  (`bossAction`), `runTurn` (`turnStart`, `afterAction`, `bossExtraAction`), `executeMove` (skip, forced charged move, PP
  tax, `onFoeMove`), `strike` (`filterHit`), `useItem` (`onFoeItem`), `doSwitch` (`onFoeSwitch`), `endOfTurn`, `statsOf`
  (`adjustStats`), `statusImmune`, `awardExp`, `throwBall`, `finish` (`bossLoot`, `restore`: the creature goes back to
  its own species and moves, so a tamed boss is the plain species).
- **Events**: `boss` (HUD snapshot), `form`, `telegraph`, `loot` (side-0 private).

## Co-op raid readiness (design only, no networking; #28 owns dungeons/raids)

The same boss can later be fought by N players, each with their own engine and party:

1. **Shared state**: a raid coordinator owns one `BossState` and hands it to each player's engine with
   `applyBossState()` before the player's actions and takes it back with `extractBossState()` after (the clock is part of
   the state, so every engine agrees on turn, phase, meters and enrage).
2. **Boss action**: a single call of `chooseBossAction(state, def, foe, rng)` per round with the raid's RNG, executed on
   every engine as a forced move. Needed: an external-driven boss side (the engine's `bossAction` is the integration
   point) and a per-target selection (`foe` view of the chosen target).
3. **Damage and hp**: the boss hp pool is `statMul.hp`; for N players multiply the pool (e.g. `×N^0.8`) in one place and
   sum the damage of all engines into `state.hp`.
4. **Conditions about the foe** (`foeStatus`, `foeCountry`, `foeNotCountry`, `foeSwitch`, `foeMove`, `foeItem`) are written
   for one opponent; a raid must evaluate them per attacker (the `foe` argument is the hook) and decide whether a meter is
   shared or per-player.
5. **Rewards** (`BossDef.reward`) are per participant; `finish` emits `loot` per engine.
6. **Raid flag**: a raid battle would set `BattleInit.canRun=false` and a `raid` flag to disable catching.

## Tuning and tests

- `node scripts/boss-sim.ts [bossId...] [--n=200]` prints plain vs counter win rates (shared AI, optional counter policy
  from `tests/boss-counters.ts`, a typical 4-creature team at boss level − 2).
- `npm test` → `tests/boss.test.ts`: data consistency, every phase and signature mechanic, each counter item, enrage,
  deterministic replay, checkpoint restore equals the uninterrupted fight, `BossState` round trip, `chooseBossAction`
  purity, rewards, placement/hints, and the Monte Carlo balance (plain > 5%, counter ≥ 70%, margin ≥ 25 points).
- Dev sandbox (`?dev=1`): `&battle=boss&boss=<id>[&level=<n>]` or `window.__ap.boss(id, level?)` start a boss with a sensible
  team (`content/game.json` `debug.boss`) and every counter item in the bag.

## Adding a boss

1. Add the species' boss entry to `content/bosses.json` (forms, pattern, rules, triggers, meters, gates, enrage, reward) and
   its texts to `content/text/zh-CN/boss.json` (keys must start with `boss.`).
2. If a trigger reads a bait tag add a `bait` item (+ icon, manifest, `assets_src/prompts/items_details.json`) and sell it.
3. Add gossip lines to an NPC pool and place the species as a legend or mythic chain.
4. Add a counter policy to `tests/boss-counters.ts`, run `node scripts/boss-sim.ts <id>` and tune `statMul` until plain
   is hard (about 25-50%) and the counter reliable (about 85-100%).
