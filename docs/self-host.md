# Agent Pocket 自建服务器指南 (Self-Hosting Guide)

本文档介绍如何自行部署与运行《Agent Pocket · 智灵口袋》独立服务器，并指导玩家如何在游戏客户端中添加自定义服务器进行联机。

架构与设计原则与 [ADR 0001: 运行期数据入库、服务端权威与自建服](adr/0001-runtime-data-authority-latency-worlds.md) 保持一致。

---

## 1. 架构概览

- **运行环境**：Node.js >= 23.6（推荐 Node 24+）。
- **零生产依赖**：数据持久化使用 Node 原生 `node:sqlite`（WAL 模式），网络使用标准 WebSocket 与 Node HTTP。无需额外安装外部数据库或重量级中间件。
- **服务端权威**：账号、角色、背包、战斗结算由服务端进行权威验证，确保联机环境公平与防作弊。
- **协议端点**：
  - `GET /api/status`：服务器状态探测（在线人数、版本、延迟）。
  - `POST /api/auth/register` 与 `POST /api/auth/login`：账号注册与登录（密码 scrypt 加盐哈希，发放 HttpOnly 会话 Cookie `ap_session`）。
  - `GET /api/account` 与 `POST /api/account/bind`：账号角色绑定与服务端存档管理。
  - `GET /ws`：游戏实时通信 WebSocket 端点。

---

## 2. 快速启动

### 2.1 安装依赖
在服务器上克隆仓库并安装开发构建依赖：

```bash
git clone https://github.com/Crosery/agent-pocket.git
cd agent-pocket
npm install
```

### 2.2 启动服务器
直接通过 Node 启动游戏服务端：

```bash
# 使用默认端口 8787
npm start

# 或直接运行入口脚本
node src/server/index.ts
```

启动成功后，服务端会在终端输出监听日志：
```
[server] listening on http://0.0.0.0:8787 (ws on /ws)
```

---

## 3. 环境变量与配置

可以通过环境变量自定义服务器参数：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` 或 `AP_SERVER_PORT` | `8787` | 服务端监听的 HTTP/WebSocket 端口 |
| `AP_DATA_DIR` | `data/server` | SQLite 数据库和服务器持久化存储目录 |
| `AP_DEV` | `0` | 是否开启本地调试模式（生产环境请勿开启） |
| `NODE_ENV` | `production` | 运行环境模式 |

示例：在自定义端口和数据目录下运行
```bash
AP_SERVER_PORT=9000 AP_DATA_DIR=/srv/ap/data node src/server/index.ts
```

---

## 4. 反向代理配置（推荐）

自建服通常通过 Caddy 或 Nginx 进行反向代理并配置 HTTPS/WSS 证书。

### 4.1 Caddy 配置示例
Caddy 默认支持 WebSocket 自动升级与 HttpOnly Cookie 透传：

```caddyfile
ap.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### 4.2 Nginx 配置示例
确保开启 WebSocket 升级头部与保持 Cookie：

```nginx
server {
    listen 443 ssl http2;
    server_name ap.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 5. 客户端连接与加入

游戏主界面支持玩家自由添加、管理自建服务器（类似《我的世界》服务器列表机制）：

1. **进入主界面**：打开游戏，点击主菜单中的「**多人游戏**」。
2. **服务器列表**：
   - 列表中第一项为「**官方服务器**」（受保护不可删除）。
   - 点击底部的「**添加服务器**」按钮。
3. **输入服务器信息**：
   - **服务器名称**：输入自定名称（例如：`好友开黑服`）。
   - **服务器地址**：输入服务器域名或 IP 地址（例如：`ap.example.com` 或 `192.168.1.100:8787`）。
   - 点击「**保存**」。
4. **状态探测**：
   - 客户端会自动向服务器的 `/api/status` 发起探测，显示服务器在线人数、网络延迟（Ping）与版本兼容状态。
5. **加入与登录**：
   - 选中该服务器，点击「**加入服务器**」。
   - 输入账号密码进行登录或注册（密码在客户端不持久化保存，使用安全性高的 HttpOnly Cookie 会话）。
   - 首次登录时可选择「创建新角色」或「上传单人存档绑定」。
   - 进入世界后即可与同一服务器上的其他玩家自由互动、对战与冒险！

---

## 6. 数据备份与维护

- **数据位置**：所有账号、角色和世界数据保存在 `data/server/`（或 `AP_DATA_DIR` 指定路径）中的 SQLite 文件。
- **热备份**：由于使用了 SQLite WAL 模式，可通过执行 `sqlite3 data/server/ap.db ".backup 'data/backup.db'"` 安全进行在线热备份，无需停机。
