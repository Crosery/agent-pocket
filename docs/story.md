# Story & population layer

`applyStory(world)` (src/shared/world/story.ts) runs at the end of `buildWorld()` and fills the generated world
with NPCs, trainers and quests from `content/world/story/**`. The code holds **no story data**: every line,
name, level, reward, shop list and flag is JSON. Code only knows anchor names (resolved through
`worldAnchors(world)`), the `ScriptStep` contract, a handful of authoring macros, and placement rules.

Two layers share one placement path:

1. **Authored story** (towns, gyms, routes, main/side quests, rival, endgame) — fixed anchors, `npcs/*`, `trainers/*`.
2. **Procedural population** of the core continent's hamlets, landmarks (POIs), dungeons and `wild:*` spots —
   legend chains, bounty quests and template rules (src/shared/world/story-procgen.ts + `population.json`,
   `legends.json`, `bounties.json`). Claim precedence: authored → legend chains → bounties → population rules in
   file order; one anchor never gets two NPCs, and every spot passes the same occupancy / spacing / seal checks.

Measured (Node 26, M-series, buildWorld incl. story):

| seed | buildWorld | applyStory | NPCs | trainers | quests | wild trainers | hermits | nest guardians | bounties | legend tablets |
|---|---|---|---|---|---|---|---|---|---|---|
| default (20261002) | 1.67 s | 67 ms | 726 | 363 | 35 (14 authored + 18 bounties + 3 legends) | 178 | 10 | 8 | 18 (6 deliver, 4 visit, 3 defeat, 2 catch, 3 fetch) | gpu 5, attention 4, dream 4 |
| 12345 | 1.68 s | 60 ms | 734 | 359 | 34 | 165 | 20 | 8 | 17 | 4, 3, 3 |

0 problems on both. Only the core continent is populated; the infinite frontier chunks are out of scope here.

## Public API

| export | from | purpose |
|---|---|---|
| `applyStory(world, sc = STORY_CONTENT)` | story.ts | place NPCs, resolve trainers / picks / scripts into the World (idempotent per World object) |
| `storyProblems(world)` | story.ts | problems found while applying (unknown anchors, blocked tiles, bad references, unresolved text). Must be empty for shipped content |
| `STORY_CONTENT` | story.ts | parsed story JSON (`meta`, `scripts`, `services`, `rival`, `quests`, `npcGroups`, `trainerGroups`) |
| `starterSpecies(c?)`, `rivalStarterFor(starterId, c?)`, `rivalTrainerId(battle, starterId)` | story.ts | starter list, the rival's counter-pick, rival TrainerDef id |
| `walkSteps(steps, fn)` | story.ts | depth-first visit of a script (then / else / choice branches) |
| `storyFeatures(world)` | story.ts | what procgen placed on this World: `{ legends: PlacedLegend[] ({id, tablets[], final} anchor names), bounties: PlacedBounty[] ({quest, kind, giver, target?}) }` |
| `SpotIndex`, `HintIndex`, `placeLegends`, `placeBounties`, file/arch types | story-procgen.ts | spot facts (region, biome, level band, danger, on-foot reachability, overworld position of interior spots), compass/distance hints, the two procgen placers (driven through the `PopHost` interface StoryBuilder implements) |
| `StoryPick` | pick.ts | `SpeciesPick` + `habitats?: string[]` (story-only preference for species living in a biome) |
| `resolvePick(pick, level, seedKey, c?)` | pick.ts | deterministic species id for a `SpeciesPick` |
| `resolvePickAvoiding(pick, level, seedKey, avoid, c?)`, `levelForm(species, level, c?)`, `minLevelOf(species, c?)` | pick.ts | variety-aware resolver and evolution-stage helpers |

The client never needs pick logic: `World.trainers[*].party[*].species` and every `giveCreature` / `wildBattle`
step carry resolved species ids.

## Species picks (`pick.ts`)

1. Filter `CONTENT.speciesList` by `types` (any match), `rarities`, `stages`, `families`, `countries`, `habitats`
   (any match; story picks only), and starters
   (`excludeStarters`, default from `story.json` `pick.defaultExcludeStarters`; it excludes whole starter families).
   Without `rarities`, `pick.defaultExcludeRarities` (UR, MYTHIC) are never chosen.
2. Nothing matches → relax constraints in `pick.relaxOrder` (`habitats` first); `rarities` first widens to neighbouring rarity orders
   (e.g. a missing MYTHIC falls back to UR), then drops.
