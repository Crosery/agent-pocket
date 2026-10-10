# ADR 0003：账号系统、单角色存档绑定与运行期 SQLite 持久化（#49）

- **状态：** 已采纳并实现（2026-10-11）
- **Issue：** #49，分支 `task/49/accounts_sqlite`
- **关联：** ADR 0001（#21 运行期数据入库、#22 服务端权威与防作弊）、ADR 0002（#30 开发者调试模式）、#50（标题分流与登录界面）

## 1 背景与现状

1. **无账号与会话体系：**
   - 现状联机仅依赖客户端本地生成的 `playerId`（UUID 秘密）在 WebSocket `hello` 时派生公开 `id`（`publicIdFor(playerId)`）。
   - 玩家换设备即丢失联机身份；分享单机存档码会连带泄露 `playerId` 秘密。
2. **存档与角色无服务端归属：**
   - 存档只存在于浏览器 `localStorage`，服务端不保存 `SaveData`，也不校验账号与角色、存档的一对一归属。
   - 客户端在 `hello` / `profile` 中自由上报徽章数、图鉴数、队伍和名称。
3. **运行期数据仍为 JSON 文件：**
   - `src/server/store.ts` 将玩家档案与战绩保存在单个 `profiles.json` 中，依赖全量序列化写临时文件再 `rename`。
   - 无法支撑账号、会话、单角色完整存档、审计流水等关系型查询与事务保证。

## 2 设计目标

- **纯用户名 + 密码注册与登录：** 注册成功后直接登录并签发会话 Cookie；密码采用 `node:crypto` 异步 `scrypt` 加随机盐哈希；登录/注册带每 IP 与每用户名有界限流；错误提示不泄露账号是否存在；所有规则与文案由 `content/` 驱动。
- **1:1:1 服务端权威绑定（账号 ↔ 存档 ↔ 角色）：**
  - 每个账号在同一服务器上只绑定一个角色与一份 `SaveData`。
  - 联机身份、角色 ID 与存档归属完全由服务端会话决定，忽略任何客户端自报的 `playerId` / `accountId`。
  - 首次登录且服务端尚无存档时，允许玩家一次性绑定（新建角色或上传本地旧档 `POST /api/account/bind`）；已绑定账号再次调用返回 `409 already_bound`。
  - `imported: false` 采用**服务端标准新角色生成**：仅接受校验合规的名字、头像与偏好设置，服务端直接由 `newGame` 生成标准初始状态（3000 金钱、初始道具包、空队伍、空图鉴与任务），完全免疫客户端伪造道具、徽章或进度的注入。
  - `imported: true` 进入**显式不可信隔离区**：清洗版本并校验，强写 `playerId = accountId`，标记 `imported: true, trusted: false, origin: 'legacy-import'`，写入 `save.flags['auth:untrustedImport'] = true`；金钱截断至初始金额；背包清理（非出售/关键道具剔除，堆叠上限 99）；携带道具清理与等级截断；智灵标记为 `legacy`（Boss 卡保留 `origin.boss` 签名能力）；清零服务端权威战绩（`pvpWins / pvpLosses / trades / maxDistance`）且排行榜不计其徽章与图鉴，绝不凭未验明来源的客户端数据授予权威排行或经济。
- **内置 `node:sqlite` 持久化与彻底移除运行期 JSON 镜像：**
  - 使用 Node 内置 `node:sqlite`（`DatabaseSync`，零新增 npm 生产依赖），开启 `WAL` 与外键约束。SQLite 是运行期唯一的事实源；彻底移除运行期定时写回 `profiles.json` 的镜像开销。原遗留 `profiles.json` 仅作为迁移前只读备份留存。
  - 提供一次性事务迁移（启动自动检测 + 独立 CLI `scripts/migrate-sqlite.ts`），将现有 `profiles.json` 导入 SQLite，支持幂等重跑与合并战绩回滚。
  - 预发布（`/srv/ap/data/preview`）与正式环境（`/srv/ap/data/production`）通过 `AP_DATA_DIR` 严格隔离。

## 3 数据模型（SQLite Schema）

数据库文件位于 `<dataDir>/ap.db`（由 `content/net.json` 的 `store.sqliteFile` 配置），连接初始化执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

