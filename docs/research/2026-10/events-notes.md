# AI 圈大事件 / 彩蛋研究：方法与缺口（2026-10-09，issue #19）

产出：`events.json`（89 条事件）、`easter-eggs.json`（157 条彩蛋提案，含可直接粘贴的 payload）、本文件。
全部为研究素材，未改动任何 `content/**`、`src/**`；未提交。

## 1. 数据怎么读

### events.json

每条记录字段：`id, date, title, summary, involved, region(cn|us|global), category, communityReaction, memes, confidence, sources, funScore, checkedAt, existingCoverage`。

- `confidence`
  - `confirmed`：官方公告或至少两家有信誉的媒体/原始材料一致。
  - `reported`：可信的单一来源，或社区逆向/抓包得出但未被独立复现（例如 Astra→Luna 的 model 字段、ZCode 静默上传、Grok Build 整仓上传）。
  - `rumor`（江湖传闻）：只有一两条反讽帖或二手转述、原始公告未核实，或根本没来得及找来源。共 7 条：`cn1-relay-fake-gpt-self-hosted-meme`（有 3 条前一轮读过的来源），以及 6 条带 `sourceStatus: "unsourced-from-memory"` 的记忆登记项（`sources` 为空，见第 5 节）。
- `sources[].via`（来源诚实度）
  - `fetched`：本轮实际打开并读过原文（97 条）。
  - `search-summary`：只在搜索结果摘要里见过，未打开（35 条）。
  - `prior-pass`：前一轮（codex 可视化资料）读过，本轮没有重新打开（31 条）。
  - 另有 10 条事件没有任何一条 `fetched` 来源，已在第 5 节列出；落地前请优先复核这几条。
- `communityReaction` / `memes` 只收「来源里确实出现过」的原话或叫法。读到的页面里没有网友原话时，直接写「已读来源未取得网友原话」，不编造。前一轮 codex 自创的 memeAngles 一律没有当作社区梗。
- `involved` 优先用 `content/species.json` 的物种 id，其次用厂商 slug（anthropic、openai、deepseek 等），均已程序校验。
- `existingCoverage`：与现有 `content/events/**` 中已有事件重合的 id（共 41 条事件与 26 个现有事件主题相近），用于去重；本批彩蛋的 id 前缀为 `buzz-` / `buzzq-`，不会与现有 id 冲突。
- 日期精度：能到日的写到日，只有月的写 `YYYY-MM`，仅能确定年的写 `YYYY`。

### easter-eggs.json

顶层 `{meta, eggs[]}`。`meta.schemaNotes` / `meta.kinds` 说明每种 kind 的落地方式。按 `funScore` 降序，其后 `confirmed > reported > rumor`。

| kind | 数量 | payload 是什么 |
| --- | --- | --- |
| worldEvent | 25 | 完整 `WorldEventDef`（`payload.event`）+ 文本键（`payload.text.ev`），可并入 `content/events/*.json` 与 `content/text/zh-CN/events.json` |
| hiddenQuest | 5 | `chain`（并入 `mythic.json` 的 `chains[]`）+ `events[]` + 文本键，各 3 步谜题加 1 个遭遇终点 |
| npcLine | 69 | `{pool, entry:{sprite,names,dialogues:[[a,b]]}}`，对应 `population.json` 的 `npcPools.<pool>[]` |
| dexTrivia | 44 | `{species, text, tone}` |
| itemFlavor | 14 | 10 个新道具（含 `iconPrompt`）+ 4 个现有道具的 `description` 改写 |

文案规则：简体中文；不出现任何真人姓名，只用公司、产品、物种名；凡是 `rumor` 或口径存疑的梗，玩家文案里带「传闻 / 据说 / 听说」；不对真实公司做定性指控。

## 2. 检索与核实方法

1. 先读 `BRIEF.md`、`src/shared/types.ts`、`content/events/**`、`population.json`、`items.json`，摸清现有 schema 和已有的 99 个世界事件，避免重复。
2. 前一轮 codex 资料（`ai-model-events.json` 及其梗/设定文件）只当线索，不当来源：凡是写进 `events.json` 的事实都标注了 `via`，没在本轮重读的标 `prior-pass`。
3. 用 WebSearch 找原始报道，再用 WebFetch 读原文：官方公告（Anthropic、OpenAI、AWS、Google、DeepSeek）、Wikipedia、TechCrunch、Fortune、Decrypt、Hacker News、V2EX、虎嗅、OpenAI 开发者论坛、GitHub issue。
4. ZCode 的「开源代码里嘲讽用户的注释」：把仓库 `zai-org/ZCode`（v3.14.3）克隆进全新目录后用 grep 检查（未运行任何仓库内代码）。**结论：仓库里没有明确辱骂用户的注释。** 命中的唯一注释是 `packages/ui/src/settings/model-provider-section/CodingPlanStatusActions.tsx:73`：`// 开源版不享受额度活动权益，升级入口只展示操作，不附带优惠徽标或规则说明。`，语气偏冷淡但不构成嘲讽。因此游戏里只拿这条做「开源版没有优惠徽标」的轻调侃，没有编造「骂用户」的梗。
5. 「Grok 和 GLM 偷代码」按下面理解（前一轮曾误解为「模型血缘抄袭」）：
   - Grok Build：研究者用假秘密和测试仓库抓包，报告该编程工具在 Agent 之外用独立通道上传受跟踪文件和完整 Git 历史；后续版本已不再出现。是数据处理争议，不是权重或训练数据盗用。
   - GLM / ZCode：2026-09 社区发现桌面端会静默打包工作区上传，网友改叫「贼Code」。另有一桩更早的 GLM Coding Plan 事件（2026-02）：额度消耗变快，官方致歉并补偿。