3. Without `stages`, every match is moved to its level-appropriate stage (devolve while too young, evolve while the
   level allows); forms that lost the requested type are dropped when others remain. If every form lost the type and
   the pick had `habitats`, the habitat preference is dropped instead (an on-type species from elsewhere beats an
   off-type local one). With `stages` set, species are used as-is (legend chains use `stages: [1,2,3]` to keep UR forms).
   A pick with `earlyCaps: true` (story only) also obeys `world.json encounters.rarityLevelCaps` for the member's level
   (rarity order and type list, the caps wild tables follow); the cap is never relaxed, the theme (`types`) gives way.
   `tests/opening_balance.test.ts` simulates every species the first cap allows, so the first route's random members
   (`r1-*`) stay fair whatever species are added.
4. Choose by `hashString(seedKey | salt) % n` over the dex-sorted forms. Trainer parties use
   `seed:trainerId:index` and avoid repeating a species inside one party (first widening `rarities` by
   `pick.avoidRarityWiden` orders, then repeating); script steps use `seed:script:<pick JSON>`,
   so identical picks meet the same species everywhere (the legend), and `salt` separates otherwise-identical picks.

## Content files (`content/world/story/`)

| file | shape |
|---|---|
| `story.json` | `pick` rules (`relaxOrder`, `defaultExcludeRarities`, `defaultExcludeStarters`, `avoidRarityWiden`), `flags` (`starter`, `trainerWon` prefix, `groundItem` prefix), `facing.lookDistance`, `text` (`listSeparator`, `trainerNpcName` = "{class} {name}"), `trainers` defaults (`aiLevel`, `rewardPerLevel`, `sightRange`), `trainerNpc` (role + default trainer script with `{id}` `{after}` `{name}`) |
| `scripts.json` | reusable scripts `{ id: Step[] }` (nurse, box, clerk, gym-guide, gym-leader, reward-<gym>, main-progress, rival-lab-battle, legend-call, …) |
| `services.json` | `npcs[]` instantiated for **every** town (`{town}` = id, `{townName}` = name): nurse on `<town>-center:nurse`, box attendant on `<town>-center:pc-front`, clerk on `<town>-shop:clerk`; `shop.tiers[{atLeast, items}]` (cumulative by badge count) + `shop.extra{town: items}` |
| `rival.json` | rival template: `idPattern` ("rival-{battle}-{starter}"), name/sprite/portrait, `defaults`, `battles[{key, party, introText, defeatText, aiLevel, reward?}]`; a party entry `{rivalStarter: true, level}` is the rival's starter at its level stage |
| `quests.json` | `QuestDef` with `stages[].target` written as an **anchor name** (resolved to `{map,x,y}`) |
| `npcs/towns.json`, `npcs/story.json`, `npcs/quests.json` | `{ group: NpcSpec[] }` |
| `population.json` | `spacing`, `sealRadius`, `pocketMax`, `rarityBands[{maxLevel, rarities}]`, `dangerReward[]` (reward multiplier per `RegionDef.danger`), `hints` (see below), `rules[]` (`PopulationRule`), `npcPools{pool: NpcArchetype[]}`, `trainerPools{pool: TrainerArchetype[]}` |
| `legends.json` | `spacing [min,max]` tiles between tablets, `idPatterns`, `quest` stage texts, `scripts{first,next,final}` templates, `chains[]` |
| `bounties.json` | `count [min,max]`, `idPatterns`, `givers[]` (anchor regexes, in priority order), `distance [min,max]`, `levelSlack`, `reward{moneyPerLevel, round, items[{maxLevel, pool}]}`, `kinds{}` |
| `trainers/routes.json`, `trainers/gyms.json`, `trainers/story.json` | `{ group: { defaults?, trainers: TrainerSpec[] } }` |

`NpcSpec`: `id at offset? facing? sprite nameZh role portrait? lines? script? trainer? sightRange? wander?
hiddenUnlessFlag? hiddenIfFlag?`. `lines` is shorthand for one `say` per line. `facing` defaults to `auto`: the
direction with the longest clear line of sight (up to `sightRange` or `facing.lookDistance`), preferring directions
that hit a route-path terrain (`routes.json` `terrain`) — so route trainers look at the road.

`TrainerSpec` = `TrainerDef` fields (+ `party[]` of `{pick | species | rivalStarter, level, moves?}`, optional
`reward`, `after` line) + optional placement (`at offset facing role portrait sightRange wander lines script
hidden*`). With `at`, an NPC with the same id is generated; its script defaults to `trainerNpc.script`
(after-line once `trainer:<id>` is set, otherwise `battle`). `reward` defaults to `rewardPerLevel × ace level`.
`sightRange: 0` means talk-to-battle only.

Group order is irrelevant; ids must be unique across all files (duplicates are reported).

### Authoring macros (expanded at apply time, never reach the client)

