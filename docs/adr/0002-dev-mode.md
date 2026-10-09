# ADR 0002：开发者调试模式（控制台、自动化接口、场景预设、建筑编辑器）

- **状态：** 已采纳（第 9 节第 1、3 项由主控按推荐方案定；第 2 项待所有者确认）；**已实现**，与原设计的差异和未做项见第 11 节
- **Issue：** #30，分支 `task/30/dev_mode`（`ap-wt/t30`）
- **依据代码：** `integrate/0.2` @ 19182e1
- **关联：** ADR 0001（WP2 调试钩子剔除、WP4 种子启动、WP5/WP6 服务端权威、WP8 房间）

## 背景

所有者 10-09：「给我们的游戏加个开发者的调试模式，里面对应所有的游戏元素控制以及对应的数据更改和快速 mock 验证，包括里面的建筑的移动和摆放，随机数种子，以及快速去对应的事件剧情和相关的建筑」「我建议你去好好研究下这个调试模式怎么给你的测试和我的测试赋能」。

服务两类使用者：所有者的人工验收（游戏内面板、一键场景），以及多智能体 QA（稳定接口、确定性、场景、断言、截图）。

## 0 现状与发现

**已有能力：**
- URL 参数（`src/client/debug.ts:43` 的 `readDebugParams`）：`?dev=1` 加 `skipTitle / slot / reset / map,x,y / t / weather / battle=wild|trainer|boss / species / level / trainer / boss / evolve / screen`。
- `window.__ap`（`debug.ts:188-225`）共 13 个函数：`boss pos tp region gates places discover fly fog distance clock weather roamers`。
- `window.__AP`（整个 GameContext）和 `__apOnboarding` 直接暴露内部对象（`game.ts:408-410`）。
- F3 叠加层（`debug.ts:229`）；`debugSave` 生成 6 只 30 级智灵、99999 金钱（`content/game.json` 的 `debug` 段）。

**问题：**
1. **正式包带着全部调试代码 [verified：代码，主控已核对线上]。**
   - `debug.ts` 是静态 import（`game.ts:22`），是否启用只看运行期的 `?dev=1`。
   - 线上包 `index-EOg5VBNs.js` 同样只判断 `get('dev')==='1'`，就挂出 `window.__AP`。
   - 联机档案的图鉴数、徽章、队伍由客户端上报（ADR 0001 §1），任何人都能借此改排行榜。
   - 结论：M0 最先做，作为热修复候选。
2. **QA 脚本与内部实现强耦合。**
   - 8 个 `scripts/qa-*.mjs` 加 #29 的 `qa-layout-audit.mjs`，共约 120 处 `__AP` / `__ap` 调用、十多处 `import('/src/...')`，还有靠 `setTimeout` 等待的。
   - 所有 agent 共用一个浏览器的 `localStorage`，BRIEF 只好要求每人一个 10 位存档槽。
3. **随机不可复现。**
   - 遇敌和战斗种子来自 `world/controller.ts:76`，剧情赠送来自 `world/script.ts:49`，都是 `Date.now() ^ Math.random()`；`debugSave` 用 `Date.now()`。
   - 主循环用 rAF 的真实 dt。
   - 渲染层约 30 处 `Math.random()`，截图逐像素不稳定。
4. `scripts/dev.mjs:5` 设了 `AP_DEV=1`，服务端从不读取。
5. `vite.config.ts:15` 是 `server.host: true`，开发服务器监听局域网，任何写盘接口都必须限制来源。
6. **建筑只来自模板，且没有来源信息。**
   - 摆放写在 `content/world/layouts/*.json`：`buildings / props / signs / anchors`，以及 ASCII 行里的图例字符。
   - 模板可能被水平镜像（`world/data.ts:108-124`），再按 `rect + 局部坐标` 盖到地图上（`world/towns.ts:104-107`）。
   - `PropPlacement`（`types.ts:772`）不带来源；scatter、decor、frontier、hamlet 都是生成物。
7. **没有独立的 LOD 系统。** 细节层级由 `render.json` 的 `quality.low…ultra` 档位决定（`viewRadius / maxChunks / decorDensity / natureVariants / grassPerTile / particleScale`）。

## 1 可控元素与状态归属

