# 图鉴增补 · 2026-10 批次（issue #18）

> 数据源：`docs/research/additions-2026-10.json`，由 `python3 tools/data/apply_additions.py docs/research/additions-2026-10.json` 合并进 `docs/research/roster-final.json` / `designs.json` / `assets_src/prompts/creatures.json`，再由 `python3 tools/data/build_species.py` 生成 `content/species.json` 与 `docs/roster.md`。勿手改生成物。

## 规则

- **进化 = 后训练 / 版本迭代**：同一系列里，经后训练或迭代出的新型号，是前一型号的后期进化（`evolutionKind: post-training`）。只收大类与官方主要型号，不收量化 / 速度 SKU。
- 进化链最多 3 阶（生成器的捕获率、经验、体型、招式曲线都只定义到 3 阶）；已满 3 阶的名牌系列不再延长，同厂商的相邻代际另开平行家族。
- 向已有的 2 阶链中间**插入**新形态时，原首形态的阶数与 id 不变（训练家队伍、道馆引用安全），原末形态顺延为第 3 阶。
- 新增形态的稀有度只在 N–SSR；没有新增 UR（UR 须配套漫游传说与文案）和 MYTHIC。
- 野外遇敌无需手工摆放：由栖息地（`habitats`）与稀有度行为表自动分配（N/R/SR 进草丛与可见区域，SSR 受时间 / 天气 / 地点条件限制）。

## MYTHIC 隐藏链保护

- 原先 `claude-mythos-preview`（SSR）Lv50 直接进化为 MYTHIC `claude-mythos`，绕过 `content/events/mythic.json` 的 glasswing 隐藏链。**处理：取消这条进化**。Mythos Preview 成为独立的 1 阶 SSR（`claude-mythos-preview`，仍可作 `mythos-3` 步骤要求的领队），Claude Mythos 5.1 成为独立的 1 阶 MYTHIC（家族改为 `claude-mythos-5`），只能经隐藏链遇到。
- 之所以不用“进化需通关标志”门控：进化判定在共享的战斗引擎里（`evolutionTarget`，只看等级），门控需要改战斗规则，超出本单范围。
- 新增守卫测试 `tests/species.test.ts`：任何进化都不得指向“仅事件出现”（MYTHIC）的稀有度。

## 新增智灵（65 只）