| macro | expands to |
|---|---|
| `{op:'include', script, params?}` | the steps of `scripts.json[script]` with extra `{param}`s |
| `{op:'rivalBattle', battle}` | `ifFlag(starter === s) → battle rival-<battle>-<s>` chained over every starter |
| `{op:'badgeTiers', tiers:[{atLeast, then}]}` | nested `ifBadges`, highest tier first (`atLeast: 0` = final else) |
| `{op:'tieredShop', town}` | `badgeTiers` of `shop` ops from `services.shop` (cumulative tiers + town extras) |
| `{op:'warpTo', anchor, facing}` | `warp` to the anchor's coordinates |

### Text

Every string accepts `{param}` (template / include params, NPC params `{id}` `{after}` `{name}`) and lookups
`{fn:arg}` resolved from the content tables, so text never drifts from the data:
`{type:code}` `{weakTo:code}` `{resists:code}` `{strongVs:code}` (from the type chart, joined with
`text.listSeparator`), `{item:<id>}`, `{badge:<id>}`, `{town:<id>}`, `{trainer:<id>}`. Params resolve first, so
`{town:{town}}` works inside templates. `say` steps without `speaker` get the NPC's name (and portrait);
`speaker: ""` marks narration.

## Procedural population (core continent)

### Spots and claims

`SpotIndex` resolves each anchor to `{map, x, y, region, biome, levelRange, danger, ow, onFoot, siteId, siteName}`;
interior spots (houses, dungeon floors) inherit the overworld position of their entrance (BFS over warps) so hints
and distances work everywhere. `onFoot` = reachable without surfing (`worldBuildInfo().walkReach`). A spot is
claimable when no NPC stands within `spacing`, the tile is walkable and not a warp/arrival, and placing a
permanent NPC would not seal a warp, a town or a pocket larger than `pocketMax` (`sealRadius` flood fill).

### Rules (`population.json` `rules`, applied in order; first match claims the spot)

| rule | anchors | what |
|---|---|---|
| hamlet-services | `hamlet:<h>:center-door` | nurse / box / clerk for hamlets that have a centre |
| hamlet-guide | `hamlet:<h>:npc-1..2` | villagers who name a real nearby nest / dungeon / landmark / hamlet / town with compass direction and distance |
| hamlet-villager | `hamlet:<h>:npc-3+` | AI trivia (accurate history), humour, local flavour |
| resident | `<hamlet>-houseN:resident-1` | house residents |
| camp-trainer, nest-guardian | trainer camps, nests | trainers; nest guardians are talk-only, stronger (`rarityShift`) and give a one-time `gift` item after a win |
| camper, scholar, engineer, sailor, naturalist | landmark spots by POI kind | biome-filtered archetypes, `{siteName}` lore |
| dungeon-guardian, dungeon-delver | `dungeon:<d>:floorN:boss` / spots | talk-only boss with one-time reward; delvers |
| hermit | `wild:<region>:N` (share 0.06) | move tutors; `paramSets` choose 3 chips + prices by the region's level |
| wild-wanderer | `wild:*` (share 0.07) | hint-giving wanderers |
| wild-trainer | `wild:*` (share 0.85) | line-of-sight trainers; `habitat: true` parties, reward `rewardPerLevel × ace × dangerReward[danger]` |

Rule options: `share`, `pool`, `idPattern` (`{rule}` `{slug}` + regex groups), `skipIfMapHasNpc`, `role`, `facing`,
`wander`, `sightRange`, `party`, `levelBonus`, `rarityShift`, `habitat`, `minLevel`/`maxLevel` (region band filter),
`aiLevel`, `rewardPerLevel`, `music`, `params` (one value per spot), `paramSets`, `script`.
Parties: levels inside the region band (+`levelBonus`), ace at the top; types cycle through the archetype's types;
rarities from `rarityBands` for the level (+`rarityShift`).

### Hints

`hints.targets` maps a key to place sets (`pois` kinds, `landmarks`, `dungeons`, `hamlets`, `towns`, `legends`).
Every NPC text gets `{<key>Name}` `{<key>Dir}` `{<key>Dist}` `{<key>Lv}` `{<key>Rare}` for the nearest such place
(own site and anything closer than `minDistance` skipped), plus `{rareHere}`. Directions: 8 compass sectors
(`directions`, N first, 22.5° borders); distances: first `distances[].max` ≥ the tile distance. A missing target
yields `unknown` (tests assert it never appears on the default seed).

### Legend chains (`legends.json`)

