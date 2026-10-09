# 0003 M1 实施切片：M1a 随机属性 · M1b 战后签约 · M1c 新序章

**状态：** 定稿（2026-10-10），对应 `docs/design/0003-story-and-progression.md` v2。
**用途：** 实现者照着本文件开工。数值和文案的来由见 0003 正文，本文件只写"改哪里、加什么、怎么验"。

## 共同规则

1. **合并顺序：** M1a → M1b → M1c。每一刀都能单独合并、单独发预发布（rc 标签），前一刀合并后后一刀才开工。
   - M1b 依赖 M1a 的 `nature`、`origin` 和鉴定卡；
   - M1c 依赖 M1b 的 `bossBattle`、签约和 Boss 卡。
2. **数据不硬编码：** 数值、文本、开关都写在 `content/**/*.json`，文本经 `t()` 取，放在 `content/text/zh-CN/`。不改 `content/game.json:encounters.grassRateMultiplier`（0.18）。
3. **契约文件：** `src/shared/types.ts`、`src/shared/content/index.ts`、`src/shared/protocol.ts` 的改动要在 PR 描述里单独列出，等契约负责人同意。
4. **每刀都要通过的工程检查：**
   - `npm run typecheck && npm test && npm run build` 全绿；
   - `storyProblems()` 为空；
   - 不放宽现有测试阈值。依赖种子的测试如果因为随机数消耗变化而需要更新期望值，要在 PR 里写明原因。
5. **截图：**
   - 视口：`d1000r`（1000×655 @2x）、`m390`（390×844 @3，竖屏触屏）、`m844`（844×390 @3，横屏触屏）；
   - 每个列出的界面在 3 个视口各截一张，输出到 `output/41/<刀>/<视口>/<界面>.png`（不入库，在 PR 里上传）；
   - 同时跑 `scripts/qa-layout-audit.mjs`，这些界面要 0 违规；
   - 手机端要在所有浮层同时打开时检查一次（`hud-phone`）。
6. **dev 场景：** 每个截图界面都要能用 `?dev=1&scenario=<id>` 一步到达（ADR 0002）。
7. **提交：** `<type>(<scope>): <中文简述>`，结尾写 `Refs #41`。

---

## M1a 全世界随机属性

### 目标与玩家可见变化

- 新收服、获赠和选出的搭档都有性格和品质。
- 收服后弹鉴定卡：新物种、A 级以上和首次收服弹整张卡，其余弹一行 chip。
- 队伍、详情页、仓库、战斗名牌和交易界面显示品质。
- 老存档迁移到 v2：所有智灵性格为"均衡"，数值零变化，并获赠 2 张人设重写卡，可以马上使用。

### 不做

Boss 卡、签约、LoRA、蒸馏、特性胶囊、微调台（M1b / M2）。

### 改动清单

**类型（`src/shared/types.ts`，契约）：**

| 位置 | 改动 |
|---|---|
| `:409` `Creature` | 加 `nature?: string`、`origin?: CreatureOrigin`、`finetuned?: number` |
| 新类型 | `CreatureOrigin { kind: 'wild' \| 'starter' \| 'gift' \| 'boss' \| 'trade' \| 'legacy'; boss?: string; tier?: string; run?: string; at?: number }` |
| `:236` `ItemEffect` | 加 `\| { kind: 'nature' }` |
| `:1188` `Settings` | 加 `showIvNumbers: boolean` |
| 新类型 | `NatureDef { id: string; up: StatKey \| null; down: StatKey \| null }`；`GradeDef { id: string; min: number; color: string }`；`QualityFile` |

**内容：**

| 文件 | 改动 |
|---|---|
| `content/quality.json`（新） | 见下方"新增 JSON 键" |
| `src/shared/content/index.ts:28-43`（契约） | 加一行 `import qualityJson from '../../../content/quality.json' with { type: 'json' }`；在 `:140-155` 的内容对象上挂 `quality`、`natureById`；`validate` 校验 25 种性格各自只有一升一降或都为 null、`up !== down`、阈值递增、`legacyNature`/`npcNature` 存在 |
| `content/items.json` | 加 `persona-card`（见下）；图标按 `docs/assets.md` 的道具图标流程生成，`tests/item_icons.test.ts` 要求每个道具都有图标 |
| `content/config.json:26` | `save.version` 1 → 2 |
| `content/config.json:34` | `defaultSettings` 加 `"showIvNumbers": false` |
| `content/screens.json` | 设置页"显示"分组加 `showIvNumbers` 开关项（写法同现有布尔项） |
| `content/text/zh-CN/screens.json` | 新增 `quality.*`（25 种性格的名字和吐槽句、品质外号、`reveal.*`、`summary.*`、`chip`，全文见 0003 附录 C）；把 `starter.personality`、`summary.personality` 的文本从"性格"改为"人设" |

**共享逻辑：**

| 位置 | 改动 |
|---|---|
| `src/shared/gameplay/quality.ts`（新） | `gradeOf(ivs): GradeDef`；`natureMod(v, stat, nature)`（整数运算：加成 `floor((v*up + 99)/100)`，减成 `floor(v*down/100)`）；`rollNature(rng)`；`rollIvs(rng, {perfect?, min?, gradeFloor?})`——带底线时用确定性拒绝采样，最多 64 次，超过就把最低项抬到满足阈值；`natureArrows(nature)` |
| `src/shared/creature.ts:26` `calcStats` | 参数类型 `Pick` 加 `'nature'`；非 hp 项用 `natureMod`；hp 不变 |
| `src/shared/creature.ts:90` `createCreature` | `opts` 加 `nature?`、`gradeFloor?`、`perfectIvs?`、`ivMin?`、`origin?`。抽取顺序必须是：个体值（现有）→ 特性（现有）→ 闪光（现有）→ **性格（只有 `opts.nature` 未给时才掷）**。传了 `gradeFloor`/`perfectIvs`/`ivMin` 时走 `rollIvs` |
| `src/shared/creature.ts:225` `sanitizeCreature` | `nature` 不在表里就改成 `legacyNature`；`origin.kind` 必须在枚举里，`origin.boss` 必须是存在的 Boss id，否则删掉 `boss` 字段；`finetuned` 夹在 `[0, quality.finetune.loraMaxPerCreature]` |
| `src/client/world/battles.ts:150`（训练家队伍） | `createCreature(..., { ...opts, nature: CONTENT.quality.npcNature })`，不掷随机数，保证平衡测试不漂移 |
| `src/shared/battle/boss-battle.ts:33`（Boss 本体） | 同上，传 `npcNature` |
| `src/shared/dev/scenario.ts:68` | 场景的队伍条目支持 `nature`、`grade`（映射到 `gradeFloor`，并在 `rollIvs` 里把上限限制在同一档内，保证展示用的品质刚好落在该档） |

**客户端：**

| 位置 | 改动 |
|---|---|
| `src/client/ui/reveal.ts`（新） | `showReveal(ctx, cr, {full: boolean})`：整卡显示大号品质字母、5 格梯子（当前档亮，其余暗）、性格条、特性条、6 项星级（最高项高亮）；首张整卡附一次性一句 `screens.quality.reveal.ladderHint`（旗标 `ob:revealLadder`）。chip 显示一行，3 秒后消失。整卡最长 `quality.reveal.maxMs`，点任意处或确认键跳过 |
| `src/client/battle/index.ts:142-145`（`catchFlow` 之后） | 调 `showReveal`；整卡条件用 `quality.reveal.fullWhen`，其中"新物种"取 `src/client/battle/saveops.ts:18` 的 `markCaught` 返回值 |
| `src/client/battle/saveops.ts:54` `storeCaught` | `cr.origin ??= {kind: 'wild', at: Date.now()}` |
| `src/client/world/script.ts:178` `chooseStarter` | `createCreature(..., {gradeFloor: quality.giftGradeFloor, origin: {kind: 'starter'}})`，加完后调 `showReveal(full)` |
| `src/client/world/script.ts:68` `giveCreature` | 同上，`origin: {kind: 'gift'}` |
| `src/client/ui/screens/party.ts:58` | 等级后面加品质字母 chip（颜色取 `grade.color`），不加外号 |
| `src/client/ui/screens/summary.ts:103` | 该行改用 `screens.summary.personality`（文本已改为"人设"）；下面加一行"性格"：名字 + `推理↑ 稳健↓` |
| `src/client/ui/screens/summary.ts:108-118`（能力页） | 标题行显示"品质 A · FP16"；能力名后按性格加 ↑（绿）/↓（红）；`showIvNumbers` 为真时在星级右侧显示 0–31 |
| `src/client/ui/screens/box.ts` | 工具栏加"排序：默认 / 品质"和"只看 A 以上"两个开关，状态存在会话里，不写存档 |
| `src/client/battle/status-panel.ts` | 野生对手：如果 `save.dexCaught` 包含该物种，在名牌上显示品质字母（视觉上和等级同一行，不加新行） |
| `src/client/net/trade-flow.ts:51` | 交易卡片上的总星级旁边加品质字母和性格名 |
| `src/client/ui/screens/item-use.ts:87` 附近 | 新增 `case 'nature'`：选智灵 → 5×5 性格网格（当前性格高亮）→ 确认 → 写 `cr.nature`、消耗 1 张 |

**存档 v2：**

