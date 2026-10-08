# ADR：运行期数据入库、服务端权威、联机延迟与多世界（#21 #22 #23 #24）

**状态：** 提议（2026-10-09）。第 7 节的 4 项决策待所有者确认。

## 1 现状（事实）

| 方面 | 现在由谁决定 | 依据 |
|---|---|---|
| 身份 | 存档里的 `playerId`（UUID 秘密）随 hello 上送；服务端对它做 sha256，派生出公开 id | `src/client/game.ts:213`、`src/server/hub.ts:285-286`、`src/server/util.ts:69-72` |
| 档案和排行榜 | 徽章、图鉴数、队伍、时长由客户端上报，服务端只裁剪形状；只有 PvP 胜负和距离由服务端记录 | `src/server/sanitize.ts:49-74`、`src/server/store.ts:141-175` |
| 战斗、捕获、经验、金钱、道具 | 全在客户端：客户端掷种子，跑本地 `BattleEngine`，直接写本地存档 | `src/client/world/battles.ts:124,162`、`src/client/battle/index.ts:90`、`src/client/battle/saveops.ts:37-60`、`src/client/ui/screens/shop.ts:80` |
| 交易 | 只用 `sanitizeCreature` 校验形状，不校验归属，所以可以凭空造出合法智灵送人 | `src/server/trade.ts:135-179`、`src/shared/creature.ts:225` |
| PvP | 战斗由服务端执行，但出战队伍由客户端提交，同样不校验归属 | `src/server/pvp.ts:69,245,265` |
| 移动 | 服务端校验速度、地块可达性和跳跃预算；不合法的移动静默丢弃，不回送校正 | `src/server/hub.ts:329-365` |
| 联机持久化 | 单个 `profiles.json`，去抖后写临时文件再原子改名 | `src/server/store.ts:91-118` |
| 单机存档 | `localStorage` 单槽明文；存档码只有 32 位校验和，并且**带着 `playerId` 秘密**，分享存档码就等于交出联机身份 | `src/client/core/save.ts:51-66,78,102-107`、`src/client/core/save-codec.ts:26-33` |
| 设计数据 | `content/**/*.json` 静态 import，打进客户端包 | `src/shared/content/index.ts:10-43` |
| 世界种子 | 生成全链路都吃种子，包括前线 provider；种子 +1 和 +7 已有无问题测试。但客户端在标题画面之前就用默认种子 20261002 建世界，服务端也不传种子 | `src/shared/world/index.ts:80,176-178`、`tests/world.test.ts:64-66`、`tests/story.test.ts:639`、`src/client/game.ts:154`、`src/server/world.ts:35` |
| 同步 | 10 Hz；可见玩家只要有一个变化，就把所有可见玩家的完整 `PlayerState` 重发一遍；`online` 名单每 5 秒全量广播，最多 200 人 | `content/config.json:16`、`src/server/hub.ts:380-407,509-510`、`content/net.json` |
| 插值 | 样本按到达时刻打时间戳，固定 240 ms 缓冲，没有外推 | `src/client/net/client.ts:127,133,351-359`、`src/client/net/interp.ts:32-48` |
| 调试钩子 | 运行期判断 `?dev=1`；`debug.ts` 是静态 import，生产包里完整存在 | `src/client/debug.ts:40-48`、`src/client/game.ts:22` |

**补充发现：**
- **在线人数上限 [verified 代码] [unverified 生产]：**
  - `content/net.json` 里 `trustProxy: false`、`maxClientsPerIp: 8`，`clientIp` 取 `socket.remoteAddress`（`src/server/index.ts:60-67`）。
  - 生产链路是 Caddy 经隧道转发，所有玩家的源地址都是 VPS 的隧道口，所以全服同时在线实际上限是 8 人。
- **建世界耗时：**
  - 本机实测（Mac，Node 26.7）：`buildWorld` 1.9 s，换一个种子也是 1.9 s，`createWorldGeo` 4 ms。
  - 部署脚本记录 Arch 上启动约 25 s（`deploy/remote-deploy.sh:12`），差距原因还没查。
- **跨引擎确定性：**
  - `worldapi.ts:225` 用了 `Math.hypot`。规范只要求它"实现近似"，而它驱动前线难度和稀有度，不同 JS 引擎之间可能有末位差异 [residual risk]。
  - 其余生成代码只用 `sqrt` 和整数运算，有注释保证（`noise.ts:3`、`random.ts:3`）。
- **Node 版本：** CI 用 Node 24（`deploy.yml:66`）。`node:sqlite` 在 24 上不需要 flag，但会打实验警告。生产实际的 Node 版本还需要确认。

## 2 数据模型（#21）

**原则：**
- 一个服务端进程对应一个世界；SQLite 是运行期唯一的事实来源。
- 热数据（位置、在线状态）留在内存，按现有 `debounceMs` 批量落库，断线时立即落库。
- 客户端的 `SaveData` 形状不变。共享层提供纯函数 `characterToSave` 和 `saveToRows`，下发联机缓存和导入旧档都用它们。

### 2.1 Schema（`src/server/db/migrations/001_init.sql`）

