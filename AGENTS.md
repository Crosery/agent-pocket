# AGENTS.md

智灵口袋（Agent Pocket）：HD-2D（八方旅人风）网页生物收集 RPG，智灵是画成可爱 Q 版少女的各家 AI。纯网页、联机。这是所有 Agent 的唯一入口，细则链到下面的文档，不在这里重复。

| 部分 | 技术与位置 |
|---|---|
| 客户端 | Vite + TypeScript + three.js，`src/client` |
| 服务端 | Node 直接运行 `.ts` + `ws`，`src/server` |
| 同构逻辑 | `src/shared` |
| 数据 | `content/**/*.json`，经 `src/shared/content/index.ts` 的 `CONTENT` 与 `t()` 读取 |

## 开工流程：一件事 = 一个 issue = 一个分支 = 一个 PR

1. 先查重再开 issue，用 `.github/ISSUE_TEMPLATE/` 的模板：[ISSUES](docs/conventions/ISSUES.md)。
2. 从 `stage` 拉 `task/<issue>/<slug>`（slug 为小写字母、数字、下划线）。多个 Agent 并行时，一个 issue 一个 git worktree、一个写入者。
3. 每个阶段在 issue 上留一条追踪记录，头部 `<!-- ap:track v1 kind=… stage=… -->`：[TRACKING](docs/conventions/TRACKING.md)。恢复上下文先读 issue 正文和最后三条记录。
4. PR 进 `stage`，正文按模板九段写，`Closes #<issue>` 与分支号一致，CI 的 `pr-contract` 核对：[PULL-REQUESTS](docs/conventions/PULL-REQUESTS.md)。
5. 审查按 [CODE-REVIEW](docs/conventions/CODE-REVIEW.md)。合并后 issue 自动关闭、分支自动删除，合并的人核对。
6. 分支、提交格式、发版、回滚、CDN：[RELEASING](docs/RELEASING.md)。提交信息 `<type>(<scope>): <中文简述>`，首行不超过 72 字符，结尾 `Refs #<issue>`。

## 硬规则

1. **不硬编码数据**：表、id、名称、玩家可见文案、权重和可调数值都在 `content/**/*.json`，代码只放逻辑与 schema。文案放 `content/text/zh-CN/*.json`，用 `t('ns.key', params)` 读取；玩家看到的按键名来自按键绑定，不手写进文案。改过的 JSON 用 `python3 tools/content_fmt.py <文件>` 格式化。
2. **TypeScript**：只用可擦除语法（无 enum、namespace、参数属性）；相对 import 带 `.ts`；JSON 用 `import … with { type: 'json' }`。
3. **契约**：schema 在 `src/shared/types.ts` 与 `src/shared/contracts.ts`；改共享类型前找全所有使用方；地块的真值是 `GameMap.infinite`（provider）。
4. **玩家可见文本是简体中文**。
5. **保持 HD-2D 像素美术方向**，不要大幅改变整体风格。
6. **不新增 npm 依赖**（Node 内置模块如 `node:sqlite` 可以）；确需新增生产依赖，先问用户。
7. **不提交密钥**：令牌只经环境变量或 GitHub Secrets；日志、PR、评论里不出现密钥、本机绝对路径或服务器地址。提交前自查，下面这条应当没有输出：

   ```sh
   git grep --cached -nIE "kt[v]sky|/User[s]/|\.claude/secret[s]"
   ```
8. 保留不是你改的、未提交的用户改动；不做范围外的重构、清理和顺手优化。

## 检查

```sh
npm run typecheck && npm test && npm run build
```

`npm test` 约 25 秒、占 CPU；别的任务同时在跑时，耗时或 CPU 预算类用例失败先单独重跑 `node --test tests/<文件>.test.ts` 再下结论。不得放宽阈值或删断言来取得绿色。画面改动用改前改后截图（同一地点、同一时间）验证，截图放在被 git 忽略的 `output/<issue>/`，写进 PR 时要上传到 GitHub。

## 需要用户明确授权的操作

推送、合并、开 PR、在 GitHub 上评论或关闭 issue、打 tag、部署、改动生产数据或凭据、新增生产依赖、破坏性 git 操作（reset、强推、删分支）。授权只对当次有效。

## 文档地图

`docs/DESIGN.md` 设计总览 · `docs/world.md` 世界 · `docs/battle-rules.md` 战斗 · `docs/balance.md` 数值框架 · `docs/story.md` 剧情 · `docs/roster.md` 智灵名册 · `docs/assets.md` 美术管线 · `docs/music.md` 音乐 · `docs/RELEASING.md` 分支与发布 · `docs/adr/` 架构决策 · `docs/conventions/` issue / 追踪 / PR / 审查规范。
