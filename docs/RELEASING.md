# 分支、提交与发布

本项目的开发和发布规范参照 geek_main，按小项目做了精简。

## 环境

| 环境 | 地址 | 由什么触发 | Arch 上的目录 / 端口 |
|---|---|---|---|
| 预发布 preview | https://prev.ap.crosery.com | 打在 `stage` 提交上的 `vX.Y.Z-rc.N` tag | `/srv/ap/preview`，8788 |
| 正式 production | https://ap.crosery.com | 打在 `main` 同一提交上的 `vX.Y.Z` tag，需要审批 | `/srv/ap/production`，8787 |

**推送分支永远不会触发部署。** 两个环境各有独立的数据目录（`/srv/ap/data/<env>`）和独立进程（`ap@<env>`）。

游戏服务跑在家里的 Arch 上，只监听隧道地址 `10.66.0.2`。香港 VPS（156.238.244.78）只做入口：
- Caddy 负责 HTTPS，经 SSH 隧道 `hk-tunnel` 反代到 Arch。
- VPS 的 TCP 2222 转发到 Arch 的 sshd，CI 就从这个口部署。
访问 `<地址>/release.json` 可以看到当前跑的是哪个环境、哪个版本、哪个提交。

## 分支

- 长期分支只有两条：`main`（正式）和 `stage`（集成和预发布）。
- 两条不变量：**`stage` 必须包含 `main`**，`main` 不得领先 `stage`。CI 的 `branch-guard` 会检查。
- 开发流程：
  - 新需求或缺陷先开 issue。
  - 从 `stage` 拉 `task/<issue>/<slug>`，slug 是小写字母、数字和下划线。
  - 提 PR 回 `stage`，用 **merge commit** 合并，不用 squash 或 rebase，这样提交 SHA 能留在历史里供追溯。
  - 合并后分支会自动删除。
- `dev/<github用户名>` 是个人试验区，只跑 CI，不能直接合进 `stage`。
- 热修复：从 `main` 拉 `hotfix/<issue>/<slug>`，PR 进 `main`。按下面的发布流程上线后，**立刻把 `main` merge 回 `stage`**，恢复不变量。

## 提交

- 格式：`<type>(<scope>): <中文简述>`，首行不超过 72 字符，结尾不加句号。
- type 可选：feat、fix、refactor、perf、docs、test、build、ci、chore、style。
- 提交不等于发版。版本号只由维护者在 PR 里手动修改 `package.json` 的 `version`，不做自动升号。

## 发布

1. 在 `stage` 上，确认 `package.json` 的 `version` 就是本次要发的 `X.Y.Z`，并且该提交的 CI `verify` 是绿的。
2. 发预发布：

   ```bash
   git tag -a vX.Y.Z-rc.N -m "vX.Y.Z-rc.N" origin/stage
   git push origin vX.Y.Z-rc.N
   ```

3. 在 https://prev.ap.crosery.com 人工验收。有问题就修完再打 `rc.N+1`。
4. 发正式：

   ```bash
   git checkout main
   git merge --ff-only vX.Y.Z-rc.N
   git push origin main
   git tag -a vX.Y.Z -m "vX.Y.Z" vX.Y.Z-rc.N^{commit}
   git push origin vX.Y.Z
   ```

   然后在 GitHub Actions 里批准 production 部署。

`deploy/release-plan.sh` 会拒绝以下情况：

- tag 的版本号和该提交里 `package.json` 的不一致。
- rc tag 不在 `stage` 上，或正式 tag 不在 `main` 上。
- 正式 tag 所在的提交没有对应的 rc tag。
- 预发布当前跑的不是这个提交。这条保证正式环境只会发预发布已经验过的版本。

**tag 推送后不移动、不删除。** 发错了就打下一个号。重新部署一个已有 tag 时，要在该 tag 上手动运行：`gh workflow run deploy --ref vX.Y.Z -f tag=vX.Y.Z`。两个环境都只接受 `v*` tag 发起的部署。