| 位置 | 改动 |
|---|---|
| `src/client/core/save-migrate.ts`（新） | `export function migrateSave(raw: unknown, c: Content): unknown`，按版本号依次执行步骤表，例如 `{2: v1to2}`。`v1to2`：①对队伍和每个仓库里的每只智灵：`nature ??= quality.legacyNature`；`origin ??= {kind: 'legacy', ...(bossBySpecies[speciesId] ? {boss: id} : {})}`；`finetuned ??= 0`。②`flags['gift:quality-legacy']` 未置位时，背包加 `quality.legacyGift`，并置旗。③`version = 2`。整个函数幂等 |
| `src/client/core/save.ts:56-60`（load）、`:108`（importCode） | 改为 `sanitize(migrateSave(raw, c))` |
| `src/server/` | 服务端导入旧档的入口如果调用了 `sanitizeSaveData`，也要先调 `migrateSave` |
| `tests/fixtures/save-v1-starter.json`、`save-v1-3badges.json`、`save-v1-champion.json`（新） | 冠军档里放一只战斗中抓到的 Boss（例如 `deepseek-v4` Lv58） |

**博士提示（老档）：** 迁移后第一次进入世界时弹 Toast `screens.quality.legacyToast`："研究所给每位训练家发了 2 张人设重写卡。"由 `gift:quality-legacy` 和一次性旗标 `ob:legacyToast` 控制。

### 新增 JSON 键

**`content/quality.json`**（M1a 只放这些键；`capture`、`bossCard` 在 M1b 加，其余 `finetune.*` 在 M2 加）：

```json
{
  "natureMulPct": {"up": 110, "down": 90},
  "legacyNature": "balanced",
  "npcNature": "balanced",
  "natures": [
    {"id": "balanced", "up": null, "down": null}, {"id": "chill", "up": null, "down": null}, {"id": "casual", "up": null, "down": null},
    {"id": "lawful", "up": null, "down": null}, {"id": "moderate", "up": null, "down": null},
    {"id": "reckless", "up": "atk", "down": "def"}, {"id": "rigorous", "up": "atk", "down": "spa"}, {"id": "intuitive", "up": "atk", "down": "spd"}, {"id": "deep", "up": "atk", "down": "spe"},
    {"id": "steady", "up": "def", "down": "atk"}, {"id": "conservative", "up": "def", "down": "spa"}, {"id": "stubborn", "up": "def", "down": "spd"}, {"id": "heavy", "up": "def", "down": "spe"},
    {"id": "whimsical", "up": "spa", "down": "atk"}, {"id": "unbound", "up": "spa", "down": "def"}, {"id": "imaginative", "up": "spa", "down": "spd"}, {"id": "poetic", "up": "spa", "down": "spe"},
    {"id": "erudite", "up": "spd", "down": "atk"}, {"id": "bookish", "up": "spd", "down": "def"}, {"id": "citing", "up": "spd", "down": "spa"}, {"id": "cautious", "up": "spd", "down": "spe"},
    {"id": "hasty", "up": "spe", "down": "atk"}, {"id": "light", "up": "spe", "down": "def"}, {"id": "pragmatic", "up": "spe", "down": "spa"}, {"id": "surfing", "up": "spe", "down": "spd"}
  ],
  "grades": [
    {"id": "C", "min": 0, "color": "#9aa5b1"}, {"id": "B", "min": 85, "color": "#5fb0ff"}, {"id": "A", "min": 115, "color": "#b07cff"},
    {"id": "S", "min": 145, "color": "#ffb43c"}, {"id": "SS", "min": 170, "color": "#ff5c5c"}
  ],
  "giftGradeFloor": "B",
  "reveal": {"fullWhen": {"newSpecies": true, "gradeAtLeast": "A", "boss": true, "firstCatch": true}, "maxMs": 2500, "chipMs": 3000},
  "legacyGift": {"persona-card": 2},
  "finetune": {"loraMaxPerCreature": 3}
}
```

**`content/items.json`**（`category` 用现有的特殊道具类别，与 `rare-dataset` 一致）：

```json
{"id": "persona-card", "nameZh": "人设重写卡", "category": "<同 rare-dataset>", "price": 14000, "buyable": false,
 "description": "把一只智灵的性格改写成你想要的那一种。种族值不变，个体值不变，只换性格。",
 "effect": {"kind": "nature"}, "usableInBattle": false, "usableInField": true}
```

**`content/text/zh-CN/screens.json` 的 `quality`（节选；全文见 0003 附录 C）：**

```json
{"nature": {"balanced": {"name": "均衡", "quip": "什么都会一点，什么都不偏科。"}},
 "grade": {"C": "INT4 量化", "B": "INT8 量化", "A": "FP16", "S": "满血版", "SS": "满血·天选"},
 "reveal": {"title": "鉴定结果", "ladderHint": "越靠右越强", "best": "最强项：{stat}", "boss": "BOSS 卡"},
 "summary": {"nature": "性格", "grade": "品质 {grade} · {nick}"},
 "chip": "{grade} · {nature} {up}↑ {down}↓",
 "chipNeutral": "{grade} · {nature}",
 "legacyToast": "研究所给每位训练家发了 2 张人设重写卡。",
 "pickNature": "选择新的性格",
 "settings": {"showIvNumbers": "显示个体数值"}}
```

### 测试清单

| 文件 | 断言 |
|---|---|
| `tests/creature-quality.test.ts`（新） | ①25 种性格：5 种中性，其余 20 种的 `up`/`down` 两两不同，覆盖 atk/def/spa/spd/spe 的 20 种有序组合。②`natureMod`：v=7 时加成 8、减成 6；v=10 时加成 11（防浮点误差）；v=18 时 20/16；hp 不受影响。③`calcStats`：中性性格的结果与改动前完全相同（对 `speciesList` 前 50 个物种、Lv1/50/100 做快照对比）。④`gradeOf`：总和 84→C、85→B、114→B、115→A、144→A、145→S、169→S、170→SS。⑤野生 2 万次蒙特卡洛：C 35.7%、B 46.8%、A 16.5%、S 1.0% 各 ±1%。⑥`rollIvs({gradeFloor: 'B'})` 总和全部 ≥85，同种子结果相同。⑦训练家队伍：给定种子，改动前后同一训练家的个体值完全相同（不额外消耗随机数），性格都是 `balanced` |
| `tests/save-migrate.test.ts`（新） | ①3 份 v1 夹具迁移后 `version === 2`，所有智灵的 `level`、`exp`、`ivs`、`moves` 不变，`nature === 'balanced'`，`origin.kind === 'legacy'`；冠军档里的 V4 带 `origin.boss === 'deepseek'`。②背包多了 2 张 `persona-card`，旗标已置。③连续迁移两次结果相同（幂等）。④v2 存档原样通过。⑤迁移后 `sanitizeSaveData` 不报错 |
| `tests/creature.test.ts`（扩展） | `sanitizeCreature`：未知性格改成 `balanced`；非法 `origin.kind` 被删掉；`finetuned` 被夹到 0–3 |
| `tests/screens.test.ts`（扩展，如果已有队伍或详情页的视图测试） | 队伍行渲染出品质字母；详情页"人设"和"性格"两行都在 |
| `tests/opening_balance.test.ts`、`tests/balance*.test.ts` | 原阈值不变并通过。`tools/balance` 的玩家侧样本如果改用随机性格导致阈值失败，先固定成种子随机，不改阈值 |
| `tests/dev-determinism.test.ts`、`tests/dev-rolls.test.ts`、`tests/dev-replay.test.ts` | 因为野生多掷一次性格，期望值整体偏移，按新值更新并在 PR 里说明 |

### 开发场景

- `content/dev/scenarios/quality-showcase.json`：队伍为 C/B/A/S/SS 各一只（同物种不同性格）加一只中性性格；仓库放 20 只随机品质；背包 1 张 `persona-card`。
- `content/dev/scenarios/legacy-save-v1.json`：载入 `tests/fixtures/save-v1-3badges.json`。

### 验收截图（每项 × d1000r / m390 / m844）

1. 鉴定卡整卡：新物种、A 级、带梯子和首张提示。
2. 鉴定 chip：重复物种、B 级。
3. 队伍列表（`quality-showcase`）。
4. 详情页信息页："人设"行加"性格"行。
5. 详情页能力页：品质标题、箭头、星级；首屏不滚动。
6. 同上，打开 `showIvNumbers`。
7. 仓库：按品质排序 + 只看 A 以上。
8. 野战中敌方名牌显示品质字母（已收服过的物种）。
9. 人设重写卡的性格网格。
10. 设置页的新开关。
11. 老档迁移后的 Toast（`legacy-save-v1`）。

### 预发布验证（prev）

- 新档：选搭档时弹整张卡，品质 ≥B；抓 3 只野生，至少看到一次 chip；
- 导入旧存档码后：性格全是"均衡"，等级不变，背包里有 2 张人设重写卡，用掉 1 张后性格改变，详情页箭头随之变化。

### 风险

- **契约文件**两处（`types.ts`、`content/index.ts`）。
- **随机数偏移**影响依赖种子的测试，见测试清单。
- **新道具图标**是资产流程，不能用占位图上预发布。
- **手机竖屏（m390）的详情页**多了一行"性格"，要守住"首屏不滚动"。必要时把"性格"并进"人设"行的右侧。

---

## M1b Boss 战后签约（先只接 DeepSeek）

### 目标与玩家可见变化