| 元素 | 运行期状态 | 定义与规则 | 现有入口 |
|---|---|---|---|
| 存档 | `ctx.save`，存在 `localStorage`（`core/save.ts`），经 `save-sanitize.ts` 清洗 | `config.save` | `slot`、`reset`、存档码 |
| 队伍和智灵 | `save.party`、`save.boxes` | `shared/creature.ts`（`createCreature`、`sanitizeCreature`、`legalMoves`）、`species.json`、`moves.json` | `debugSave`、Boss 沙盒 |
| 道具和金钱 | `save.bag`、`save.money`；改动走 `world/save-ops.ts`、`battle/saveops.ts`、`ui/screens/shop.ts` | `items.json`、`exchange.json`、`config.economy` | 无 |
| 徽章和图鉴 | `save.badges`、`dexSeen`、`dexCaught` | `world.badges`（由 `world/towns.json` 的 gym 生成） | 无 |
| 剧情 flag 和任务 | `save.flags`、`save.quests`；由 `world/script.ts` 执行 | `content/world/story/*.json`（15 个任务、scripts、npcs），由 `shared/world/story.ts` 装配 | 无 |
| 事件和彩蛋 | `save.events / legends / research`；`world/events-runtime.ts`（内部已有 `triggerEvent`） | `content/events/*.json`、`shared/gameplay/*` | 无 |
| NPC | `world/npcs.ts`、`hiddenIfFlag` | 剧情里的 npcs、trainers、population，坐标来自锚点 | 无 |
| 世界和种子 | `World`（`shared/world/index.ts:80` 的 `buildWorld(seed)`，约 1.9 s）、`FrontierProvider` | `config.world.seed`、`content/world/**`、`frontier/gen.json`、`shared/noise.ts` | `places / gates / fly` |
| 建筑和摆件 | `GameMap.props / warps / signs` | 模板在 `layouts/*.json`；生成物在 `scatter.json`、`frontier/decor.json` | 无 |
| 地区 | `regionAt` | `world/regions.json`、`frontier/regions.ts` | `region()` |
| 天气和时钟 | `ctx.clock.minutes`、`ow.setWeatherOverride`、事件天气 | `weathers.json`、`climate.json`、`config.time` | `t / weather / clock()` |
| 遇敌和游荡 | controller 的随机源、`world/encounters.ts`（`rollEncounter` 是纯函数）、`roaming.ts`、`rarity-spawns.ts` | `config.encounters`、地区遇敌表 | `roamers()`、`battle=wild` |
| 战斗 | `BattleEngine` 的 `Rng(init.seed)`；命中 `engine.ts:792`、伤害浮动 `:802`、暴击 `:833`；`ai.ts`；`boss*.ts` | `bosses.json`、`battle_rules.json`；倍速由 `battle/speed.ts` 和 `config.battleSpeeds` 控制（#29） | `battle=*`、`boss()` |
| 引导和提示 | `save.flags` 中的 `tip:*` 与课程前缀（`onboarding/config.ts:106`），`onboarding/logic.ts` | `tutorial.json` | `__apOnboarding` |
| 联机 | `net/client.ts`（远端玩家、RTT）、`src/server/*` | `net.json`、`multiplayer.json` | `__AP.net` |
| 渲染、物理、光照、LOD | `RENDER`（`render/config.ts:770`）、`Settings` | `render.json`（`quality` 档位，以及 `physics / occlusion / reflections / leaves` 等约 40 段）、`physics-config.ts` | F3 叠加层 |

## 2 架构：一个命令注册表，五个入口

借鉴的做法：
- Unreal 的 `CheatManager` 在 Shipping 版本里编译剔除；
- Source 引擎的 `sv_cheats` 由服务器授予；
- Minecraft 的命令和"允许作弊"世界标记；
- Unity / SRDebugger 用元数据生成调试面板；
- Godot 的远程场景树；
- Factorio 的确定性输入回放。

**设计要点：**
- **命令注册表**（`src/client/dev/registry.ts`）：每条命令是 `{ id, args: schema, mutates, needs: 'live'|'rebuildWorld'|'reload', run(host, args) }`。
- **五个入口都只调用注册表：**
  1. 面板（按 `content/dev/console.json` 生成）；
  2. 命令行（例如 `tp town:forge`、`give special-sauce 3`）；
  3. URL 参数 `&cmd=`；
  4. 场景的 `then`；
  5. `window.__ap.v1.cmd()`。

  命令只写一次，手测和自动化同时可用。
- **DevHost 接缝：**
  - `game.ts` 只改三处：开发模式时动态 import `src/client/dev/index.ts`；`createInput` 改为可包装的工厂；`frame()` 的 dt 和暂停交给 `devClock`。
  - 另外，场景模式注入内存存储。
  - `OverworldExt` 加 `devHandles()`，暴露 gameplay runtime（`triggerEvent`）、NPC 层和遇敌。
- **覆盖层：**
  - 对 `CONTENT / RENDER / GAME` 做 JSON merge-patch，在 boot 时生效。
  - `console.json` 标注每条路径能否实时生效。
  - 覆盖只存在 `agent-pocket/dev/overrides`，点"写回 JSON"后才进入内容文件。
- **数据都放在内容文件里：**
  - 面板布局、预设、白名单、场景、剧情节点、队伍预设放在 `content/dev/**`；文案放在 `content/text/zh-CN/dev.json`，启动时并入 `CONTENT.text`。
  - 这些文件只被 `src/client/dev/**` 引用，因此不进正式包。
- **不新增依赖：** 面板用自己的 DOM 和 `dev.css`，不依赖 `ui/kit.ts`、`widgets.ts`。

## 3 开发者控制台（人工验收）

### 3.1 标签页

