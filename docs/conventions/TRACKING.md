# 追踪记录规范（issue 与 PR 的评论）

> 一件事从提出到关闭，每一步都以固定格式的评论留在 issue 与 PR 上；人扫一眼能看懂进展，Agent 按字段就能读出状态。

状态：`current` · 更新：2026-10-09 · 适用：所有 issue、PR 的评论，人与 Agent 都遵守。

## §1 生命周期：一件事 = 一个 issue = 一个 task 分支 = 一个 PR

```
开 issue ─▶ 从 stage 拉 task/<issue>/<slug> ─▶ 开 PR（Closes #<issue>）─▶ 审查 + CI ─▶ 合并进 stage
   │                                                                                       │
   └────────────────────────── 每个阶段在 issue 上发一条「追踪记录」 ──────────────────────┘
                                                                                           ▼
                                         自动：关闭 issue、两边互相留言、删远端 task 分支
```

- **issue 是这件事的主档**：现象、期望、验收条件写在正文；之后的每一步进展写成评论，**不改写已发出的评论**。
- **PR 是这次改动的证据档**：解决链路、验收证据、人工验收步骤写在正文（[PULL-REQUESTS](PULL-REQUESTS.md)）；审查与返工写成评论。
- 多个 Agent 并行时，每个 issue 用独立的 git worktree 和分支，一个 worktree 只有一个写入者；合并或放弃后删掉 worktree 和本地分支。
- 做完当场关，开着的 issue 只留还有人在做的事：
  - 合并后必须关：PR 合并进 `stage`，它 `Closes` 的 issue 必须关闭，task 分支必须清理。`issue-lifecycle` 的 `close-on-merge` 关闭 issue 并在 issue 和 PR 上各留一条「关闭」记录，`branch-hygiene` 删除远端 task 分支。GitHub 只在合进默认分支 `main` 时才按 `Closes #n` 自动关闭，所以不能依赖它；自动化没关上的（工作流失败，或 fork 来的 PR 合并时工作流没有写权限）由合并的人当场手工关闭，并照 §3 的格式留言，按 [CODE-REVIEW](CODE-REVIEW.md) 第 12 项核对。
  - 不走 PR 做完的（运维操作、决定不做、重复、被别的改动顺带解决）：做完的人当场写「关闭」记录，写明做了什么、在哪验证，或者为什么不做、被哪个 #n 取代，再关闭；不静默关闭。
  - 只剩外部等待的（等第三方、等别人给凭据）：关掉原 issue，把剩下的那一步开成新 issue，写明负责人和在等什么，两边 `Refs` 互相引用。
- **一件事做不完**：在原 issue 留「阻塞」或「拆分」记录，拆出的新 issue 用 `Refs #<原 issue>` 互相引用；不在已合并的分支上继续提交。
- **每天巡检**（`issue-lifecycle` 的 `sweep`，`scripts/issue-sweep.mjs`）：
  - 关联的 PR 已合并进 `stage`（热修复是合并进 `main`）、issue 还开着的，补关并留「关闭」记录。最近一次合并之后被人重开过的、还有开着的 PR 关联同一个 issue 的不关，「超期」记录里写明原因；PR 合并不到一小时的留给 `close-on-merge`。
  - 其余开着的 issue 14 天没有任何动静，留一条「超期」记录。
  - 14 天内关闭的 issue 既没有合并的 PR 也没有「关闭」记录的，留一条「缺记录」，请关闭的人补上，不重开。

### 各个生命周期在哪里强制

| 生命周期 | 规则 | 强制在哪 | 查不到时 |
|---|---|---|---|
| issue | PR 合并后它 `Closes` 的 issue 必须关闭；不走 PR 做完的当场写「关闭」再关 | 合并时 `close-on-merge`；合并的人按 [CODE-REVIEW](CODE-REVIEW.md) 第 12 项核对；每天的 `sweep` 补关、留「超期」「缺记录」 | 定时任务只跑默认分支 `main` 上的工作流，要等该工作流随发布进入 `main`；`sweep` 只留记录、不重开 |
| PR | 九段正文、`Closes #<issue>` 与分支号一致、issue 开着 | `issue-lifecycle` 的 `pr-contract` | 无 |
| task 分支（远端） | 合并后立即删除 | `branch-hygiene` 合并后删（仓库已开启「合并后删除分支」，通常 GitHub 先删，此时视为已完成）；每周巡检 14 天没提交、没有 open PR 的残留分支，只告警 | 删分支不可逆，残留的由人确认后删 |

## §2 互相引用