- 选完搭档后，研究所里出现"机房模拟舱"终端（`ds-terminal`），可以直接挑战 DeepSeek 体验版 Lv12。
- 打赢后进入签约画面：首通必成功，等级滚到 1，V4 说专属签约台词，弹出 Boss 版鉴定卡（保底 A、签名特性"峰谷电价"、会"权重空投"）。
- Boss 卡在队伍里有 BOSS 角标和"Lv x/上限"。上场或替补都有带教加成；到顶后经验进储备；拿到徽章时 Toast"算力许可升级"，并结算储备。
- 体验版可以重打：给 ×0.5 经验和 300 金钱，不进签约。

### 不做

- 不做新序章（M1c），不做教练条（M1c），不做陪练（M1c）；
- 不做重复签约和保底，不做进阶档和满血档（M2）。

**游荡 Boss 保持原状：** `src/client/world/battles.ts:118-143` 的野外 Boss 路径不动，仍然 `canCatch: true` 并乘 `catchRateMul`，抓到的智灵 `origin.kind = 'wild'`，不受许可上限约束。它们在 380 格以外、Lv54 以上，和这一刀没有交集；M2 再统一改为战后签约。

### 改动清单

**类型（`src/shared/types.ts`，契约）：**

| 位置 | 改动 |
|---|---|
| `:652` `BossDef` | 加 `tiers?: Record<string, BossTierDef>`、`signature?: {ability?: string; move?: string}`、`scriptedOnly?: boolean` |
| 新类型 | `BossTierDef`（字段见 0003 §8.2，包括 `expMul`、`byStarter`、`rules`（按 rule id 覆盖）、`addRules`、`residualMul`、`enrage`、`assist`） |
| `:492` `BossCond` | 加 `foeCompany?: string[]`（读当前出场的玩家方智灵的 `species.company`） |
| `:462` `BattleInit` | 加 `bossTier?: string`、`assist?: boolean`、`captureAfterWin?: boolean` |
| `:480` `BattleModifiers` | 加 `benchExp?: number[]`、`levelCapByParty?: number[]`、`expCapByParty?: number[]` |
| `:150` `AbilityCondition` | 加 `turnCycle?: {period: number; from: number; to: number}` |
| `:1216` `SaveData` | 加 `rollSeed?: number`、`instances?: Record<string, InstanceProgress>` |
| 新类型 | `InstanceProgress { clears: Record<string, number>; captures: Record<string, number>; runSeq: number; losses: Record<string, number> }`（`pity`、`day` 在 M2 加）；`InstanceFile` |
| `:820` `ScriptStep` | 加 `\| { op: 'bossBattle'; boss: string; tier: string; captureAfterWin?: boolean; lossContinues?: boolean; lossFlag?: string }`（`coach`、`lossWarp` 在 M1c 加） |

**内容：**

| 文件 | 改动 |
|---|---|
| `content/bosses.json:bosses.deepseek` | 加 `tiers.story`（JSON 见 0003 §3.4.2，`assist` 一并加入）、`signature: {"ability": "peak-valley", "move": "weight-drop"}` |
| `content/abilities.json` | 加 `peak-valley`（0003 §8.2） |
| `content/world/instances.json`（新） | 最小版，见下；在 `src/shared/content/index.ts` 加载（契约），或者放进 `src/shared/gameplay/data.ts` 的加载路径（非契约，二选一，推荐后者） |
| `content/quality.json` | 加 `capture`、`bossCard`（见下） |
| `content/world/layouts/interiors.json:lab` | `anchors` 加 `terminal`（选一个可达、不挡 `starters-front` 和 `rival` 的格子，由 `validate.ts:215` 检查在界内） |
| `content/world/story/npcs/story.json`（`prologue` 列表） | 加 NPC `ds-terminal`，见下 |
| `content/text/zh-CN/boss.json:deepseek` | 加 `contract`、`contractWake`、`tier.*`、`instance.name`、`card.*`、`follow.day`、`follow.night`、`follow.capped`、`follow.badge`、`terminal.*`（0003 附录 B） |
| `content/text/zh-CN/battle.json` | 加 `err.cantCatchBoss`："Boss 战中无法投球，打赢后可以签约。" |
| `content/text/zh-CN/battleui.json` | 加签约画面文本 `capture.*`：标题、成功率、"签约"按钮、成功、回滚提示 |
| `content/text/zh-CN/hud.json` | 加 `license.up`："算力许可升级：{name} Lv{from} → Lv{to}"、`license.capped`、`party.boss`："BOSS" |
| `content/tutorial.json` | 新课 `bossCard`（手册页：带教、替补也有经验、换上去再换下来也算参战、许可与储备）；新提示卡 `bossCard`（触发：第一次获得 `origin.kind === 'boss'` 的智灵）和 `bossCapped`（触发：第一次有经验进储备） |

**共享逻辑：**

| 位置 | 改动 |
|---|---|
| `src/shared/battle/boss-tier.ts`（新） | `resolveBossDef(def, tier, {starter, assist}): BossDef`：把档位合并成一个普通 `BossDef`——`statMul` 写进 `forms[initialForm]`；`rules` 按 rule id 覆盖 `dealtMul`/`takenMul`；追加 `addRules`；`enrage` 浅合并；`expMul` 覆盖；先合 `byStarter[starter]`，再合 `assist`（`assist.byStarter` 最后合）；`residualMul` 挂在结果上。纯函数，引擎不需要知道"档位"的存在 |
| `src/shared/battle/boss-battle.ts:39` `buildBossInit` | 选项加 `tier?`、`starter?`、`assist?`，内部先 `resolveBossDef`；`:43` 的等级取档位的 `level` |
| `src/shared/battle/boss.ts:5` `bossCondHolds` | 加 `foeCompany`：`CondCtx` 要能拿到玩家当前出场智灵的物种 |
| `src/shared/battle/engine.ts:1406-1409`（寄生吸血）和紧随其后的异常持续伤害 | 目标是 Boss 并且有 `residualMul` 时，伤害乘上它，至少 1 |
| `src/shared/battle/engine.ts:510` | `canCatch === false` 且是 Boss 战时返回 `cantCatchBoss` |
| `src/shared/battle/engine.ts:1508-1520` `awardExp` | ①参战者照旧乘 `expByParty`。②`benchExp[i] > 0` 的非参战存活成员拿 `round(each * benchExp[i])`，至少 1，同样发 `exp`/`levelUp` 事件。③`gainExp` 传 `{levelCap: levelCapByParty?.[i], expCap: expCapByParty?.[i]}` |
| `src/shared/battle/formulas.ts:52` `condHolds` | 加第 6 个参数 `turn = 0`，判断 `turnCycle`（`(turn-1) % period` 落在 `[from, to)`，和 `boss.ts:76` 一致）；5 处调用都传入引擎当前回合 |
| `src/shared/creature.ts:132` `gainExp` | 加 `opts?: {levelCap?: number; expCap?: number}`：等级不超过 `levelCap`；`exp` 不超过 `expCap` |
| `src/shared/creature.ts:225` `sanitizeCreature` | `origin.kind === 'boss'` 时：特性允许等于 `bosses[origin.boss].signature.ability`；招式允许包含 `signature.move`；经验上界放宽到 `expForLevel(level + bossCard.bankMaxLevels)` |
| `src/shared/gameplay/bosscard.ts`（新） | `isBossCard(cr)`；`bossCardCap(badges)`；`catchUpMul(gap)`（`gap < 1 ? 1 : min(max, 1 + perLevel * gap)`）；`partyExpMods(party, badges)`，返回 `expByParty`、`benchExp`、`levelCapByParty`、`expCapByParty`，其中非 Boss 卡是 1 / 0 / undefined；`expCap(cr, cap)` = `expForLevel(cap + bankMaxLevels)`；`settleBank(cr, cap)`；`captureSeed(rollSeed, instanceId, tier, runSeq)` 用 `src/shared/rng.ts:6` 的 `hashString`；`rollBossCard(rng, tierRules, {first, starterLevel})` 返回新智灵（Lv `startLevel`，`defaultMoves(species, 1)` 的最后一格换成签名招式，特性按 `firstAbility` 或权重，个体按 `perfectIvs`/`ivMin`/`firstGradeFloor`，性格随机） |

**客户端：**

