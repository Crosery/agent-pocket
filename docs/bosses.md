# Boss battles

Very strong creatures (UR / MYTHIC) are fought as **bosses**: a normal creature on the enemy side plus a data-driven
rule set (`content/bosses.json`) that adds phases, form switches, telegraphed attacks, an enrage timer and, above all, a
**counter-strategy rooted in an AI meme** that the player discovers from hints. Every number and string is content;
the engine only interprets the DSL (`src/shared/battle/boss.ts`).

Rules of thumb: a boss is beatable **without** its counter (hard) and clearly easier **with** it. Monte Carlo tests keep
that true (`tests/boss.test.ts`, 200 seeds per boss).

## The eighteen bosses

| Boss (species, Lv) | Meme / event | Counter | Mechanics |
|---|---|---|---|
| 鹈鹕仙人 GPT-6 Astra (62) | The linux.do way to tell whether a model got 酱汁'd: "画一只鹈鹕骑自行车" (据说 the pelican is now in the samples), and the launch-day "仿佛核弹爆炸" that turned out to be a 窜天猴 | **鹈鹕骑车测试** (`pelican-test`, tag `pelican`) and **自行车骑鹈鹕** (`bike-pelican`, tag `bike`) | Three turns in every five it is secretly sauced (hidden `juice` meter, deals ×0.7; a "回得快得可疑" line is the tell). Testing a sauced Astra exposes it for 5 turns (deals ×0.15, takes ×4.5); testing a full-juice one is wasted. Below 70% hp the *library* phase puts the pelican into its samples: the pelican test is then fooled ("鹈鹕：好像满血？") and only the bike test works. Below 50% a deep-think boost, plus a telegraphed 核弹 (beam, ×0.6) |
| 繁忙战神 DeepSeek-V4 (58) | "服务器繁忙，请稍后再试" and the off-peak discount; the community's 蓝色大肥鱼 who slacks off at peak hours | **谷价半价券** (`off-peak-coupon`, tag `offpeak`) | 6-turn tide: 3 turns of peak hours (takes ×0.12, deals ×1.35), 3 turns of valley pricing (takes ×2.5, deals ×0.4). The coupon turns a peak into 4 turns of valley. Below 40% hp it raises prices (+1 atk/spa). Enrage = price hikes |
| 蹬完了仙人 Kimi K3 (58) | 额度蹬完了 / 429: the quota that burns in a day ("早买早享受，晚买没额度"), shown in game as the 2M-character window filling up | **两百万字小作文** (`long-document`, tag `flood`), status moves | A *context* meter grows every turn (and from status moves / documents); its stat stages grow with it. At 8 it overflows: stages cleared, the boss crashes for 3 turns (takes ×2.2) |
| 拉夯之间 MiniMax H3 (56) | 拉还是夯: benchmark gaming ("进步了，但雷霆大思考", 据说) | **私有题库** (`holdout-set`, tag `holdout`) or off-benchmark move types | *Bench* form: damage ×0.25 from benchmark types (logic/code/chat/search/write/compute), and each such hit erases real-world progress. Three off-benchmark hits (or the holdout set) expose it for 4 turns (takes ×2.2, deals ×0.6) |
| 蒸馏战神 Qwen3-8 Max (58) | 蒸馏论: "追上了=蒸馏，没追上=被藏起来了" (据说, an accusation, not proof) | **Switching out** (no item) | Copies the foe's damaging moves (max 2). A voluntary switch (not the replacement after a faint) makes the copied data mismatch: it forgets them, hallucinates, stands dazed for 2 turns and loses defence and special defence (-2) |
| 冤种年费 Cursor (55) | 冤种年费: the pricing backlash, then apology and refund; the 忘了署名 Composer 2 / Kimi base-model episode appears only as flavour | **联名投诉小作文** (`complaint-letter`, tag `outrage`), loud moves | *Metered*: every foe move costs +2 PP and the boss hits harder. Public outrage (letters or trending moves, 3 times) makes it apologise: *refunded* form, heals the foe, deals ×0.5 / takes ×1.8 for a while |
| 源码裸奔王 Claude Code (58) | The 512,000-line source leak (a stray `.map` in the package), the `/buddy` pets and Undercover Mode | **.map 源码映射** (`source-map`, tag `sourcemap`) | Every second turn a BUDDY pet appears and eats exactly one of your attacks (the hit deals ×0.08, then the pet is gone): half of your attacks are wasted. The map unmasks it: cover dropped, pets gone, deals ×0.8 and takes ×2 for 5 turns. Below 50% hp its own leak exposes it for good (def/spd -1, takes ×2) |
| 太危险仙人 Claude Mythos (72, no run) | "太危险了不敢公开" + the Discord group that guessed a URL and used it for two weeks (sandbox escape as the mechanic) | **沙箱补丁** (`sandbox-patch`, tag `seal`), safety-type moves | *Sealed* form (deals ×0.35, takes ×2) while the *escape* meter < 10; it rises every turn. At 10 the boss is **unbound** (atk/spa ×1.6, extra action every 2 turns, immune to status). Safety moves −3, patches −5; pushing it back below 3 seals it again |
| 78挖 AlphaGo (70, no run) | 神之一手 / 78 挖: move 78 that sent AlphaGo into a run of bad moves (no player name in game) | **Change the move type every turn** | *Reading* form reads the foe's last move type: the same type again deals ×0.3 and wipes the *surprise* meter. Three type changes in a row = the "divine move": it deliberates for 3 turns (takes ×1.6, deals ×0.6) |
| 封号斗罗 Claude Opus (66) | "Claude 暂不支持您所在的地区" and the mass bans of Chinese accounts | **海外住宅 IP** (`residential-ip`, tag `vpn`) | A *risk* meter flags the active creature every turn: CN creatures +2, others +1 every second turn (a mistaken flag); at 3 the account is *banned* (freeze, which code-type creatures resist). Switching clears the risk. The IP hides the origin for about 8 turns: risk stays at 0, a banned account is appealed and unfrozen, and Opus is fooled (deals ×0.75, takes ×2) |
| 酱汁战神 ChatGPT (62) | 酱汁 (≈ 降智), the juice number and being routed to a mini model behind the "flagship" label | **秘制酱汁** (`special-sauce`, tag `sauce`) | The sauce triggers the *router*: ChatGPT becomes **GPT-4o** (weaker, hp ratio kept, juice 64) and at 30% hp **GPT-6 Luna** (juice 16). Un-sauced it is a full-power model (juice 256) with a hit cap (30% of max hp per hit), a telegraphed **beam** (warning the turn before, damage ×0.6) and a "deep think" phase at 50% hp |
| 剧情需要 Unitree GD01 (60) | 剧情需要: the gala robot that fell over, and the 3.9 million yuan mech nobody bought | **香蕉皮** (`banana-peel`, tag `peel`) | Upright it is a plain heavy hitter. A peel drops it (*fallen*): it loses 3 actions, takes ×3 and deals ×0.2, then stands up after 4 turns; the peel works again |
| 偷仓库战神 Grok 4.7 (64) | Grok Build CLI uploading whole repositories, git history and `.env` included (据说, linux.do) | **网线** (`ethernet-cable`, tag `unplug`), or any creature that knows *Blackout* | Every physical or special move the foe uses is uploaded: Grok copies it (max 3 borrowed moves) and gains +1 atk/spa (3 times). A blackout (the cable or the move) cuts it off for the weather's length: it forgets what it copied, loses its boosts, deals ×0.5 and takes ×2.5; while offline it cannot upload |
| 裸奔的龙虾 OpenClaw (60) | Exposed instances, malicious skills, prompt injection and the Moltbook leak of 1.5M API tokens (据说) | **吊销密钥** (`revoke-key`, tag `revoke`), used in the right window | Every 4 turns it loads a malicious skill (warning, *inject* meter) and the injection lands at the end of the next turn: the foe is poisoned (data pollution, safety types resist) and confused. A key revoked inside that window reflects the skill: the boss falls into the *compromised* form (deals ×0.5, takes ×2.2, loses 2 actions, back to normal after 4 turns). Revoking too early or too late does nothing but clean the foe |
| 吃石头仙人 Gemini Argon (68) | 哈基米 = Gemini; its AI Overview era: glue on the pizza, "eat a small rock a day" | **小石子** (`small-rock`, tag `rock`) | Feeding a rock makes it follow its own advice (*overview* form: deals ×0.6, takes ×1.8, poisoned and confused, loses an action) for 6 turns, then it digests; rocks can be chained |
| 领个寂寞 Doubao (58) | 领个寂寞: the spring-festival red-packet rain where most people drew 1.66 | **邀请码** (`invite-code`, tag `referral`) | It pays the *player*: each code gives the active creature +1 atk/spa, 25% hp and a cure (up to 4); with four packets out its subsidy is gone (*broke*: deals ×0.6, takes ×1.5) |
| 毒鸡蛋发放员 GLM-5.3 (62) | ZCode quietly uploading whole workspaces (git history included), then the "致歉小鸡蛋" (1 亿 token, 一个手机号领两次); the community calls the freebies 毒鸡蛋 | **不上云承诺书** (`no-upload-pledge`, tag `pledge`), or switching out | *Queue* form for 2 turns ("当前购买人数较多": takes ×0.25). Then every 3rd turn a free egg: the foe heals 10%, the boss gains +1 atk/spa and its *backup* meter +1. At 3 backups it telegraphs a restore (force-push ×2). The pledge stops the eggs for 8 turns, wipes the backups and embarrasses it (deals ×0.7, takes ×1.5); a voluntary switch clears the backups too. At 50% hp a "修复信任" popup: it loses a turn, gives one more egg, and eggs then come every 2 turns |
| 屋顶打斗 Seedance 2.5 (62) | 屋顶打斗: the two-line prompt that scared Hollywood, plus the "违规，哪个词违规？你猜" review lottery | **Hit the cameo's two weak types** (shown in the HUD) | Five cameos in a 15-turn cycle (3 turns each). Each takes ×6 from its two weak types and ×0.05 from everything else; the *cameo* meter states which cameo and which types |