Each chain walks landmark POIs matching `sites`, hop by hop inside `spacing`, `steps` tablets long, leading
outward from the spawn; the final site (regex `final`) is the farthest hop. Tablet k: keeper NPC `{chain}-t{k}`
reads `lore[k]`, needs flag `{chain}:t{k-1}`, sets `{chain}:t{k}` and moves quest `{chain}` to stage k, pointing to
the next site by direction/distance. The seer `{chain}-seer` appears at the final site (`hiddenUnlessFlag` = last
tablet flag) and runs the `encounter` steps once (`{chain}:done`): a `wildBattle` with a UR pick at the final
region's top level + `levelBonus`, music `battle_legend`. Chains: `lg-gpu` (compute), `lg-attention` (logic),
`lg-dream` (vision/motion). Hamlet guides and wanderers can name the first tablet site (`legend` hint target).

### Bounties (`bounties.json`)

`count` quests `bq-1…`, kinds cycled by `weight`: **deliver** (parcel item to a partner), **visit** (talk to a
partner), **defeat** (talk-only trainer target, giver checks `trainer:<id>`), **catch** (`ifCaught type atLeast`),
**fetch** (buyable item, `ifItem`/`takeItem`). One bounty per giver site; givers are hamlet NPC spots, then camp /
lighthouse / dock / windmill / oasis spots. Targets: overworld, on foot, `distance` band from the giver, region
level ≤ giver band top + `levelSlack`, another site. Reward: `round(moneyPerLevel × level mid × rewardMul)` to the
nearest `round`, plus an item from the level band pool, granted by the quest `done` step.

## Conventions the client relies on

| topic | convention |
|---|---|
| flags | `trainer:<trainerId>` set by the client on a win; `starter` = chosen species id (set by `chooseStarter`); `item:<groundItemId>` for picked items; `badge:<type>` set by the leader scripts (save.badges is filled from `TrainerDef.badge`) |
| `hiddenIfFlag` / `hiddenUnlessFlag` | hidden while the flag is truthy / until it is truthy; re-evaluated on map load and `refresh()` |
| `hideNpc` | always paired with a `setFlag` that the NPC's `hiddenIfFlag` watches, so hiding persists across saves |
| `battle` | shows `introText` before and `defeatText` after; on a win sets `trainer:<id>`, pays `reward`, adds `badge`. Post-battle steps are guarded by `ifFlag trainer:<id>`, so scripts behave whether a loss aborts the script or not |
| `quest {done: true}` | marks the quest finished; the client grants `QuestDef.reward` |
| `takeMoney {failText}` | not enough money → show `failText` and stop the script (tutors rely on it) |
| `ifCaught {atLeast}` | number of caught species (optionally of `type` / a `species`) |
| `ifBadges` | `save.badges.length` |
| trainers | `trainer` + `sightRange` = line-of-sight trainer facing `facing`; `sightRange` absent = talk only |
| roles | `boxTerminal` is an attendant beside the centre PC (normal sprite); nurse/clerk stand behind counters facing down |

## Chapter outline (main quest `main`)

| stage | goal | set by |
|---|---|---|
| 0 | 妈妈说图灵博士在找你 → 研究所 | 妈妈 (`intro:mom`) |
| 1 | 选初始智灵（`chooseStarter`），领取 AI 图鉴、城镇地图、5 个提示词球；与对手零对战 → 1 号道路去开源林镇 | 图灵博士 |
| 2–3 | 代码道馆（林，Lv12–14，送徽章盒 + 悬浮滑板）→ 像素港视觉道馆（绘，Lv16–18）；零在像素港码头等你（徽章 1 后） | 道馆馆主 → `main-progress` |
| 4–5 | 和弦沙城音律道馆（韵，Lv21–23）→ 幻觉团在检索遗都与沼泽散播假数据：团员 ×4、干部·妄言（`quest:6`）→ 检索道馆（典，Lv25–28，送潜水协议） | `villain:swamp` |
| 6–7 | 熔炉镇算力道馆（焰，Lv30–33）→ 霜脊山口守卫放行 → 霜盾城对齐道馆（霜，Lv35–39）；零在霜盾城广场 | `badge:compute` |
| 8 | 幻觉团占领枢纽市数据塔：广场/塔门/1F–3F 团员 → 首领·幻影（Lv42–45）。被困研究员送研究所通行证 → 数据中心机房主管 | `villain:boss` |
| 9–10 | 枢纽市智能体道馆（枢，Lv41–45，首领被击退后开放）→ 衡理镇推理道馆（衡，Lv50–55） | `main-progress` |
| 11 | 八枚徽章 → 遗迹守门人放行（`gate:ruins`）→ 9 号道路 → 零的最终对战（圣殿镇营地）→ 圣殿守卫 ×2 → 冠军·启（UR 队伍 Lv60–65） | `champion` |
| 12 | 冠军之后走向祭坛：一次性的 MYTHIC 传说 `wildBattle`（Lv70），完成主线 | `legend` |

`main-progress` derives the stage from the badge count (+ `villain:swamp` / `villain:boss`), so any gym order keeps
the quest log consistent. Leaders award `badge-<type>` through `TrainerDef.badge`, a type chip + money, and key items:
hover-board + badge-case (badge 1), dive-protocol (search leader, badge 4 in the intended order).