核心表结构（`PRAGMA user_version = 1`）：

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'flagged', 'banned')),
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS characters (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  avatar TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('new', 'legacy-profile', 'legacy-import')),
  imported INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 1,
  save_json TEXT NOT NULL,
  save_sig TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('money', 'item', 'exp', 'creature')),
  subject TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id, at);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  pvp_wins INTEGER NOT NULL DEFAULT 0,
  pvp_losses INTEGER NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  max_distance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legacy_profiles (
  id TEXT PRIMARY KEY,
  raw_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  account_id TEXT,
  ip_hash TEXT,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit(account_id, at);
```

- **会话令牌不落明文：** 客户端 Cookie 持有随机 256-bit 令牌 `token`，库内仅存 `sha256(token)`（`token_hash`），同时为每个会话生成独立的 `session_secret` 供 #22 的消息级 HMAC 签名使用。
- **1:1 强约束：** `characters.account_id` 为主键并外键关联 `accounts(id)`，从表结构上保证一个账号最多绑定一个角色与一份存档。

## 4 认证、安全与 HTTP 契约

### 4.1 密码哈希与防枚举
- 采用 `node:crypto.scrypt`（异步，默认 `N=16384, r=8, p=1, keylen=64`，盐长 16 字节），格式为 `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`。
- 登录校验使用 `timingSafeEqual`；当用户名不存在时，对预设假哈希执行一次同参数 `scrypt` 计算后再返回统一的 `401 invalid_credentials`（`用户名或密码错误`），消除用户名枚举的响应与时序差异。
- 密码与会话令牌严禁写入日志、错误消息、`localStorage` 或 URL 查询参数。

### 4.2 会话 Cookie、同源 CSRF 与 WebSocket 升级防护
- Cookie 名：`ap_session`（在 `content/net.json` 的 `auth.cookieName` 配置）。
- 属性：`HttpOnly; Path=/; SameSite=Lax; Max-Age=<sessionTtlSeconds>`；当请求协议为 HTTPS（含反向代理 `X-Forwarded-Proto: https`）时自动附加 `Secure`。
- 状态变更接口（`POST /api/auth/*`、`POST /api/account/*`）及 WebSocket 升级（`/ws`）强制校验同源策略：
  - `Sec-Fetch-Site` 仅放行 `same-origin` 与 `none`（拒绝 `cross-site` 与 `same-site` 绕过）；
  - 若请求携带 `Origin` 头，其 host 必须与请求 `Host` 一致；
  - 若无 `Origin` 但携带 `Referer`，其 URL host 必须与请求 `Host` 一致；
  - 跨域伪造请求直接拒绝（HTTP 返回 `403 forbidden_origin`，WS 返回 `403 Forbidden` 并切断建连），记录 `audit`。
- **主动会话吊销与断线防护：** 登出时主动广播并关闭该账号所有活跃 WebSocket 连接；断线保存坐标前重新校验会话有效性与非封禁状态，并采用 `Math.floor` 坐标对齐。

### 4.3 有界限流与防 DoS
- 在 `content/net.json` 的 `auth.rates` 中配置每 IP 与每账号（归一化用户名）的令牌桶，表项数上限受 `auth.maxRateBuckets` 约束（超出时按最久未访问淘汰，防内存耗尽）。
- `loginAccount` 在执行规范化、限流计数与写审计日志前即刻检查用户名原始长度，超出 4 倍字符上限直接拒绝，杜绝大文本内存与数据库膨胀。
- `evictIfNeeded` 淘汰策略实施白名单保护：仅淘汰无注册账号的游客 Profile，永久保留已注册账号的战绩与档案。
### 4.4 HTTP 接口一览

| 方法与路径 | 入参 | 成功响应（200） | 错误码 |
|---|---|---|---|
| `GET /api/status` | 无 | `{ protocolVersion, version, online, name }` | `405` |
| `POST /api/auth/register` | `{ username, password }` | `{ account: { id, username }, save: null }` + `Set-Cookie` | `400 invalid_username / invalid_password`、`409 username_taken`、`403 forbidden_origin`、`429 rate_limited` |
| `POST /api/auth/login` | `{ username, password }` | `{ account: { id, username }, save: SaveData \| null }` + `Set-Cookie` | `401 invalid_credentials`、`403 forbidden_origin`、`429 rate_limited` |
| `POST /api/auth/logout` | 无 | `{ ok: true }` + 清除 Cookie | `403 forbidden_origin` |
| `GET /api/account` | Cookie `ap_session` | `{ account: { id, username }, save: SaveData \| null, imported?: boolean }` | `401 unauthorized` |
| `POST /api/account/bind` | `{ save: SaveData, imported: boolean }` | `{ account: { id, username }, save: SaveData, imported: boolean }` | `401 unauthorized`、`409 already_bound`、`400 invalid_save` |

## 5 模块接缝（`AccountStore` 与 #22 / #28 / #50 协作）

`src/server/accounts.ts` 与 `src/server/store.ts` 暴露统一的深模块接口（`ProfileStore extends AccountStore`）：

- `getAccountBySession(cookieHeaderOrToken, now?)` / `verifySession(...)`：解析 Cookie 或令牌并校验过期时间，返回 `{ token, accountId, username, sessionSecret, createdAt, expiresAt }`。
- `getSave(accountId)` / `getAccountSave(accountId)`：读取账号绑定的权威 `SaveData` 及 `{ imported, trusted, rev, sig }` 元数据。
- `putSave(accountId, save, opts?)` / `putAccountSave(...)`：**仅限服务端内部模块（#22 权威战斗/交易、#28 副本结算）调用**，更新角色存档、递增 `rev`、持久化 `save_sig` 并同步更新公开档案。HTTP 层不暴露任意覆盖存档的接口。
- `bindSave(accountId, rawSave, opts?)`：仅在账号尚未绑定角色存档时成功一次（`INSERT ... ON CONFLICT DO NOTHING` 事务检查），强制覆写 `save.playerId = accountId`。封禁账号直接拒绝。
- `recordLedger(entry)` / `listLedger(accountId, limit)`：记录与查询经济流水，对接 #22 权威流水。
- `audit(entry)` / `recordAudit(entry)`：写入 `audit` 表（IP 经 SHA-256 脱敏存储）。

## 6 JSON → SQLite 迁移与回滚说明

### 6.1 一次性迁移流程
1. **自动迁移：** 服务端启动调用 `store.load()` 时，若发现 `<dataDir>/profiles.json` 且 `meta.legacy_imported` 未设置，自动在打开迁移事务前生成快照备份 `<dataDir>/backups/pre-legacy-import-<ts>.db`，随后在单个 SQLite 事务中将全部记录写入 `profiles` 与 `legacy_profiles`，并设置 `meta.legacy_imported = <timestamp>`。首次启动无遗留 JSON 时写入 `meta.legacy_imported = 'none'`，彻底阻断后续新旧文件误判。迁移后内存中即刻更新合并后的战绩。
2. **命令行工具：**
   ```bash
   # 执行或校验迁移（幂等，重复运行不会重复导入）
   node scripts/migrate-sqlite.ts --data-dir /srv/ap/data/preview
   ```
3. **保留原文件与运行时纯 SQLite 化：** 原 `<dataDir>/profiles.json` 保持只读留存，不删除、不截断，同时在 `legacy_profiles.raw_json` 完整留底。运行时服务绝不再生成或回写 `profiles.json` 镜像。

命令行遇到未知参数、缺少目录或备份路径时，在打开数据库前以非零状态退出；`--restore-db` 与 `--backup` 必须和 `--rollback` 一起使用，避免拼写错误意外操作默认数据目录。

### 6.2 备份与安全回滚步骤
1. **将 SQLite 导出回 `profiles.json` 并回滚（包含 post-migration 战绩合并与 WAL 安全清理）：**
   ```bash
   # 1) 停止对应环境的进程（预发布 preview 或正式 production）
   sudo systemctl stop ap@preview

   # 2) 使用迁移工具从 SQLite 恢复 profiles.json（合并最新的胜负/距离），并在指定快照时安全切断 WAL 恢复
   node scripts/migrate-sqlite.ts --data-dir /srv/ap/data/preview --rollback

   # 3) 若需彻底退回迁移前的数据库文件，可在关闭后清理 -wal/-shm 并替换：
   rm -f /srv/ap/data/preview/ap.db-wal /srv/ap/data/preview/ap.db-shm
   cp /srv/ap/data/preview/backups/pre-legacy-import-*.db /srv/ap/data/preview/ap.db

   # 4) 切回旧版发布并启动
   bash /srv/ap/preview/current/deploy/rollback.sh preview
   ```
2. **环境隔离：**
   - 预发布：`/srv/ap/data/preview/ap.db`
   - 正式服：`/srv/ap/data/production/ap.db`
   - 本地开发：`data/server/ap.db`