| 标签页 | 控制项 |
|---|---|
| 世界 | 设置或随机种子；重建世界（约 2 s，保留存档和位置）；`frontier/gen.json` 和 `world.json` 噪声参数中白名单路径的滑块；前线重置；导出地图 PNG（复用 `sandbox/world-png.ts`） |
| 跳转 | 搜索全部锚点（`town:* / hamlet:* / poi:* / dungeon:*:floorN:boss / wild:* / gate:* / quest:*`）、建筑内部（`<town>-<slot>`）、事件地点、前线地点（`placesIn` 后接 `discover` 和 `fly`）、剧情节点（先套用节点状态，再传送） |
| 剧情 | flag 表（从内容扫描出全部已知 flag，未知的标红）；任务阶段选择（`quests.json`）；剧情节点（`content/dev/beats.json`）；分支选择器（列出脚本里的 `choice` 分支，并写入对应 flag） |
| 事件 | 列出全部事件，逐条显示条件是否成立及原因（时间、天气、地点、flag）；立即触发、重置状态；生成或重置传说 |
| 队伍 | 编辑物种、等级、经验、招式（只能从 `legalMoves` 里选）、个体值、特性、闪光、状态、HP、亲密度、携带物；改完后用 `sanitizeCreature` 显示被裁剪的字段；进化、回满、放入盒子 |
| 道具 | 按名称或类别发放；设置金钱；开关单个徽章；图鉴全见或按属性填满 |
| 战斗 | 野战、训练家战、Boss 战（任意物种和等级）；队伍预设 `plain / counter / 当前队伍`；随机种子；强制暴击、未命中、伤害浮动取极值、捕获必成；自动驾驶；超过玩家选项的倍速 |
| 环境与显示 | 时间滑块、流速、冻结；天气种类和强度；画质档位（即 LOD），以及逐键覆盖 `viewRadius / maxChunks / decorDensity / natureVariants / grassPerTile / particleScale`；光影、物理、遮挡、反射、落叶、脚印开关；角色动作库（全部角色 × 4 个方向 × 待机/行走，可逐帧步进） |
| 遇敌 | 指定下一次遇敌（物种、等级、闪光）、遇敌率倍率、驱散开关、游荡智灵列表（可传送过去） |
| 联机 | 延迟、抖动、丢包（以停顿模拟）、断线；假服务器与假玩家；本地服务器机器人（见 3.4） |
| 引导 | 重置引导；提示画廊（逐条显示是否可见，以及哪个条件不成立，可单独弹出） |
| 验收 | 按 issue 分组的一键场景（`content/dev/acceptance/<issue>.json`），由 worker 随 PR 一起提交 |

每个可操作的控件都带 `data-dev-cmd="<命令 id>"`，作为自动化的稳定选择器。

### 3.2 桌面与手机
- **入口：** 反引号键（`KeyboardEvent.code` 写在 `content/dev/console.json` 的 `panel.toggleCode`，由调试模块自己的 keydown 监听处理，`Esc` 关闭；不进 `content/input.json`，因为 `Input` 本来就不处理可编辑控件里的按键，调试键不该成为游戏的输入动作）。开发模式下底部居中常驻一个可点击的 `DEV` 徽标，同时显示世界种子、随机种子和场景 id；手机上靠它打开面板。F3 叠加层保留。
- **布局：** 宽屏为右侧抽屉，宽 420 px。窄屏或触屏为底部抽屉，高 62%，标签页做成可横向滚动的标签条。触控目标不小于 44 px。
- **输入隔离：** 面板或编辑器打开时关闭角色操控，并调用 `input.setTouchControlsVisible(false)`；两者都关闭后恢复（`src/client/dev/ui/gate.ts` 按持有者计数）。面板内的按键事件不再冒泡到游戏。
- **布局来源：** 标签页、分区、预设按钮、读数、选择列表全部来自 `content/dev/console.json` 的 `panel`；`≤ panel.compactMaxWidth`（700 px）时变成底部抽屉。`tests/dev-panel.test.ts` 保证每个控件指向真实命令、预设和列表项通过同一套参数校验、所有文案存在、没有面板够不到的命令。
- **编辑器触屏操作：** 点按选中，单指拖动，浮动工具条提供旋转、删除和撤销。

### 3.3 建筑与摆件编辑器

**来源记录：**
- 开发模式下，`buildWorld(seed, { provenance })` 为每个摆件、建筑、告示牌和锚点记录 `{ file, pointer, transform }`。
- `transform` 包括模板原点、是否镜像和占地宽度，用来把世界坐标换回模板的局部坐标；镜像时 `x = w − x′ − footprintW`。
- 只记录来自模板的内容。生成物显示为只读，并标出产生它的规则。

**交互：**
- 点击地块即可选中。
- 拖动时显示吸附到格子的半透明影子，松手才提交。
- 旋转：`rot` 取 0–3。建筑固定朝南，所以建筑不提供旋转。
- 从 `content/dev/editor.json` 的调色板里选摆件放置；可以删除。
- 撤销和重做通过保存反向 patch 实现。

**提交流程：**
1. 在内存中修改模板，然后重建世界。
2. 验证：调用 `canPlace`；`worldBuildInfo().problems` 不能比改动前多；`validateWorldContent()` 必须通过。
3. 验证失败就回滚，并显示具体问题；验证通过就写回 JSON。

**写回接口：**
- 由 Vite 插件 `scripts/vite-dev-api.ts` 提供（`apply: 'serve'`），正式构建和 devtools 构建里都没有。
- 路径为 `POST /__ap/dev/content`，请求体为 `{ file, baseHash, ops: RFC6902 }`。
- **安全检查：**
  - 只接受回环地址；
  - 校验 `Origin`；
  - 校验每次启动时生成、通过 `transformIndexHtml` 注入页面的 `x-ap-dev-token`；
  - 只接受 `application/json`；
  - 文件必须在 `editor.json` 的白名单内。
- **写入流程：**
  - `baseHash` 与当前文件不符时返回 409；
  - 写入前在 Node 端再跑一次校验器；
  - 原子写入；
  - 用 `python3 tools/content_fmt.py` 格式化（参数用数组传，不拼 shell 字符串）。