```sql
-- PRAGMA journal_mode=WAL; foreign_keys=ON; synchronous=NORMAL; schema 版本记在 user_version
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);         -- server_id, legacy_imported
CREATE TABLE worlds(id TEXT PRIMARY KEY, seed INTEGER NOT NULL, gen_seed INTEGER NOT NULL,
  rules_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE accounts(id TEXT PRIMARY KEY,                             -- publicIdFor(secret)，秘密不入库
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','flagged','banned')),
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE characters(id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id), world_id TEXT NOT NULL REFERENCES worlds(id),
  name TEXT NOT NULL, name_key TEXT NOT NULL, avatar TEXT NOT NULL,
  money INTEGER NOT NULL CHECK(money >= 0), position_json TEXT NOT NULL, respawn_json TEXT NOT NULL,
  clock_minutes INTEGER NOT NULL, play_time_sec INTEGER NOT NULL, max_distance INTEGER NOT NULL,
  stats_json TEXT NOT NULL, settings_json TEXT,
  origin TEXT NOT NULL,                                                -- new | legacy-profile | legacy-import
  rev INTEGER NOT NULL DEFAULT 0,                                      -- 每次权威变更 +1，state.patch 按它排序
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(account_id, world_id), UNIQUE(world_id, name_key));
CREATE TABLE creatures(uid TEXT PRIMARY KEY, owner INTEGER REFERENCES characters(id),  -- NULL = 交易托管中
  place TEXT NOT NULL CHECK(place IN ('party','box','escrow')), box INTEGER NOT NULL, slot INTEGER NOT NULL, -- 队伍 box=-1
  species_id TEXT NOT NULL, level INTEGER NOT NULL, shiny INTEGER NOT NULL,
  data_json TEXT NOT NULL,                                             -- sanitizeCreature() 的完整结果，带 v
  origin TEXT NOT NULL,                                                -- starter | battle:<id> | gift:<step> | trade:<id> | legacy
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner, place, box, slot));
CREATE TABLE inventory(character_id INTEGER NOT NULL REFERENCES characters(id), item_id TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty > 0), PRIMARY KEY(character_id, item_id)) WITHOUT ROWID;
CREATE TABLE dex(character_id INTEGER NOT NULL, species_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
  caught_at INTEGER, PRIMARY KEY(character_id, species_id)) WITHOUT ROWID;
CREATE TABLE progress(character_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
  value_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(character_id, kind, key)) WITHOUT ROWID;                 -- kind: flag quest badge town place event legend research fog
CREATE TABLE battles(id TEXT PRIMARY KEY, character_id INTEGER NOT NULL, kind TEXT NOT NULL, seed INTEGER NOT NULL,
  init_json TEXT NOT NULL, actions_json TEXT NOT NULL, result_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','done','aborted')), opened_at INTEGER NOT NULL, closed_at INTEGER);
CREATE TABLE pvp_matches(id TEXT PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, winner INTEGER,
  result TEXT NOT NULL, seed INTEGER NOT NULL, turns INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE trades(id TEXT PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, a_uid TEXT, b_uid TEXT,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE ledger(id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('money','item','exp','creature')), subject TEXT,
  delta INTEGER NOT NULL, balance INTEGER, ref TEXT NOT NULL);         -- ref: battle:<id> | shop:<id> | trade:<id> | script:<step>
CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, account_id TEXT, ip_hash TEXT,
  kind TEXT NOT NULL, severity INTEGER NOT NULL, detail_json TEXT NOT NULL);
CREATE TABLE access(kind TEXT NOT NULL CHECK(kind IN ('whitelist','ban','admin')), subject TEXT NOT NULL,
  reason TEXT, until INTEGER, PRIMARY KEY(kind, subject)) WITHOUT ROWID;
CREATE TABLE content_packs(rules_hash TEXT PRIMARY KEY, pack_hash TEXT NOT NULL, version TEXT NOT NULL, first_seen INTEGER NOT NULL);
CREATE TABLE legacy_profiles(id TEXT PRIMARY KEY, raw_json TEXT NOT NULL, imported_at INTEGER NOT NULL);
-- 只在官方服或信令服使用
CREATE TABLE servers(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, rules_hash TEXT,
  listed INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER);
CREATE TABLE rooms(code TEXT PRIMARY KEY, host_account TEXT NOT NULL, rules_hash TEXT NOT NULL, seed INTEGER NOT NULL,
  max_players INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX ledger_by_char ON ledger(character_id, at);
CREATE INDEX audit_by_account ON audit(account_id, at);
CREATE INDEX creatures_by_species ON creatures(species_id);
```

**设计要点：**
- **智灵：** 常查的字段单独成列，完整 `Creature` 放进 JSON。内容表加字段时不需要迁移。
- **`ledger`（经济流水）：**
  - 金钱、道具、经验、智灵的每次变化都写一行，并带来源。
  - 它同时服务 #26 的产出/消耗监控和反作弊。
- **事务：** `DatabaseSync` 是同步 API，会阻塞事件循环，所以事务要短、只有一个写者。排行榜用查询生成，缓存 10 s。

### 2.2 迁移、旧档导入与备份

- **迁移：**
  - 迁移文件为 `migrations/NNN_*.sql`，只增不改。
  - 启动时比对 `PRAGMA user_version`，在一个事务里按顺序执行。
  - 执行前先用 `node:sqlite` 的 `backup()` 写出 `data/backups/pre-v<N>-<ts>.db`。
- **旧档导入：**
  - 触发条件：发现 `profiles.json`，并且 `meta.legacy_imported` 不存在。
  - 导入 accounts 和 characters，标 `origin=legacy-profile`。旧档里只有公开资料、PvP 战绩、交易数和距离。
  - 每条原文存进 `legacy_profiles.raw_json`，导入后原文件改名保留。
  - 测试：导入后再导出，结果与原文件 `deepEqual`；重复启动不会重复导入。
- **备份：**
  - 每天在线 `backup()` 一次，保留 N 份，参数放在 `content/net.json` 的 `store` 段。
  - 拷到异地（VPS 或七牛私有空间）属于外发，需要批准。

### 2.3 设计数据：JSON 作为源，还是直接进库（决策 D1）

| | JSON 进 git，构建时编译成带哈希的内容包 | 直接在数据库里编辑 |
|---|---|---|
| 审查与回滚 | PR diff、现有的内容校验测试、按提交回滚 | 要自建后台、审计和版本表 |
| 客户端 | 同构代码静态 import，运行期零加载 | 要改成运行期下载内容；`CONTENT` 是模块级常量（例如 `pvp.ts:35` 的 `PVP_RULES`），改造面很大 |
| 线上调参 | 必须发版 | 能热改，但客户端和服务端的规则会暂时不一致 |
| 数值分析 | 另外生成一个只读 SQLite 来查询 | 天然可以查询 |

**推荐：保留 JSON 作为源。**
- 构建时由 `scripts/content-pack.ts` 规范化（键排序、去掉空白）后算 SHA-256，得到两个哈希：
  - `packHash`：覆盖全部内容；
  - `rulesHash`：只覆盖影响规则的文件，文件清单写在 `content/pack.json`。渲染和 UI 的改动不会破坏联机兼容。
- 同时生成只读的 `output/content.db`，给数值策划做查询。
- 所有者说的"所有数据走 db"，落在运行期数据上。

### 2.4 内容包校验与扩展点

- **校验：**
  - `hello` 增加 `rules` 字段；服务端启动时用同一个函数对自己的 `content/` 算哈希。
  - 不一致时用新关闭码 `content` 断开，并返回 `t('net.error.content_mismatch')`，客户端提示刷新（满足 #21 的验收）。
  - `/api/info` 也返回这两个哈希。
