# 红点与「去看看」提示

状态：`current` · 更新：2026-10-10 · 对应 issue #40

玩家能处理的事（领奖励、新条目……）不能靠碰运气发现。这套机制把「有东西等着你」做成数据：一个来源 = 一个 provider + content 里一行配置，红点、菜单光标和首次提示都跟着走。

## 谁在哪里亮红点

| 位置 | 实现 |
|---|---|
| 触屏「菜单」键（桌面没有） | `html.ap-attn-menu` 由 `src/client/attention/index.ts` 开关，样式在 `styles.css` |
| 桌面左上角「Esc 菜单有新动态」小条（触屏隐藏） | `HUD.setMenuAlert(on, device)`，键帽来自按键绑定 |
| 暂停菜单里对应的行 | `pause.ts` 画行时按 `entrySources()` 判断，菜单行末尾一个红点 |
| 页面里可领取的条目（研究页的「领取研究奖励」行和顶部的「可领取」行） | 页面自己读 `researchSummary()`，领完重画，红点立刻消失 |

红点只是 `attentionDot()`（`widgets.ts`），颜色是 `--ap-alert`。

## 首次引导

某个来源第一次从「没有」变成「有」（存档读进来就有也算），`attention:raised` 事件触发 `content/tutorial.json` 里的提示卡 `researchReward`：

- 桌面写「按 Esc → 智灵研究 → 领取奖励」（`{menu}` 是按键占位符），触屏写「点「菜单」→ 智灵研究 → 领取奖励」。
- 走现成的提示系统：`phase: field`，战斗、对话、全屏界面里不弹，排队到玩家回到世界后再弹；只弹一次（`tip:` 旗标）；玩家在设置里关了新手提示就不弹，红点仍在。
- `whileAttention`：排队期间玩家已经领掉了，就不弹了。
- 打开暂停菜单时，光标直接停在有东西的那一行，那一行轻轻呼吸，直到玩家点开过它（`guideFlag`）。

## 接入一个新来源

1. `src/client/attention/logic.ts` 的 `PROVIDERS` 里加一个函数 `(save) => 数量`。
2. `content/ui.json` 的 `attention.sources` 里加一行：`id`、`provider`、`entry`（暂停菜单的 action）、`guideFlag`（存档旗标，别重名）、`detail`（暂停菜单详情栏的一句话，文本放 `content/text/zh-CN/hud.json`）。
3. 要首次提示就在 `content/tutorial.json` 加一个 `on: attention:raised`、`match: {id: <来源 id>}`、`phase: field` 的提示，并挂到某一课上。

`tests/attention.test.ts` 校验配置（provider 存在、入口是真实的菜单项、文本齐全、旗标不重名），并用第二个假来源证明接入只要这两步。