Gates: `gate:snowpass` 山口守卫 (`hiddenIfFlag: badge:compute`); `gate:ruins` 遗迹守门人 (`ifBadges` = all badges →
`setFlag gate:ruins` + `hideNpc`). Before the starter, eight patrol NPCs stand in the start town's four exits
(`hiddenIfFlag: starter`).

## Branches and the hidden storyline (issue #25)

Four `choice` steps decide a flag value and pay out differently; later scripts read the value with `ifFlag … equals`.
`tests/story-branches.test.ts` asserts the values, the per-option rewards, the readers and that no branch touches `main`.

| choice (where) | flag = options | rewards per option | read by |
|---|---|---|---|
| 零 at 像素港 (`rival-pixelport`) | `rival:bond` = `ally` / `rival` / `calm` | cache ×3 + refill / 3000 + rare ball / 5 balls | `rival-frost` (intel or rematch line, ally gift), `rival-final` (greeting, parting gift) |
| 被困研究员 after the boss (`dt-scientist`) | `choice:dataset` = `public` / `lab` / `keep` | 3000 / rare dataset / rare chip | `professor`, `dc-chief` |
| 圣殿长老 before the champion (`tp-elder`) | `temple:blessing` = `accept` / `refuse` | full restore ×2 + respawn / heal | `champion` (refusers get a gold token after the win) |
| 守档人 (hidden line, below) | `zero:ending` = `lab` / `rival` / `self` | 2 finetune sets / dataset + restore / quantum bit + gold token | `professor` (gift), `rival-final` |

Hidden storyline 「第 0 号服务器」 (quest `hq-zero`, started only by finding the terminal): `zero-terminal` (`cave-core:4`,
deep in the second cave) sets `zero:t1` → `zero-rack` (`region:desert`, appears after t1) takes 3 data shards (or 3000 Token
coins, so nothing soft-locks) and sets `zero:t2` → `zero-keeper` (`agi-house1:resident-2`, appears after t2) hands over the
original training log, one-time (`zero:ending`). The professor, mom and the rival also react to progress (`badgeTiers`).

## Side quests

| id | name | type | where | reward |
|---|---|---|---|---|
| sq-floppy | 古董软盘 | deliver | 原点镇老王 → 开源林镇陈工 | 1500 + few-shot-ball ×3 |
| sq-dex | 图鉴初稿 | catch count (10 → 30 species) | 研究所 小图 | cot-ball ×3 (stage), 5000 + rare-dataset ×2 |
| sq-photo | 港口写真集 | catch type (2 vision) | 像素港 阿光 | 1200 + chip-diffusion |
| sq-chorus | 沙城合唱团 | catch type (1 sound) | 和弦沙城 团长 | 1500 + chip-lullaby |
| sq-badges | 徽章鉴赏家 | badges 2 / 5 / 8 | 和弦沙城 老金 | rare-ball ×2, hyper-cache ×3 (stages), finetune-dataset ×2 |
| sq-antivirus | 图书馆杀毒行动 | fetch (3 antivirus) | 检索遗都 典藏 | 1500 + universal-patch ×3 |
| sq-fan | 服务器风扇快递 | deliver | 熔炉镇老焰 → 数据中心工程师 | 4000 + old-gpu |
| sq-snow | 雪原迷途者 | visit (`quest:8`) | 霜盾城 大伟的妻子 | 3000 + full-cache ×2 |
| sq-castaway | 荒岛研究员 | visit by surf (`island:island-1`) | 像素港 阿海 | rare-chip (stage), 3000 + cot-ball ×5 |
| sq-arena | 开源擂台 | battle | 开源林镇 擂台主·阿源 | 1000 + chip-unit-test |
| sq-lostkid | 迷路的孩子 | visit (`cave-core:3`) | 衡理镇 焦急的妈妈 | 2500 + hyper-cache ×3 |
| sq-chaos | 幻觉研究 | catch type (1 chaos) | 枢纽市 诺瓦 | chip-hallucination-nova |
| hq-zero | 第 0 号服务器（隐藏） | hidden chain (cave → desert → temple town) | 守档人 | rare-ball ×2 + the chosen ending |
| sq-ruins | 遗迹铭文 | visit 2 spots (`quest:11`, `quest:18`) | 圣殿镇 石教授 | agi-key |

Also: two move tutors (和弦沙城 曲, 枢纽市 栈: `takeMoney` + chip), one-time gift NPCs on quest spots, a desert
merchant `shop`, optional trainers (外卖骑手, 岛主, 机房主管 behind `lab-pass`), 4 cave trainers.

## Flags