- **扩展：**
  - 加智灵、属性、地区，仍然是加 JSON。
  - 模组的做法：复制一份 `content/`，修改后自己构建，得到一套自带网页的客户端和服务端，哈希自然不同。
  - 官方客户端遇到 `rulesHash` 不同的服务器时拒绝连接，并给出"打开该服务器自带网页"的链接。
  - v1 不做运行期热插拔内容包。

## 3 防作弊与加密（#22）

**威胁模型：** 作弊者完全控制自己的浏览器和 JS。客户端里的密钥、签名、混淆都只能抬高门槛。真正的边界只有两条：**服务端权威结算**，以及**库存归服务端所有**。

### 3.1 战斗：服务端执行（推荐），还是客户端执行加服务端重放

**已有基础：**
- `BattleEngine` 只用 `Rng(init.seed)` 取随机数，是确定性的（`engine.ts:1`），并且已经在服务端跑 PvP。
- 战斗 UI 由 `BattleChannel` 驱动，本地引擎和远程 PvP 共用这套接口（`battle/index.ts:90`）。

**两个方案：**
- **服务端执行：**
  - 联机的野战、训练家战和 PvP 都由服务端构建 `init`、掷种子、执行；客户端新增 `pve-channel.ts`。
  - 代价是每回合多 1 个 RTT，可以被选招后的出招动画盖住；开战时那 1 个 RTT 可以被转场动画盖住。
  - 断线时，服务端把战斗保留 `battleResumeSeconds` 秒。
- **客户端执行加服务端重放：**
  - 没有额外延迟。
  - 但客户端必须事先知道种子，于是可以预演每个动作的暴击、命中和捕获结果，挑最优解。
  - 结果不一致时还要回滚 UI。

**结论：** 联机由服务端执行，单机仍用本地引擎。`battles` 表保存 `init` 和全部动作，以后需要时可以离线重放审计。

### 3.2 校验清单

| 事件 | 服务端怎么判 |
|---|---|
| 野生遇敌 | 位置与服务端记录相符；遇敌频率按服务端累计步数和地区遇敌率判断；物种和等级必须在该地区的遇敌表内（地图上可见的游荡智灵允许客户端提名物种）；个体值和闪光由服务端掷 |
| 训练家 | 训练家存在于世界里，`progress` 中没有被打败的记录，玩家就在附近；对手队伍由服务端按内容生成 |
| 经验、升级、进化 | 直接用引擎结果写库；进化选择走 `creature.evolve` 请求 |
| 捕获 | 由引擎判定；智灵由服务端生成后入库，`origin=battle:<id>` |
| 金钱、商店、道具 | `shop.buy`、`shop.sell`、`item.use` 按内容表的价格和库存校验，每次变化写 `ledger` |
| 交易 | 只能交易自己库里的 `uid`；先进入托管，再在一个事务里完成归属转移 |
| PvP 出战 | 只认库里自己的队伍，仍按 `healParty` 和等级上限处理 |
| 剧情给予、地面道具、研究奖励 | 第三期（WP9）按脚本步骤 id 和一次性 flag 校验；在那之前只记账，并且结果不可信 |

被拒绝的请求返回 `error` 并写一条 `audit`；客户端用服务端下发的状态覆盖本地缓存。#22 的验收测试即：篡改战斗结果、经验或道具数量都会被拒绝，并且留下审计记录。

### 3.3 协议防护

- **加密：**
  - 加密就是 TLS，生产环境只允许 `wss`。
  - 应用层再加一层加密或每条消息做 HMAC，用的密钥都在客户端里，**不增加安全性**，不建议做。
  - 如果所有者坚持要做，可以用 `hello` 下发的会话密钥做 HMAC，但要明确把它定位为混淆。
- **重放防护**在这里的实际含义：
  - 改变状态的消息带每个连接单调递增的 `seq`。
  - `battleId`、`tradeId` 和商店幂等键由服务端签发，只能用一次。
  - 结果是重复发来的消息只会被忽略，不会被执行两次；第三方重放已经被 TLS 挡住。
- **频率限制：**
  - 保留现有的"每连接 × 每消息类型"令牌桶。
  - 增加每账号的桶（重连不会重置）和每 IP 的桶；开战、生成区块这类昂贵操作再加全局预算。
  - 每 IP 限流的前提是先拿到真实 IP（WP0）。

### 3.4 异常检测

规则写在 `content/net.json` 的 `anticheat` 段：
- 速度和瞬移沿用现有移动校验；跳跃预算反复耗尽时记审计。
- 每小时获得的经验或金钱超过 `ledger` 的分位线。
- 遇敌次数与步数之比异常。
- 物种分布偏离遇敌表权重。
- 闪光率用二项分布的尾部概率判断。
- 同一对玩家反复打短局（刷胜场）。
- 多个账号向同一个账号输送智灵。

v1 只记审计并把账号标为 `flagged`（不进排行榜），由人工复核，不自动封号。

### 3.5 单机存档签名

**它做不到什么：** 用本机密钥做 HMAC，密钥和存档在同一台机器上，读过 JS 的人都能重新签名。

**它能做到的只有三件事：**
- 发现意外损坏和版本错配；
- 标记存档来源（离线，还是联机缓存）；
- 挡住手改 base64 的随手篡改。

**真正的保证来自结构：**
- 离线存档永远不进官方服，联机角色只从服务端库里读。
- 因此"改过的单机存档在联机时被识别"在结构上就成立。唯一的例外是 D2 的一次性旧档导入：导入时做 sanitize、写审计，并标 `origin=legacy-import`。
- 存档码不再携带身份秘密；账号秘密单独存放在 `agent-pocket/accounts`。

### 3.6 构建加固

- **调试钩子：**
  - `debug.ts` 改为只在 `import.meta.env.DEV` 下动态 import，生产包里整段剔除，包括 `window.__ap` 和 `__AP`。
  - 验收：在 `dist/` 里 grep 不到这些标识。
  - 预发布环境如果需要钩子，用 `AP_DEV_HOOKS=1` 单独打开。
- **压缩与 sourcemap：** 保持 Vite 默认压缩，继续不出 sourcemap（`vite.config.ts` 本来就没有开）。
- **混淆：** 混淆器是新依赖，违反规则 6；属性改名还会碰坏由 JSON 驱动的代码，收益又很低，不建议做。

## 4 延迟（#23）

### 4.1 先测量（WP0）

