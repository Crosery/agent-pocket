# Pull Request 规范

> PR 是一次改动的证据档：写清解决链路、验证结果、可以直接照着做的人工验收步骤和截图录屏；审查与返工写成评论，合并后 issue 自动关闭。

状态：`current` · 更新：2026-10-09

## 目标分支与合并

- PR 只进 `stage`；`main` 只收 `stage` 经预发布验收后的发布（热修复 `hotfix/<issue>/<slug>` 除外）。分支、合并方式（merge commit，不用 squash 或 rebase）、提交格式和发布流程以 [RELEASING](../RELEASING.md) 为准，本文不重复。
- 合并本身不部署，发版靠打 tag。合并后来源 task 分支自动删除。

## 正文契约

一件事 = 一个 issue = 一个 `task/<issue>/<slug>` 分支 = 一个 PR（生命周期见 [TRACKING](TRACKING.md) §1）。标题写 `type(scope): 中文简述`。正文从模板 `.github/pull_request_template.md` 开始写，**九个段落一个都不能少**；CI 的 `pr-contract` 检查（`.github/workflows/issue-lifecycle.yml` 调 `scripts/pr-contract.mjs`）逐项核对，改 PR 描述会自动重跑：

| 段落（`### 标题`） | 要求 | CI 核对 |
|---|---|---|
| 目的 | 解决什么问题、为什么现在做；引用 issue 里的原话 | 非空 |
| 关联 | `Closes #<issue>`，与分支号一致、只关这一个；相关的写 `Refs #n`，依赖写 `Depends on #n` | issue 号一致、issue 存在且开着、不关别的 issue |
| 变更范围 | 按端列出改了什么，再写明「不做什么」 | 非空 |
| 解决链路 | 复现 → 定位（根因与怎么确认的）→ 修复（为什么这样改、否决了什么）→ 验证（能区分修复前后的测试）。新功能写需求场景、方案取舍和验证方式 | 非空 |
| 验证命令与结果 | 实际跑过的命令 + 真实输出摘要；失败、跳过、未验证的逐条列出 | 非空 |
| 验收证据 | 画面改动放同一地点、同一时间的改前改后截图，动作和动画放逐帧拼图或录屏；每项写编号、视口 / 设备、对应的验收点。没有界面变化写「无界面变化：<理由>」 | 至少一张图 / 视频 / 附件链接，或写明无界面变化 |
| 人工验收步骤 | 给验收人照着做的清单：打开哪个地址（本机 dev，或预发布并写版本 / commit）→ 做什么 → **应看到**什么 | 非空 |
| 审查结论 | 按 [CODE-REVIEW](CODE-REVIEW.md) 逐项；审查人、时间、被审查 commit；最后一行 `**结论：通过**` / `**结论：有条件通过**` / `**结论：阻塞**` | 有结论行 |
| 风险与回滚 | 已知风险、没覆盖到的环境、回滚方式（revert 合并提交）；涉及存档或服务端数据格式的写清旧数据怎么办 | 非空 |

- 模板里的 HTML 注释不算内容：删掉注释后段落是空的就不通过。
- 截图与录屏直接拖进 GitHub 编辑框上传；本机路径（`output/…`、`/tmp/…`）别人看不到，不算证据，检查也不认。
- `pr-contract` 只检查进 `stage` 的 PR。来自 `dev/*`、`hotfix/*` 等非 task 分支的 PR 进不了 `stage`；唯一例外是热修复上线后把 `main` 合回 `stage` 的 PR（分支就是 `main`），不套用正文契约。
- 不要把真实凭据、服务器地址或玩家数据放进 PR。

## 评论与生命周期

- 审查意见、返工、人工验收结果写成评论，格式统一用 [TRACKING](TRACKING.md) §3 的追踪记录（`review` / `rework` / `accept`），不改写已发出的评论。
- 合并进 `stage` 后：它 `Closes` 的 issue 必须关闭，task 分支必须清理（[ISSUES](ISSUES.md) §1）。`issue-lifecycle` 关闭 issue 并在 issue 与 PR 上各留一条「关闭」记录，`branch-hygiene` 删除 task 分支；自动化没做成的，合并的人当场补齐，并按 [CODE-REVIEW](CODE-REVIEW.md) 第 12 项核对。
- 已合并的 PR 不再追加提交；验收发现的新问题开新 issue，`Refs #<原 issue>`。

## 门禁

- 必需检查是 `verify`（`.github/workflows/ci.yml`），包含 `npm run typecheck`、`npm test`、`npm run build`。`pr-contract` 是正文契约检查，不替代 `verify`。
- 不得删除失败断言或放宽阈值来取得绿色结果。
- 不带密钥、真实数据、无关改动、新增的 npm 依赖（新增生产依赖需要用户明确同意）。
- 合并、部署与发布是独立授权操作，不由 Agent 默认执行。