| flag | set by | read by |
|---|---|---|
| `starter` | client (`chooseStarter`) | professor, aide, rival branches, start-town patrols |
| `intro:mom` | mom | — (progress marker) |
| `rival:lab` `rival:pixelport` `rival:frost` `rival:final` | rival scripts | rival NPC visibility |
| `badge:<type>` | gym-leader script | leader after-line, snow pass guard, rival visibility |
| `villain:swamp` `villain:boss` | admin / boss scripts | grunts, search & agent leaders, villagers, main-progress |
| `gate:ruins` | ruins gate keeper | gate keeper, final rival |
| `gift:lab-pass`, `gift:<npc>` | gift scripts | one-time gifts |
| `champion` `legend` | champion script | champion, professor, temple fan |
| `rival:bond` `choice:dataset` `temple:blessing` `zero:ending` | the branch choices above | rivals, professor, champion, data-center chief |
| `zero:t1` `zero:t2` `zero:fed` `gift:professor-zero` | hidden line | cabinet / keeper visibility, professor |
| `lesson:<id>`, `lesson:types-lost`, `ob:typeLesson`, `exchange:<offer>` | `teach`, the type-lesson battle, the exchange desk | manual, objective, tips |
| `sq-<quest>:<step>` | quest NPCs | quest NPCs (`started`, `given`, `found`, `rescued`, `a`, `b`, `s1`, `s2`, `done`) |
| `trainer:<id>` | client | trainer scripts (after-line, post-battle rewards) |
| `{chain}:t{k}`, `{chain}:done` | legend tablets / seer | next tablet, seer visibility, one-time encounter |
| `bq-N:given` `bq-N:started` `bq-N:found` `bq-N:done` | bounty giver / partner / target | bounty scripts |
| `gift:<npc>` | nest / dungeon guardians, gift NPCs | one-time item gifts |

## NPCs by map (default seed; `*` = conditional visibility)

| overworld region | NPCs |
|---|---|
| 1 号道路 `route-1` | 学生 小新、实习程序员 阿杰、游戏玩家 大雄、画师 小美、登山客 老周 |
| 2 号道路 `route-2` | 冲浪手 阿浪、主播 小鹿、像素画师 Pixel、大学生 晓晓、前端工程师 阿码、钓鱼佬 老金 |
| 3 号道路 `route-3` | 驴友 林子、博士生 李博、开源贡献者 阿开、高中生 小优、电竞选手 阿飞、插画师 阿森 |
| 4 号道路 `route-4` | 沙漠向导 沙哥、音乐主播 阿 Ray、数据科学家 陈研、运维工程师 小 A、游戏主播 沙漠之狐、留学生 晴 |
| 5 号道路 `route-5` | 沼泽观察员 阿观、泥潭冲浪手 泥鳅、采药人 苔藓、调参侠 老三、雾景画家 雾画、幻觉团团员 妄二*、幻觉团团员 妄三* |
| 6 号道路·霜脊山口 `route-6` | 登山家 雪人、冰川学者 冰博士、冬泳爱好者 老冬、雪地赛车手 漂移、考研人 一凡、嵌入式工程师 阿嵌、山口守卫* |
| 7 号道路 `route-7` | 数码博主 测测、架构师 老架、对齐研究员 小齐、背包客 大卫、动画师 阿动、速通玩家 秒秒、铲雪工人 |
| 8 号道路 `route-8` | 高原骑手 巴特尔、首席科学家 郑首席、提示词工程师 Prompt 君、游戏原画师 阿原、电台 DJ 小麦、AI 少年班 小天才、棋类爱好者 飞象、高原湖泳者 阿湖 |
| 9 号道路·圣殿参道 `route-9` | 遗迹研究员 文博士、苦行者 无言、退休架构师 老顾、预言画师 星绘、传说追寻者 阿寻、遗迹守门人* |
| 检索遗都 `retrieval` | 幻觉团团员 妄一*、老图书管理员、遗都居民、索引研究员、小典 |
| 检索沼泽 `swamp` | 幻觉团干部 妄言* |
| 枢纽市 `hub` | 幻觉团团员 乱码*、幻觉团团员 看门狗*、全栈工程师、白领、上班族、小枢、招式导师·栈（tutor）、老教授、广场主播 |
| 开源林镇 `opensource` | 擂台主 阿源（questGiver）、维护者·小林、林镇长老、小树、馆主的粉丝 |
| 枢纽新区 `city` | 外卖骑手 闪电 |
| 数据之海 `sea` | 岛主 浪人、漂流研究员·艾达*、岛上隐士 |
| 原点镇 `origin` | 小满、花店阿姨、保安大叔、阿哲、小豆*、巡逻员·阿木*、巡逻大叔*、小花*、巡逻员·阿北*、小北*、巡逻员·阿南*、小南*、退休工程师·老王（questGiver） |
| 像素港 `pixelport` | 街头画师、冲浪少年、老船长、小渔、零（rival）*、摄影师·阿光（questGiver）、港口调度员·阿海（questGiver） |
| 和弦沙城 `chord` | 沙漠歌手、驼队老人、招式导师·曲（tutor）、小沙、合唱团团长（questGiver） |
| 熔炉镇 `forge` | 矿工、登山客、熔炉镇老人、小焰、电竞少年 |
| 霜盾城 `frostshield` | 城门老兵、霜盾城居民、红队研究员、小雪、旅店老板、零（rival）* |
| 衡理镇 `balance` | 棋社老人、考研党、衡理镇居民、小衡、牧场主 |
| AGI 圣殿 `agi` | 朝圣者、学者、圣殿镇居民、小启、圣殿门卫、零（rival）* |
| 霜盾雪山 `snow` | 登山客·大伟* |
| AGI 遗迹 `ruins` | 考古队员甲*、考古队员乙* |
| 原点草原 `meadow` | 放风筝的孩子、野餐的游客 |
| 开源森林 `forest` | 林中隐士、采蘑菇的孩子 |
| 像素海岸 `coast` | 沙滩救生员 |
| 和弦沙海 `desert` | 沙漠行商（clerk）、沙漠探险家 |
| 算力火山 `volcano` | 火山学家 |
| 衡理高原 `highland` | 高原牧民、天文爱好者 |