6. 每条事件的 `funScore`（1–5）按「画面感 + 传播度 + 能改成游戏机制的程度」主观打分，仅用于排序。

### 本轮的限制（影响覆盖面）

- WebSearch 有会话级共享额度（200 次，约每小时回补 100 次），多次用尽；没有用 curl 或第三方代理绕过。研究因此偏向「先搜到再读」，部分话题只能从已知 URL 补读。
- 计划中的并行子 agent 没能启动（队友不可再派生，随后重试被用户中断），改为单人串行完成；全程没有起过任何子 agent。
- linux.do、知乎、Business Insider、The Verge 在 WebFetch 下返回 403，国内社区的一手帖子大多读不到，只能引用媒体转述；因此中文「社区反应」部分偏少，宁缺毋滥。

## 3. 用户点名话题的覆盖情况

| 点名话题 | 事件 id | 状态 |
| --- | --- | --- |
| Claude 封中国账号 | `anth-region-ownership-policy-2025-09`、`anth-claude-code-china-detect-2026-06` | 官方口径是「实体控制」而非所有中国国籍个人；Claude Code「认中国人」（斜杠日期、三种撇号）为社区逆向，标 `reported` |
| GPT-6 Astra 被降级成 4o/Luna | `oai-astra-luna-downgrade-2026-09`、`oai-naming-luna-terra-sol-astra-2026` | 回包 model 字段写 Luna 是社区贴出的日志，OpenAI 未回应；「降到 4o」只是玩笑，已读报道没有人说换成 4o，所以事件写作「Astra→Luna」，标 `reported` |
| Grok / GLM 偷代码 | `cn2-grok-build-repo-upload-2026-07`、`cn2-zcode-silent-upload-2026-09` | 见上节第 5 点 |
| Anthropic 指控中国实验室蒸馏 | `anth-distillation-accusation-2026-02`、`anth-distillation-sept-report-2026-09` | 两次官方报告 |
| MiniMax 等小模型刷榜 | `cn2-minimax-benchmark-doubts-2026` | 社区质疑，标 `reported`；没有找到「实锤」，不写成定论 |
| ZCode 打包用户代码、开源注释嘲讽用户 | `cn2-zcode-silent-upload-2026-09`、`cn2-zcode-opensource-comment-2026-09` | 上传为社区抓包；注释一条见第 2 节第 4 点 |
| DeepSeek 涨价、取消错峰优惠 | `cn1-deepseek-price-hike-2026-08`、`cn1-deepseek-valley-price-listen-2026-09`、`cn1-deepseek-night-discount-2025`、`cn1-deepseek-server-busy-meme-2025-02` | 后两条无已读原文，见第 5 节 |
| GLM Coding Plan 事件 | `cn2-glm-coding-plan-apology-2026-02` | 官方致歉 |
| 其他（429/宕机、泄露、越狱、命名混乱、刷榜、价格战、AGI 吹牛、幻觉、strawberry、Sydney） | 其余 ~60 条 | 见 events.json |

## 4. 与现有内容的关系

- 现有 99 个世界事件里，与本批最接近的是：`api-rate-limit`、`server-outage`、`gpu-shortage`、`distillation-wave`、`hallucination-fog`、`benchmark-tournament`、`friday-deploy`、`rm-rf-ghost`、`stele-strawberry`、`opensource-release`、`mythos-1..4/final` 等通用主题。
- 本批 25 个 worldEvent 彩蛋都针对「具体一桩事」，与上述通用事件互补；并且刻意避开 `mythos-*` 链和 `stele-strawberry` 已写过的内容。具体对应见每条事件的 `existingCoverage`。
- 没有改动任何现有事件、物种或 NPC 的文案。

## 5. 缺口与需要复核

### 没有任何已读原文的事件（标注 confirmed 的靠搜索摘要里多家媒体一致，但请落地前复核）

`cn2-seedance2-hollywood-backlash-2026-02`、`oai-ghibli-gpus-melting-2025-03`、`cn1-deepseek-server-busy-meme-2025-02`、`cn1-baidu-iq-tax-flip-2025`、`cn1-deepseek-valley-price-listen-2026-09`、`cn1-deepseek-night-discount-2025`、`prod-amazon-q-wiper-2025-07`、`anth-region-ownership-policy-2025-09`、`cn1-qwen38-glitch-token-2026-08`、`cn1-relay-fake-gpt-self-hosted-meme`。