- **客户端：**
  - 已经有 RTT 平滑值（`online.ts:257-267`）。
  - 增加 p50、p95、抖动、快照到达间隔直方图，以及超过 250 ms 的停顿次数，显示在 F3 面板。
- **服务端：**
  - 每个连接每秒的收发字节数、tick 耗时，以及 `perf_hooks` 测出的事件循环延迟。
  - 通过 `/api/metrics` 暴露，只允许本机访问或带 token。
- **分段测量：**
  - 客户端到游戏服的全程 RTT，减去 VPS 上 Caddy 直接响应的 `/edge-ping`，差值就是隧道加 Arch 的开销。
  - 在 VPS 上 `ping 10.66.0.2`，并用 `ss -ti` 看重传计数。
  - 再用一个临时的、不经过 EdgeOne 的主机名做 A/B 对比。改 Caddy 和改 DNS 都需要批准。
- **实验环境：**
  - 在 Arch 上用 `tc netem delay 75ms 10ms loss 2%` 复现验收条件。
  - 仓库里另写一个 Node 延迟代理 `scripts/lagproxy.ts`，可以注入延迟、抖动和停顿，供确定性测试使用。

### 4.2 自己的移动

- 现在已经是本地先动、服务端只做校验，所以"零等待"本来就成立。
- 缺的是校正：
  - `move` 加 `seq`；服务端拒绝时回 `move.correct {seq, map, x, y}`，客户端在 150 ms 内平滑拉回。
  - 碰撞代码是两端共享的，正常玩家几乎不会触发校正。

### 4.3 别人的移动

- 快照带上服务端时间 `at`。客户端用 ping 计算的时钟偏移把它换算成本地时间（现在 `client.ts:259` 的偏移没有扣除 RTT）。
- 缓冲改为自适应：`clamp(p95 抖动 + 1 tick, 150, 400) ms`，取代固定的 240 ms。
- 缓冲耗尽时，按朝向、`moving`、`running` 和内容表里的速度外推 1–2 个 tick，然后收敛；只有误差超过 `snapDistanceTiles` 才瞬移。
- 走路动画由插值速度驱动。

### 4.4 发送频率与编码

**频率与编码改动：**
- 保持 10 Hz，按距离分档：16 格以内 10 Hz，更远的 3–5 Hz。
- 快照拆成两部分：
  - 静态部分：名字、形象、首发、徽章、图鉴，只在加入或变化时发送；
  - 动态增量 `[n, x, y, flags]`：`n` 是加入时分配的短 id，坐标是整数厘格，状态位压进 `flags`。先用 JSON 数组，二进制作为第二步。

**带宽估算**（实测 `PlayerState` 269 B、`move` 97 B）：

| 项目 | 现在 | 增量 JSON | 二进制 |
|---|---|---|---|
| 每个可见的移动玩家（下行） | 约 2.7 KB/s | 约 0.2 KB/s（约 13 倍） | 约 11 B 一条 |
| 20 个可见玩家（下行） | 约 54 KB/s | | |
| 一条 `move`（上行） | 97 B | 约 25 B | |

**其他：**
- **`online` 名单：** 200 人时每 5 秒约 22 KB，折合每个客户端 4.4 KB/s。改为只广播人数和进出增量，名单在面板打开时按需拉取。
- **permessage-deflate：** 不开启。小帧压缩收益低，每个连接都要额外的内存和 CPU，边缘节点是否支持也不确定。

### 4.5 EdgeOne 能做什么、不能做什么

**能做：**
- 七层站点加速可以转发 WebSocket：
  - 需要手动开启，只支持 HTTP/1.1；
  - 空闲超时可设 1–300 s，客户端每 5 秒 ping 一次，不会触发。
- 就近终止 TLS，但只节省建连和重连时的 1–2 个 RTT。
- "智能加速"另外收费（按请求数，上行流量也计费），能优化边缘到源站的路径，可能降低跨境段的 RTT 和丢包。
- 静态资源已经走七牛，HTML 走源站并且 `no-cache`。

**不能做：**
- 缓存或计算游戏状态，每次移动都要回源。
- 消除 TCP 队头阻塞：链路仍然是全程 TCP，只是被切成几段，各段各自重传。
- 改善 VPS 到家里的那一段。
- 四层代理只有企业版才有；浏览器发不了裸 UDP，所以它对 WebSocket 没有额外收益。
- 大陆节点已经在用 [verified 2026-10-09]：`ap.crosery.com` CNAME 到 `*.eo.dnse0.com`，解析到大陆移动边缘（武汉、上海等）。所以大陆玩家已经就近接入，剩下的延迟在“边缘 → 香港 VPS → 隧道 → 家里 Arch”这段回源链路上。VPS 本身是面向大陆的线路（主机别名 `hk-cn2`），EdgeOne 回源是否比直连更快，仍以 A/B 测量为准。

**结论：**
- CDN 只能改善建连，也许能改善跨境路径，做不到"无感"。
- "无感"要靠 4.2、4.3 的客户端算法，加上去掉隧道。
- WebSocket 路径上是否保留 EdgeOne，以 A/B 测量结果为准。

### 4.6 TCP 套 TCP 隧道

**问题：** `ssh -w` 是三层隧道，所有玩家的 TCP 都装在同一条 SSH TCP 流里。
- 外层只要丢一个段，所有玩家一起卡住（跨玩家的队头阻塞）。
- 内层 TCP 的定时器可能在外层重传期间超时，再塞进重复数据，这就是重传放大（TCP meltdown）。
- 家里线路发往 VPS 的 UDP 全部被丢，所以 WireGuard 和 QUIC 都用不了。

**可选方案**（都需要批准，见 D3）：
- **a. 游戏服迁到香港 VPS：** 隧道直接从游戏路径上消失。前提是 VPS 的 CPU 和内存够用，需要实测建世界耗时。
- **b. 改用 `ssh -R` 四层端口转发：** TCP 在两端终止，不再有双层拥塞控制，但仍然是单条流。改动很小。
- **c. 开多条 SSH 分摊：** 只是缩小一次丢包的影响面，收益有限。
- 区域中继解决不了回程那一段，不考虑。

## 5 离线/联机、种子、自建服、房间（#24）

### 5.1 种子世界