| # | id | 名称 | 公司 | 属性 | 稀有度 | BST | 进化线 | 发布 | 来源 |
|---|---|---|---|---|---|---|---|---|---|
| 8 | `gpt-5-4` | GPT-5.4 | OpenAI | 推理/对话 | SR | 478 | → GPT-5.5「土豆」 Lv28 | 2026-03-05 | <https://en.wikipedia.org/wiki/GPT-5.4> |
| 14 | `gpt-5-3-codex` | GPT-5.3-Codex | OpenAI | 代码/智能体 | SSR | 520 | ← Codex 初代；→ OpenAI Codex（编程智能体） Lv40 | 2026-02-05 | <https://en.wikipedia.org/wiki/GPT-5.3-Codex> |
| 20 | `sora-1` | Sora（初代） | OpenAI | 影像 | R | 405 | → Sora 2（已停服） Lv30 | 2024-12-09 | <https://en.wikipedia.org/wiki/Sora_(text-to-video_model)> |
| 22 | `chatgpt-agent` | ChatGPT Agent | OpenAI | 智能体/对话 | SR | 472 | → ChatGPT dots（常驻智能体） Lv28 | 2025-07-17 | <https://openai.com/index/introducing-chatgpt-agent/> |
| 30 | `claude-fable-5` | Claude Fable 5 | Anthropic | 推理/对齐 | SSR | 528 | → Claude Fable 5.1 Lv36 | 2026-06-09 | <https://en.wikipedia.org/wiki/Claude_Mythos> |
| 35 | `claude-computer-use` | Claude Computer Use | Anthropic | 智能体/视觉 | R | 392 | → Claude 应用（Cowork 合体） Lv28 | 2024-10-22 | <https://www.anthropic.com/news/3-5-models-and-computer-use> |
| 44 | `gemma-3` | Gemma 3 | Google | 开源/视觉 | R | 372 | → Gemma 4 Lv30 | 2025-03-12 | <https://en.wikipedia.org/wiki/Gemma_(language_model)> |
| 48 | `nano-banana-2-1` | Nano Banana 2.1 | Google | 视觉/算力 | SSR | 548 | ← Nano Banana 2 | 2026-10-06 | <https://openrouter.ai/google/gemini-nano-banana-2.1> |
| 50 | `veo-3-1` | Veo 3.1 | Google | 影像/音律 | SR | 488 | ← Veo 3；→ Gemini Omni 1.1 Flash Lv40 | 2025-10-15 | <https://wavespeed.ai/blog/posts/what-is-veo-4/> |
| 52 | `lyria-2` | Lyria 2 | Google | 音律 | R | 385 | → Lyria 3 Lv22 | 2025-04-01 | <https://siliconangle.com/2026/02/18/google-launches-lyria-3-music-generation-model/> |
| 53 | `lyria-3` | Lyria 3 | Google | 音律/创作 | SR | 452 | ← Lyria 2；→ Lyria 3.5 Lv38 | 2026-02-18 | <https://siliconangle.com/2026/02/18/google-launches-lyria-3-music-generation-model/> |
| 57 | `gemini-cli` | Gemini CLI | Google | 代码/智能体 | R | 395 | → Google Antigravity 反重力 Lv30 | 2025-06-25 | <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/> |
| 73 | `mixtral` | Mixtral 8x7B | Mistral AI | 开源/算力 | R | 350 | ← Mistral 7B；→ Mistral Medium 3.5 Lv34 | 2023-12-09 | <https://en.wikipedia.org/wiki/Mistral_AI> |
| 75 | `phi-3` | Phi-3 | Microsoft | 推理 | N | 300 | → Phi-4 Lv22 | 2024-04-23 | <https://innfactory.ai/en/ai-models/microsoft-phi/> |
| 77 | `phi-4-reasoning` | Phi-4-reasoning | Microsoft | 推理/开源 | SR | 438 | ← Phi-4 | 2025-04-30 | <https://innfactory.ai/en/ai-models/microsoft-phi/> |
| 82 | `nemotron-3-super` | Nemotron 3 Super | NVIDIA | 开源/算力 | SR | 440 | → Nemotron 3 Ultra Lv34 | 2026-03-11 | <https://en.wikipedia.org/wiki/Nemotron> |
| 93 | `sd-3-5` | Stable Diffusion 3.5 | Stability AI | 视觉/开源 | SR | 440 | ← SDXL | 2024-10-22 | <https://arena.ai/leaderboard/text-to-image> |
| 95 | `flux-2` | FLUX.2 | Black Forest Labs | 视觉/开源 | SR | 470 | ← FLUX.1；→ FLUX 3 Lv40 | 2025-11-25 | <https://artificialanalysis.ai/image/leaderboard/text-to-image> |
| 97 | `runway-gen-4` | Runway Gen-4 | Runway | 影像/创作 | SR | 438 | → Runway Gen-4.5 Lv30 | 2025-03-31 | <https://en.wikipedia.org/wiki/Runway_(company)> |
| 104 | `eleven-v3` | Eleven v3 | ElevenLabs | 音律/对话 | SR | 478 | ← ElevenLabs 多语言 v2；→ Eleven v4 Lv42 | 2025-06-05 | <https://artificialanalysis.ai/text-to-speech/leaderboard> |
| 126 | `langgraph` | LangGraph | LangChain | 智能体/开源 | SSR | 520 | ← LangChain | 2024-01-08 | <https://github.com/langchain-ai/langgraph> |
| 143 | `wan-2-2` | 通义万相 2.2 | Alibaba (Tongyi) | 影像/开源 | SR | 455 | ← 通义万相 2.1；→ 通义万相 3.0 Lv42 | 2025-07-28 | <https://technode.com/2026/08/24/alibaba-launches-wan3-0-video-model-with-30-second-generation-and-document-input/> |
| 162 | `seedream-4` | 即梦 Seedream 4.0 | ByteDance Seed | 视觉/创作 | SR | 458 | ← 即梦 Seedream 3.0；→ 即梦 Seedream 5.0 Lv38 | 2025-09-09 | <https://artificialanalysis.ai/image/leaderboard/text-to-image> |
| 173 | `hunyuan-image-3` | 混元生图 3.0 | Tencent Hunyuan | 视觉/开源 | SR | 450 | → 混元生图 3.5（预览） Lv30 | 2025-09-28 | <https://github.com/Tencent-Hunyuan/HunyuanImage-3.0> |
| 180 | `step-3-7-flash` | 阶跃 Step 3.7 Flash | StepFun | 算力/开源 | SR | 452 | ← 阶跃 Step 3.5 Flash；→ 阶跃 Step 5 Preview Lv40 | 2026-05-29 | <https://en.wikipedia.org/wiki/StepFun> |
| 191 | `longcat-2` | 美团 LongCat 2.0 | Meituan | 智能体/算力 | SR | 435 | ← 美团 LongCat-Flash；→ 美团龙猫 LongCat-2.5 Lv40 | 2026-06-30 | <https://www.marktechpost.com/2026/07/05/meituan-releases-longcat-2-0-a-1-6t-parameter-open-moe-model-with-native-1m-context-and-longcat-sparse-attention/> |
| 211 | `hailuo-02` | 海螺 02 | MiniMax | 影像 | SR | 455 | ← 海螺 Video-01；→ 海螺 H3 Lv40 | 2025-06-18 | <https://platform.minimax.io/docs/release-notes/models> |
| 218 | `o3-mini` | o3-mini | OpenAI | 推理 | R | 368 | → o3 Lv20 | 2025-01-31 | <https://hidekazu-konishi.com/entry/openai_gpt_model_release_timeline.html> |
| 219 | `o3` | o3 | OpenAI | 推理/代码 | SR | 448 | ← o3-mini；→ o3-pro Lv40 | 2025-04-16 | <https://en.wikipedia.org/wiki/OpenAI_o3> |
| 220 | `o3-pro` | o3-pro | OpenAI | 推理/算力 | SR | 486 | ← o3 | 2025-06-10 | <https://openrouter.ai/openai/o3-pro> |
| 221 | `claude-opus-4` | Claude Opus 4 | Anthropic | 代码/对齐 | R | 400 | → Claude Opus 4.5 Lv22 | 2025-05-22 | <https://en.wikipedia.org/wiki/Claude_(language_model)> |
| 222 | `claude-opus-4-5` | Claude Opus 4.5 | Anthropic | 代码/对齐 | SR | 458 | ← Claude Opus 4；→ Claude Opus 4.7 Lv40 | 2025-11-24 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 223 | `claude-opus-4-7` | Claude Opus 4.7 | Anthropic | 代码/推理 | SSR | 515 | ← Claude Opus 4.5 | 2026-04-16 | <https://en.wikipedia.org/wiki/Claude_(language_model)> |
| 224 | `claude-sonnet-4-5` | Claude Sonnet 4.5 | Anthropic | 代码/创作 | SR | 450 | → Claude Sonnet 5 Lv34 | 2025-09-29 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 225 | `claude-sonnet-5` | Claude Sonnet 5 | Anthropic | 代码/创作 | SSR | 530 | ← Claude Sonnet 4.5 | 2026-06-30 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 226 | `claude-haiku-3` | Claude 3 Haiku | Anthropic | 代码 | N | 295 | → Claude 3.5 Haiku Lv18 | 2024-03-13 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 227 | `claude-haiku-3-5` | Claude 3.5 Haiku | Anthropic | 代码 | R | 372 | ← Claude 3 Haiku；→ Claude Haiku 5.5 Lv34 | 2024-11-04 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 228 | `claude-haiku-5-5` | Claude Haiku 5.5 | Anthropic | 代码/智能体 | SR | 440 | ← Claude 3.5 Haiku | 2026-10-07 | <https://openrouter.ai/anthropic/claude-haiku-5.5> |
| 229 | `gemini-2-5-flash` | Gemini 2.5 Flash | Google | 算力 | R | 398 | → Gemini 3 Flash Lv24 | 2025-04-17 | <https://hidekazu-konishi.com/entry/google_gemini_model_release_timeline.html> |
| 230 | `gemini-3-flash` | Gemini 3 Flash | Google | 算力/对话 | SR | 462 | ← Gemini 2.5 Flash；→ Gemini 3.5 Flash Lv40 | 2025-12-17 | <https://hidekazu-konishi.com/entry/google_gemini_model_release_timeline.html> |
| 231 | `gemini-3-5-flash` | Gemini 3.5 Flash | Google | 算力/智能体 | SSR | 520 | ← Gemini 3 Flash | 2026-05-19 | <https://hidekazu-konishi.com/entry/google_gemini_model_release_timeline.html> |
| 232 | `grok-build` | Grok Build | SpaceXAI (formerly xAI) | 代码/智能体 | SR | 462 | — | 2026-05-14 | <https://abz.global/technology/xai-just-launched-grok-build-ai-coding-agents-are-moving-into-the-terminal> |
| 233 | `grok-4-20` | Grok 4.20 | SpaceXAI (formerly xAI) | 推理/幻觉 | SR | 470 | → Grok 4.5 Lv36 | 2026-03-09 | <https://en.wikipedia.org/wiki/Grok_(chatbot)> |
| 234 | `grok-4-5` | Grok 4.5 | SpaceXAI (formerly xAI) | 推理/幻觉 | SSR | 525 | ← Grok 4.20 | 2026-07-08 | <https://en.wikipedia.org/wiki/Grok_(chatbot)> |
| 235 | `muse-image` | Muse Image | Meta | 视觉/创作 | SR | 470 | — | 2026-07-07 | <https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/> |
| 236 | `mistral-large-3` | Mistral Large 3 | Mistral AI | 开源/推理 | R | 398 | → Mistral Large 4 Lv32 | 2025-12-02 | <https://en.wikipedia.org/wiki/Mistral_AI> |
| 237 | `mistral-large-4` | Mistral Large 4 | Mistral AI | 开源/推理 | SR | 460 | ← Mistral Large 3 | 2026-10-06 | <https://openrouter.ai/mistralai/mistral-large-4-0> |
| 238 | `devstral-2` | Devstral 2 | Mistral AI | 代码/开源 | SR | 440 | — | 2025-12-09 | <https://en.wikipedia.org/wiki/Mistral_AI> |
| 239 | `deepseek-v3-1` | DeepSeek-V3.1 | DeepSeek | 算力/推理 | R | 372 | → DeepSeek-V3.2 Lv22 | 2025-08-21 | <https://en.wikipedia.org/wiki/DeepSeek> |
| 240 | `deepseek-v3-2` | DeepSeek-V3.2 | DeepSeek | 算力/推理 | SR | 450 | ← DeepSeek-V3.1；→ DeepSeek-V3.2-Speciale Lv38 | 2025-12-01 | <https://en.wikipedia.org/wiki/DeepSeek> |
| 241 | `deepseek-v3-2-speciale` | DeepSeek-V3.2-Speciale | DeepSeek | 推理/开源 | SSR | 508 | ← DeepSeek-V3.2 | 2025-12-01 | <https://en.wikipedia.org/wiki/DeepSeek> |
| 242 | `deepseek-app` | DeepSeek 应用 | DeepSeek | 对话/检索 | SSR | 530 | — | 2025-01-10 | <https://aiproducthub.cn/newsflash/questmobile-2026-h1-doubao-aigc-app-leader/> |
| 243 | `qwen3` | 通义千问 Qwen3 | Alibaba | 开源/对话 | R | 378 | → 通义千问 Qwen3.5 Lv24 | 2025-04-28 | <https://en.wikipedia.org/wiki/Qwen> |
| 244 | `qwen3-5` | 通义千问 Qwen3.5 | Alibaba | 开源/视觉 | SR | 452 | ← 通义千问 Qwen3；→ 通义千问 Qwen3.7-Max Lv40 | 2026-02-16 | <https://en.wikipedia.org/wiki/Qwen> |
| 245 | `qwen3-7` | 通义千问 Qwen3.7-Max | Alibaba | 开源/推理 | SSR | 520 | ← 通义千问 Qwen3.5 | 2026-05-20 | <https://www.buildfastwithai.com/blogs/qwen3-7-max-preview-alibaba-2026> |
| 246 | `qwen3-coder` | Qwen3-Coder | Alibaba | 代码/开源 | SR | 440 | → Qwen3-Coder-Next Lv32 | 2025-07-22 | <https://lmarena.ai/leaderboard/text> |
| 247 | `qwen3-coder-next` | Qwen3-Coder-Next | Alibaba | 代码/智能体 | SSR | 502 | ← Qwen3-Coder | 2026-02-04 | <https://openrouter.ai/qwen/qwen3-coder-next> |
| 248 | `kimi-k2-thinking` | Kimi K2 Thinking | Moonshot AI | 推理/智能体 | SR | 430 | → Kimi K2.5 Lv26 | 2025-11-06 | <https://en.wikipedia.org/wiki/Moonshot_AI> |
| 249 | `kimi-k2-5` | Kimi K2.5 | Moonshot AI | 智能体/视觉 | SR | 470 | ← Kimi K2 Thinking；→ Kimi K2.6 Lv40 | 2026-01-27 | <https://en.wikipedia.org/wiki/Kimi_(chatbot)> |
| 250 | `kimi-k2-6` | Kimi K2.6 | Moonshot AI | 智能体/代码 | SSR | 515 | ← Kimi K2.5 | 2026-04-20 | <https://www.kimi.com/blog/kimi-k2-6> |
| 251 | `glm-4-7` | GLM-4.7 | Zhipu AI (Z.ai) | 智能体/代码 | SR | 438 | → GLM-5 Lv26 | 2025-12-22 | <https://en.wikipedia.org/wiki/Z.ai> |
| 252 | `glm-5` | GLM-5 | Zhipu AI (Z.ai) | 代码/开源 | SR | 478 | ← GLM-4.7；→ GLM-5.2 Lv40 | 2026-02-11 | <https://baike.baidu.com/en/item/GLM-5/1422146> |
| 253 | `glm-5-2` | GLM-5.2 | Zhipu AI (Z.ai) | 代码/开源 | SSR | 530 | ← GLM-5 | 2026-06-16 | <https://en.wikipedia.org/wiki/Z.ai> |
| 254 | `minimax-m2-1` | MiniMax-M2.1 | MiniMax | 代码/开源 | R | 395 | → MiniMax-M2.7 Lv30 | 2025-12-23 | <https://lmarena.ai/leaderboard/text> |
| 255 | `minimax-m2-7` | MiniMax-M2.7 | MiniMax | 代码/开源 | SR | 455 | ← MiniMax-M2.1 | 2026-03-18 | <https://en.wikipedia.org/wiki/MiniMax_Group> |