| 位置 | 改动 |
|---|---|
| `src/client/world/battles.ts:64-70` `battleMods` | 合并 `partyExpMods(ctx.save.party, badges)`。所有战斗都生效，不只 Boss 战 |
| `src/client/world/battles.ts`（新函数 `boss(bossId, tier, opts)`，放在 `:156` 的 `trainer` 旁边） | ①`instances[id].runSeq += 1` 并立刻 `ctx.persist('boss-room')`。②用 `buildBossInit` 风格组装 `BattleInit`：`canCatch: false`、`captureAfterWin: clears[tier] === 0`、`bossTier`、`mods`。③胜利后：`clears[tier] += 1`，发首通或重复奖励，置 `bossWonPrefix` 旗标。④返回结果 |
| `src/client/battle/capture.ts`（新） | 签约画面：Boss 倒地 → 成功率 100% → 选球（只显示持有的球；M1b 首通任意球都 100%）→ 摇晃 → 成功 → 等级从当前滚到 1（数字滚动 ≤1.2 秒）→ `say(boss.<id>.contract)`（`ds:approach === 'wake'` 时用 `contractWake`）→ `showReveal(full, boss: true)`。触屏为"点球 → 再点签约"两步 |
| `src/client/battle/index.ts:138-146` | `result === 'win' && init.captureAfterWin` 时 `await captureFlow(scene, …)`。新智灵用 `rollBossCard(new Rng(captureSeed(...)))` 生成，走 `storeCaught` 入队或进仓库，`captures[tier] += 1` |
| `src/client/world/script.ts:106` `step` | 新 `case 'bossBattle'` → `host.bossBattle(boss, tier, {captureAfterWin})`；`lossFlag` 和 `lossContinues` 的语义同 `battle` |
| `src/client/world/save-ops.ts` | 新增 `settleBossCards(ctx)`：对每张 Boss 卡用新上限调 `settleBank`，有升级就 Toast `hud.license.up`；可学的招式走 `src/client/ui/screens/learnmove.ts`；"队伍"挂红点（#40 有接口就接） |
| 订阅 `badge:earned`（`src/client/world/battles.ts:191` 发出） | 调 `settleBossCards` |
| `src/client/world/controller.ts:951` `followerInteract` | 跟随者是 Boss 卡时，按顺序选 `boss.<id>.follow.capped`（到顶且有储备）→ `day`/`night`（按 `ifTime` 同样的时段判断）；否则走原来的逻辑 |
| `src/client/ui/screens/party.ts:58` | Boss 卡加 BOSS 角标；等级写成 `Lv{level}/{cap}`；有储备时加 chip"储备 +{n}" |
| `src/client/ui/screens/summary.ts`（信息页） | Boss 卡加两行："算力许可 {level}/{cap}"、"储备 +{n} 级" |
| `src/client/core/save-sanitize.ts:253` | `rollSeed` 缺失就生成（uint32，用 `ctx.newId` 的随机源）；`instances` 缺失为 `{}`，每项清洗成非负整数 |
| `src/client/net/trade-flow.ts` | `origin.kind === 'boss'` 的智灵不能放上交易台（按钮置灰并提示 `net.trade.boundBoss`），服务端同样拒绝 |
| `src/client/dev/commands/`（`battle.boss`） | 加参数 `tier`、`assist`；新命令 `capture.force {result: 'success'}`、`instance.reset {id}` |

### 新增 JSON 键

**`content/world/instances.json`：**

```json
{"instances": {"deepseek-tide": {
  "boss": "deepseek", "name": "boss.deepseek.instance.name",
  "tiers": {"story": {
    "capture": {"first": 1, "perfectIvs": 1, "ivMin": 5, "firstGradeFloor": "A", "firstAbility": "signature", "ability": {"signature": 0.4, "slot0": 0.4, "slot1": 0.2}},
    "reward": {"money": 1200},
    "firstReward": {"items": {"off-peak-coupon": 2, "chip-weight-drop": 1}},
    "repeat": {"expMul": 0.5, "money": 300, "capture": false}
  }}
}}}
```

**`content/quality.json` 追加：**

```json
{"capture": {"ballBonus": {"few-shot-ball": 0.05, "cot-ball": 0.1, "rare-ball": 0.15}, "masterBall": "agi-key", "roamingBase": 0.3},
 "bossCard": {"startLevel": 1, "capByBadges": [10, 14, 19, 24, 29, 35, 41, 51, 100], "bankMaxLevels": 12,
   "catchUp": {"perLevel": 1.0, "max": 12, "benchShare": 0.5}}}
```

**模拟舱终端 NPC（M1c 会把 `hiddenUnlessFlag` 改成 `ds:legacy`）：**

```json
{"id": "ds-terminal", "at": "origin-lab:terminal", "sprite": "trainer_scientist", "nameZh": "机房模拟舱", "role": "villager",
 "hiddenUnlessFlag": "starter", "hiddenIfFlag": "ds:done",
 "script": [
   {"op": "say", "text": "boss.deepseek.terminal.t1", "speaker": ""},
   {"op": "choice", "text": "boss.deepseek.terminal.ask", "options": ["boss.deepseek.terminal.go", "boss.deepseek.terminal.later"],
    "branches": [[{"op": "bossBattle", "boss": "deepseek", "tier": "story", "captureAfterWin": true, "lossContinues": true, "lossFlag": "ds:lost"},
                  {"op": "ifFlag", "flag": "ds:lost", "equals": true, "then": [{"op": "heal"}, {"op": "say", "text": "boss.deepseek.loss.default", "speaker": "story.cast.r1"}],
                   "else": [{"op": "setFlag", "flag": "ds:done"}]}], []]}
 ]}
```

`sprite` 先借用 `trainer_scientist`，有终端贴图后替换。在 M1b 里 `speaker` 不能用 `story.cast.r1`（`story.json` 命名空间是 M1c 才加的），改为直接写"小 R"文本键 `boss.deepseek.terminal.r1Name`。

**`boss.json:deepseek.terminal`：**

```json
{"t1": "屏幕上滚动着一行字：『潮汐机房·模拟舱。载入：DeepSeek-V4 体验版。』",
 "ask": "要进入模拟舱吗？", "go": "进入", "later": "下次再说", "r1Name": "小 R"}
```

### 测试清单

| 文件 | 断言 |
|---|---|
| `tests/boss-card.test.ts`（新） | ①`rollBossCard` 首签：等级 1、`origin {kind: 'boss', boss: 'deepseek', tier: 'story'}`、特性 `peak-valley`、招式包含 `weight-drop`、品质 ≥A；同种子结果相同，不同 `runSeq` 结果不同。②`sanitizeCreature` 保留签名特性和签名招式；把同样的特性和招式放到 `origin.kind: 'wild'` 的 V4 上会被清掉。③`bossCardCap`：0→10、1→14、7→51、8→100。④带教确定性模拟：击杀序列 `[50, 28, 37, 61] + [35]×5 + [57, 75, 67, 74, 102, 57, 71, 107] + [96]×30`，队伍最高等级 10，上场 9 个击杀、替补 14 个击杀到 Lv10（复刻评审 N 的 `catchup2.py`）。⑤上限与储备：Lv10 的卡在 0 徽章时再拿 500 经验，等级仍是 10，`exp` 不超过 `expForLevel(22)`；`settleBank` 到 1 徽章后等级为 14 并学会途中的招式。⑥老 Boss 卡（`origin.kind: 'legacy'`）不受上限约束。⑦`gainExp` 不传 `opts` 时行为与改动前相同 |
| `tests/boss.test.ts`（扩展） | ①`resolveBossDef`：`rules.peak.takenMul` 覆盖为 0.15，未出现的规则不变；`byStarter.deepseek-v3` 的 hp 1.8 覆盖 2.5；`assist` 最后合并。②`foeCompany`：玩家出场 V3 时 `family` 规则生效，出场 o1 时不生效。③`residualMul`：寄生对体验版每回合吸取 = `floor(maxHp/8 × 0.4)`。④**体验版胜率**（新辅助模块 `tests/boss-story.ts`，策略移植自评审 N 的 `story_boss.ts`：朴素、合格玩家（`tools/balance/pilot.ts`）、引导）：队伍为首发 Lv8 + 文心一言 Lv6（带 `embedding-orb`）+ `phi-3` Lv5，背包 5 药 2 券，每种搭档 120 个种子：引导 ≥85%、合格 ≥50%、减负下合格 ≥90%、引导胜局平均 6–16 回合。⑤`boss.deepseek.contract` 存在。⑥`peak-valley` 的 `turnCycle` 在第 1–3 回合和第 4–6 回合分别生效 |
| `tests/balance-framework.test.ts`（扩展） | `tools/balance` 新增 `bosscard` 子命令：V4 卡在上限（徽章 2/4/6 → Lv19/29/41）、个体值全 19、带权重空投，单挑馆 3/5/7 的馆主整队，各 100 个种子，胜率 ≤50% |
| `tests/creature.test.ts`（扩展） | `gainExp(..., {levelCap})` 的边界 |
| `tests/save-*.test.ts` | `rollSeed` 缺失时生成，并且重载后保持不变；`instances` 被清洗成非负整数 |
| `tests/story.test.ts` | `ds-terminal` 的锚点存在，`storyProblems()` 为空 |

**测试耗时：** ④一共 3 个搭档 × 3 种策略 × 120 次，要控制在 60 秒内。超出就把合格玩家和引导降到 80 个种子，并把阈值的统计余量写进注释。

### 开发场景

| 场景 | 内容 |
|---|---|
| `ds-boss-story` | 首发 Lv8（参数可选三种搭档）+ 文心一言 Lv6 带嵌入光球 + phi-3 Lv5；背包 2 券 5 药；`then: [{"cmd": "battle.boss", "args": {"boss": "deepseek", "tier": "story"}}]`；`rng: 41` |
| `ds-capture` | 同上，加 `capture.force success`，停在签约画面 |
| `bosscard-catchup` | V4 卡 Lv1 + 首发 Lv10，站在 `route:route-1:3` |
| `bosscard-bank` | V4 卡 Lv10、储备 3 级、0 徽章；`then: badge.set 1` 验证结算 |

### 验收截图（每项 × d1000r / m390 / m844）

1. 模拟舱终端的对话和选项。
2. 体验版战斗：对手名牌上有"体验版"字样和时段栏；球页提示"打赢后可以签约"。
3. 签约画面：成功率 100% + 选球（触屏两步）。
4. 回滚动画结束帧："Lv1"，V4 说签约台词。
5. Boss 版鉴定卡：金框、BOSS 角标、签名特性镶金边。
6. 队伍列表：BOSS 角标、`Lv10/10`、"储备 +3"。
7. 详情页：算力许可和储备两行。
8. 拿到徽章后的 Toast"算力许可升级"和学招画面。
9. 跟随者对话（到顶台词）。