- **刷新行为：** 对自己的写入抑制 HMR 整页刷新，改发 `ap:content-updated` 事件。之后刷新页面读到的就是新 JSON，所以位置保持不变。[verified] 实测：页面标记在两次写入后仍在，Vite 日志没有对应的 `page reload`。写入前先登记「自己的写入」，因为文件监听可能早于接口返回就报告改动。
- **实现细节：**
  - 来源记录用模块级 sink（`src/shared/world/provenance.ts`，`buildWorld(seed, { provenance })` 才开启，不传时零开销），除每个物件外还记录模板覆盖的区域（放置新摆件时用）。
  - 只记录来自 `towns.json`、`interiors.json`、`gyms.json` 模板的建筑、摆件、告示牌、锚点；洞穴、前线、POI、散布、路线都是生成物，只读。
  - 一个模板可被多个城镇共用（`town_gym_a` 被 `opensource` 与镜像的 `forge` 共用），编辑改的是模板，所以所有使用处一起变；选中时显示「N 处共用同一模板」。
  - 编辑的模型在 `src/client/dev/editor/session.ts`（无 DOM，Node 可测），补丁与反向补丁在 `src/shared/dev/editor.ts`。
  - 写前校验在子进程里跑（`scripts/dev/validate-edit.ts`）：分别用原文件和候选文件建世界，新增构建问题或内容错误即拒绝（422）。
  - 写回接口还提供 `GET ?file=` 返回文件哈希，作为 `baseHash` 的来源。
  - 运行中的游戏不会立刻换成新世界：编辑器自己重建一份带来源的世界做校验，工具条提供「重新载入」。

### 3.4 联机模拟（不改 `net/client.ts`）

`client.ts` 只用了 `new WebSocket(url)`、`onopen / onmessage / onclose / onerror`、`send` 和 `close`（`client.ts:218-247`）。因此调试模块在 `net.connect()`（`game.ts:491`）之前，把 `window.WebSocket` 换成 `DevSocket`：
- **延迟、抖动：** 收发两个方向分别排队延时。
- **丢包：** WebSocket 跑在 TCP 上，不会真的丢消息。这里按 TCP 重传的表现模拟：按概率让整条流停顿，时长从 RTO 区间里抽取，不会乱序。
- **断线：** 一键断开。
- **假服务器：** 没有服务器、或场景要求时启用。由页面内的模拟端回复 `welcome`、`online`，并以 10 Hz 发送 N 个假玩家的 `snapshot`。行走模式写在 `content/dev/net-sim.json`，消息类型用 `shared/protocol.ts`。
- **真机器人：** 本地服务器上的机器人由 `scripts/dev/bots.ts` 提供。

## 4 自动化接口（智能体测试）

### 4.1 `window.__ap`（v1）

```ts
window.__ap = { version: 1, v1: {
  info(),                                // { build, commit, contentHash, worldSeed, rngSeed, scenario, taint }
  cmd(id, args?), cmds(),                // 唯一改动入口；cmds() 自描述参数 schema
  state: { dump(sections?), diff(a, b), digest() },   // 分 save / runtime / world 三段的规范 JSON
  scenario: { list(), load(id, opts?), check() },
  time: { pause(), resume(), step(frames, dt?), scale(x) },
  rng: { seed(n), cursor() },            // 各随机流已抽取的次数
  input: { press(a), hold(a, frames), axis(x, y, frames), record(), stop(), replay(rec) },
  wait: { ready(), free(), map(id), battle(phase), screen(id), event(name, match?) },  // 都带 timeoutMs，超时抛错并附 dump
  expect: { state(pointer, matcher), noErrors(), layout(scope?) },
  shot: { prepare({ hideDev, hideHud, settleFrames }), release() },
  events: { since(cursor) }, log(),      // GameEvents 环形缓冲；log() 取代 __AP_LOG
} }
```

- 旧的 `pos / tp / …` 保留一个版本作为别名，调用时打印弃用提示。
- QA 脚本不得再使用 `__AP` 和 `import('/src/...')`，运行器启动时会检查。

### 4.2 状态导出与对比
- `dump()` 的 `runtime` 段包括：地图、位置、移动模式、`free`、战斗状态、天气、时钟、地区、任务导航目标、引导目标和当前提示、UI 栈、网络状态、随机流游标。
- `diff` 用来断言"买一瓶药只改变了 `/save/money` 和 `/save/bag/potion`"，从而抓出意外的副作用。

### 4.3 确定性：一个主种子
- **随机源：**
  - 新增 `src/client/core/rng-hub.ts`，由主种子派生出 `encounter / script / battle / debug / cosmetic` 几条随机流。
  - 不开调试时，主种子每局随机，行为与现在一致。
  - `controller.ts:76`、`script.ts:49` 和调试存档改用它。
- **种子入口：**
  - 世界种子用 `&seed=`：调试模式下改 `game.ts:154`，以后由 ADR 0001 WP4 统一。
  - 随机种子用 `&rng=`。
  - 场景文件里有同名字段。
- **时间控制：** `devClock` 提供暂停、固定步长和倍率。同一个场景、同一个随机种子、同一段输入，得到同一个状态摘要。
- **不在 #30：** 渲染层的 `Math.random` 改用 `cosmetic` 流，放到 #16、#17 合入之后。
- **测试**（`tests/dev-determinism.test.ts`，单文件约 5 s CPU）：
  - **世界：** 同一个种子 `buildWorld` 两次，核心大陆摘要相同；两个独立的 `FrontierProvider` 在若干采样坐标上的区块哈希相同。
  - **遇敌：** `RngHub(S)` 的 `encounter` 流沿一条固定的草丛路径，调用 `rollEncounter`（`world/encounters.ts:39`）和 `createCreature`，再生成战斗种子（同 `battles.ts:126`）。两次得到的序列相同。
  - **战斗：** 用这些 `init` 跑 `BattleEngine`，双方都由 AI 出招，事件流 JSON 两次相同。
  - **反证：** 换成 `S+1`，以上三项都要变化。
  - **接线：** 浏览器用例 `determinism-walk` 以固定步长回放同一段输入，加载两次，`battle:start` 记录的物种、等级和种子必须一致。