**要改的入口**（生成本身已经由种子驱动）：
- 客户端改为"标题 → 选择或新建世界 → `buildWorld(seed)`"，不再在启动时就建默认世界（`game.ts:154`）。切换世界时清空 `BY_SEED`（`world/index.ts:67`）。
- 服务端改为 `loadWorldInfo(seed)`，种子从配置读取。
- 顺手把 `Math.hypot` 换成 `sqrt`。
- 联机时客户端必须用服务器的种子建世界，所以种子对连上的玩家是公开的。

**种子输入与修复**（`src/shared/world/seed.ts` 的 `seedFromInput`）：
- 纯数字且在 int32 范围内的直接使用；其他文本用 `hashString` 映射成 uint32，并显示规范化后的数字，方便分享。
- 如果生成出现 `problems`，按 `hash(seed, attempt)` 确定性地换种子重试。世界同时记录 `seed` 和 `genSeed`，所以同一个输入永远得到同一个世界。

**测试：**
- 常规测试里加 2 个随机种子。
- `npm run test:seeds` 跑 50 个种子，每个约 2 s，不放进约 25 s 的主测试。
- 验收"同种子地块哈希一致"：在 Node 里对核心大陆和前线的若干坐标采样做哈希；两个浏览器的对比用 ego-browser（Chromium）。Safari 只能手测 [unverified]。

### 5.2 存档按世界分开

- 存储布局：索引放在 `agent-pocket/worlds`，每个世界放在 `agent-pocket/world/<id>`。
- `SaveData` 增加 `world: { id, mode: 'offline'|'online', seed, rulesHash, server? }`。
- 联机世界在本地只是缓存，连上服务器后由 `state.full` 覆盖。
- 旧的槽 0 存档自动迁移成一个离线世界（默认种子）。它能否带进官方服，见 D2。
- `localStorage` 只有约 5 MB，需要实测单个存档的大小；超了再换 IndexedDB（异步，要改 `StorageLike`）。

### 5.3 服务器列表与直连

**列表：**
- 从标题进入"联机"，列表分三组：
  - 官方：置顶；
  - 我添加的：保存在本地；
  - 推荐：来自官方服 `servers` 表中 `listed=1` 的条目，人工审核，不开放注册。
- 每一行显示名称、在线人数/上限、延迟（3 次 `/api/info` 取中位数）和兼容性。
- `/api/info` 需要加 `Access-Control-Allow-Origin: *`。

**直连：**
- 输入地址后规范化为 `wss://host[:port]/ws`。
- 限制：https 页面只能连 `wss`（混合内容规则）。局域网或没有证书的服务器，需要打开它自带的网页；服务端本来就托管了 `dist/`。

### 5.4 自建服务器包

- **运行：** `node src/server/index.ts --config server.json`，需要 Node ≥ 24。
- **打包：** `npm run server:pack` 产出一个 tgz，包含 `dist/ src/ content/ package*.json server.example.json`，另附 Dockerfile（不是 npm 依赖）。
- **配置：** schema 写在 contracts 里，默认值放在 `content/net.json` 的 `selfHost` 段。字段：`name, motd, seed, maxPlayers, pvp, trade, whitelist{enabled, ids}, admins, listed, dataDir, port`。
- **内容包：** 包里自带的 `content/` 就是内容包，客户端和服务端出自同一次构建，天然一致。

### 5.5 离线建房（WebRTC）

**拓扑：**
- 房主浏览器是权威，星形连接，每个访客一条 `RTCPeerConnection`。
- 两条 DataChannel：
  - 移动走 `ordered:false, maxRetransmits:0`，没有队头阻塞，这是 WebRTC 相对 WebSocket 的真实优势；
  - 聊天和对战走可靠有序通道。

**复用服务端逻辑：**
- WP0 先把 hub 改成与传输无关：用 `Link` 接口取代 `ws`，把 `node:crypto` 和 `Buffer` 移到适配层。
- 之后房主在浏览器里运行同一个 hub 核心（在线状态、兴趣管理、聊天、PvP），世界规则使用房主的种子。

**信令**（官方服或自建服的 `/signal`）：
1. 房主发 `room.open {rulesHash, seed, max}`，拿到 6 位房间码；字母表和有效期写在内容里。
2. 访客发 `room.join {code}`。
3. 之后服务器只中转 `rtc.offer`、`rtc.answer` 和 `rtc.ice`。

- 房主断线时房间作废。
- 信令服务器看不到任何游戏数据。

**v1 范围：**
- 支持移动、聊天、表情和 PvP。访客用自己离线世界的队伍，房主按房间规则做 sanitize、回满状态、限制等级。
- 关闭交易：两份离线存档之间交易，刷新页面就能复制智灵。
- 像 Minecraft 那样把访客角色存进房主世界，留到 v2。

**限制：**
- 浏览器会节流后台标签页的定时器，房主需要保持页面在前台。
- 只用 STUN 时，双方都处在对称 NAT 或 CGNAT 后面就连不上，这在移动网络很常见。
- Google STUN 在大陆不可靠，需要自建 STUN。是否做兜底，见 D4。

### 5.6 副本、组队与多人 Boss（#27 #28）

**现状：**
- 生成器里有 2 个地牢，每个 2 层（`content/world/dungeons.json`）。最深层有守卫锚点 `dungeon:<id>:floor<n>:boss`（`src/shared/world/dungeons.ts:4,128`）。
- 地牢楼层就是普通地图 id。hub 按 `state.map` 做兴趣管理（`hub.ts:380-407`），所以同一楼层的玩家互相可见，没有实例的概念。
- 战斗引擎固定为两侧单打：
  - `SideIndex = 0 | 1`（`types.ts:441`），`BattleInit.sides` 是二元组（`types.ts:458`）；
  - 视角转换只会翻转两侧（`battle/messages.ts:32-42`）。
- PvP 已经有回合计时、超时自动出招和挂机判负（`pvp.ts:299,372-383`）。

#### 一套逻辑，三种宿主
组队、实例、Raid 都写成不依赖 Node 的纯状态机，放在 `src/shared/coop/`，时钟、随机源和发送函数从外部注入。同一份代码跑在三个地方：

| 宿主 | 接入方式 |
|---|---|
| 官方服、自建服 | 服务端适配层挂到 WP0 的消息路由上，结果入库 |
| 离线房间 | 房主浏览器里的 hub 核心（WP8）直接复用 |
| 离线单刷 | 本地用回环 `Link` 运行同一套模块 |

单刷就是 1 人队伍、1 人实例、N=1 的 Raid，走同一条路径，不另写一套。