### 验收数字

- 体验版胜率达到测试清单④的目标；
- 读档：进 Boss 房后强制刷新页面再打赢，签约出来的个体值、性格、特性与第一次完全相同；
- 带教 9 / 14；
- 首个徽章把 Lv10 的卡结算到 Lv14。

### 预发布验证（prev）

- 新档选完搭档后，用模拟舱打体验版，签约成功，卡为 Lv1；
- 在 1 号道路打 3 场，卡追到 Lv8 以上；
- 老档：已有战斗中抓到的 V4，不受上限约束。

### 风险

- **`engine.ts` 同时在 #32 和 WP12a 里被修改：** `awardExp` 和 `condHolds` 的改动面要小，并提前和 #32 对齐。
- **V3 线数值偏乐观：** 评审脚本把认亲近似成对全队生效。实装 `foeCompany` 后要按测试④重测，旋钮是 `byStarter.deepseek-v3.statMul.hp`（1.8）和 `family.takenMul`（4）。另加一条目标"V3 朴素 ≤60%"，保证机制不能被跳过。
- **`sanitizeCreature` 的放宽可能被伪造：** 一张 Lv1、带签名特性的"Boss 卡"可以被伪造出来。交易台已经拒绝；PvP 提交队伍时同样校验 `origin.boss` 必须存在、物种必须匹配。
- **M1b 先于 M1c 上线：** 新玩家第一小时就能从终端拿到卡。这和最终设计一致，只是入口不同。

---

## M1c 新序章与 DeepSeek 引导战

### 目标与玩家可见变化

- 新档按 0003 §2.2 的 11 拍走，主线 7 个新阶段，目标条一次只指向一个地方。
- 上岗证三个印；研究所地下两层；文心一言送招；陪练一号入队。
- 前厅有简报、补给、回血机和 V2 陪练；走廊有阿转；DeepSeek 体验版有教练条；输了回前厅，有减负模式；签约之后出发。
- 序章期间 HUD 只显示"当前目标"。57 张教学弹窗按表处置。打开浮层时战斗和剧情暂停。触屏文案修好。
- 老档迁移到 v3：门禁全开，DeepSeek 作为可选任务从模拟舱进入。

### 不做

- 不做第一章以后的剧情；不做 5 个战斗粒度的惊喜机制（M2）；
- 不改游荡 Boss；不碰遇敌率。

### 改动清单

**A. 地图**

| 位置 | 改动 |
|---|---|
| `content/world/towns.json`（原点镇 `buildings.lab`） | `{"interior": "lab", "below": ["lab_b1", "lab_b2"]}` |
| `src/shared/world/towns.ts:122-125` | 读 `bs.below`：`mapIds` 为 `[baseId, ...below.map((_, k) => `${baseId}-b${k + 1}`)]`；`floors` 为 `[interior, ...below]`；`DoorLink` 加 `belowCount` |
| `src/shared/world/interiors.ts:74-80` | 地上楼层仍用 `up`/`down` 配对。新增：第 k 层（k=0 是地面，往下依次）的 `links.down` 和第 k+1 层的 `links.up` 配对，生成 `kind: 'stairs'` 的双向传送；地下楼层的 `spawn` 取 `links.up.arrive`；"楼梯不匹配"的检查对称处理 |
| `content/world/layouts/interiors.json:lab` | `props` 加 `{"prop": "stairs_down", "x": <x>, "y": <y>}`；`links` 加 `down: {x, y, arrive, facing}`；`anchors` 加 `stairs`、`stairs-front`、`stairs-side`。由布局负责人选格子，要求从入口 `arrive`（7,10）可达、不挡 `starters-front`、`rival`、`aide-2` |
| `content/world/layouts/interiors.json`（新模板 `lab_b1`） | 16×10，`nameZh` 为"研究所·潮汐机房 前厅"，`palette` 同 `datacenter`；`links.up`、`links.down`；`anchors`：`r1`、`r1-front`、`supply`、`heal`、`v2`、`v2-front` |
| `content/world/layouts/interiors.json`（新模板 `lab_b2`） | 16×12，`nameZh` 为"研究所·潮汐机房 核心"，地面局部铺 `shallow`；`links.up`；`anchors`：`queue`（走廊中段）、`core`、`core-front` |
| `content/world/layouts/towns.json:town_start.signs` | 加 `{"slot": "board", "x": <x>, "y": <y>, "kind": "board"}`，放在广场（`town:origin:square` 一侧），在家到研究所的路上 |
| `content/world/towns.json`（原点镇 `signs`） | 加 `"board": "原点镇公共算力节点\n白天：高峰期，排队∞\n凌晨：谷时半价，排队 3"`（沿用现有路牌写法） |

**B. 主线阶段平移（逐条，[verified] grep）**

| 位置 | 改动 |
|---|---|
| `content/world/story/quests.json:2`（`main.stages`） | 在下标 0 之后插入 7 个阶段（文本和目标见 0003 §3.2）；旧阶段 1–12 变成 8–19 |
| `content/world/story/npcs/story.json:4`（博士脚本） | 删除 `quest main 1`，整段替换为 `ds-professor`（见 C） |
| `content/world/story/scripts.json:25`（`main-progress`） | 11 个常量 1–11 改为 8–18；整个 `badgeTiers` 外面包一层 `{"op": "ifFlag", "flag": "ds:gateOpen", "then": [...], "else": []}` |
| `content/world/story/scripts.json:83` | `stage 12, done` → `stage 19, done` |
| `content/world/story/trainers/story.json:31` | `stage 12` → `19` |
| `content/tutorial.json:71`（`quests` 提示卡） | `stage.min 1` → `8` |
| `content/dev/beats.json:7` | `main.stage 4` → `11` |
| `tests/dev-commands.test.ts:89`、`tests/dev-scenarios.test.ts:168` | 期望值 4 → 11 |
| `tests/onboarding.test.ts:38` | 按新阶段表改断言（`stages[2]` 现在是"去 1 号道路收服一位队友。"） |
| `content/world/story/migrations.json`（新） | `{"mainStage": {"3": {"from": 1, "add": 7}}}` |

**C. 剧本与 NPC**（`content/world/story/scripts.json` 和 `npcs/story.json`；对白键见 0003 附录 A）