### 4.4 场景预设
- **入口：** 场景文件放在 `content/dev/scenarios/*.json`，用 `/?dev=1&scenario=<id>` 直接进入。在 devtools 构建里，`&scenario` 本身就会开启调试。
- **存储：** 场景模式默认用内存存储（`createSaveManager` 已支持注入 `storage`），不占存档槽；只有显式传 `&slot` 时才写 `localStorage`。

```json
{ "id": "boss-astra-counter", "extends": "after-gym-3", "seed": 20261002, "rng": 7,
  "place": "town:forge", "clock": { "minutes": 1290, "frozen": true }, "weather": "rain",
  "party": [{ "team": "boss-counter:astra" }], "bag": { "special-sauce": 3 }, "flags": { "tip:battle-intro": true },
  "then": [{ "cmd": "battle.boss", "args": { "boss": "astra" } }],
  "expect": [{ "path": "/runtime/battle/kind", "eq": "boss" }] }
```

- **字段：** `extends / seed / rng / place / party / team / bag / money / badges / flags / quests / clock / weather / net / then / expect`。
- **应用器：** 纯函数放在 `src/shared/dev/scenario.ts`，输入场景和世界，输出 `SaveData` 和待执行命令。浏览器和 Node 共用这一份。
- **校验：** `beats.json`、`teams.json` 由测试检查引用的内容都存在。`tests/boss-counters.ts` 改为读取同一份 `teams.json`，这件事与 #27 协调。

首批场景（id 都已对照内容核对）：

| id | 内容 | 用途 |
|---|---|---|
| `fresh-start` | 新档，原点镇，引导开启 | 开场、引导 |
| `tutorial-first-battle` | 只有初始智灵，停在第一场野战前的课程状态 | 引导提示（#25） |
| `after-gym-3` | 徽章 `badge-code / badge-vision / badge-sound`；`quests.main.stage=4`（目标 `quest:6`）；道馆训练家已击败的 flag 取自 `beats.json`；位置 `town:chord` | 剧情中段 |
| `boss-astra-counter` | `gpt-6-astra` 62 级，破解队，`special-sauce` ×3，直接开战 | Boss（#27） |
| `night-rain-forge` | `town:forge`，21:30 冻结，雨天 | 光影、物理（#16、#17） |
| `frontier-far` | 主大陆外约 1500 格，已发现若干地点 | 前线生成、LOD |
| `ui-worst-case` | 6 只智灵都用最长昵称并带异常状态，满背包，8 枚徽章 | 布局审计（#29） |
| `fake-peers-square` | 原点镇广场，假服务器加 12 个假玩家 | 联机显示、插值 |
| `determinism-walk` | 草丛路径起点，固定种子 | 确定性用例 |

### 4.5 录制与回放
- 在 `Input` 接口层录制每一帧的 held、pressed（含长按重复）、released、方向轴和 dt；回放时用一个替身 `Input` 驱动固定步长。接缝只有 `game.ts` 里的一行：`dev ? dev.wrapInput(createInput(root)) : createInput(root)`；`src/client/dev/replay.ts` 的 `InputTap` 同时承担录制、回放和脚本输入（`input.press / hold / axis`）。游戏不走帧（暂停、页面隐藏）时脚本帧不前进；`time.step` 手动走的帧会前进。
- 回放文件绑定提交哈希和内容哈希，版本不匹配就拒绝回放；还记录开始时存档的摘要，不一致时只在结果里报告 `startMatches: false`。
- 回放只作为 bug 复现的附件，不作为长期回归资产。
- 局限：不录制 DOM 上的鼠标点击。

### 4.6 截图与运行器
- **截图：** `shot.prepare` 依次暂停时间，隐藏面板和光标，等资源和流式加载空闲，再等若干帧。截图由 ego-browser 执行，报告同时记录 `digest()`。
- **Node 端：** `tests/dev-scenarios.test.ts` 逐个场景应用，检查：sanitize 后没有字段丢失、地点能解析、`expect` 成立、引导目标和任务导航能给出结果、Boss 场景能用自动驾驶打完。
- **浏览器：**
  - `node scripts/qa/run.mjs <suite|all> [--space <id>] [--base <url>] [--out <dir>]` 读取 `content/dev/suites/*.json`，把用例展开（`each` 展开、`viewports` 乘开）后，连同 `scripts/qa/browser.mjs` 一起通过标准输入交给 `ego-browser nodejs` 执行（ego-browser 把脚本的 console 输出写在 stderr，运行器从那里读结果），逐个用例执行"加载场景 → 命令或输入 → 等待 → 截图、导出状态、断言"。启动时检查 `scripts/qa/` 与套件 JSON 不含 `__AP` 和 `import('/src/...')`。
  - 输出 `report.json`、`report.md` 和 `overview.html`（所有截图的缩略图拼图）。套件可声明 `guard`（如 `cleanGit`: 套件结束后 `git status` 在指定路径下必须干净）。
  - 套件有四个：`scenarios`（9 个场景）、`dev-panel`（13 类 × d1280 与 m390 触屏，每格带 `expect.layout`）、`editor`（拖动 → 文件变化 → 撤销哈希一致；移动 → 刷新后位置保持 → 移回哈希一致，`cleanGit` 守卫）、`determinism`（同场景、同种子、同脚本输入加载两次，状态与 `battle:start` 摘要一致）。`actors` 套件未做，见第 11 节。

### 4.7 对测试的帮助