#### 实例
- **地图 id：** 实例地图 id 为 `<楼层地图id>#<实例id>`。
  - hub 按地图字符串分组，所以不同实例天然互不可见。
  - 移动校验时去掉 `#` 后缀，用原楼层的几何。这个解析函数放进 WP0，避免和 WP3 同时改 `hub.ts`。
- **刷新：**
  - 地形沿用世界种子生成的楼层，不按日重建。
  - "每日/每周刷新"只轮换内容：精英位置、机关、Boss 变体和词缀，由 `hash(world.seed, dungeonId, periodKey)` 决定。
  - 这样客户端不用下载地图，也不会出现地形不同步。
- **状态与交互：**
  - `InstanceState { id, dungeonId, difficulty, periodKey, members, progress, raid?, expiresAt }` 只存在于权威端。
  - 玩家交互时发 `inst.act {seq, kind, id}`；权威端校验距离和前置条件后，广播 `inst.patch {rev, ops}`。
  - 客户端先播交互动画，1 个 RTT 内收到确认，被拒绝就回退。
- **精英战：**
  - 每场是一次普通单打，联机时由服务端执行（见 3.1）。
  - 交战期间锁定该精英，避免两人同时开打；击败后记在实例上，全队共享。
- **生命周期：**
  - 所有成员离开，或超过 `instanceTtlMinutes`，实例销毁。
  - 队员在有效期内重连，会被放回原实例（服务端内存 + `dungeon_runs` 记录）。

#### 组队与邀请
- **队伍：** 队伍是 hub 级的概念，不依附于实例。
  - 流程：`party.invite {to}` → 对方收到 `party.invited` → 回复 `party.respond {accept}`。
  - 队伍状态以 `party.state {id, leader, members[]}` 整体下发，每个成员带名字、形象、在线状态、所在地图和血量概况。
  - 支持转让队长、踢人、离队；聊天增加 `party` 频道。
  - 人数上限、邀请有效期和频率写在 `content/multiplayer.json` 的 `coop` 段。邀请复用交易请求的"挂起/过期"模式（`trade.ts`）。
- **进本：**
  1. 队长在入口选难度，发 `inst.create {dungeonId, difficulty}`。
  2. 权威端校验每个成员的等级要求和本周期剩余次数，然后建实例。
  3. 站在入口 `entryRangeTiles` 内的队员自动进入。
  4. 不在入口的队员收到"队伍已进入副本"提示，Boss 开打前都可以从入口加入。
- **开打：** Boss 房间有就绪确认。全员就绪即开打；倒计时结束时由在场成员开打，至少 1 人。

#### 多人对一个 Boss

**方案：** 引擎层面是"并行单打 + 共享 Boss 状态"，画面上同屏。
- 权威端给每个玩家各开一个普通的两侧引擎实例（该玩家对 Boss 的一份副本）。
- Raid 协调器（`src/shared/battle/raid.ts`）把各副本里的 Boss 合并成一个。
- N=1 时与普通战斗完全一致，现有的战斗 UI、AI 和测试都能复用。
- 客户端根据队友的回合摘要，把队友的出战智灵画在己方一侧并播放简化动作，玩家看到的就是同屏组队。
- 真正的编队格式（多槽位、能对队友出招）要改 `SideIndex`、`perspective()` 和整个战斗舞台，所有使用方都受影响。这部分留作第二期升级：组队、实例、计时和掉落都能沿用，只换合并层和战斗 UI。

**一个回合：**
1. 回合开始时，协调器把共享的 Boss 状态写进每个副本。
2. Boss 本回合做什么，由协调器用 Raid 随机源统一决定：
   - 伤害类招式在每个副本里各打各的玩家，效果上就是"Boss 攻击所有人"；
   - 自身强化和回复只结算一次。
3. 收集所有在场玩家的动作：
   - 截止时间为 `raidTurnSeconds`。期间广播 `raid.chosen {slot}`，让队友看到谁已经出招；是否公开具体招式由内容配置决定。
   - 超时按 PvP 的 `autoPick` 自动出招。
   - 连续超时 `afkAutoAfter` 次后改为 AI 托管，不判负，避免拖累队友。
4. 推进各副本，再按确定性规则合并 Boss 状态：

   | 状态 | 合并规则 |
   |---|---|
   | HP | 各副本伤害求和：`H' = max(0, H − Σdᵢ)` |
   | 能力等级 | 各副本的变化量求和后截断 |
   | 异常状态、形态和阶段触发（如 #27 的"喂酱汁 → 路由降级"） | 按槽位顺序先到先得 |

5. 下发 `raid.turn {turn, events(本人视角), mates[摘要], boss(共享状态), deadline}`。

**结束与断线：**
- 胜利：共享 HP 归零，协调器强制结束所有副本。
- 失败：狂暴回合数用尽，或全员倒下。
- 个人倒下：单个玩家全灭后转为观战，Raid 继续。
- 断线：掉线玩家的副本保留 `raidReconnectSeconds`，期间由 AI 托管。重连后发 `raid.resume` 拿回完整视图。全员掉线时挂起，超时算失败。

**引擎需要新增的东西（与 #27 共用，先定契约）：**
- 可序列化的 `BossState`（HP、能力等级、异常、形态、阶段、狂暴计数），以及 `extractBossState()` / `applyBossState()`。
- 一种"外部驱动"的敌方类型：动作由协调器传入。Boss AI 拆成纯函数 `chooseBossAction(state, rng)`。
- `forceEnd(result)`。
- Raid 标志：关闭副本内的经验和捕获，改由协调器统一发放。
- 每个副本的种子为 `hash(raidSeed, slot)`。`battles` 表保存 Raid 种子和全部动作，可以完整重放审计。

**和 #27 的分工：** #27 的阶段、形态切换、破解道具和狂暴，都必须表达在 `BossState` 里，同一个 Boss 才能单刷和组队表现一致。做法是 WP12a 先合入类型和钩子，#27 再在上面实现机制，两边不同时改 `engine.ts`。