| 脚本 / NPC | 内容 |
|---|---|
| `ds-professor`（替换 `professor` 的选搭档分支） | `lab.p1`、`nar1`、`p2`、`p3` → `chooseStarter` → `byStarter` 反应 2 句 → `showNpc rival-lab` → `rival.z1`、`z2` → `include rival-lab-battle`（台词键换成 `rival.zWin`/`zLose`）→ `include ds-zero-down`（0003 附录 A 的样例） |
| `rival-lab` | `hiddenUnlessFlag: "starter"`，保留 `hiddenIfFlag: "rival:lab"` |
| `rival-lab-back`（新） | 站在 `origin-lab:stairs-front`，默认隐藏，由脚本显示和隐藏 |
| `aide-types` → `ds-aide` | `a1` → `choice [optLesson, optSkip]`。上课：`include type-lesson-battle`（保留它原有的 3 瓶药和 `teach typeChart`）→ `a2`。跳课：`aSkip`，`giveItem cache-potion 3`，`setFlag ds:skipLesson`，`teach typeChart`。之后共通：`a3` → `a4` → `giveCreature {species: "phi-3", level: 5, gradeFloor: "B"}` → `say phi3`（`portrait: "creature:phi-3"`）→ `setFlag ds:stamp:types` → `quest main 2` |
| `trainers/tutorial.json:lesson-types` | 不改：三只陪练正好是三种搭档各克一只，保证一次"效果拔群" |
| `ds-ernie`（新 NPC） | 站在 `route:route-1:1` 加 `offset`（落在高草格上，不挡路）；`creature: "ernie-bot"`；`hiddenUnlessFlag: "ds:stamp:types"`、`hiddenIfFlag: "ds:ernie"`。脚本：`emote "!"` → `e1` → `e2` → `wildBattle {species: "ernie-bot", level: 6, moves: ["token-tackle", "web-crawl", "morning-greeting", "embedding-orb"], catchRateMul: 1.6, gradeFloor: "B"}` → `ifCaught ernie-bot`（`atLeast: 1`）为真则 `e4` + `setFlag ds:ernie`，否则 `e3` |
| `content/species.json:ernie-bot.teachable` | 加 `"embedding-orb"`（文件 1.1 MB，用 `jq` 或脚本修改，不要整体读写） |
| `trainers/routes.json:r1-xin` | `introText`、`defeatText` 改用 `story.opening.trainer.xinIntro`/`xinDefeat`（如果训练家文本只支持内联，就内联写同样的句子） |
| `content/world/story/triggers.json`（新） | `[{"id": "ds-stamp-catch", "on": "dex:caught", "when": {"flag": ["ds:stamp:types"], "noFlag": ["ds:stamp:catch"]}, "script": "ds-stamp-catch", "once": true}, {"id": "ds-first-spark", "on": "region:entered", "match": {"region": "route-1"}, "when": {"flag": ["ds:done"], "noFlag": ["ds:spark"]}, "script": "ds-spark-show", "once": true}]` |
| `ds-stamp-catch` | `ernie.stamp`（旁白）→ `setFlag ds:stamp:catch` → `setFlag ds:certFull` → `quest main 3` → `sfx notify` → 小 R 来电 `call.r1–r5`（`r3` 前插入 `byStarter` 的 `rO1`/`rHaiku`/`rV3` 之一，`portrait: "creature:deepseek-r1"`）→ `setFlag ds:called` |
| `ds-guard-yard`（新） | 站在 `town:origin:professor`，`sprite: "villager_man"`，`lines: ["story.opening.town.guardYard"]`，`hiddenIfFlag: "ds:gateOpen"` |
| `o-guard`（`npcs/towns.json:5`） | 加 `hiddenUnlessFlag: "ds:gateOpen"` |
| `ds-guard`（新） | 站在 `origin-lab:stairs-front`，`hiddenIfFlag: "ds:certFull"`。脚本：`g1` → 缺 `ds:stamp:types` 说 `needTypes`，否则说 `needCatch` |
| `ds-guard-aside`（新） | 站在 `origin-lab:stairs-side`，`hiddenUnlessFlag: "ds:certFull"`；第一次对话说 `gate.ok`，之后说 `gate.after`（`ds:done` 后） |
| 进入 `origin-lab-b1` | 触发器 `{"on": "map:entered", "match": {"map": "origin-lab-b1"}, "when": {"flag": ["ds:certFull"], "noFlag": ["ds:briefed"]}, "script": "ds-enter-lobby"}` → `quest main 4` |
| `ds-r1`（新，b1:`r1`，`creature: "deepseek-r1"`） | 第一次：`b1` → `choice [optBrief, optSkip]`。听简报：`b2`–`b5`。跳过：`skip` + `setFlag ds:skipBrief`。之后共通：`giveItem off-peak-coupon 3`（含 1 张练习券）→ `setFlag ds:briefed` → `bossBattle {boss: "deepseek-drill", tier: "story", coach: true}` → `drill.v2b` → `setFlag ds:drill` → `quest main 5`。再次对话：`again` → `choice [再练一轮 / 不用了]`。前厅败后的逻辑见 D |
| `ds-v2`（新，b1:`v2`，`creature: "deepseek-v2"`） | `drill.v2a`，纯装饰 |
| `ds-supply`（新，b1:`supply`，`role: "clerk"`） | 进入交互就 `setFlag ob:shopped` → `supply` → `shop {"items": ["cache-potion", "prompt-ball", "few-shot-ball"]}` → `teach shop` |
| `ds-heal`（新，b1:`heal`） | 进入交互就 `heal` + `setRespawn` + `setFlag ob:healed` → 旁白 `heal`；每次进入 b1 限用一次，用旗标 `ds:healUsed`，进入 b1 时清除 |
| `trainers/tutorial.json` | 加 `ds-relay-o1`、`ds-relay-claude-haiku`、`ds-relay-deepseek-v3`：各 3 只 Lv6，对首发属性克制，`pick` 限 N（`earlyCaps`），保证触发 `takenSuper`；`reward` 按 `rewardPerLevel`；`ds-scalper` 不做 |
| `ds-relay`（新 NPC，b2:`queue`） | `starterBattle {trainer: "ds-relay"}`，`sightRange: 4`，开战前说 `queue.relay1`、`relay2`，赢后说 `relayAfter` → `quest main 6` |
| `ds-v4`（新，b2:`core`，`creature: "deepseek-v4"`） | `include ds-core`（结构同 v1 附录的样例，台词换成 v2 的键）：`choice [optPolite, optWake]` 写入 `ds:approach`（`polite` 或 `wake`）→ `bossBattle {boss: "deepseek", tier: "story", coach: true, captureAfterWin: true, lossWarp: "origin-lab-b1:r1-front", lossContinues: true, lossFlag: "ds:lost"}` → 胜利时（在战斗结果回调里，签约画面之前）`setFlag ds:gateOpen` → 签约画面里按 0003 附录 A 的顺序穿插 `signed.*` → `setFlag ds:done` → `quest main 7` |
| `professor`（`ds:done` 之后的分支） | `depart.p7` → V4 `v5` → 小 R `r6` → `p8` → `quest main 8` |
| `rival-depart`（新，`town:origin:rival`） | `hiddenUnlessFlag: "ds:done"`、`hiddenIfFlag: "ds:departed"`；`z10`、`z11` → `setFlag ds:departed` |
| `ds-spark`（新，`route:route-1:3` 加 `offset`） | 由 `ds-spark-show` 显示，`creature` 为一只 Lv5 的 N（`pick` 受 `earlyCaps` 约束），带光环。脚本：`wildBattle {pick: …, level: 5, gradeFloor: "S", aura: "spark"}` → `setFlag ds:spark` |
| 东、北、南巡逻员（`npcs/story.json` 的 `block-*`） | `hiddenIfFlag` 从 `starter` 改为 `ds:gateOpen`，台词改为 `town.patrolBusy`；西出口的两名保持 `starter` |
| `ds-gate-opensource`（新，`town:opensource:exit-east`） | `hiddenIfFlag: "ds:gateOpen"`，`lines: ["story.opening.town.barrierBusy"]` |
| `os-greeter`（新，开源林镇入口内侧） | `hiddenUnlessFlag: "ds:done"`、`hiddenIfFlag: "ds:greeted"`；队伍里有 V4 时说 `town.greeter`，然后置旗 |
| `ds-terminal`（M1b） | `hiddenUnlessFlag` 改为 `ds:legacy` |
| 镇民 `*After` 台词 | 小满、花店阿姨、保安加 `ifFlag ds:done` 分支（键见附录 A） |
| 妈妈（`npcs/story.json:3`） | `m1`–`m3`；`ds:done` 后说 `after1`，队伍里有 V4 时再加 `afterV4`（`speaker: story.cast.v4`） |
| `game.json:newGame.introScript`（`:8-16`） | 换成 4 句：`intro.n1`、`phone1`、`phone2`（中间 `sfx notify`）、`wake`；删除 `game.intro.hint` 这一步 |
| 护士（`scripts.json:2`） | `setFlag ob:healed` + `setRespawn` 挪到 `choice` 之前 |
| 店员（`scripts.json:10`） | `choice` 之前加 `setFlag ob:shopped` |

**D. 剧本操作、宏、触发器（`src/shared/types.ts:820` 契约 + `src/client/world/script.ts:106`）**

| 项 | 改动 |
|---|---|
| `wildBattle` | 加 `moves?`、`catchRateMul?`、`gradeFloor?`、`aura?`；`host.wildBattle` 改为接收 opts（`controller.ts:1160` 的 `startWildBattle` 一并改）。`catchRateMul` 写进 `init.mods.catchRate`（`engine.ts:1334` 已经会乘）；`aura` 交给渲染层画金色光环 |
| `giveCreature` | 加 `gradeFloor?`、`nature?`、`moves?`、`ability?` |
| `bossBattle` | 加 `coach?`、`lossWarp?`。输了并且有 `lossWarp`：淡出 → 传送到锚点 → `heal` → `include ds-loss`，并且 `abort` 原脚本 |
| `emote`（新） | `{target, fx}`，复用 `content/game.json` 已有的 emote 气泡（`emoteBubbleMs`） |
| `openScreen`（新） | `{screen: 'typeChart'}` 打开 `src/client/ui/screens/typechart.ts` |
| 宏 `byStarter`、`starterBattle` | 在 `src/shared/world/story.ts:634` 附近（`rivalBattle` 旁边）展开：`byStarter` 变成一串 `ifFlag starter equals <id>`；`starterBattle` 变成 `byStarter` 下的 `battle {trainer: <trainer>-<starter>}`。`storyProblems` 校验每种搭档都有变体 |
| `NpcSpec.creature`（`story.ts:69`） | 智灵 NPC 用跟随者的广告牌渲染（`src/client/world/follower.ts` 那一套），不需要人物贴图 |
| `say.portrait: "creature:<id>"` | 对话框立绘：有 `/assets/portraits/creature-<id>.png` 就用，否则把智灵贴图裁成半身 |
| `{species:<id>}` | 文本查表，和现有的 `{type:}` 写法一致 |
| 触发器运行时 `src/client/world/triggers.ts`（新） | 订阅触发器里用到的事件；条件用 `onboarding/logic.ts:13` 的 `condHolds`；只在 `controller.ts:139` 的 `isFree()` 为真时执行，否则排队等到 free；`once` 写旗标 `trig:<id>` |
| 文本命名空间 | `content/text/zh-CN/story.json`（新），在 `src/shared/content/index.ts:28-43` 加一行导入（契约）；退路是 `world.json` 的 `world.story.*` |

**E. Boss 引导战**