| 现在 | 换成 | 效果 |
|---|---|---|
| `qa-character-idle.mjs`（直接 import 渲染配置、改 `__AP.save.avatar`、靠 sleep 等待） | `actors` 套件，加角色动作库 | 侧面待机抬脚的问题（5492bf8，所有者验收时才发现）一屏就能看出；agent 可以先产出逐帧拼图 |
| `qa-hud-layout`、`qa-party-layout`、#29 的 `qa-layout-audit` | `ui-worst-case` 等场景，加 `expect.layout()` | 遮挡问题：开发模式下每次打开界面都自动审计，并在徽标上报警 |
| `qa-door-entry.mjs`（直接 import 碰撞和世界模块） | 跳转 + `input.hold` + `wait.map` | 不再依赖内部模块路径 |
| `qa-event-hud.mjs` | `event.trigger` | 一行命令触发事件 |
| `qa-chat-focus.mjs` | 回放 + `wait.screen` | 去掉 sleep |
| `scripts/boss-sim.ts`（保留，作为数值依据） | Boss 实验台：预设队伍、强制随机结果、自动驾驶、高倍速 | 一分钟内确认破解方法有效；Astra 吃酱汁后的形态切换可以稳定截图 |
| 引导相关的手工排查 | 提示画廊，加课程场景 | 直接看到是哪个条件不成立 |

**对多 agent 的收益：**
- 不再抢存档槽；
- 不再用 sleep 等待；
- 内部重构不会打断脚本；
- 报告附带"场景 + 随机种子 + 回放"，任何人都能原样复现。

## 5 开放条件与安全边界

**编译期剔除：**
- 常量 `__AP_DEVTOOLS__` 在 `vite` 开发服务器和 `vite build --mode devtools` 下为 true，正式构建为 false。
- 写成 `if (__AP_DEVTOOLS__) await import('./dev/index.ts')`，正式构建就会剔除整个调试 chunk 和 `content/dev/**`。
- 构建检查 `scripts/check-dev-gate.mjs`（`npm run check:devgate`，接在 CI 的构建步骤之后）：
  - 正式 `dist/` 中不得出现哨兵串 `__AP_DEV_SENTINEL`、`__ap`、`skipTitle` 和 `content/dev`；
  - devtools 构建中必须出现。
- 即使是 devtools 构建，也仍然需要 `?dev=1` 或 `&scenario` 才会启用，所以可以当普通版本玩。

**官方服拒绝（在 #30 内实现）：**
- `src/server/index.ts` 读取 `AP_DEV` 得到 `allowDev`。生产环境的 env 文件里没有这个变量，所以为 false。
- hello 新增可选字段 `build: { devtools }`，不升 `protocolVersion`。
- `hub.ts` 的 `hello()` 在 `devtools && !allowDev` 时，用新关闭码 `closeCodes.devNotAllowed` 断开。
- `net/client.ts` 收到这个关闭码后，像版本不匹配一样停止重连，并提示 `t('net.error.dev_not_allowed')`。
- 这一层只防止误用。能挡住恶意的是 ADR 0001 §3 的服务端权威，见第 10 节。

**后续工作（不在 #30，依赖 ADR 0001）：**
- **允许调试的服务器**（WP5、WP7）：
  - 改变状态的命令改为发送 `dev.cmd`，由服务端执行、写库，并记审计 `kind: 'dev'`。
  - 服务器在 `welcome` 里声明后，所有人的界面都显示 `DEV`。
  - 自建服配置项 `devCommands` 可选 `off | admins | all`。
- **离线世界：**
  - 首次执行改变状态的命令后，存档写入 `devTaint: { firstAt, count }`，世界列表显示"调试过"。
  - ADR 0001 D2 的旧档导入会拒收这类存档。
  - 这只是诚信标记，可以被删掉，不是安全措施。
- **WebRTC 房间**（WP8）：
  - 由房主决定 `allowDev`，房间列表和所有人的界面都显示 `DEV`。
  - 房主未授权时，拒绝访客发出的改变状态的命令。

**写回接口：** 见 3.3，只存在于开发服务器上。

## 6 实施计划（`task/30/dev_mode`，`ap-wt/t30`，单人按顺序提交）

**冲突核对：**
- 编写时只有 #19（2 个文件）、#27（17 个）、#29（28 个）有未合入的提交；#29 已于 ce8005f 合入。
- 下表中只有 `src/shared/types.ts`（#27 在改）和 `src/shared/battle/engine.ts`（#27 在改）有冲突风险，单独处理。

