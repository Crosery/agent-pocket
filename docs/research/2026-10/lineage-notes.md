# 模型族谱调研说明（issue #19，2026-10-09）

产物：`lineage.json`（714 条记录 / 74 个厂商）、`missing-in-game.json`、`evolution-proposals.json`。本文件说明方法、来源、可信度分级与已知缺口。

## 1. 方法

1. **目录数据优先**：2026-10-08T18:43:27Z 拉取 OpenRouter `/api/v1/models` 与 models.dev `api.json`（原始快照 `raw-*.json`）。`tools/make_seeds.py` 去掉量化版、第三方托管、`:free/:nitro/:batch/-latest` 别名、路由、社区微调，按厂商归并成 `seeds/<vendor>.json` 候选。
2. **人工策展**：`curation/<vendor>.py` 写入脉络（LINES）、日期/开源/关系覆盖（R）、目录里没有的条目（EXTRA）、游戏物种映射（SPECIES）、排除项与缺口。
3. **构建**：`python3 tools/build_lineage.py .` 生成 `lineage.json`、`tools/species-map.json`，并报告未被任何脉络认领的候选。`parts/*.json`（已按完整 schema 写好的厂商文件，目前只有 `kuaishou`，由独立子任务产出）直接并入。
4. **校验**：`python3 -I tools/validate.py .`。
5. **派生**：`python3 -I tools/make_outputs.py . <content/species.json>` 生成缺失榜与进化提案；排序规则见 `tools/rank_missing.py`、地标加分表 `tools/fame.json`。

## 2. 字段约定

- **chainStage**：沿 `parent` 链的深度（1=链首）。取代原来含义不清的“代际”列，可直接对应游戏 `stage`。
- **relation**：`post-train`/`distill` 必须有官方或可靠报道；`successor`=直接技术延续；`series-successor`=同一产品线的下一个版本，**不声明权重关系**（`parentBasis=inferred-series`）；跨厂商血缘写在 `parentExternal`。
- **sourceCheck / releaseDateBasis**（可信度）：`official`（官方页/文档/发布稿）> `secondary`（Wikipedia、媒体、时间线站）> `catalog`（OpenRouter/models.dev，其日期常是上架日而非发布日）> `background`（凭记忆或旧研究，URL 只是指向官方站点，**未打开核对**）。
- 日期只有月份时填 `releaseMonth`，`releaseDate=null`，不猜日。时区造成的 ±1 天差异不单独处理（Midjourney、Kling、ByteDance 等）。
- **species→record 映射约定**：一个游戏物种若代表“一条线”，映射到该线当前最新版本（如 `claude-opus`→Opus 5.5）；这使物种日期与记录日期可能不同，`evolution-proposals.json` 的日期差异检查已按“记录或其祖先任一日期吻合即视为一致”处理。
- `gameSpeciesId` 覆盖 190 个物种中的 189 个；`agi`（TBD 占位）不是模型，无记录。

## 3. 来源

- 目录：OpenRouter、models.dev（快照时间见 `fetch-time.txt`）。
- 官方页（已打开）：DeepSeek API 更新日志、Cohere 文档 Command A+、Xiaomi MiMo V2.6 发布说明、AWS Nova 发布说明/Nova 2.5 Sonic、OpenRouter 模型页描述等。
- 二手（已打开）：Wikipedia（Midjourney、Black Forest Labs、Suno、Kling AI、ElevenLabs、Runway、Stability AI、Luma、iFlytek、Manus、OpenClaw、Cursor、Cognition、Perplexity、Figure AI、Unitree、Apple Intelligence、Llama、Gemma、Veo、Baichuan）；Anthropic 发布时间线（hidekazu-konishi.com）；各厂商相关新闻/评测站（见记录 `sources`）。
- 搜索额度（200 次）在做到 Apple/Phi 之前用完，之后的厂商只能靠 WebFetch 打开 Wikipedia/官方页，部分厂商回退到记忆。

## 4. 各厂商可信度（记录数 / official / secondary / catalog / background）

official 偏多：DeepSeek（13/19）、智谱（17/22）、Kuaishou（23/28）。
background 偏多（**需要人工复核**）：Stability（10/10）、Huawei（5/5）、ShengShu/Vidu（5/5）、Skywork（5/5）、Intern/上海AI实验室（6/6）、01.AI（3/3）、PixVerse、World Labs、Physical Intelligence、Tencent（12/22）、ByteDance（12/25）、Google（23/59）、OpenAI（15/62，OpenAI 帮助页 403）。
完整表见 `lineage.json` 内各记录的 `sourceCheck`。

## 5. 名册与族谱的冲突（详见 `evolution-proposals.json`）