## 回滚

- 自动回滚：部署时会等待 `/release.json` 报出新提交。没等到就自动切回上一个版本，部署任务失败。
- 手动回滚：

  ```bash
  ssh -p 2222 ap@156.238.244.78 bash /srv/ap/<env>/current/deploy/rollback.sh <env> [sha]
  ```

  不带 sha 时，回到 `deploy-history.log` 里的上一个版本。回滚不动 tag，也不动数据。

## 预发布使用 devtools 构建

预发布（`prev.ap.crosery.com`）用 `vite build --mode devtools` 构建，所有者可以在手机上点场景链接验收（ADR 0002 §9，所有者 10-09 批准）。正式环境仍是普通构建，并在构建后运行 `npm run check:devgate`，门禁不过就让部署失败。

- **界面：** 不带 `?dev=1` 时，devtools 构建里的调试工具不启动，玩家看到的和正式版一样。带 `?dev=1` 或 `?scenario=<id>` 才会出现右下角的 `DEV` 徽标和面板。
- **服务器：** devtools 构建会向服务器声明自己，服务器默认拒绝。预发布的 env 文件需要有 `AP_DEV=1`，**这是一次性手工步骤，由维护者在 Arch 上做**，下一次获准的预发布部署之前完成：

  ```bash
  echo 'AP_DEV=1' >> /srv/ap/preview.env   # 只加在 preview，production.env 里不能有
  sudo systemctl restart ap@preview        # 部署时 remote-deploy.sh 本来就会重启，已经加过就不需要再手动重启
  ```

- **漏做会怎样：** 发布本身通过 HTTP 健康检查，但每个游戏连接都会被关闭。`deploy/remote-deploy.sh` 发现发布是 devtools 构建而 env 里没有 `AP_DEV=1` 时，会在部署日志（`deploy-history.log` 和 Actions 输出）里写一条 `WARNING`，并发出 Actions 警告。
- **`release.json`：** 多一个 `devtools` 字段，预发布为 `true`，正式为 `false`。
- **代价：** 预发布环境的排行榜等数据失去参考意义。

## 静态资源 CDN（七牛）

- **只有 HTML 和 `release.json` 留在源站**，其余资源都从 `https://cdn.crosery.com/ap/static/` 加载：
  - Vite 产出的带哈希文件：`ap/static/assets/<name>-<hash>.<ext>`。
  - 整个 `public/`：`ap/static/p/<public 目录内容哈希>/...`。`public/` 任何一个文件改了，前缀就会变。
- **因为键都按内容寻址，上传只增不改，CDN 永远不需要刷新。**
  - 上传令牌只能往 `ap/static/` 下新增文件，不能覆盖或删除，有效期 180 天。
  - 上传后，脚本会经 CDN 逐个 HEAD 核对状态码、大小和 CORS 头。
- 相关配置：
  - 布局：`deploy/cdn.json`。
  - 构建开关：仓库变量 `STATIC_CDN_BASE`。没有上传令牌时，自动退回同源构建。
  - 换发令牌：维护者在本机运行

    ```bash
    node scripts/static-cdn.ts mint-token --env-file <含 QINIU_ACCESS_KEY/QINIU_SECRET_KEY 的文件> | gh secret set STATIC_CDN_UPLOAD_TOKEN
    ```

## GitHub 配置一览

- Secrets：`DEPLOY_SSH_KEY`（只用于部署，服务器上是受限账号 `ap`）、`STATIC_CDN_UPLOAD_TOKEN`。
- Variables：`DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_KNOWN_HOSTS`（Arch 的主机密钥）、`STATIC_CDN_BASE`、`DEPLOY_PREVIEW_ENABLED` / `DEPLOY_PRODUCTION_ENABLED`。后两个是部署开关，值为 `enabled` 时才会部署。
- Environments：`preview`；`production`（需要审批）。
- 必需检查：`verify`（`ci.yml`）。
