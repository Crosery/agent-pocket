# 教学大纲 · 必要知识清单

每个玩家必须学会的内容，及其教学触发。数据在 `content/tutorial.json` 的 `curriculum`（课程）与 `tips`（提示），文本在 `content/text/zh-CN/tutorial.json`（`tutorial.tip.*` 提示、`tutorial.manual.*` 手册页）。
`tests/curriculum.test.ts` 保证：清单里的每一项都有手册页和至少一个能触发的教学（提示或 NPC `teach` 步骤），且不存在无归属的提示。

## 机制

- **提示**（tip）：一次性小卡片，同一时刻只出一张，按顺序排队；`after` 保证先后，`expires` 让已学会的老玩家不被打扰，排队超过 `staleSec` 作废。卡片可点击、按取消键关闭、点「不再提示」永久关闭（设置里可重开），7 秒自动消失，不盖住角色。
- **NPC 课**：NPC 脚本里的 `{op:"teach", lesson}` 记录该课已学（`lesson:<id>` 标记）。属性课还带引导战斗：研究所阿灵的三只陪练，保证三个初始智灵都能亲手打出「效果拔群」和「效果不佳」。
- **教学手册**：菜单 →「教学手册」，按分组翻页回看每一课，已学的打钩。
- 触发 `on` 可监听总线事件（打开界面、获得徽章、进入地图、任务更新、见到稀有智灵、联机上线、世界事件……）和战斗中的教学时刻（克制、抵抗、免疫、双弱点、暴击、异常、增减益、天气、特性、倒下、升级、可进化、收服成功/失败）。

## 清单

### 基础操作

| 必要知识 | 之前的覆盖 | 现在的触发时机 | 形式 | 手册页 |
|---|---|---|---|---|
| 移动与奔跑 (`move`) | tip `move` | `move`：空闲 1.2s | 提示 | `tutorial.manual.move` |
| 对话与交互 (`talk`) | tip `talk` | `talk`：走近 NPC 2 格 | 提示 | `tutorial.manual.talk` |
| 当前目标 (`objective`) | 无 | `objective`：空闲 3s（已有标记 intro:mom） | 提示 | `tutorial.manual.objective` |
| 路牌与拾取 (`pickups`) | 无 | `signs`：走近路牌<br>`groundItem`：走近地上的道具 | 提示 | `tutorial.manual.pickups` |
| 高草丛与野生智灵 (`grass`) | tip `grass` | `grass`：踏入高草丛 | 提示 | `tutorial.manual.grass` |
| 菜单 (`menu`) | tip `menuHint` + `menu` | `menuHint`：空闲 2.5s（已有标记 starter）<br>`menu`：首次打开菜单 | 提示 | `tutorial.manual.menu` |
| 存档 (`save`) | 无 | `save`：`battle:end`，result="win"（回到大世界后） | 提示 | `tutorial.manual.save` |
| 小地图与时间 (`hud`) | 无 | `hud`：空闲 4s（已有标记 ob:route1） | 提示 | `tutorial.manual.hud` |

### 战斗

| 必要知识 | 之前的覆盖 | 现在的触发时机 | 形式 | 手册页 |
|---|---|---|---|---|
| 战斗指令 (`battle`) | tip `battle` | `battle`：战斗开始 | 提示 | `tutorial.manual.battle` |
| 招式的信息 (`moveInfo`) | 无 | `moveInfo`：`turn`，turn=2（战斗中） | 提示 | `tutorial.manual.moveInfo` |
| 属性克制 (`typeChart`) | tip `typeMatchup`（仅一段文字） | `typeMatchup`：战斗开始（wild/trainer/gym/legend）<br>`superEffective`：`superEffective`，side=1（战斗中）<br>`resisted`：`resisted`，side=1（战斗中）<br>NPC `aide-types`：对话时 `teach`，含引导战斗 `lesson-types` | 提示 + NPC 课+引导战斗 | `tutorial.manual.typeChart` |
| 免疫 (`typeImmune`) | 无 | `immune`：`immune`（战斗中） | 提示 | `tutorial.manual.typeImmune` |
| 双属性 (`dualType`) | 无 | `doubleType`：`doubleSuper`（战斗中） | 提示 | `tutorial.manual.dualType` |
| 本系加成 (`stab`) | 无 | `stab`：战斗开始（wild/trainer/gym） | 提示 | `tutorial.manual.stab` |
| 六项基础能力 (`stats`) | tip `statGlossary`（开局即弹，时机不对） | `statGlossary`：`battle:end`，result="win"（回到大世界后） | 提示 | `tutorial.manual.stats` |
| 增益与减益 (`statStages`) | tip `battleEffects`（战斗外弹出） | `battleEffects`：`stat`（战斗中） | 提示 | `tutorial.manual.statStages` |
| 异常状态 (`status`) | 无 | `status`：`status`（战斗中） | 提示 | `tutorial.manual.status` |
| 暴击、天气与特性 (`battleField`) | 无 | `crit`：`crit`（战斗中）<br>`weather`：`weather`（战斗中）<br>`ability`：`ability`（战斗中） | 提示 | `tutorial.manual.battleField` |
| 收服智灵 (`catch`) | tip `catch` | `catch`：战斗开始（wild）<br>`caught`：`caught`（回到大世界后） | 提示 | `tutorial.manual.catch` |
| 球的种类 (`balls`) | 无 | `catchFail`：`catchFail`（战斗中） | 提示 | `tutorial.manual.balls` |
| 训练家对战 (`trainerBattle`) | 无 | `trainer`：战斗开始（trainer/gym） | 提示 | `tutorial.manual.trainerBattle` |
| 战斗中换人 (`switchOut`) | 无 | `takenSuper`：`takenSuper`，side=0（战斗中） | 提示 | `tutorial.manual.switchOut` |
| 倒下与复活 (`faint`) | 无 | `faintOwn`：`faintOwn`（战斗中） | 提示 | `tutorial.manual.faint` |
| 经验与升级 (`levelUp`) | 无 | `levelUp`：`levelUp`（回到大世界后） | 提示 | `tutorial.manual.levelUp` |
| 学习新招式 (`moveLearn`) | 无 | `moveLearn`：`moveLearnable`（回到大世界后） | 提示 | `tutorial.manual.moveLearn` |
| 进化 (`evolve`) | 无 | `evolve`：`evolveReady`（回到大世界后） | 提示 | `tutorial.manual.evolve` |