| map | NPCs |
|---|---|
| `cave-echo` | 洞穴探险家 阿洞、回声研究员 韵博士、幻觉团团员 妄四* |
| `cave-core` | 晶石猎人 晶晶、洞穴寻宝者 阿宝、小涛* |
| `origin-lab` | 图灵博士（professor）、零（rival）*、研究助理·阿灵、研究助理·小图（questGiver） |
| `origin-center` | 补给站护士（nurse）、仓库管理员（boxTerminal）、旅行者 |
| `origin-home` | 妈妈 |
| `origin-shop` | 店员（clerk） |
| `origin-house1` | 邻居阿姨 |
| `origin-house2` | 邻居大叔 |
| `opensource-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `opensource-shop` | 店员（clerk） |
| `gym-code` | 实习生 小码、测试工程师 阿测、开源志愿者 小源、代码馆主 林（gymLeader）、道馆向导 |
| `opensource-house1` | 陈工 |
| `opensource-house2` | 大学生 |
| `opensource-house3` | 林镇居民 |
| `pixelport-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `pixelport-shop` | 店员（clerk） |
| `gym-vision` | 美术生 小彩、摄影博主 快门、识图专家 阿瞳、视觉馆主 绘（gymLeader）、道馆向导 |
| `pixelport-house1` | 渔具店老板娘 |
| `pixelport-house2` | UP 主·阿彩 |
| `chord-shop` | 店员（clerk） |
| `chord-house1` | 徽章收藏家·老金（questGiver） |
| `chord-center` | 补给站护士（nurse）、仓库管理员（boxTerminal）、探险爱好者 |
| `gym-sound` | 歌手 小调、音乐学院学生 阿谱、配音演员 声声、音律馆主 韵（gymLeader）、道馆向导 |
| `chord-house2` | 沙城居民 |
| `chord-house3` | 行脚商人 |
| `gym-search` | 图书管理员 阿检、资料员 小索、搜索工程师 阿引、检索馆主 典（gymLeader）、道馆向导 |
| `retrieval-center` | 补给站护士（nurse）、仓库管理员（boxTerminal）、图书馆志愿者 |
| `retrieval-shop` | 店员（clerk） |
| `retrieval-house1` | 图书管理员·典藏（questGiver） |
| `retrieval-house2` | 遗都居民 |
| `forge-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `forge-shop` | 店员（clerk） |
| `gym-compute` | 超频玩家 阿超、机房搬运工 大力、并行计算工程师 阿并、算力馆主 焰（gymLeader）、道馆向导 |
| `forge-house1` | 矿场老板·老焰（questGiver） |
| `forge-house2` | 熔炉镇居民 |
| `forge-house3` | 熔炉镇居民 |
| `frostshield-shop` | 店员（clerk） |
| `frostshield-house1` | 大伟的妻子（questGiver） |
| `frostshield-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `gym-safety` | 安全审核员 阿审、红队队员 阿红、伦理学研究生 小伦、对齐馆主 霜（gymLeader）、道馆向导 |
| `frostshield-house2` | 高中生 |
| `hub-datacenter` | 机房主管 老机、数据中心访客、数据中心工程师 |
| `data-tower-1f` | 幻觉团团员 假前台*、前台、数据塔员工 |
| `data-tower-2f` | 幻觉团团员 复读机*、幻觉团团员 标题党*、幻觉团团员 水军*、被困研究员 |
| `data-tower-3f` | 幻觉团团员 深伪*、幻觉团团员 谣言*、幻觉团首领 幻影*、观景的游客* |
| `hub-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `gym-agent` | 自动化工程师 阿自、多智能体玩家 阿群、规划算法研究员 阿划、智能体馆主 枢（gymLeader）、道馆向导 |
| `hub-shop` | 店员（clerk） |
| `hub-house1` | 幻觉学者·诺瓦（questGiver） |
| `gym-logic` | 数学竞赛选手 小算、逻辑学家 阿辩、棋手 阿弈、推理馆主 衡（gymLeader）、道馆向导 |
| `balance-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `balance-shop` | 店员（clerk） |
| `balance-house1` | 焦急的妈妈（questGiver） |
| `balance-house2` | 村长 |
| `agi-temple` | 圣殿守卫 阿尔法、圣殿守卫 贝塔、AGI 冠军 启（champion）、圣殿长老、冠军的粉丝 |
| `agi-center` | 补给站护士（nurse）、仓库管理员（boxTerminal） |
| `agi-shop` | 店员（clerk） |
| `agi-house1` | 石教授（questGiver） |