| 位置 | 改动 |
|---|---|
| `content/bosses.json:bosses.deepseek` | 加 `coach`（0003 §3.4.3 的 JSON）；`meters[tide]` 加 `"cycle": {"period": 6, "from": 0, "to": 3}`；加 6 个教练触发器（见下） |
| `content/bosses.json:bosses.deepseek-drill`（新） | `species: "deepseek-v2"`，`level: 7`，`scriptedOnly: true`，`expMul: 4`，`canRun: false`，`statMul {hp: 0.8, atk: 0.3, spa: 0.3}`；周期 4：`peak` 为 `turnCycle {period: 4, from: 0, to: 2}`，`takenMul 0.2`；`valley` 为 `from: 2, to: 4`，`takenMul 2.0`；`coupon` 触发器同 deepseek；`family` 规则同体验版；`catchRateMul: 0`；`reward` 为空；教练只有 `drill.valley`、`drill.coupon` 两条 |
| `src/shared/content/index.ts:150` | `bossBySpecies` 排除 `scriptedOnly`（`byId(bossList.filter((b) => !b.scriptedOnly), 'species')`） |
| `src/shared/types.ts:526` `BossOp` | 加 `{ op: 'coach'; text: string }`；`:743` `BattleEvent` 加 `{ t: 'coach'; text; speaker; portrait? }`；`:623` `BossMeterDef` 加 `cycle?` |
| `src/shared/battle/boss.ts` | `coach` 动作只在 `init.coach` 为真时发出；同一 `text` 每场只发一次；每场最多 `coach.maxPerFight` 条；`init.skipBrief` 为真时只放行 `skipBriefLines`；`start` 按 `starter` 选 `startO1`/`startHaiku`/`startV3`，没有对应变体就用 `start` |
| 教练触发器 | `start`：`on: start`。`peakEndsNext`：`on: turnEnd`，`turnCycle {period: 6, from: 2, to: 3}`，`turnAtMost: 6`。`valleyStart`：`on: turnEnd`，`turnCycle {from: 3, to: 4}`，只发第一次。`peakAgain`：`on: turnStart`，`turn === 7`，加新条件 `foeHasItem: "off-peak-coupon"`。`residual`：`on: turnEnd`，`bossHas: {volatile: "leech"}` 或任一异常，且 `meter tide atMost 0`。`ownLow`：`on: turnEnd`，`foeHpBelow: 0.3`，`turnAtLeast: 7`。需要的新 `BossCond`：`foeHpBelow`、`bossHas`、`foeHasItem`、`turnAtMost` |
| `src/shared/battle/engine.ts`（战斗结束） | 输出 `BattleSummary`：`damageByMeterState`（以 tide 为键）、`baitTagsUsed`、`healItemsUsed`、`faintedByMeterState`、`enraged`、`turns`、`foeHpLeft` |
| `src/client/battle/coach.ts`（新） | 教练条：小 R 头像 + 一行文字（≤24 字），放在消息窗上方，不进命令按钮区。只在命令菜单出现时显示 `coach` 事件队列的头一条，玩家选定指令后收起；不设计时；触屏点一下收起 |
| `src/client/battle/menus.ts` | 第一轮（回合 1–6）：高峰期且包里有 bait 道具时，"背包"按钮脉冲；谷时"战斗"按钮脉冲。纯视觉效果，`init.coach` 为真时才有 |
| `src/client/battle/model.ts:272` `bossPanelInfo` | 渲染 `cycle` 倒计时点 `●●○`（当前段还剩几回合） |
| `src/client/onboarding/index.ts:108` | `init.coach` 为真的战斗不处理 `battleCues`，也不写"已看过"标记；战斗结束后按原规则补发 |
| `ds-loss`（脚本） | 小 R 说 `lossHints` 匹配出的句子 → 包里没有券就补 1 张（`refill`）→ 判断减负条件（`instances.json:defaults.assistAfterLosses`、`assistEarly`，读 `instances[id].losses` 和上一场的 `BattleSummary`）→ 满足就 `choice [assistYes, assistNo]`（副标题 `assistHint`），选是则 `setFlag ds:assist` 并说 `assistOn` → `choice [retry, train]`，选"直接再战"就传送到 `origin-lab-b2:core-front` 并 `include ds-core`（跳过开场，`ds:met` 已置） |
| `src/client/world/battles.ts`（`boss` 函数） | `init.assist = flags['ds:assist']`；`init.skipBrief = flags['ds:skipBrief']`；败北时 `instances[id].losses.story += 1`，胜利时清零 |
| `content/world/instances.json` | 加 `defaults`（0003 §3.4.4 的 JSON）和 `deepseek-tide.lobby`、`lossHints` |

**F. 引导系统**

| 位置 | 改动 |
|---|---|
| `content/tutorial.json:tips.list`（57 张） | 按下表处置 |
| `src/client/onboarding/logic.ts:13` `condHolds` / `Cond` 类型 | 加 `device?: ('keyboard' \| 'gamepad' \| 'touch')[]`，`LiveView` 提供 `device`（`ctx.input.lastDevice`） |
| `src/client/onboarding/logic.ts:109` `tipLive` | `expires` 允许数组，任一条件成立就算过期 |
| `dex:seen` 事件 | 载荷加 `kind`（`wild`/`trainer`/`boss`），`rarity` 提示卡只匹配 `wild` |
| `src/client/onboarding/view.ts:63-75` | 阶段变化时展开 `objective.collapseSec`（7 秒）再收起（现在是变化时直接折叠） |
| `src/client/ui/hud.ts:32-44`（任务卡） | 当 `tutorial.json:objective.hideQuestCardUntilFlag`（`"ds:gateOpen"`）未置位时隐藏 `.ap-quest` |
| `content/text/zh-CN/tutorial.json` | `tip.battle`、`tip.save`、`tip.hud` 加 `bodyTouch`（文本见 0003 §3.9 和评审 O-I5）；新课和新提示卡的文本 |
| `content/tutorial.json:curriculum.lessons` | 新增 `bossMechanic`、`bait`、`capture`、`grade`（`bossCard` 在 M1b 已加），各有手册页；`pickups.tips` 只剩 `groundItem`；`worldMap.tips` 只剩 `worldMap`；`trade`、`pvp` 改为指向 `online`；`box.tips` 留空，靠 `npcs: ["box-origin"]` 满足"至少一个触发" |
| 新提示卡 `roamTouch` | 触发：`ds:stamp:types` 之后第一次进入 1 号道路，且视野内有游荡野生；文本："画面里走来走去的智灵，碰一下就能开战。" |

**57 张提示卡的处置（来自评审 O-I1）：**

| 处置 | 键 | 具体改法 |
|---|---|---|
| 剧（7） | `objective` | 弹窗退役；`curriculum.objective.npcs: ["mom"]`；目标条第一次出现时展开 7 秒 |
| | `menuHint` | 退役；博士给图鉴时说一句"按 {menu} 看看"，配合红点 |
| | `typeMatchup` | `trigger.needs.flag: ["lesson:typeChart"]`，`expires: [{"minStat": {"battlesWon": 1}}, {"flag": ["lesson:typeChart"]}]`，实际上等于退役 |
| | `superEffective`、`resisted` | `expires` 加 `{"flag": ["lesson:typeChart"]}`（数组） |
| | `catch`、`caught` | `expires` 加 `{"flag": ["ds:ernie"]}` |
| 境（16） | `move` | `needs.device: ["keyboard", "gamepad"]`（触屏有摇杆首用动画） |
| | `save` | `needs.flag: ["ds:done"]`；加 `bodyTouch` |
| | `hud` | `needs.flag: ["ds:done"]`；加 `bodyTouch` |
| | `stab` | `needs.flag: ["ds:done"]` |
| | `statGlossary` | 触发改为第一次打开详情页的能力页 |
| | `trainer` | `needs.flag: ["ds:ernie"]`（零是 `lossContinues`，"输了扣钱"对他不成立） |
| | `battleEffects`、`status`、`crit`、`weather`、`ability`、`immune`、`doubleType` | 教练战里静音且不写已看标记（见 E），战后按原规则弹 |
| | `rarity` | `dex:seen` 的 `kind` 只匹配 `wild` |
| | `quests` | `stage.min 8` |
| | `badge` | `needs.flag: ["lic:settled"]`（`settleBossCards` 结算完后置位；没有 Boss 卡时也置位） |
| 删（4） | `signs`、`fly`、`tradePvp`、`center` | 从 `tips.list` 删除，手册页保留；`tradePvp` 的内容并进 `online` |
| 保留（30） | `talk` `groundItem` `grass` `menu` `battle`（加 `bodyTouch`）`moveInfo` `catchFail` `takenSuper` `faintOwn` `levelUp` `moveLearn` `evolve` `party` `teamBuild` `bag` `shop` `exchange` `chips` `bike` `surf` `hurt` `gym` `worldMap` `sideQuest` `worldEvent` `timeWeather` `research` `dex` `online` `chat` | 不改触发条件 |

**G. 浮层暂停**（所有者要求；优先放进 #32，#32 没合入就在这一刀做最小实现）

| 位置 | 改动 |
|---|---|
| `src/client/battle/`（循环入口） | 新状态 `paused`：战斗内打开状态页、克制表、手册或背包时置为真。为真时消息计时（`message.ts:113` 的 `held += battleMs(dt, …)`）、动画、Boss 演出和教练排队都传入 `dt = 0` |
| `src/client/onboarding/index.ts` | `ctx.ui.isBlocking()` 为真时，提示卡层的时钟（`clock`、`pending.at`、`staleSec`）不走 |
| `src/client/world/triggers.ts` | 非 `isFree()` 时排队（见 D） |
| `src/client/core/clock.ts` | `ctx.ui.isBlocking()` 为真时游戏时钟不走（克制表和手册属于 blocking 浮层） |

**H. 存档 v3**

| 位置 | 改动 |
|---|---|
| `content/config.json:26` | `save.version` 2 → 3 |
| `src/client/core/save-migrate.ts` | 步骤表加 `3: v2to3`：①`flags.starter` 存在时置 `ds:gateOpen`、`ds:legacy`。②`quests.main.stage` 按 `migrations.json:mainStage["3"]` 处理：`stage >= from` 时加上 `add`。③版本号置为 3 |
| `tests/fixtures/save-v2-*.json` | 用 M1a 迁移后的 3 份夹具 |