### 队伍与道具

| 必要知识 | 之前的覆盖 | 现在的触发时机 | 形式 | 手册页 |
|---|---|---|---|---|
| 队伍与出战顺序 (`party`) | 无 | `party`：`screen:opened`，screen="party"（打开界面时） | 提示 | `tutorial.manual.party` |
| 配队思路 (`teamBuild`) | 无 | `teamBuild`：`party:changed`（回到大世界后） | 提示 | `tutorial.manual.teamBuild` |
| 背包 (`bag`) | 无 | `bag`：`screen:opened`，screen="bag"（打开界面时） | 提示 | `tutorial.manual.bag` |
| 商店买卖 (`shop`) | 无 | `shop`：`screen:opened`，screen="shop"（打开界面时）<br>NPC `clerk-origin`：对话时 `teach` | 提示 + NPC 课 | `tutorial.manual.shop` |
| 物品兑换 (`exchange`) | 无 | `exchange`：`screen:opened`，screen="exchange"（打开界面时）<br>NPC `clerk-origin`：对话时 `teach` | 提示 + NPC 课 | `tutorial.manual.exchange` |
| 技能芯片 (`chips`) | 无 | `chips`：空闲 2s（背包有chip类道具） | 提示 | `tutorial.manual.chips` |
| 关键道具 (`keyItems`) | 无 | `bike`：空闲 2s（背包有 hover-board）<br>`surf`：空闲 2s（背包有 dive-protocol） | 提示 | `tutorial.manual.keyItems` |
| 治疗与补给 (`heal`) | tip `hurt` | `hurt`：队伍有智灵 HP < 50%<br>NPC `nurse-origin`：对话时 `teach` | 提示 + NPC 课 | `tutorial.manual.heal` |
| 仓库 (`box`) | 无 | `center`：`map:entered`，mapId={"endsWith": "-center"}（回到大世界后）<br>NPC `box-origin`：对话时 `teach` | 提示 + NPC 课 | `tutorial.manual.box` |

### 世界与成长

| 必要知识 | 之前的覆盖 | 现在的触发时机 | 形式 | 手册页 |
|---|---|---|---|---|
| 道馆挑战 (`gym`) | 无 | `gym`：`map:entered`，mapId={"startsWith": "gym-"}（回到大世界后） | 提示 | `tutorial.manual.gym` |
| 徽章 (`badge`) | 无 | `badge`：`badge:earned`（回到大世界后） | 提示 | `tutorial.manual.badge` |
| 地图与飞行 (`worldMap`) | 无 | `worldMap`：`screen:opened`，screen="map"（打开界面时）<br>`fly`：`badge:earned`（回到大世界后） | 提示 | `tutorial.manual.worldMap` |
| 任务与悬赏 (`quests`) | 无 | `quests`：`quest:updated`，questId="main"，stage={"min": 1}（回到大世界后）<br>`sideQuest`：`quest:updated`，questId={"startsWith": "sq-"}（回到大世界后） | 提示 | `tutorial.manual.quests` |
| 世界事件与情报 (`worldEvent`) | 无 | `worldEvent`：`world:event`（回到大世界后） | 提示 | `tutorial.manual.worldEvent` |
| 稀有度 (`rarity`) | 无 | `rarity`：`dex:seen`，rarityOrder={"min": 2}（战斗中） | 提示 | `tutorial.manual.rarity` |
| 昼夜与天气 (`timeWeather`) | 无 | `timeWeather`：空闲 6s（已有标记 ob:route1，夜晚） | 提示 | `tutorial.manual.timeWeather` |
| 智灵研究 (`research`) | 无 | `research`：`screen:opened`，screen="research"（打开界面时） | 提示 | `tutorial.manual.research` |
| 图鉴 (`dex`) | 无 | `dex`：`screen:opened`，screen="dex"（打开界面时） | 提示 | `tutorial.manual.dex` |

### 联机

| 必要知识 | 之前的覆盖 | 现在的触发时机 | 形式 | 手册页 |
|---|---|---|---|---|
| 在线与离线 (`online`) | 无 | `online`：`screen:opened`，screen="online"（打开界面时） | 提示 | `tutorial.manual.online` |
| 聊天 (`chat`) | 无 | `chat`：`net:status`，status="online"（回到大世界后） | 提示 | `tutorial.manual.chat` |
| 交易 (`trade`) | 无 | `tradePvp`：`screen:opened`，screen="online"（打开界面时） | 提示 | `tutorial.manual.trade` |
| 玩家对战 (`pvp`) | 无 | `tradePvp`：`screen:opened`，screen="online"（打开界面时） | 提示 | `tutorial.manual.pvp` |

## 物品兑换

店员柜台新增「兑换废料」：`content/exchange.json` 的 `desks.general.offers`，用野外捡到的数据碎片、坏硬盘、旧显卡等换药品、球和进化道具，档位随徽章数开放；规则在 `src/shared/gameplay/exchange.ts`（兑换所得的标价不得高于所交材料的标价，有测试）。脚本步骤 `{op:"exchange", desk}`。