#### 掉落与防作弊
- **在哪掷骰：** 只在权威端，用服务端随机源；离线房间用房主的随机源。不从任何客户端已知的种子推导。
- **个人掉落：** 每个合格成员各掷一次。不需要分配界面，也没有分赃纠纷和交易骗局。
- **合格条件：** Boss 被击败时人在实例内，并且贡献（伤害或存活回合）达到 `minContribution`，挂机蹭本拿不到奖励。
- **周期锁定：**
  - `dungeon_lockouts` 的主键是"角色 + 副本 + 难度 + 周期"。
  - 用 `INSERT … ON CONFLICT DO NOTHING` 看受影响行数，决定是否发奖。
  - 掷骰、写 `ledger`（`ref=dungeon:<runId>`）和写锁定在同一个事务里完成，所以断线重试也不会重复发奖。
  - 锁定后仍然可以进本"帮刷"，只是没有奖励。
- **掉落的智灵：** 由服务端生成，`origin=dungeon:<runId>`。
- **客户端声明一律不认：** 客户端发来的掉落或通关声明全部忽略，并写审计。
- **身份绑定：** Raid 的槽位绑定连接身份，不能替别人出招。
- **异常检测：**
  - 通关时间低于内容里配置的下限。
  - 掉落率偏离期望值。
  - 同一 IP 多号组队刷本：只记审计不拦截，因为家庭和校园网会共用出口。
- **离线房间：** 房主是权威，房主自己也可能作弊。但存档本来就是离线的，这在信任模型之内。

#### Schema 追加（第 2.1 节，迁移 `00N_dungeons.sql`）
```sql
CREATE TABLE dungeon_runs(id TEXT PRIMARY KEY, dungeon_id TEXT NOT NULL, difficulty TEXT NOT NULL, period_key TEXT NOT NULL,
  raid_seed INTEGER, status TEXT NOT NULL CHECK(status IN ('open','cleared','failed','abandoned')),
  started_at INTEGER NOT NULL, ended_at INTEGER, boss_turns INTEGER);
CREATE TABLE dungeon_members(run_id TEXT NOT NULL REFERENCES dungeon_runs(id), character_id INTEGER NOT NULL,
  contribution INTEGER NOT NULL DEFAULT 0, reward_json TEXT, PRIMARY KEY(run_id, character_id)) WITHOUT ROWID;
CREATE TABLE dungeon_lockouts(character_id INTEGER NOT NULL, dungeon_id TEXT NOT NULL, difficulty TEXT NOT NULL,
  period_key TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(character_id, dungeon_id, difficulty, period_key)) WITHOUT ROWID;
```
周期边界（时区偏移和刷新时刻）写在内容里，不写进代码。

## 6 分阶段实施

**共享热点文件：**
- `src/client/game.ts`、`src/server/hub.ts`、`content/net.json`、`content/multiplayer.json`：每个包只改自己的函数或配置段，由主控按顺序合并。
- `src/shared/battle/engine.ts`：同时被 #26、#27 和 WP12a 修改。WP12a 只加钩子，并且要最先合入。

**不在本 ADR 范围内的工作：**
- #28 的副本内容：6 个副本、题材、入口和掉落表数据。
- #27 的 Boss 数据和机制实现。

它们和本设计的接口是：`BossState`（WP12a 定义）、副本定义的扩展类型（WP11 定义）和掉落表 schema（WP13 定义）。

| 包 | 期 | 内容 | 主要文件 | 测试与验收 | 阻塞 |
|---|---|---|---|---|---|
| WP0 接缝与测量 | 0 | 协议按领域拆文件；hub 增加路由注册和 `Link` 接口，去掉 Node 专属依赖；`/api/metrics`；真实 IP 可配置；实例地图 id 解析 `splitInstanceMap` 和 `resolveMap` 钩子 | `src/server/hub.ts`、`core.ts`、`util.ts`、`index.ts`、`src/shared/protocol*`、`src/shared/coop/mapkey.ts` | 现有 server 测试不改即过；新增 metrics、真实 IP 和实例 id 解析测试 | 无；生产启用需批准 |
| WP1 SQLite 存储 | 1 | `src/server/db/**`；`store.ts` 换成库实现，接口不变 | `src/server/db/**`、`store.ts`、`net.json#store` | 重启后档案完整；导入往返 `deepEqual`；迁移；备份 | 无 |
| WP2 内容包与构建加固 | 1 | 内容包哈希；hello 校验；调试钩子剔除 | `scripts/content-pack.ts`、`vite.config.ts`、`src/client/debug.ts`、`game.ts`（只改 debug 导入和 hello）、`hub.ts`（只改 `hello()`） | 哈希稳定；不一致被拒；`dist/` 里没有调试钩子 | 产物形态受 D1 影响 |
| WP3 联机延迟 | 1 | 增量快照、时间戳、自适应插值、移动校正、名单瘦身、延迟代理 | `src/client/net/client.ts`、`interp.ts`、`src/shared/net/codec.ts`、`src/server/presence.ts`、`scripts/lagproxy.ts` | 编解码往返；无跳变；字节数改前改后对比；netem 录屏 | 无 |
| WP4 种子世界与分世界存档 | 1 | `seed.ts`；启动流程；世界列表；存档迁移；替换 `hypot` | `src/shared/world/seed.ts`、`worldapi.ts`、`src/server/world.ts`、`src/client/core/save*.ts`、`ui/screens/worlds.ts`、`title.ts`、`game.ts`（只改启动段） | 同种子地块哈希一致；种子模糊测试；迁移测试 | 无 |
| WP12a Boss 状态契约与引擎钩子 | 1 | `BossState`；`extract/applyBossState`；外部驱动敌方；`forceEnd`；Raid 标志；`chooseBossAction` 拆为纯函数 | `src/shared/types.ts`（只加新类型）、`src/shared/battle/engine.ts`（只加钩子）、`ai.ts` | 先取出再写回状态后续打，结果与不中断一致；现有战斗测试不变 | 先于 #27 合入 |
| WP5 服务端角色与同步 | 2 | 账号和角色仓储；`state.full`/`state.patch`；客户端 `Authority` 接缝 | `src/server/session.ts`、`db/characters.ts`、`src/client/net/state-sync.ts`、`battle/saveops.ts`、`world/save-ops.ts`、`ui/screens/logic.ts`、`shop.ts` | 联机变更只来自服务端；重连后状态一致 | WP1、D2 |
| WP6 权威结算与审计 | 2 | `pve-channel`、捕获、商店、道具；交易和 PvP 改用库存；`ledger`、`audit` | `src/server/authority/**`、`trade.ts`、`pvp.ts`、`src/client/net/pve-channel.ts`、`world/battles.ts` | #22 验收测试；战斗 CPU 压测 | WP5 |
| WP7 自建服与服务器列表 | 2 | 配置文件、白名单、`/api/info`、打包、服务器列表 UI、文档 | `src/server/selfhost.ts`、`http.ts`、`scripts/server-pack.ts`、`ui/screens/servers.ts`、`docs/self-host.md` | 两个客户端连自建服，互见并对战 | WP2、WP4 |
| WP11 组队与实例 | 2 | 队伍和实例两个纯状态机；服务端适配；`coop` 协议；副本迁移与仓储；`multiplayer.json#coop`；副本定义扩展类型 | `src/shared/coop/party.ts`、`instance.ts`、`src/shared/protocol/coop.ts`、`src/server/coop.ts`、`src/server/db/dungeons.ts`、`migrations/00N_dungeons.sql` | 邀请、接受、踢人、离队、过期；实例的创建、加入、离开、重连、过期；同一副本的两个实例互不可见；越权或超距的机关操作被拒 | WP0、WP1 |
| WP12b Raid 协调器 | 2 | 回合收集、截止与自动出招、AI 托管、断线保留、合并规则、结束条件 | `src/shared/battle/raid.ts`、`src/shared/protocol/raid.ts` | 3 人 Raid 确定性重放一致；超时和断线路径；HP 与能力等级合并；N=1 时与普通战斗结果一致 | WP12a |
| WP8 离线房间 | 3 | 浏览器端 hub 适配、`/signal`、DataChannel、房间 UI、STUN；hub 核心带上组队与实例模块 | `src/client/net/rtc/**`、`src/server/signal.ts`、`ui/screens/rooms.ts` | 房主和访客同屏移动、聊天；房间内两人组队进副本 | WP0、WP4、WP11、D4 |
| WP9 剧情、拾取、研究的校验 | 3 | 按脚本步骤 id、一次性 flag 和位置校验 | `src/server/authority/script.ts` | 伪造的给予被拒 | WP6、#25 |
| WP13 掉落与锁定 | 3 | 个人掉落、合格判定、周期锁定、ledger、审计和异常规则；掉落表 schema | `src/server/authority/loot.ts`、`src/shared/types.ts`（只加掉落表类型）、`net.json#anticheat` 中副本相关项 | 重试不重复发奖；锁定按周期生效；贡献不足没有奖励；伪造的掉落请求被拒并写审计 | WP6、WP11；数据来自 #28 |
| WP14 副本客户端 | 3 | 队伍面板、邀请提示、入口难度选择、就绪确认、实例 HUD；`coop-channel.ts`（实现 `BattleChannel`）；Raid HUD（共享血条、队友条、倒计时）；舞台上的队友精灵；离线单刷的回环宿主 | `src/client/net/coop-channel.ts`、`src/client/ui/screens/party.ts`、`src/client/battle/raid-hud.ts`、`content/battle-stage.json`（只加队友槽位）、`content/text/zh-CN/multiplayer.json` | #28 验收：单刷通关录屏；两个客户端组队击败 Boss 的录屏；两个机器人的服务端测试（每人只发一次奖） | WP11、WP12b；舞台改动要与战斗舞台的负责人协调 |
| WP10 基础设施 | 任意 | 按测量结果替换隧道、迁到 VPS 或调整 EdgeOne | `deploy/**`、`docs/RELEASING.md`，以及服务器本身 | 改前改后的测量数据 | D3，需要批准 |