**I. 文本修正（红线，评审 R-§5.3）**

| 位置 | 改动 |
|---|---|
| `content/text/zh-CN/boss.json:astra.taunt2` | "#keep4o 的坟头草，都两米高了"改为"#keep4o 的白月光，还挂在墙上" |
| `content/text/zh-CN/boss.json:minimax.gossip2` | "它好像悄悄似了"改为"它好像悄悄下架了" |

### 新增 JSON 键（节选；完整对白见 0003 附录 A、B）

**`content/world/story/quests.json:main.stages`（插在下标 0 之后）：**

```json
[
  {"text": "找阿灵上属性课，盖第二个印。", "target": "origin-lab:aide-2"},
  {"text": "去 1 号道路收服一位队友。", "target": "route:route-1:1"},
  {"text": "回研究所，给保安看上岗证。", "target": "origin-lab:stairs-front"},
  {"text": "在机房前厅找小 R 报到。", "target": "origin-lab-b1:r1"},
  {"text": "穿过排队走廊。", "target": "origin-lab-b2:queue"},
  {"text": "叫醒核心机柜上的她。", "target": "origin-lab-b2:core"},
  {"text": "回一楼向博士复命。", "target": "origin-lab:professor"}
]
```

**`content/items.json`（关键道具）：**

```json
{"id": "work-permit", "nameZh": "上岗证", "category": "<同 dex-device>", "price": 0, "buyable": false,
 "description": "图灵研究所签发。盖满三个印，机房保安放行。", "effect": {"kind": "none"}, "usableInBattle": false, "usableInField": false}
```

**`content/tutorial.json:objective`：**

```json
{"hideQuestCardUntilFlag": "ds:gateOpen", "collapseSec": 7}
```

**`content/world/story/quests.json`（可选任务）：**

```json
{"id": "ds-legacy", "nameZh": "潮汐机房", "kind": "side", "stages": [{"text": "研究所的模拟舱里，DeepSeek 体验版还在等你。", "target": "origin-lab:terminal"}]}
```

### 测试清单

| 文件 | 断言 |
|---|---|
| `tests/opening.test.ts`（新） | ①阶段链：在 `storyProblems()` 为空的前提下，从新档沿脚本图走到阶段 8，每个阶段的 `target` 在 `worldAnchors()` 里存在且从上一个目标步行可达（`walkReach`）。②`choice` 全分支：遍历序章所有 `choice` 的每个分支，都能到达设置下一阶段的那一步（防止护士、店员式的卡死）。③连续 `say` ≤4：用 `walkSteps` 检查序章所有脚本，连续 `say` 超过 4 个之间必须有 `emote`、`moveNpc`、`choice`、`wildBattle`、`battle`、`bossBattle` 之一。④所有 `story.*`、`boss.deepseek.*` 文本键都存在。⑤三种搭档的 `byStarter` 和 `starterBattle` 变体齐全。⑥时长模型：按评审 O §5 的参数（对话框 4 秒、回合 10 秒、步速 3.6 格/秒），脚本最短路径到 `bossBattle` ≤12 分钟。⑦三个印分别由 `ds-professor`、`ds-aide`、`ds-stamp-catch` 置位，`ds-guard` 在 `ds:certFull` 前挡住楼梯格 |
| `tests/boss.test.ts`（扩展） | ①教练：每条 `boss.deepseek.coach.*` 去掉占位符后 ≤24 字。②用 `ds-boss-story` 的队伍回放 50 局，每局教练事件 ≤6 条，选了"我都懂"时 ≤4 条，同一键不重复。③陪练：o1、Haiku 首发 Lv6 + 文心一言 Lv4 和首发 Lv8 + 文心一言 Lv6 两种配置，合格玩家都是 100%；V3 在 Lv8/6 时 ≥90%。④`bossBySpecies` 不包含 `deepseek-drill`，野生 V2 仍按普通智灵处理 |
| `tests/story.test.ts`（扩展） | "封闭的起始镇"断言改为：没有 `starter` 时只有研究所能进；有 `starter` 没有 `ds:gateOpen` 时只有西出口通；有 `ds:gateOpen` 时全通 |
| `tests/story-branches.test.ts` | 主线阶段集合覆盖 0–19 |
| `tests/curriculum.test.ts` | 新课都有手册页和至少一个触发；删除的 4 张卡不再被课程引用 |
| `tests/onboarding.test.ts` | `Cond.device`；`expires` 数组任一成立即过期；教练战里 `battleCues` 被静音且不写已看标记；阶段变化时目标条展开 |
| `tests/save-migrate.test.ts`（扩展） | v2→v3：有搭档的存档得到 `ds:gateOpen` 和 `ds:legacy`；阶段 1→8、12 且 done → 19 且 done；阶段 0 不变；幂等 |
| `tests/dev-commands.test.ts`、`tests/dev-scenarios.test.ts` | 期望阶段 11 |
| `tests/overworld.test.ts` 或 `tests/buildings.test.ts` | 生成出 `origin-lab-b1`、`origin-lab-b2`；楼梯双向传送配对；`origin-lab` 的地图 id 不变 |
| `tests/touch-layout.test.ts`（或新建） | `tip.battle`、`tip.save`、`tip.hud` 都有 `bodyTouch`；触屏下 `introScript` 不含键盘键名 |

### 开发场景

| 场景 | 内容 |
|---|---|
| `opening-cert` | 已选 o1、打过零、盖了印①；站在阿灵面前 |
| `opening-ernie` | 盖了印②；站在 1 号道路入口 |
| `ds-lobby` | 三个印齐全；站在 `origin-lab-b1:r1-front`；首发 Lv7 + 文心一言 Lv6 + phi-3 Lv5 |
| `ds-boss-story`（M1b 已有） | 加 `coach: true` |
| `ds-loss-assist` | `instances.deepseek-tide.losses.story = 1`；`then`：强制输一场（`capture.force` 的对称命令 `battle.forceResult lose`），停在败后画面 |
| `after-deepseek` | 节拍 `after-deepseek`：`ds:done`，V4 卡 Lv1，站在研究所门口 |

### 验收截图（每项 × d1000r / m390 / m844）

1. 开场第一帧：目标条展开，没有任务卡。
2. 广场公告牌的对话框。
3. 零被拍回的对话（带立绘）。
4. 背包里的上岗证。
5. 阿灵的"上课 / 我都懂"选项。
6. 文心一言遭遇战：招式列表里有"嵌入光球"。
7. 小 R 来电（智灵立绘）。
8. 保安挡住楼梯。
9. 前厅全景（3 个智灵 NPC、补给员、回血机）。
10. 陪练战：教练条、倒计时点、"背包"脉冲。
11. Boss 战命令菜单里的教练条（m390 竖屏重点检查不压命令按钮）。
12. Boss 战中打开克制表（暂停状态，背景回合数不变）。
13. 败后画面：小 R 一句话、减负的两个按钮、"直接再战 / 去练级"。
14. 签约对话（V4 签约台词）。
15. 开源林镇入口"D 老师？！"。
16. 触屏下的战斗提示卡（显示 `bodyTouch` 文案）。
17. `hud-phone`：目标条 + Toast + 摇杆 + 一张提示卡同时出现时，相互不遮挡，也不遮挡玩家。

### 验收数字

- **时长：** 桌面端 3 次录屏，新手视角（不选"我都懂"，首战照常打）。
  - 进 Boss 战的中位时间 ≤25 分钟，最慢一次 ≤35 分钟；签约加出发完成 ≤35 分钟；
  - 熟练视角（两次"我都懂"）1 次 ≤15 分钟；
  - 录屏放在 `output/41/m1c/`，在 PR 里上传。
- **等级：** 进 Boss 战时首发 Lv8–9（截图队伍页）。
- **暂停：** 在 `ds-boss-story` 的回合开头打开克制表停 30 秒，关闭后回合数、消息位置和教学卡队列都不变。
- **老档：** 3 份 v2 夹具迁移到 v3 后，玩家站在原地，所有出口畅通，研究所里出现模拟舱。

### 预发布验证（prev）

- 新档完整走一遍：手机竖屏、手机横屏、桌面各一次；
- 故意连输两次：第二次败后出现减负选项；
- 老存档码导入后能直接出镇。

### 风险

- **内容量大：** 新增约 20 个 NPC、15 段脚本、2 张图。建议按 A–I 拆成小提交，由一人整合；剧本改动先在 `tests/opening.test.ts` 里跑通，再接美术。
- **生成器：** `towns.ts` 和 `interiors.ts` 的地下楼层改动会影响所有建筑的生成，要跑 `tests/buildings.test.ts`、`tests/overworld.test.ts`，并确认世界其余部分的地图 id 和锚点集合不变（快照对比 `worldAnchors()` 的键集合，只允许新增）。
- **#32 未合入：** 教练条和暂停要自己做最小实现，合并时要和 #32 对齐。
- **契约：** `story.json` 文本命名空间需要契约负责人同意；不同意就走 `world.story.*`。
- **时长靠实测：** 新手时长是主观的，以 3 次录屏为准。如果超过 25 分钟，优先砍掉对话，不去提高战斗经验。
- **触发器时序：** 小 R 来电要在收服动画和鉴定卡全部结束、`isFree()` 之后才执行，否则会叠在鉴定卡上。