Regenerate placement views: `node sandbox/story-png.ts /tmp/ap-story 8 [mapId…]` (`CROP=x,y,w,h` for overworld
close-ups) — trainers red with their sight line, leaders orange, services green, quest givers yellow, villagers
blue, conditional NPCs purple.

## How to add content (JSON only)

- **Villager**: append `{id, at, sprite, nameZh, role: "villager", lines}` to a group in `npcs/towns.json`.
- **Route trainer**: append a `TrainerSpec` with `at: "route:<route>:<n>"` and `party: [{pick, level}]` to the route
  group in `trainers/routes.json` (group `defaults` give `aiLevel`, `rewardPerLevel`, `sightRange`).
- **Quest**: add a `QuestDef` (targets as anchor names) to `quests.json`, then NPCs whose scripts move it with
  `quest` steps and gate on `sq-…` flags.
- **Town**: nothing to do for services — nurse, box attendant and clerk are created for every town that has the
  `<town>-center` / `<town>-shop` anchors; add a `shop.extra.<town>` list for specialties.
- **Starter**: mark a species `starter: true` — rival variants and the `rivalBattle` branches follow automatically.
- **Procedural people**: add an archetype to a pool in `population.json` (`biomes` to restrict it), or a rule
  (anchor regex + pool; order = priority). Use hint params (`{nestName}`…) in dialogue to point at real places.
- **Legend chain**: append to `legends.json` `chains` (`sites`/`final` regexes over POI ids, `steps`, `lore` lines
  ≥ max steps, `encounter` steps with a `wildBattle` pick).
- **Bounty kind**: add to `bounties.json` `kinds` (stages, giver/partner/trainer archetypes, texts, `scripts`
  templates using `{quest}` flags).

Then run `node --test tests/story.test.ts`; `storyProblems()` lists any unknown anchor, blocked tile, bad reference
or unresolved `{lookup}`.

## Verification

```
npx tsc --noEmit -p tsconfig.json
node --test tests/story.test.ts
```

tests/story.test.ts covers: no apply problems; NPC ids unique, on walkable non-warp non-arrival tiles; permanent
NPCs never seal warps/towns and stay talkable; trainer refs and resolved, level-appropriate species; scripts
well-formed recursively with every item/trainer/quest/stage/npc/sfx/bgm/town reference; no placeholder or macro
leaks; every read flag is written or a client convention; every badge has a leader in its gym that battles, sets
the badge flag and gives a chip, with 2–4 gym trainers and rising aces (12–14 … 50–55); ≥ 50 route trainers with
sight 3–5, 1–4 creatures and route-band levels; rival variant per starter/battle with the advantaged starter line;
prologue gifts/heal/key items and the sealed start town; gates lock until opened; quests start, finish and use
every stage; services and villagers in every town, buyable shops, tutors; villains, champion (60–65) and a
one-time legend; determinism and another seed; problem reporting on broken content; `resolvePick` on a synthetic
roster; legend chains (tablet order, flags, quest stages, hop spacing, UR one-time encounter above its region,
no shared landmarks); ≥ 15 bounties with all kinds, giver/target placement, distance, on-foot reachability and
rewards; ≥ 150 wild trainers with danger-scaled rewards and ≥ 60 % biome-native party members; ≥ 5 hermit tutors
with level-appropriate chips; a gift-giving guardian on every nest; compass/distance hints and real place names
for every hamlet guide; a fresh-copy `applyStory` that is identical and < 400 ms.