| 步骤 | 规模 | 内容 | 文件 | 测试与证据 |
|---|---|---|---|---|
| M0 门禁与骨架（热修复候选） | S | `__AP_DEVTOOLS__`；`game.ts` 三处接缝和存储注入；`debug.ts` 迁到 `src/client/dev/params.ts`，旧参数保留为别名；服务端 `allowDev` 和 `devNotAllowed`；客户端停止重连；构建检查 | `vite.config.ts`、`src/client/game.ts`（只改接缝）、`src/client/dev/{index,params,legacy}.ts`、`src/client/debug.ts`（删除）、`src/server/{index,hub}.ts`（只改 `hello`）、`src/client/net/client.ts`（只改关闭码处理）、`content/net.json`（只加 closeCodes）、`content/text/zh-CN/net.json`、`scripts/check-dev-gate.mjs`、`package.json`、`.github/workflows/ci.yml` | `tests/dev-gate.test.ts`：开关判断；`allowDev=false` 时被关闭码断开，为 true 时正常进入；两种构建的 `check:devgate` |
| M1 注册表与 API v1 | M | 注册表、`__ap.v1`、状态导出与对比、事件缓冲、`wait`、`log`；`devHandles()`；dev 文案并入 | `src/client/dev/{registry,api,state,diff,events,wait}.ts`、`content/dev/console.json`、`content/text/zh-CN/dev.json`、`world/controller.ts`（只加一个 getter） | `tests/dev-api.test.ts`：diff；命令 schema 与 `console.json` 一致；文案 key 都存在 |
| M2 确定性 | M | `RngHub`；两处一行改动和调试存档；`&seed`、`&rng`；`devClock` | `src/client/core/rng-hub.ts`、`src/client/dev/clock.ts`、`controller.ts`、`script.ts` | `tests/dev-determinism.test.ts`（见 4.3）；不开调试时仍是每局随机 |
| M3 场景 | M | 场景格式、纯函数应用器、9 个场景、`beats.json`、`teams.json` | `content/dev/{scenarios/*,beats,teams}.json`、`src/shared/dev/scenario.ts`、`src/client/dev/scenario.ts`、`src/shared/types.ts`（只在末尾追加 dev 段） | `tests/dev-scenarios.test.ts` |
| M4 各类命令 | M/L | 3.1 中的全部类别（战斗强制结果除外，见 M8） | `src/client/dev/commands/*.ts` | 每类命令都有 Node 单测（用假 host） |
| M5 面板 | L | 各标签页、命令行、`DEV` 徽标、桌面抽屉、手机底部抽屉 | `src/client/dev/ui/**`、`src/client/dev/dev.css`、`content/dev/console.json`（`panel` 段；开关键在这里而不在 `input.json`） | M9 的 `dev-panel` 套件 |
| M6 联机模拟 | M | `DevSocket`、假服务器、机器人 | `src/client/dev/net-sim.ts`、`content/dev/net-sim.json`、`scripts/dev/bots.ts` | `tests/dev-netsim.test.ts`：用假定时器验证延迟、顺序和停顿；假服务器发出的消息符合 `ServerMsg` |
| M7 编辑器 | L | 来源记录（含镜像逆变换）、编辑器、写回插件、HMR 抑制 | `src/shared/world/{index,towns,interiors,data}.ts`（只加可选参数）、`src/client/dev/editor/**`、`scripts/vite-dev-api.ts`、`vite.config.ts`、`content/dev/editor.json` | `tests/dev-editor.test.ts`：来源记录往返（含镜像城镇）；patch 后重建，建筑在新位置且没有新增 `problems`。`tests/dev-api-endpoint.test.ts`：在临时目录副本上测 403、409，以及校验失败时文件不变。`world.test.ts` 的耗时预算不变 |
| M8 强制暴击、未命中 | S | `BattleInit.debug.rolls`，作用于 `engine.ts` 的命中、伤害浮动、暴击和捕获共 4 处 | `src/shared/battle/engine.ts`（只改这 4 处）、`types.ts` 末尾 dev 段 | 强制时全部暴击或全部未中；不设置时事件流与原来逐字节相同 |
| M9 回放、运行器、截图 | M | 输入录制与回放、`shot`、运行器和四个套件；按实际实现修订本 ADR | `src/client/dev/{replay,shot}.ts`、`scripts/qa/**`、`content/dev/suites/*.json`、`docs/adr/0002-dev-mode.md` | 全部套件通过；`output/30/**` 下有截图和 `report.md` |

**主控协调：**
1. M0 单独做成一个可以先合入、先发版的提交。发版需要所有者批准。
2. M8 作为分支上最后一个独立提交，只改那 4 处，由主控合并时解决与 #27 的冲突。
3. `types.ts` 只在文件末尾追加 dev 段，主控按 #27、#30 的顺序合入。
4. #29 已合入：`qa-layout-audit.mjs` 的审计函数可以移到 `src/client/dev/audit.ts`，供 `expect.layout()` 使用。

**worker 注意事项：**
- 开发服务器设了 `host: true`，所以写回接口必须测试"非回环地址请求返回 403"。
- 浏览器写回用例会真的修改 t30 里的内容 JSON。用例结束前必须撤销，并断言文件哈希与原文件一致、`git status` 干净。
- 改过世界生成文件后，单独跑一次 `node --test tests/world.test.ts`。
- 场景模式不占存档槽，但仍然只用自己的端口，只开一个 TaskSpace。
- 调试数据都放在 `content/dev/**`，文案放在 `dev.json`；改过的 JSON 用 `tools/content_fmt.py` 格式化；不新增依赖。

## 7 #30 验收对照

| 验收条件 | 设计 | 证明 |
|---|---|---|
| ADR 内容齐全 | 本文 §1–§6 | 本文件，M9 时按实际实现修订 |
| 面板在桌面和手机上可用，各类控制每类至少一张实际操作截图 | §3.1、§3.2 | `dev-panel` 套件：10 类 × d1280、m390，每格"打开标签 → 点 `data-dev-cmd` 控件 → 等待 → 截图"，存到 `output/30/panel/<viewport>/<category>.png` |
| 拖动建筑后写回 JSON 并通过校验，刷新后位置保持 | §3.3 | M7 的 Node 测试；浏览器用例：拖动 → 文件变化且校验通过 → 刷新后位置不变 → 撤销 → 哈希一致、`git status` 干净 |
| 至少 6 个场景，各有一条网址，并有自动化用例 | §4.4（共 9 个） | `tests/dev-scenarios.test.ts`；`scenarios` 套件逐个用 `/?dev=1&scenario=<id>` 加载、断言、截图 |
| 同一个种子跑两次，世界、遇敌、战斗完全一致 | §4.3 | `tests/dev-determinism.test.ts`；浏览器用例 `determinism-walk` 两次对比 |
| 正式构建和官方线上环境里打不开 | §5 | `check:devgate`（CI）；`tests/dev-gate.test.ts` |