| 在哪 | 写什么 | 作用 |
|---|---|---|
| 分支名 | `task/<issue>/<slug>` | 分支 → issue |
| PR 正文「关联」 | `Closes #<issue>`（只关这一个）；其它相关的写 `Refs #n`，依赖写 `Depends on #n` | PR → issue；`pr-contract` 核对与分支号一致 |
| 评论 | 提到别的 issue / PR / 提交一律写 `#n` 或完整 SHA，不写「上面那个」「刚才的 PR」 | 在 GitHub 上生成双向链接 |
| 提交信息 | 结尾 `Refs #<issue>` | 提交 → issue |

## §3 追踪记录的格式

每条评论第一行是**记录头**，之后是固定的字段。字段用 `**名字**：` 开头，一个字段一行或一个列表；没有内容的字段整行省略，不写「无」。

```markdown
<!-- ap:track v1 kind=<类型> stage=<阶段> -->
**<类型中文>**｜<一句话结论>

**现状**：<现在是什么样，一两句>
**证据**：
- <命令 + 真实输出摘要 / 截图 / 日志 / 链接>
**下一步**：<谁、做什么；已结束写「无，关闭」>
**引用**：#<issue> · #<PR> · <提交 SHA>
```

- 第一行的 HTML 注释对人不可见，给 Agent 和脚本解析：`kind` 取下表的英文值，`stage` 取 `triage | dev | review | merged | released | closed`。
- 第二行加粗的中文类型 + 一句话结论，是给人扫的标题行。
- 时间与作者由 GitHub 记录，不在正文里重复写。
- 证据必须是能复查的东西：命令与真实输出、截图（直接拖进评论框上传）、CI 运行链接、提交 SHA。「看起来没问题」不是证据；本机路径别人看不到，不算。
- 不贴密钥、令牌、会话、服务器地址、真实玩家数据。

| kind | 中文类型 | 什么时候发 | 发在哪 |
|---|---|---|---|
| `triage` | 受理 | 确认能复现 / 确认要做，定了优先级、端和范围 | issue |
| `repro` | 复现 | 补充或更新复现步骤、环境、日志 | issue |
| `plan` | 方案 | 开工前写定位结论与打算怎么改（大改动必发） | issue |
| `progress` | 进展 | 阶段性结果：分支已建、主要改动完成、卡在哪 | issue |
| `blocked` | 阻塞 | 需要人决定、缺凭据、依赖别的 issue | issue（同时 @ 相关人） |
| `review` | 审查 | 逐项审查结论（也可以写在 PR 正文「审查结论」） | PR |
| `rework` | 返工 | 审查或验收提出的问题，以及改了什么 | PR |
| `accept` | 验收 | 人工验收结果：在哪个环境、按哪几步、看到了什么 | PR 或 issue |
| `closed` | 关闭 | 合并、发布或放弃；写明合并提交或原因 | issue 与 PR 各一条 |
| `overdue` | 超期 | 巡检自动发：开着的 issue 14 天没有动静，请负责人关掉、拆出外部等待或写进展 | issue |
| `unrecorded` | 缺记录 | 巡检自动发：issue 关了，却没有合并的 PR，也没有「关闭」记录 | issue |

### 例子（虚构）

```markdown
<!-- ap:track v1 kind=plan stage=dev -->
**方案**｜战斗结算时经验条先涨满再升级，改成按等级分段播放

**现状**：结算画面一次性把总经验加到当前等级的条上，跨级时条会溢出。
**证据**：
- 复现：存档槽 3，对手 Lv.20，胜利后升 2 级，经验条越过右端（截图见 issue 正文）
- 定位：`src/client` 结算面板按总经验算比例，没有按等级切段
**下一步**：Claude 在 task/21/exp_bar_levels 上改结算面板，今天提 PR
**引用**：#21
```

## §4 Agent 怎么读

- 取某个 issue 的全部记录：`gh issue view <n> --json body,comments`，只看以 `<!-- ap:track v1` 开头的评论；最后一条的 `kind` 与 `stage` 就是当前状态。
- 恢复上下文（新会话、压缩后）先读 issue 正文 + 最后三条追踪记录，再读关联 PR 的正文与最后一条 `review` / `rework` / `accept`，不凭记忆续做。
- 自己做完一个阶段就发一条记录；不发「收到」「在做了」这类没有字段的评论。
- 在 GitHub 上发评论、推送、开 PR 属于需要用户授权的操作，没有授权时把要发的记录交给用户。

## §5 与其它规范的关系

issue 正文字段见 [ISSUES](ISSUES.md)，PR 正文字段与 CI 契约见 [PULL-REQUESTS](PULL-REQUESTS.md)，审查清单见 [CODE-REVIEW](CODE-REVIEW.md)，分支、提交与发布见 [RELEASING](../RELEASING.md)。本文件只规定评论与生命周期，不重复它们的内容。