- **进化链与族谱矛盾（14 条）**：o1→gpt-5（o 系与 GPT 系在 GPT-5 合流，不是直接后训练）；gpt-6-luna→gpt-6-sol（同代不同档位）；claude-haiku→opus-4-8、claude-3-opus→claude-3-5-sonnet（跨档位，应改为各档位自己的链：Haiku 4.5→5.5、Opus 4.8→5→5.5、Sonnet 3.5→…→5.5）；gemini-flash-lite→flash→argon（Argon 跟随的是 3.1 Pro）；mistral-7b→mistral-medium（无权重关系，应走 Mistral 7B→Mixtral→Large/Medium 各自的线）；deepseek-r1→deepseek-v4（R1 是 V3 的后训练，V4 另起线）；qwen2.5→qwen3.8-max（开源线与 Max 线分开）；baichuan-2→baichuan-m3（M 系是医疗线，且 M2 基于 Qwen2.5-32B，属回忆未核）；mimo-v2-flash→mimo-v2-6-pro（Flash 与 Pro 是两条线）；pangu→openpangu、unitree→unitree-gd01、codex-2021→openai-codex（非同一产品线/中间缺环）。
- **名册 kind 偏强**：名册几乎所有边标 `post-training`，族谱里 39 条边跨越多个中间版本、多数只有 `series-successor` 证据（无权重声明）。
- **名册日期/类别差异（23 项）**：Sora 已下线；Qwen-Image 3.1 实为 2.1（2026-09-20）；GLM-5.3 为 2026-08-18（名册 08-14）；MAI-Image-2.6 预览为 2026-07-31（名册 09-04 是 OpenRouter 上架日）；Clawdbot 名册 2025-11-24 实为最初名 Warelay，Clawdbot 名称自 2026-01-02；gpt-image-1 名册 2025-03-25 是 ChatGPT 4o 生图，API 发布为 2025-04-23；o1 名册 2024-09-12 是 preview，正式版 2024-12-05；Solar Pro 4 是普通 LLM 而非 agent、日期 2026-08-06；Apple AFM 3 不是 Gemini 模型，而是用 Gemini 前沿模型输出做精炼；FLUX 3 经 Wikipedia 确认主输出是视频（名册 `video` 分类正确），另有 FLUX 3 Image（目录显示 2026-10-05，未核）；Phi-4、Nemotron 3 Ultra、Grok 4、Gemini 2.5 Pro 在名册里标为 reasoning，更准确是 llm（混合推理旗舰）；MiniMax-M2 标为 code，更准确是 llm。
- **新增产品线事实**：Kling AI 已于 2026 年拆分为独立法人（Kuaishou 仍控股，约 68%），名册“spin-off”说法大体成立（来自 `parts/kuaishou.json` 的子任务来源，官方稿/报道）；Cursor 已被 SpaceX 收购（2026-08-14 完成），Cursor Composer 2 基于 Kimi K2.5；Windsurf 2026-06-02 更名 Devin Desktop；Manus 2026-08-11 恢复独立。

## 6. 已知缺口与风险

- 所有 `background` 记录的日期可能有误；`sources` 里的 URL 只是官方入口，**不代表已打开核对**。
- Mistral changelog 两次 WebFetch 超时，Magistral/Medium 3.5/Small 4 的日期依据搜索结果摘要（与 Wikipedia/OR 一致）。
- 未核实存在性的条目：Luma Ray3.x、Marble 1.1、Vidu 2.0/Q1/Q2、Eleven v4（月份级）、Manus 2.0（月份级）、Spark X1.5/X2/X2.5（X2.5 为月份级、链上可能跳版）、Helix 2.5、Hermes Agent 日期、Intern-S2、Stable Audio 3.0。
- 发布日期有冲突的条目已在 `notes` 写明：HunyuanImage 3.5（09-22 对 09-24）、Step 5 Preview（09-16/09-18/09-20/10-08）、Spark V4.0（06-27/06-28/08-15）、Llama 3.3（12-06/12-07）。
- Anthropic 的 Sonnet 5.5（2026-09-28）和 Haiku 5.5（2026-10-07）只有 OpenRouter/models.dev 上架日，参考的时间线页快照尚未收录（`catalog` 级）。
- 缺失榜（`missing-in-game.json`）的“知名度”用 models.dev 托管数量 + OpenRouter 在榜 + 手工地标加分估计；OpenRouter 没有热度 API，所以多模态/开源小模型会被低估。
- 子任务并行被拒绝，所以小厂商（Baichuan、iFlytek、Huawei、Vidu、PixVerse、Skywork、World Labs 等）覆盖较薄。
- 安全：网页内容一律按不可信数据处理，没有下载或运行任何网页代码；回避了仿冒 MiniMax-M31 的恶意 GitHub 仓库。