## 新增 / 变更的进化关系

| 进化 | 等级 | 说明 |
|---|---|---|
| GPT-5.4 → GPT-5.5「土豆」 | 28 | 新增形态的进化 |
| Codex 初代 → GPT-5.3-Codex | 24 | 原：→ OpenAI Codex（编程智能体） Lv32 |
| GPT-5.3-Codex → OpenAI Codex（编程智能体） | 40 | 新增形态的进化 |
| Sora（初代） → Sora 2（已停服） | 30 | 新增形态的进化 |
| ChatGPT Agent → ChatGPT dots（常驻智能体） | 28 | 新增形态的进化 |
| Claude Fable 5 → Claude Fable 5.1 | 36 | 新增形态的进化 |
| Claude Computer Use → Claude 应用（Cowork 合体） | 28 | 新增形态的进化 |
| Gemma 3 → Gemma 4 | 30 | 新增形态的进化 |
| Nano Banana 2 → Nano Banana 2.1 | 46 | 新增形态的进化 |
| Veo 3 → Veo 3.1 | 26 | 原：→ Gemini Omni 1.1 Flash Lv38 |
| Veo 3.1 → Gemini Omni 1.1 Flash | 40 | 新增形态的进化 |
| Lyria 2 → Lyria 3 | 22 | 新增形态的进化 |
| Lyria 3 → Lyria 3.5 | 38 | 新增形态的进化 |
| Gemini CLI → Google Antigravity 反重力 | 30 | 新增形态的进化 |
| Mistral 7B → Mixtral 8x7B | 18 | 原：→ Mistral Medium 3.5 Lv26 |
| Mixtral 8x7B → Mistral Medium 3.5 | 34 | 新增形态的进化 |
| Phi-3 → Phi-4 | 22 | 新增形态的进化 |
| Phi-4 → Phi-4-reasoning | 38 | 新增形态的进化 |
| Nemotron 3 Super → Nemotron 3 Ultra | 34 | 新增形态的进化 |
| SDXL → Stable Diffusion 3.5 | 34 | 新增形态的进化 |
| FLUX.1 → FLUX.2 | 24 | 原：→ FLUX 3 Lv36 |
| FLUX.2 → FLUX 3 | 40 | 新增形态的进化 |
| Runway Gen-4 → Runway Gen-4.5 | 30 | 新增形态的进化 |
| ElevenLabs 多语言 v2 → Eleven v3 | 26 | 原：→ Eleven v4 Lv34 |
| Eleven v3 → Eleven v4 | 42 | 新增形态的进化 |
| LangChain → LangGraph | 32 | 新增形态的进化 |
| 通义万相 2.1 → 通义万相 2.2 | 24 | 原：→ 通义万相 3.0 Lv38 |
| 通义万相 2.2 → 通义万相 3.0 | 42 | 新增形态的进化 |
| 即梦 Seedream 3.0 → 即梦 Seedream 4.0 | 22 | 原：→ 即梦 Seedream 5.0 Lv30 |
| 即梦 Seedream 4.0 → 即梦 Seedream 5.0 | 38 | 新增形态的进化 |
| 混元生图 3.0 → 混元生图 3.5（预览） | 30 | 新增形态的进化 |
| 阶跃 Step 3.5 Flash → 阶跃 Step 3.7 Flash | 24 | 原：→ 阶跃 Step 5 Preview Lv36 |
| 阶跃 Step 3.7 Flash → 阶跃 Step 5 Preview | 40 | 新增形态的进化 |
| 美团 LongCat-Flash → 美团 LongCat 2.0 | 24 | 原：→ 美团龙猫 LongCat-2.5 Lv34 |
| 美团 LongCat 2.0 → 美团龙猫 LongCat-2.5 | 40 | 新增形态的进化 |
| 海螺 Video-01 → 海螺 02 | 24 | 原：→ 海螺 H3 Lv34 |
| 海螺 02 → 海螺 H3 | 40 | 新增形态的进化 |
| o3-mini → o3 | 20 | 新增形态的进化 |
| o3 → o3-pro | 40 | 新增形态的进化 |
| Claude Opus 4 → Claude Opus 4.5 | 22 | 新增形态的进化 |
| Claude Opus 4.5 → Claude Opus 4.7 | 40 | 新增形态的进化 |
| Claude Sonnet 4.5 → Claude Sonnet 5 | 34 | 新增形态的进化 |
| Claude 3 Haiku → Claude 3.5 Haiku | 18 | 新增形态的进化 |
| Claude 3.5 Haiku → Claude Haiku 5.5 | 34 | 新增形态的进化 |
| Gemini 2.5 Flash → Gemini 3 Flash | 24 | 新增形态的进化 |
| Gemini 3 Flash → Gemini 3.5 Flash | 40 | 新增形态的进化 |
| Grok 4.20 → Grok 4.5 | 36 | 新增形态的进化 |
| Mistral Large 3 → Mistral Large 4 | 32 | 新增形态的进化 |
| DeepSeek-V3.1 → DeepSeek-V3.2 | 22 | 新增形态的进化 |
| DeepSeek-V3.2 → DeepSeek-V3.2-Speciale | 38 | 新增形态的进化 |
| 通义千问 Qwen3 → 通义千问 Qwen3.5 | 24 | 新增形态的进化 |
| 通义千问 Qwen3.5 → 通义千问 Qwen3.7-Max | 40 | 新增形态的进化 |
| Qwen3-Coder → Qwen3-Coder-Next | 32 | 新增形态的进化 |
| Kimi K2 Thinking → Kimi K2.5 | 26 | 新增形态的进化 |
| Kimi K2.5 → Kimi K2.6 | 40 | 新增形态的进化 |
| GLM-4.7 → GLM-5 | 26 | 新增形态的进化 |
| GLM-5 → GLM-5.2 | 40 | 新增形态的进化 |
| MiniMax-M2.1 → MiniMax-M2.7 | 30 | 新增形态的进化 |

