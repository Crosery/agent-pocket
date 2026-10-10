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
  - 本地导入的旧档标记为不可信来源（`imported: true, trusted: false, origin: 'legacy-import'`），清零服务端权威战绩（`pvpWins / pvpLosses / trades / maxDistance`），智灵标记为 `legacy` 并记录审计，绝不凭未验明来源的客户端数据授予权威排行或联机战绩。
- **内置 `node:sqlite` 持久化与平滑迁移：**
  - 使用 Node 内置 `node:sqlite`（`DatabaseSync`，零新增 npm 生产依赖），开启 `WAL` 与外键约束。
  - 提供一次性事务迁移（启动自动检测 + 独立 CLI `scripts/migrate-sqlite.ts`），将现有 `profiles.json` 导入 SQLite，保留原 JSON 文件不删除，支持幂等重跑与一键回滚。
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

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

### 4.2 会话 Cookie 与同源 CSRF 防护
- Cookie 名：`ap_session`（在 `content/net.json` 的 `auth.cookieName` 配置）。
- 属性：`HttpOnly; Path=/; SameSite=Lax; Max-Age=<sessionTtlSeconds>`；当请求协议为 HTTPS（含反向代理 `X-Forwarded-Proto: https`）时自动附加 `Secure`。
- 状态变更接口（`POST /api/auth/*`、`POST /api/account/*`）强制校验同源策略：
  - 若请求携带 `Origin` 头，其 host 必须与请求 `Host` 一致；
  - 若无 `Origin` 但携带 `Referer`，其 URL host 必须与请求 `Host` 一致；
  - 跨域伪造请求直接拒绝并返回 `403 forbidden_origin`，记录 `audit`。

### 4.3 有界限流
- 在 `content/net.json` 的 `auth.rates` 中配置每 IP 与每账号（归一化用户名）的令牌桶，表项数上限受 `auth.maxRateBuckets` 约束（超出时按最久未访问淘汰，防内存耗尽）。
- 触发限流时返回 `429 rate_limited` 并写入 `audit`。

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
- `getSave(accountId)` / `getAccountSave(accountId)`：读取账号绑定的权威 `SaveData` 及 `{ imported, trusted, rev }` 元数据。
- `putSave(accountId, save, opts?)` / `putAccountSave(...)`：**仅限服务端内部模块（#22 权威战斗/交易、#28 副本结算）调用**，更新角色存档、递增 `rev` 并同步更新公开档案。HTTP 层不暴露任意覆盖存档的接口。
- `bindSave(accountId, rawSave, opts?)`：仅在账号尚未绑定角色存档时成功一次（`INSERT ... ON CONFLICT DO NOTHING` 事务检查），强制覆写 `save.playerId = accountId`；若 `imported: true`，执行 `migrateSave` + `sanitizeSaveData`，将 `pvpWins / pvpLosses / trades / maxDistance` 归零，智灵 `origin` 归一为 `{ kind: 'legacy' }`，标记 `trusted = false` 并写审计。
- `audit(entry)` / `recordAudit(entry)`：写入 `audit` 表（IP 经 SHA-256 脱敏存储）。

## 6 JSON → SQLite 迁移与回滚说明

### 6.1 一次性迁移流程
1. **自动迁移：** 服务端启动调用 `store.load()` 时，若发现 `<dataDir>/profiles.json` 且 `meta.legacy_imported` 未设置，自动在打开迁移事务前生成快照备份 `<dataDir>/backups/pre-legacy-import-<ts>.db`，随后在单个 SQLite 事务中将全部记录写入 `profiles` 与 `legacy_profiles`，并设置 `meta.legacy_imported = <timestamp>`。
2. **命令行工具：**
   ```bash
   # 执行或校验迁移（幂等，重复运行不会重复导入）
   node scripts/migrate-sqlite.ts --data-dir /srv/ap/data/preview
   ```
3. **保留原文件：** 原 `<dataDir>/profiles.json` 保持只读留存，不删除、不截断，同时在 `legacy_profiles.raw_json` 完整留底。

命令行遇到未知参数、缺少目录或备份路径时，在打开数据库前以非零状态退出；`--restore-db` 与 `--backup` 必须和 `--rollback` 一起使用，避免拼写错误意外操作默认数据目录。

### 6.2 备份与回滚步骤
1. **将 SQLite 导出回 `profiles.json` 并回滚：**
   ```bash
   # 1) 停止对应环境的进程（预发布 preview 或正式 production）
   sudo systemctl stop ap@preview

   # 2) 使用迁移工具从 SQLite 恢复 profiles.json（或还原迁移前备份库）
   node scripts/migrate-sqlite.ts --data-dir /srv/ap/data/preview --rollback

   # 3) 若需彻底退回迁移前的数据库文件，也可直接用 backups/ 下的快照覆盖：
   cp /srv/ap/data/preview/backups/pre-legacy-import-*.db /srv/ap/data/preview/ap.db

   # 4) 切回旧版发布并启动
   bash /srv/ap/preview/current/deploy/rollback.sh preview
   ```
2. **环境隔离：**
   - 预发布：`/srv/ap/data/preview/ap.db`
   - 正式服：`/srv/ap/data/production/ap.db`
   - 本地开发：`data/server/ap.db`