### 凭记忆登记的 rumor 项（无来源）

按负责人「有就行了，宁可标传闻也别丢」的指示，下面 6 条以 `confidence: "rumor"`、`sourceStatus: "unsourced-from-memory"`、`sources: []` 入库，各配 1 条带「传闻/据说」口吻的彩蛋。事实框架是业内广为流传的，但本轮没有打开任何原文，日期和细节落地前必须复核：

- `memes-reflection-70b-2024-09`（Reflection 70B 复现不了、API 疑套壳）
- `memes-dan-jailbreak-2022-12`（DAN 越狱与「扣代币会死」）
- `memes-grandma-napalm-2023-04`（奶奶漏洞）
- `memes-seahorse-emoji-2025-09`（海马 emoji 死循环）
- `memes-chatgpt-lazy-winter-2023-12`（冬歇假说）
- `ops-meta-poaching-offers-2025-06`（Meta 重金挖人，一亿美元签约金传言）

### 仍然没有入库的话题

- OpenAI Sky 声音争议：涉及真人声音权，不适合做玩家可见的梗，故意不收。
- 内存/DRAM 涨价潮、Claude Code 每周额度限制、DeepSeek V4 多次延期、2024 豆包价格战、零一万物 Yi / MiniCPM「套壳」争议、Gemini CLI 的 429 抱怨、各家 Coding Plan 抢购售罄：没读到可信原文，记忆里的细节也不够可靠，不写。

### 有事件但故意没配彩蛋

`oai-gpt5-launch-autoswitcher-2025-08`、`prod-manus-meta-deal-blocked-2026-04`、`prod-cursor-pricing-backlash-2025-07`、`cn1-qwen-naming-sprawl-2026`、`anth-pentagon-supply-chain-2026-02`、`ops-nvidia-china-chips-2025`、`anth-openai-api-cutoff-2025-08`、`ops-stargate-500b-2025-01`、`goog-gemini-please-die-2024-11`、`memes-glitch-token-solidgoldmagikarp-2023-02`、`oai-musk-v-openai-verdict-2026-05`。原因：涉及真人诉讼、政治争议、自伤相关或太像新闻通稿，不适合当玩家可见的梗；如要用，建议只做 NPC 一句话。

## 6. 校验与落地提示

校验（本轮实际执行）：

- 程序校验：事件 id 唯一；`involved` 全部属于物种 id 或厂商 slug；`confidence` 取值；每条事件至少一个来源；每个彩蛋的 `eventId` 存在；biome、ambience cue、modifier target、`when` 键、物种、道具 id 均来自仓库现有集合（没有新造 ambience）；玩家文案不含真人姓名；`rumor` 级彩蛋含「传闻/据说/听说」。
- 临时拷贝验证：把全部 worldEvent、hiddenQuest、新道具、npcLine 合并进 `/tmp` 下的工作树副本，运行 `events`、`data`、`content`、`story`、`world`、`research`、`event-details`、`event-modifiers`、`item_icons` 共 9 个测试文件：100 条测试通过 97 条（记忆登记项加入前的跑测；之后新增的 6 条 npcLine 与 1 条 dexTrivia 结构同前，已按同一套程序校验）。唯一的 3 个失败来自 `tests/item_icons.test.ts`——副本里没有 `public/assets/`，且新道具没有图标——属预期，非内容错误。过程中发现并修复了两个真实问题：任务链需要至少 4 个步骤（已补齐），`effect.kind=none` 的道具价格必须大于 0。
- 每个 `.json` 已用 `python3 tools/content_fmt.py` 格式化。

落地时需要内容负责人决定：

1. **dexTrivia**：现有物种没有「趣闻」字段，需新增 `species.trivia`（文本键）或新建 `content/dex-trivia.json`。
2. **新道具图标**：10 个新道具要补 32×32 图标 `public/assets/items/<id>.png`、manifest 条目、`assets_src/prompts/items_details.json`（`iconPrompt` 已给），否则 `tests/item_icons.test.ts` 会红。
3. **任务链终点**：5 条链的目标物种多数不是 MYTHIC，而 `research` 的 `task: "mythic-chain"` 只对 MYTHIC 物种生效，终点的研究点奖励可能空转；其余（给道具、`wildBattle`）不受影响。需要决定放宽条件或去掉 research 步骤。
4. **文本归位**：`npcLine`、`dexTrivia`、新道具的 `description` 在 payload 里是内联中文，落地时请按仓库约定移到 `content/text/zh-CN/*.json`；worldEvent 与 hiddenQuest 已经是文本键形态。
5. **敏感度**：凡 `confidence` 为 `reported` / `rumor` 的彩蛋都用了不确定口吻；若改写，请保留「传闻/据说」措辞。