## 8 测试策略
- **Node 端，并入 `npm test`：** `dev-gate`、`dev-api`、`dev-determinism`、`dev-scenarios`、`dev-netsim`、`dev-editor`、`dev-api-endpoint`，以及各类命令的单测。每条命令都先有 Node 测试，再接入面板。
- **CI：** 构建之后跑 `check:devgate`。
- **浏览器：** worker 跑四个套件；主控在合并前跑一次 `scripts/qa/run.mjs smoke`（5 个场景，每个都做导出、命令、对比、截图）。
- 不为了通过测试而放宽任何阈值。

## 9 决策
1. **正式包是否保留调试代码** —— **已定 B**：编译期剔除，另外提供 `--mode devtools` 构建，用于本地验收和自建服。（A：只在 `vite` 开发服务器上提供；C：运行期开关，即现状，不采用。）
2. **预发布环境 `prev.ap.crosery.com` 是否用 devtools 构建** —— **待所有者确认**。推荐使用：所有者可以在手机上点场景链接验收，预发布服开启 `allowDev`、界面显示 `DEV`；代价是预发布环境的排行榜失去参考意义。
3. **编辑器写回的范围** —— **已定 A**：只写回模板来源的内容，即城镇、室内、道馆、洞穴模板里的建筑、摆件、告示牌和锚点；生成物只读。（B：给生成物加固定种子下的覆盖文件，换种子即失效，与种子世界冲突，不采用。）

## 10 剩余风险与待验证
- **[residual risk] 官方服的拒绝依赖客户端自报。**
  - 手改过的客户端可以不发送 `build.devtools`。
  - #30 能保证的是：正式包里没有调试代码，官方服拒绝声明了调试构建的客户端。
  - "官方服不接收调试改出来的状态"要等 ADR 0001 的 WP5、WP6 完成才真正成立。在那之前，服务端仍然信任客户端上报的档案。
- **[verified] 线上正式包现在就能用 `?dev=1`**（主控已核对 `index-EOg5VBNs.js`）。M0 合入并发版之前会一直如此。
- **[verified] HMR 抑制：** `handleHotUpdate` 返回 `[]` 既不整页刷新、又让模块缓存失效：写回后手动刷新读到的是新 JSON（`editor` 套件的 `survives-reload` 用例）。
- **[unverified] 其他：** 其他 worktree 的未提交改动；节日事件是否依赖真实日期（因此没有做成场景，改由"触发事件"控件覆盖）。

## 参考
- Unreal Engine：Cheat Manager（Shipping 构建剔除）、Gameplay Debugger
- Godot：远程场景树和调试绘制开关
- Source Engine：`sv_cheats`
- Minecraft：命令系统与世界"允许作弊"标记
- Factorio：确定性输入回放

## 11 实现状态与偏差（#30 完成时）

**与设计一致且已验证的部分：** M0 门禁（`check:devgate` 两个方向）、注册表与 `__ap.v1`、确定性（`RngHub`、`devClock`、`&seed`、`&rng`）、9 个场景与纯函数应用器、全部命令类别、面板（桌面抽屉与手机底部抽屉）、联机模拟（`DevSocket`、页面内假服务器、本地机器人）、编辑器与写回接口、输入录制回放、`shot`、`expect.layout`、运行器与四个套件。

**与设计不同的实现：**
- **开关键**：在 `content/dev/console.json` 的 `panel.toggleCode`，不在 `content/input.json`（见 3.2）。
- **重建世界**：运行中的世界不能原地替换（世界对象被游戏各处持有）。`world.seed` / `world.seedRandom` 把当前存档写进开发者专用槽（`limits.reloadSlot`），再用新种子的网址重载；不碰玩家自己的存档槽。
- **场景的 `net` 字段**：用 `then` 里的 `net.fake` 命令表达，没有单独字段。
- **`expect.layout`**：是 DOM 层的审计（屏外控件、被裁文字、同级控件重叠、触屏目标过小），不是 #29 `qa-layout-audit.mjs` 的移植。
- **确定性的起点**：场景加载本身会跑真实时间的帧（地图进入、淡入），这些帧里 `encounter` 流的抽取次数不固定。所以可比对的起点是“`time.fixed` 之后再 `rng.seed` 一次”，`determinism` 套件按这个顺序执行；只在场景加载时播种，两次加载的游标会差几次抽取（实测出现过 202 对 198）。
- **编辑器**：运行中的游戏不会立刻换成新世界（见 3.3）；写回只接受回环地址，所以手机上能编辑、校验，但写回会被 403 拒绝。

**未做（留待后续）：**
- 世界页：导出地图 PNG、前线重置；剧情页：分支选择器；事件页：逐条显示条件成立与否的原因；战斗页：自动驾驶与超出玩家选项的倍速（`battle.auto`）；环境页的角色动作库与 `actors` 套件；`tests/boss-counters.ts` 改读 `teams.json`（与 #27 协调）。
- 强制暴击、未命中、伤害浮动取极值、捕获必成：引擎侧由 M8 提供（`BattleInit.debug.rolls`，分支上最后一个独立提交，只改 `engine.ts` 的 4 处和 `types.ts` 末尾 dev 段）；面板和命令把它接进开战参数还没做。
- 旧 `scripts/qa-*.mjs` 仍用 `__AP`，按 4.7 的表格逐个迁移，不在 #30 内。