All eighteen are placed as roaming legends (`content/events/legends.json`) or mythic chain finales (`content/events/mythic.json`);
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
  `extraAction` / `foePpCost` / `statMul` / `noStatus`. `takenMul` entries filter by `moveTypes`, `notMoveTypes`, `categories`, `moves`,
  `sameTypeAsLast` and `effectiveness` (`super` / `neutral` / `resisted` against the boss's current species).
- **triggers**: `on` (`start`, `turnStart`, `turnEnd`, `afterAction`, `foeMove`, `foeItem`, `foeMedicine`, `foeSwitch`), filters
  (`tag`, `moveTypes`, `categories`, `novelType`, `typeShift`, `voluntary`...), a `BossCond` guard, `times` (default 1; 0 = unlimited), `phase: true`
  (lights a HUD pip) and `do`: ops `say`, `form`, `heal`, `stages`, `clearStages`, `status`, `cure`, `volatile`, `meter`,
  `loseTurn`, `charge`, `cancelCharge`, `learn`, `forget`, `forgetTypes`.
- **conditions** (`BossCond`): form, phase, hp, turn, `formTurnAtLeast`, `turnCycle`, meters, `hasBorrowed` and, about the foe's
  active creature, `foeStatus`, `foeCountry` / `foeNotCountry`, `foeReleasedBefore` / `foeReleasedFrom` (release date, `YYYY-MM[-DD]`) and the field `weather` / `notWeather`.
  Ops include `weather` (sets the field weather, e.g. `blackout`), so a boss can react to the player's weather moves too.
  `foeMedicine` fires when the player heals, cures, refills PP or revives with an item (not for bait items).
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

Numbers are balanced with the toolkit in `tools/balance` (docs/balance.md): the player side is a **level-appropriate archetype
team** (`sensibleParty` in `tests/boss-sim.ts`: six SR/SSR creatures per archetype, level = boss level - 2, the seed picks one
of the 7 archetypes and a variant) piloted by `tools/balance/pilot.ts`, with a bag for the counter items only. The pilot itself never uses items, so a boss that
reacts to an everyday habit such as healing would get a `PLAIN` policy in `tests/boss-counters.ts` for the baseline runs (none does
right now); a counter may also bring a hand-picked team (`partyIds`), kitted like an archetype role through `partyRole`.

- `node scripts/boss-sim.ts [bossId...] [--n=200]` prints win rates and the mean length of won fights without and with the
  counter strategy (`tests/boss-counters.ts`).
- `npm test` -> `tests/boss.test.ts`: data consistency, every phase and signature mechanic, each counter item, enrage,
  deterministic replay, checkpoint restore equals the uninterrupted fight, `BossState` round trip, `chooseBossAction`
  purity, rewards, placement/hints, and the Monte Carlo balance (plain > 5% and < 75%, counter >= 70%, margin >= 25 points,
  at least 4 of the 7 archetypes win plain >= 10%, at least 5 win >= 70% with the counter).
- `BOSS_TABLE=1 node --test tests/boss.test.ts` prints the win rates per boss and per archetype (hyper-offense, wall-stall,
  setup-sweep, status-control, weather-rush, balanced, glass-cannon).
- Dev sandbox (`?dev=1`): `&battle=boss&boss=<id>[&level=<n>]` or `window.__ap.boss(id, level?)` start a boss with a sensible
  team (`content/game.json` `debug.boss`) and every counter item in the bag.

## Adding a boss

1. Add the species' boss entry to `content/bosses.json` (forms, pattern, rules, triggers, meters, gates, enrage, reward) and
   its texts to `content/text/zh-CN/boss.json` (keys must start with `boss.`).
2. If a trigger reads a bait tag add a `bait` item (+ icon, manifest, `assets_src/prompts/items_details.json`) and sell it.
3. Add gossip lines to an NPC pool and place the species as a legend or mythic chain.
4. Add a counter policy to `tests/boss-counters.ts`, run `node scripts/boss-sim.ts <id>` and tune `statMul` until plain
   is hard (about 30-50%) and the counter reliable (about 85-100%).