**人员编排（4 个 worker：A、B、C、D）：**
- 第 0 期：WP0，1 人串行。
- 第 1 期：A 做 WP1，B 做 WP2 后接 WP12a，C 做 WP3，D 做 WP4。
- 第 2 期：A 做 WP5 后接 WP6，B 做 WP11，C 做 WP12b，D 做 WP7。
- 第 3 期：WP8、WP13、WP14、WP9。
- WP10 等 D3 决定后再做。

**[residual risk]：**
- WP12a 和 #26、#27 共用 `engine.ts`。如果 #27 的 worker 已经开始改引擎，需要主控先让双方对齐 `BossState` 的字段。
- 战斗舞台加队友槽位属于视觉改动，所有者对画面要求很高，需要做前后截图对比。

## 7 待所有者决策

1. **D1 设计数据的载体**
   - A（推荐）：JSON 进 git，构建时编译成带哈希的内容包，另生成一个只读分析库。审查和回滚现成，客户端零改造；代价是调参要发版。
   - B：以数据库为源，导出 JSON 给构建。需要自建编辑后台，git diff 失去意义。
   - C：运行期由数据库下发内容。能热更新，但 `CONTENT` 的全局改造量很大，两端规则还可能漂移。

2. **D2 现有玩家进度如何进入服务端角色**
   - A（推荐）：一次性导入。切换后第一次联机时上传当前存档，sanitize 后入库，标 `legacy-import` 并写审计，只接受截止日期前创建的存档。目前玩家少，体验好；代价是此前的作弊进度会被带进来。
   - B：联机从零开始，旧存档转成离线世界。最干净，但老玩家可能流失。
   - C：只导入名字和图鉴这类展示数据。

3. **D3 游戏服部署位置与链路**（第 0 期测量之后再定）
   - A（推荐，前提是 VPS 资源够）：游戏服迁到香港 VPS，隧道不再出现在游戏路径上。需要调整部署流程。
   - B：保留 Arch，把 `ssh -w` 换成 `ssh -R`。改动小，消除了双层 TCP，但仍有单流阻塞。
   - C：只做应用层优化。
   - 另外，WebSocket 是否绕开 EdgeOne、直连 VPS，按 A/B 测量数据决定。生产的真实 IP 配置也在这一项里一并批准。

4. **D4 房间直连失败时的兜底**
   - A：只用自建 STUN。零流量成本，但部分移动网络连不上。
   - B（推荐）：直连失败时，经官方服的 WebSocket 中继，自己实现并限制速率和人数。所有人都能连上，代价是延迟要绕香港，并产生带宽成本。
   - C：部署 coturn（TURN 走 TCP/TLS 443）。这是标准方案，但运维成本最高。

**参考：**
- [EdgeOne WebSocket](https://cloud.tencent.com/document/product/1552/73071)
- [EdgeOne 四层代理概述](https://edgeone.ai/document/zh/54506)
- [四层代理实例配置（企业版）](https://edgeone.ai/document/54507)
- [EdgeOne 智能加速](https://cloud.tencent.com/document/product/1552/70959)
- [回源超时](https://cloud.tencent.com/document/product/1552/104992)