## 因进化链变化而重算的既有智灵

阶数变化的既有智灵（末形态顺延）会重新生成 `learnset` / `teachable` / `catchRate` / `baseExp` / `size`，种族值、特性、栖息地、文案不变；家族最高稀有度变化的家族，`growth` 随之重算。

`gpt-5-5`、`gpt-5-6`、`openai-codex`、`sora-2`、`chatgpt-dots`、`claude-fable`、`claude-mythos`、`claude-cowork`、`gemma-4`、`gemini-omni`、`lyria`、`google-antigravity`、`mistral-medium`、`phi-4`、`nemotron`、`sd-1-5`、`sdxl`、`flux-3`、`runway`、`eleven-v4`、`langchain`、`wan-3`、`seedream-5`、`hunyuan-image`、`step-5`、`longcat-2-5`、`minimax-h3`（共 27 只）。

## 现有“进化为 UR”的链条（保留，仅列出）

| 进化 | 稀有度 | 等级 |
|---|---|---|
| GPT-5 → GPT-6 Astra（星） | SSR → UR | Lv36 |
| GPT-6 Luna（月） → GPT-6.1 Sol（日） | SR → UR | Lv30 |
| GPT-5.3-Codex → OpenAI Codex（编程智能体） | SSR → UR | Lv40 |
| GPT Image 1（吉卜力风暴） → GPT Image 2.5 | SR → UR | Lv44 |
| Claude Opus 4.8 → Claude Opus 5.5 | SSR → UR | Lv36 |
| Claude 3.5 Sonnet → Claude Sonnet 5.5 | SR → UR | Lv40 |
| Claude Fable 5 → Claude Fable 5.1 | SSR → UR | Lv36 |
| Gemini 3.8 Flash → Gemini 4 Argon（氩） | SSR → UR | Lv48 |
| Grok 4 → Grok 4.7 | SR → UR | Lv44 |
| Suno v5 → Suno v6 | SR → UR | Lv44 |
| Eleven v3 → Eleven v4 | SR → UR | Lv42 |
| Moltbot（蜕壳期） → OpenClaw 小龙虾 | SR → UR | Lv36 |
| DeepSeek-R1 深度思考 → DeepSeek-V4 / V4.1 | SSR → UR | Lv36 |
| 通义千问 2.5 → 通义千问 3.8-Max | R → UR | Lv38 |
| 通义万相 2.2 → 通义万相 3.0 | SR → UR | Lv42 |
| Kimi K2 → Kimi K3 | SR → UR | Lv44 |
| GLM-4.5 → GLM-5.3 | SR → UR | Lv42 |
| 即梦 Seedance 2.0 → 即梦 Seedance 2.5 | SSR → UR | Lv46 |
| MiMo-V2-Flash → MiMo-V2.6-Pro | SR → UR | Lv44 |
| 海螺 02 → 海螺 H3 | SR → UR | Lv40 |
| 宇树 G1/H2 → 宇树 GD01 载人机甲 | SSR → UR | Lv50 |
