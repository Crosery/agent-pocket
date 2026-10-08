# 图鉴增补 · 2026-10 批次（issue #18）

> 数据源：`docs/research/additions-2026-10*.json`（首批 + 各增补批次），由 `python3 tools/data/apply_additions.py <批次文件>` 合并进 `docs/research/roster-final.json` / `designs.json` / `assets_src/prompts/creatures.json`，再由 `python3 tools/data/build_species.py` 生成 `content/species.json` 与 `docs/roster.md`。勿手改生成物。

## 规则

- **进化 = 后训练 / 版本迭代**：同一系列里，经后训练或迭代出的新型号，是前一型号的后期进化（`evolutionKind: post-training`）。按谱系研究（lineage）挑选各厂商有代表性的型号；同系列的小号 / 精简型号（mini、nano、Flash、Lite）按世代各自成线，不作为大号的进化前形态。
- 进化链最多 3 阶（生成器的捕获率、经验、体型、招式曲线都只定义到 3 阶）；已满 3 阶的名牌系列不再延长，同厂商的相邻代际另开平行家族。
- 向已有的 2 阶链中间**插入**新形态时，原首形态的阶数与 id 不变（训练家队伍、道馆引用安全），原末形态顺延为第 3 阶。
- 新增形态的稀有度只在 N–SSR；没有新增 UR（UR 须配套漫游传说与文案）和 MYTHIC。
- 野外遇敌无需手工摆放：由栖息地（`habitats`）与稀有度行为表自动分配（N/R/SR 进草丛与可见区域，SSR 受时间 / 天气 / 地点条件限制）。

## MYTHIC 隐藏链保护

- 原先 `claude-mythos-preview`（SSR）Lv50 直接进化为 MYTHIC `claude-mythos`，绕过 `content/events/mythic.json` 的 glasswing 隐藏链。**处理：取消这条进化**。Mythos Preview 成为独立的 1 阶 SSR（`claude-mythos-preview`，仍可作 `mythos-3` 步骤要求的领队），Claude Mythos 5.1 成为独立的 1 阶 MYTHIC（家族改为 `claude-mythos-5`），只能经隐藏链遇到。
- 之所以不用“进化需通关标志”门控：进化判定在共享的战斗引擎里（`evolutionTarget`，只看等级），门控需要改战斗规则，超出本单范围。
- 新增守卫测试 `tests/species.test.ts`：任何进化都不得指向“仅事件出现”（MYTHIC）的稀有度。

## 新增智灵（258 只）

| # | id | 名称 | 公司 | 属性 | 稀有度 | BST | 进化线 | 发布 | 来源 |
|---|---|---|---|---|---|---|---|---|---|
| 8 | `gpt-5-4` | GPT-5.4 | OpenAI | 推理/对话 | SR | 478 | → GPT-5.5「土豆」 Lv28 | 2026-03-05 | <https://en.wikipedia.org/wiki/GPT-5.4> |
| 11 | `gpt-5-6-luna` | GPT-5.6 Luna | OpenAI | 算力/对话 | R | 375 | → GPT-6 Luna（月） Lv23 | 2026-07-09 | <https://openrouter.ai/openai/gpt-5.6-luna> |
| 15 | `gpt-5-3-codex` | GPT-5.3-Codex | OpenAI | 代码/智能体 | SSR | 520 | ← Codex 初代；→ OpenAI Codex（编程智能体） Lv40 | 2026-02-05 | <https://en.wikipedia.org/wiki/GPT-5.3-Codex> |
| 18 | `gpt-oss-safeguard-120b` | gpt-oss-safeguard-120b | OpenAI | 开源/对齐 | SR | 447 | ← gpt-oss-120b | 2025-10-29 | <https://models.dev/> |
| 22 | `sora-1` | Sora（初代） | OpenAI | 影像 | R | 405 | → Sora 2（已停服） Lv30 | 2024-12-09 | <https://en.wikipedia.org/wiki/Sora_(text-to-video_model)> |
| 24 | `chatgpt-agent` | ChatGPT Agent | OpenAI | 智能体/对话 | SR | 472 | → ChatGPT dots（常驻智能体） Lv28 | 2025-07-17 | <https://openai.com/index/introducing-chatgpt-agent/> |
| 32 | `claude-fable-5` | Claude Fable 5 | Anthropic | 推理/对齐 | SSR | 528 | → Claude Fable 5.1 Lv36 | 2026-06-09 | <https://en.wikipedia.org/wiki/Claude_Mythos> |
| 37 | `claude-computer-use` | Claude Computer Use | Anthropic | 智能体/视觉 | R | 392 | → Claude 应用（Cowork 合体） Lv28 | 2024-10-22 | <https://www.anthropic.com/news/3-5-models-and-computer-use> |
| 42 | `gemini-3-1-flash-live` | Gemini 3.1 Flash Live | Google | 音律/对话 | R | 375 | → Gemini 3.8 Live Lv37 | 2026-03-26 | <https://models.dev/> |
| 47 | `gemma-2` | Gemma 2 | Google | 开源/对话 | N | 277 | → Gemma 3 Lv23 | 2024-06-27 | <https://blog.google/technology/developers/google-gemma-2/> |
| 48 | `gemma-3` | Gemma 3 | Google | 开源/视觉 | R | 372 | ← Gemma 2；→ Gemma 4 Lv30 | 2025-03-12 | <https://en.wikipedia.org/wiki/Gemma_(language_model)> |
| 52 | `nano-banana-2-1` | Nano Banana 2.1 | Google | 视觉/算力 | SSR | 548 | ← Nano Banana 2 | 2026-10-06 | <https://openrouter.ai/google/gemini-nano-banana-2.1> |
| 54 | `veo-3-1` | Veo 3.1 | Google | 影像/音律 | SR | 488 | ← Veo 3；→ Gemini Omni 1.1 Flash Lv40 | 2025-10-15 | <https://wavespeed.ai/blog/posts/what-is-veo-4/> |
| 56 | `lyria-2` | Lyria 2 | Google | 音律 | R | 385 | → Lyria 3 Lv22 | 2025-04-01 | <https://siliconangle.com/2026/02/18/google-launches-lyria-3-music-generation-model/> |
| 57 | `lyria-3` | Lyria 3 | Google | 音律/创作 | SR | 452 | ← Lyria 2；→ Lyria 3.5 Lv38 | 2026-02-18 | <https://siliconangle.com/2026/02/18/google-launches-lyria-3-music-generation-model/> |
| 59 | `genie-1` | Genie | Google DeepMind | 影像/幻觉 | R | 350 | → Genie 2 Lv31 | 2024-02-23 | <https://deepmind.google/research/publications/60474/> |
| 60 | `genie-2` | Genie 2 | Google DeepMind | 影像/视觉 | SR | 433 | ← Genie；→ Genie 3 精灵世界 Lv45 | 2024-12-04 | <https://deepmind.google/discover/blog/genie-2-a-large-scale-foundation-world-model/> |
| 63 | `gemini-cli` | Gemini CLI | Google | 代码/智能体 | R | 395 | → Google Antigravity 反重力 Lv30 | 2025-06-25 | <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/> |
| 65 | `gemini-robotics-1` | Gemini Robotics | Google DeepMind | 智能体/视觉 | R | 379 | → Gemini Robotics 1.5 Lv31 | 2025-03-12 | <https://deepmind.google/models/gemini-robotics/> |
| 66 | `gemini-robotics-1-5` | Gemini Robotics 1.5 | Google DeepMind | 智能体/视觉 | SR | 452 | ← Gemini Robotics；→ Gemini Robotics 2 Lv39 | 2025-09-25 | <https://deepmind.google/models/gemini-robotics/> |
| 77 | `muse-spark-1-1` | Muse Spark 1.1 | Meta | 推理/视觉 | SR | 449 | → Muse Spark 1.2 Lv30 | 2026-07-16 | <https://openrouter.ai/meta/muse-spark-1.1> |
| 78 | `muse-spark-1-2` | Muse Spark 1.2 | Meta | 推理/视觉 | SR | 461 | ← Muse Spark 1.1；→ Muse Spark 灵感火花 Lv47 | 2026-08-05 | <https://zapier.com/blog/llama-meta/> |
| 83 | `mixtral` | Mixtral 8x7B | Mistral AI | 开源/算力 | R | 350 | ← Mistral 7B；→ Mistral Medium 3.5 Lv34 | 2023-12-09 | <https://en.wikipedia.org/wiki/Mistral_AI> |
| 85 | `phi-3` | Phi-3 | Microsoft | 推理 | N | 300 | → Phi-4 Lv22 | 2024-04-23 | <https://innfactory.ai/en/ai-models/microsoft-phi/> |
| 87 | `phi-4-reasoning` | Phi-4-reasoning | Microsoft | 推理/开源 | SR | 438 | ← Phi-4 | 2025-04-30 | <https://innfactory.ai/en/ai-models/microsoft-phi/> |
| 88 | `mai-1-preview` | MAI-1-preview | Microsoft | 对话/算力 | R | 368 | → MAI-Thinking-1 Lv30 | 2025-08-28 | <https://innfactory.ai/en/ai-models/microsoft-phi/> |
| 90 | `mai-image-1` | MAI-Image-1 | Microsoft | 视觉 | R | 375 | → MAI-Image-2 Lv32 | 2025-10-01 | <https://microsoft.ai/news/> |
| 91 | `mai-image-2` | MAI-Image-2 | Microsoft | 视觉/创作 | SR | 449 | ← MAI-Image-1；→ MAI-Image-2.6 Lv39 | 2026-03-19 | <https://innfactory.ai/en/ai-models/microsoft-phi/> |
| 105 | `sd-3-5` | Stable Diffusion 3.5 | Stability AI | 视觉/开源 | SR | 440 | ← SDXL | 2024-10-22 | <https://arena.ai/leaderboard/text-to-image> |
| 107 | `flux-2` | FLUX.2 | Black Forest Labs | 视觉/开源 | SR | 470 | ← FLUX.1；→ FLUX 3 Lv40 | 2025-11-25 | <https://artificialanalysis.ai/image/leaderboard/text-to-image> |
| 109 | `runway-gen-4` | Runway Gen-4 | Runway | 影像/创作 | SR | 438 | → Runway Gen-4.5 Lv30 | 2025-03-31 | <https://en.wikipedia.org/wiki/Runway_(company)> |
| 111 | `luma-ray1` | Luma Dream Machine (Ray1) | Luma AI | 影像 | R | 357 | → Luma Ray2 Lv22 | 2024-06-12 | <https://en.wikipedia.org/wiki/Luma_AI> |
| 112 | `luma-ray2` | Luma Ray2 | Luma AI | 影像/视觉 | R | 382 | ← Luma Dream Machine (Ray1)；→ Luma Ray3 Lv30 | 2025-01-15 | <https://lumalabs.ai/ray> |
| 118 | `eleven-v3` | Eleven v3 | ElevenLabs | 音律/对话 | SR | 478 | ← ElevenLabs 多语言 v2；→ Eleven v4 Lv42 | 2025-06-05 | <https://artificialanalysis.ai/text-to-speech/leaderboard> |
| 140 | `langgraph` | LangGraph | LangChain | 智能体/开源 | SSR | 520 | ← LangChain | 2024-01-08 | <https://github.com/langchain-ai/langgraph> |
| 143 | `pi0-5` | π0.5 | Physical Intelligence | 智能体/视觉 | R | 386 | → π*0.6 Lv30 | 2025-04-22 | <https://www.physicalintelligence.company/blog> |
| 144 | `pi-star-0-6` | π*0.6 | Physical Intelligence | 智能体/视觉 | SR | 458 | ← π0.5；→ π0.7 物理智能 Lv38 | 2025-11-17 | <https://www.physicalintelligence.company/blog> |
| 159 | `wan-2-2` | 通义万相 2.2 | Alibaba (Tongyi) | 影像/开源 | SR | 455 | ← 通义万相 2.1；→ 通义万相 3.0 Lv42 | 2025-07-28 | <https://technode.com/2026/08/24/alibaba-launches-wan3-0-video-model-with-30-second-generation-and-document-input/> |
| 178 | `seedream-4` | 即梦 Seedream 4.0 | ByteDance Seed | 视觉/创作 | SR | 458 | ← 即梦 Seedream 3.0；→ 即梦 Seedream 5.0 Lv38 | 2025-09-09 | <https://artificialanalysis.ai/image/leaderboard/text-to-image> |
| 189 | `hunyuan-image-3` | 混元生图 3.0 | Tencent Hunyuan | 视觉/开源 | SR | 450 | → 混元生图 3.5（预览） Lv30 | 2025-09-28 | <https://github.com/Tencent-Hunyuan/HunyuanImage-3.0> |
| 196 | `step-3-7-flash` | 阶跃 Step 3.7 Flash | StepFun | 算力/开源 | SR | 452 | ← 阶跃 Step 3.5 Flash；→ 阶跃 Step 5 Preview Lv40 | 2026-05-29 | <https://en.wikipedia.org/wiki/StepFun> |
| 207 | `longcat-2` | 美团 LongCat 2.0 | Meituan | 智能体/算力 | SR | 435 | ← 美团 LongCat-Flash；→ 美团龙猫 LongCat-2.5 Lv40 | 2026-06-30 | <https://www.marktechpost.com/2026/07/05/meituan-releases-longcat-2-0-a-1-6t-parameter-open-moe-model-with-native-1m-context-and-longcat-sparse-attention/> |
| 216 | `skyreels-v2` | SkyReels V2 | Skywork AI (Kunlun Tech) | 影像/开源 | SR | 435 | → SkyReels V3 Lv32 | 2025-04-21 | <https://github.com/SkyworkAI/SkyReels-V2> |
| 217 | `skyreels-v3` | SkyReels V3 | Skywork AI (Kunlun Tech) | 影像/开源 | SR | 449 | ← SkyReels V2；→ 天工 SkyReels V4 Lv39 | 2026-01-29 | <https://github.com/SkyworkAI/SkyReels-V2> |
| 229 | `hailuo-02` | 海螺 02 | MiniMax | 影像 | SR | 455 | ← 海螺 Video-01；→ 海螺 H3 Lv40 | 2025-06-18 | <https://platform.minimax.io/docs/release-notes/models> |
| 233 | `unitree-h1` | 宇树 H1 | Unitree Robotics | 影像/智能体 | R | 375 | → 宇树 G1/H2 Lv37 | 2023-08-01 | <https://en.wikipedia.org/wiki/Unitree_Robotics> |
| 237 | `o3-mini` | o3-mini | OpenAI | 推理 | R | 368 | → o3 Lv20 | 2025-01-31 | <https://hidekazu-konishi.com/entry/openai_gpt_model_release_timeline.html> |
| 238 | `o3` | o3 | OpenAI | 推理/代码 | SR | 448 | ← o3-mini；→ o3-pro Lv40 | 2025-04-16 | <https://en.wikipedia.org/wiki/OpenAI_o3> |
| 239 | `o3-pro` | o3-pro | OpenAI | 推理/算力 | SR | 486 | ← o3 | 2025-06-10 | <https://openrouter.ai/openai/o3-pro> |
| 240 | `claude-opus-4` | Claude Opus 4 | Anthropic | 代码/对齐 | R | 400 | → Claude Opus 4.5 Lv22 | 2025-05-22 | <https://en.wikipedia.org/wiki/Claude_(language_model)> |
| 241 | `claude-opus-4-5` | Claude Opus 4.5 | Anthropic | 代码/对齐 | SR | 458 | ← Claude Opus 4；→ Claude Opus 4.7 Lv40 | 2025-11-24 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 242 | `claude-opus-4-7` | Claude Opus 4.7 | Anthropic | 代码/推理 | SSR | 515 | ← Claude Opus 4.5 | 2026-04-16 | <https://en.wikipedia.org/wiki/Claude_(language_model)> |
| 243 | `claude-sonnet-4-5` | Claude Sonnet 4.5 | Anthropic | 代码/创作 | SR | 450 | → Claude Sonnet 5 Lv34 | 2025-09-29 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 244 | `claude-sonnet-5` | Claude Sonnet 5 | Anthropic | 代码/创作 | SSR | 530 | ← Claude Sonnet 4.5 | 2026-06-30 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 245 | `claude-haiku-3` | Claude 3 Haiku | Anthropic | 代码 | N | 295 | → Claude 3.5 Haiku Lv18 | 2024-03-13 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 246 | `claude-haiku-3-5` | Claude 3.5 Haiku | Anthropic | 代码 | R | 372 | ← Claude 3 Haiku；→ Claude Haiku 5.5 Lv34 | 2024-11-04 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 247 | `claude-haiku-5-5` | Claude Haiku 5.5 | Anthropic | 代码/智能体 | SR | 440 | ← Claude 3.5 Haiku | 2026-10-07 | <https://openrouter.ai/anthropic/claude-haiku-5.5> |
| 248 | `gemini-2-5-flash` | Gemini 2.5 Flash | Google | 算力 | R | 398 | → Gemini 3 Flash Lv24 | 2025-04-17 | <https://hidekazu-konishi.com/entry/google_gemini_model_release_timeline.html> |
| 249 | `gemini-3-flash` | Gemini 3 Flash | Google | 算力/对话 | SR | 462 | ← Gemini 2.5 Flash；→ Gemini 3.5 Flash Lv40 | 2025-12-17 | <https://hidekazu-konishi.com/entry/google_gemini_model_release_timeline.html> |
| 250 | `gemini-3-5-flash` | Gemini 3.5 Flash | Google | 算力/智能体 | SSR | 520 | ← Gemini 3 Flash | 2026-05-19 | <https://hidekazu-konishi.com/entry/google_gemini_model_release_timeline.html> |
| 251 | `grok-build` | Grok Build | SpaceXAI (formerly xAI) | 代码/智能体 | SR | 462 | — | 2026-05-14 | <https://abz.global/technology/xai-just-launched-grok-build-ai-coding-agents-are-moving-into-the-terminal> |
| 252 | `grok-4-20` | Grok 4.20 | SpaceXAI (formerly xAI) | 推理/幻觉 | SR | 470 | → Grok 4.5 Lv36 | 2026-03-09 | <https://en.wikipedia.org/wiki/Grok_(chatbot)> |
| 253 | `grok-4-5` | Grok 4.5 | SpaceXAI (formerly xAI) | 推理/幻觉 | SSR | 525 | ← Grok 4.20 | 2026-07-08 | <https://en.wikipedia.org/wiki/Grok_(chatbot)> |
| 254 | `muse-image` | Muse Image | Meta | 视觉/创作 | SR | 470 | — | 2026-07-07 | <https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/> |
| 255 | `mistral-large-2` | Mistral Large 2 | Mistral AI | 开源/对话 | R | 339 | → Mistral Large 3 Lv22 | 2024-07-24 | <https://mistral.ai/news/mistral-large-2407/> |
| 256 | `mistral-large-3` | Mistral Large 3 | Mistral AI | 开源/推理 | R | 398 | ← Mistral Large 2；→ Mistral Large 4 Lv32 | 2025-12-02 | <https://en.wikipedia.org/wiki/Mistral_AI> |
| 257 | `mistral-large-4` | Mistral Large 4 | Mistral AI | 开源/推理 | SR | 460 | ← Mistral Large 3 | 2026-10-06 | <https://openrouter.ai/mistralai/mistral-large-4-0> |
| 258 | `devstral-small` | Devstral Small | Mistral AI | 代码/开源 | R | 353 | → Devstral Medium Lv21 | 2025-05-21 | <https://mistral.ai/news/devstral> |
| 259 | `devstral-medium` | Devstral Medium | Mistral AI | 代码/开源 | R | 389 | ← Devstral Small；→ Devstral 2 Lv28 | 2025-07-10 | <https://models.dev/> |
| 260 | `devstral-2` | Devstral 2 | Mistral AI | 代码/开源 | SR | 440 | ← Devstral Medium | 2025-12-09 | <https://en.wikipedia.org/wiki/Mistral_AI> |
| 261 | `nemotron-3-super` | Nemotron 3 Super | NVIDIA | 开源/算力 | SR | 440 | — | 2026-03-11 | <https://en.wikipedia.org/wiki/Nemotron> |
| 262 | `deepseek-v3-1` | DeepSeek-V3.1 | DeepSeek | 算力/推理 | R | 372 | → DeepSeek-V3.2 Lv22 | 2025-08-21 | <https://en.wikipedia.org/wiki/DeepSeek> |
| 263 | `deepseek-v3-2` | DeepSeek-V3.2 | DeepSeek | 算力/推理 | SR | 450 | ← DeepSeek-V3.1；→ DeepSeek-V3.2-Speciale Lv38 | 2025-12-01 | <https://en.wikipedia.org/wiki/DeepSeek> |
| 264 | `deepseek-v3-2-speciale` | DeepSeek-V3.2-Speciale | DeepSeek | 推理/开源 | SSR | 508 | ← DeepSeek-V3.2 | 2025-12-01 | <https://en.wikipedia.org/wiki/DeepSeek> |
| 265 | `deepseek-app` | DeepSeek 应用 | DeepSeek | 对话/检索 | SSR | 530 | — | 2025-01-10 | <https://aiproducthub.cn/newsflash/questmobile-2026-h1-doubao-aigc-app-leader/> |
| 266 | `qwen3` | 通义千问 Qwen3 | Alibaba | 开源/对话 | R | 378 | → 通义千问 Qwen3.5 Lv24 | 2025-04-28 | <https://en.wikipedia.org/wiki/Qwen> |
| 267 | `qwen3-5` | 通义千问 Qwen3.5 | Alibaba | 开源/视觉 | SR | 452 | ← 通义千问 Qwen3；→ 通义千问 Qwen3.7-Max Lv40 | 2026-02-16 | <https://en.wikipedia.org/wiki/Qwen> |
| 268 | `qwen3-7` | 通义千问 Qwen3.7-Max | Alibaba | 开源/推理 | SSR | 520 | ← 通义千问 Qwen3.5 | 2026-05-20 | <https://www.buildfastwithai.com/blogs/qwen3-7-max-preview-alibaba-2026> |
| 269 | `qwen3-coder` | Qwen3-Coder | Alibaba | 代码/开源 | SR | 440 | → Qwen3-Coder-Next Lv32 | 2025-07-22 | <https://lmarena.ai/leaderboard/text> |
| 270 | `qwen3-coder-next` | Qwen3-Coder-Next | Alibaba | 代码/智能体 | SSR | 502 | ← Qwen3-Coder | 2026-02-04 | <https://openrouter.ai/qwen/qwen3-coder-next> |
| 271 | `kimi-k2-thinking` | Kimi K2 Thinking | Moonshot AI | 推理/智能体 | SR | 430 | → Kimi K2.5 Lv26 | 2025-11-06 | <https://en.wikipedia.org/wiki/Moonshot_AI> |
| 272 | `kimi-k2-5` | Kimi K2.5 | Moonshot AI | 智能体/视觉 | SR | 470 | ← Kimi K2 Thinking；→ Kimi K2.6 Lv40 | 2026-01-27 | <https://en.wikipedia.org/wiki/Kimi_(chatbot)> |
| 273 | `kimi-k2-6` | Kimi K2.6 | Moonshot AI | 智能体/代码 | SSR | 515 | ← Kimi K2.5 | 2026-04-20 | <https://www.kimi.com/blog/kimi-k2-6> |
| 274 | `glm-4-7` | GLM-4.7 | Zhipu AI (Z.ai) | 智能体/代码 | SR | 438 | → GLM-5 Lv26 | 2025-12-22 | <https://en.wikipedia.org/wiki/Z.ai> |
| 275 | `glm-5` | GLM-5 | Zhipu AI (Z.ai) | 代码/开源 | SR | 478 | ← GLM-4.7；→ GLM-5.2 Lv40 | 2026-02-11 | <https://baike.baidu.com/en/item/GLM-5/1422146> |
| 276 | `glm-5-2` | GLM-5.2 | Zhipu AI (Z.ai) | 代码/开源 | SSR | 530 | ← GLM-5 | 2026-06-16 | <https://en.wikipedia.org/wiki/Z.ai> |
| 277 | `minimax-m2-1` | MiniMax-M2.1 | MiniMax | 代码/开源 | R | 395 | → MiniMax-M2.7 Lv30 | 2025-12-23 | <https://lmarena.ai/leaderboard/text> |
| 278 | `minimax-m2-7` | MiniMax-M2.7 | MiniMax | 代码/开源 | SR | 455 | ← MiniMax-M2.1 | 2026-03-18 | <https://en.wikipedia.org/wiki/MiniMax_Group> |
| 279 | `gpt-4-turbo` | GPT-4 Turbo | OpenAI | 对话/算力 | R | 361 | → GPT-4.1 Lv31 | 2023-11-06 | <https://openrouter.ai/openai/gpt-4-turbo> |
| 280 | `gpt-4-1` | GPT-4.1 | OpenAI | 代码/对话 | SR | 441 | ← GPT-4 Turbo | 2025-04-14 | <https://openrouter.ai/openai/gpt-4.1> |
| 281 | `gpt-5-1` | GPT-5.1 | OpenAI | 推理/对话 | SSR | 520 | → GPT-5.2 Lv37 | 2025-11-13 | <https://openrouter.ai/openai/gpt-5.1> |
| 282 | `gpt-5-2` | GPT-5.2 | OpenAI | 推理/算力 | SSR | 529 | ← GPT-5.1 | 2025-12-11 | <https://openrouter.ai/openai/gpt-5.2> |
| 283 | `gpt-4o-mini` | GPT-4o mini | OpenAI | 对话 | N | 285 | → GPT-5 mini Lv22 | 2024-07-18 | <https://openrouter.ai/openai/gpt-4o-mini> |
| 284 | `gpt-5-mini` | GPT-5 mini | OpenAI | 对话/算力 | R | 371 | ← GPT-4o mini；→ GPT-5.4 mini Lv29 | 2025-08-07 | <https://openrouter.ai/openai/gpt-5-mini> |
| 285 | `gpt-5-4-mini` | GPT-5.4 mini | OpenAI | 对话/智能体 | SR | 448 | ← GPT-5 mini | 2026-03-17 | <https://openrouter.ai/openai/gpt-5.4-mini> |
| 286 | `gpt-4-1-nano` | GPT-4.1 nano | OpenAI | 算力 | N | 260 | → GPT-5 nano Lv18 | 2025-04-14 | <https://openrouter.ai/openai/gpt-4.1-nano> |
| 287 | `gpt-5-nano` | GPT-5 nano | OpenAI | 算力/对话 | N | 301 | ← GPT-4.1 nano；→ GPT-5.4 nano Lv25 | 2025-08-07 | <https://openrouter.ai/openai/gpt-5-nano> |
| 288 | `gpt-5-4-nano` | GPT-5.4 nano | OpenAI | 算力/智能体 | R | 357 | ← GPT-5 nano | 2026-03-17 | <https://openrouter.ai/openai/gpt-5.4-nano> |
| 289 | `gpt-5-codex` | GPT-5-Codex | OpenAI | 代码/智能体 | SR | 458 | → GPT-5.1-Codex-Max Lv37 | 2025-09-15 | <https://models.dev/> |
| 290 | `gpt-5-1-codex-max` | GPT-5.1-Codex-Max | OpenAI | 代码/智能体 | SSR | 517 | ← GPT-5-Codex；→ GPT-5.2-Codex Lv44 | 2025-11-19 | <https://openrouter.ai/openai/gpt-5.1-codex-max> |
| 291 | `gpt-5-2-codex` | GPT-5.2-Codex | OpenAI | 代码/推理 | SSR | 526 | ← GPT-5.1-Codex-Max | 2025-12-11 | <https://openrouter.ai/openai/gpt-5.2-codex> |
| 292 | `o4-mini` | o4-mini | OpenAI | 推理/算力 | R | 386 | — | 2025-04-16 | <https://openrouter.ai/openai/o4-mini> |
| 293 | `gpt-oss-20b` | gpt-oss-20b | OpenAI | 开源/算力 | R | 364 | → gpt-oss-safeguard-20b Lv22 | 2025-08-05 | <https://openrouter.ai/openai/gpt-oss-20b> |
| 294 | `gpt-oss-safeguard-20b` | gpt-oss-safeguard-20b | OpenAI | 开源/对齐 | R | 375 | ← gpt-oss-20b | 2025-10-29 | <https://openrouter.ai/openai/gpt-oss-safeguard-20b> |
| 295 | `gpt-5-6-terra` | GPT-5.6 Terra | OpenAI | 推理/创作 | SR | 463 | — | 2026-07-09 | <https://openrouter.ai/openai/gpt-5.6-terra> |
| 296 | `claude-1` | Claude 1 | Anthropic | 对话/对齐 | N | 252 | → Claude 2 Lv22 | 2023-03-14 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 297 | `claude-2` | Claude 2 | Anthropic | 对话/创作 | R | 339 | ← Claude 1 | 2023-07-11 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 298 | `claude-3-sonnet` | Claude 3 Sonnet | Anthropic | 对话/对齐 | R | 368 | — | 2024-03-04 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 299 | `claude-3-7-sonnet` | Claude 3.7 Sonnet | Anthropic | 代码/创作 | R | 379 | → Claude Sonnet 4 Lv28 | 2025-02-24 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 300 | `claude-sonnet-4` | Claude Sonnet 4 | Anthropic | 代码/创作 | SR | 444 | ← Claude 3.7 Sonnet；→ Claude Sonnet 4.6 Lv35 | 2025-05-22 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 301 | `claude-sonnet-4-6` | Claude Sonnet 4.6 | Anthropic | 代码/智能体 | SR | 466 | ← Claude Sonnet 4 | 2026-02-17 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 302 | `claude-opus-4-1` | Claude Opus 4.1 | Anthropic | 代码/对齐 | SR | 449 | → Claude Opus 4.6 Lv30 | 2025-08-05 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 303 | `claude-opus-4-6` | Claude Opus 4.6 | Anthropic | 代码/推理 | SR | 472 | ← Claude Opus 4.1；→ Claude Opus 5 Lv37 | 2026-02-05 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 304 | `claude-opus-5` | Claude Opus 5 | Anthropic | 代码/推理 | SSR | 537 | ← Claude Opus 4.6 | 2026-07-24 | <https://hidekazu-konishi.com/entry/anthropic_claude_model_release_timeline.html> |
| 305 | `grok-2` | Grok-2 | SpaceXAI (formerly xAI) | 对话/幻觉 | R | 357 | → Grok 3 Lv29 | 2024-08-13 | <https://x.ai/news/grok-2> |
| 306 | `grok-3` | Grok 3 | SpaceXAI (formerly xAI) | 对话/推理 | SR | 444 | ← Grok-2；→ Grok 4.1 Fast Lv36 | 2025-02-17 | <https://x.ai/news/grok-3> |
| 307 | `grok-4-1-fast` | Grok 4.1 Fast | SpaceXAI (formerly xAI) | 对话/算力 | SR | 461 | ← Grok 3 | 2025-11-19 | <https://models.dev/> |
| 308 | `grok-4-3` | Grok 4.3 | SpaceXAI (formerly xAI) | 对话/推理 | SR | 472 | → Grok 4.6 Lv36 | 2026-04-17 | <https://openrouter.ai/x-ai/grok-4.3> |
| 309 | `grok-4-6` | Grok 4.6 | SpaceXAI (formerly xAI) | 对话/推理 | SSR | 531 | ← Grok 4.3 | 2026-08-12 | <https://codersera.com/blog/grok-4-6-launch-guide-2026/> |
| 310 | `llama-2` | Llama 2 | Meta | 开源/对话 | N | 277 | → Llama 3 Lv24 | 2023-07-18 | <https://ai.meta.com/blog/llama-2/> |
| 311 | `llama-3` | Llama 3 | Meta | 开源/对话 | R | 361 | ← Llama 2；→ Llama 3.3 Lv31 | 2024-04-18 | <https://ai.meta.com/blog/meta-llama-3/> |
| 312 | `llama-3-3` | Llama 3.3 | Meta | 开源/算力 | R | 397 | ← Llama 3 | 2024-12-07 | <https://en.wikipedia.org/wiki/Llama_(language_model)> |
| 313 | `muse-glimmer` | Muse Glimmer | Meta | 对话/算力 | R | 375 | — | 2026-08-10 | <https://www.cnbc.com/2026/08/10/meta-muse-glimmer-open-weight-ai.html> |
| 314 | `muse-code` | Muse Code | Meta | 代码/智能体 | SR | 444 | — | 2026-08-05 | <https://zapier.com/blog/llama-meta/> |
| 315 | `mistral-small-3` | Mistral Small 3 | Mistral AI | 开源/算力 | R | 346 | → Mistral Small 3.2 Lv21 | 2025-01-30 | <https://openrouter.ai/mistralai/mistral-small-24b-instruct-2501> |
| 316 | `mistral-small-3-2` | Mistral Small 3.2 | Mistral AI | 开源/算力 | R | 364 | ← Mistral Small 3；→ Mistral Small 4 Lv28 | 2025-06-20 | <https://openrouter.ai/mistralai/mistral-small-3.2-24b-instruct> |
| 317 | `mistral-small-4` | Mistral Small 4 | Mistral AI | 开源/智能体 | SR | 441 | ← Mistral Small 3.2 | 2026-03-16 | <https://openrouter.ai/mistralai/mistral-small-2603> |
| 318 | `magistral-small` | Magistral Small | Mistral AI | 推理/开源 | R | 357 | → Magistral Medium Lv31 | 2025-06-10 | <https://docs.mistral.ai/resources/changelogs> |
| 319 | `magistral-medium` | Magistral Medium | Mistral AI | 推理/开源 | SR | 441 | ← Magistral Small | 2025-06-10 | <https://docs.mistral.ai/resources/changelogs> |
| 320 | `pixtral-12b` | Pixtral 12B | Mistral AI | 视觉/开源 | N | 285 | → Pixtral Large Lv22 | 2024-09-11 | <https://mistral.ai/news/pixtral-12b/> |
| 321 | `pixtral-large` | Pixtral Large | Mistral AI | 视觉/开源 | R | 364 | ← Pixtral 12B | 2024-11-18 | <https://mistral.ai/news/pixtral-large/> |
| 322 | `mai-code-1-flash` | MAI-Code-1-Flash | Microsoft | 代码/算力 | R | 357 | → MAI-Code-1.1-Flash Lv20 | 2026-06-02 | <https://theaieconomy.substack.com/p/microsofts-mai-models-build-2026> |
| 323 | `mai-code-1-1-flash` | MAI-Code-1.1-Flash | Microsoft | 代码/算力 | R | 382 | ← MAI-Code-1-Flash | 2026-08-11 | <https://models.dev/> |
| 324 | `gemini-1-0` | Gemini 1.0 | Google | 对话/视觉 | R | 350 | — | 2023-12-06 | <https://blog.google/technology/ai/google-gemini-ai/> |
| 325 | `gemini-3-pro` | Gemini 3 Pro | Google | 推理/视觉 | SSR | 526 | — | 2025-11-18 | <https://models.dev/> |
| 326 | `gemini-2-0-flash` | Gemini 2.0 Flash | Google | 算力/对话 | R | 368 | — | 2025-02-05 | <https://blog.google/technology/google-deepmind/gemini-model-updates-february-2025/> |
| 327 | `gemini-3-6-flash` | Gemini 3.6 Flash | Google | 算力/智能体 | SR | 455 | → Gemini 3.7 Flash Lv39 | 2026-07-21 | <https://openrouter.ai/google/gemini-3.6-flash> |
| 328 | `gemini-3-7-flash` | Gemini 3.7 Flash | Google | 算力/智能体 | SSR | 511 | ← Gemini 3.6 Flash | 2026-08-13 | <https://openrouter.ai/google/gemini-3.7-flash> |
| 329 | `diffusiongemma` | DiffusionGemma | Google | 开源/幻觉 | SR | 435 | — | 2026-06-09 | <https://models.dev/> |
| 330 | `nano-banana-pro` | Nano Banana Pro | Google | 视觉/创作 | SSR | 526 | — | 2025-11-20 | <https://openrouter.ai/google/gemini-3-pro-image-preview> |
| 331 | `nano-banana-2-lite` | Nano Banana 2 Lite | Google | 视觉/算力 | SR | 452 | — | 2026-06-30 | <https://openrouter.ai/google/gemini-3.1-flash-lite-image> |
| 332 | `imagen-3` | Imagen 3 | Google | 视觉 | R | 368 | → Imagen 4 Lv30 | 2024-08-15 | <https://deepmind.google/models/imagen/> |
| 333 | `imagen-4` | Imagen 4 | Google | 视觉/创作 | SR | 444 | ← Imagen 3 | 2025-05-20 | <https://deepmind.google/models/imagen/> |
| 334 | `veo-1` | Veo | Google | 影像 | R | 361 | → Veo 2 Lv28 | 2024-05-14 | <https://deepmind.google/models/veo/> |
| 335 | `veo-2` | Veo 2 | Google | 影像/视觉 | SR | 438 | ← Veo | 2024-12-16 | <https://deepmind.google/models/veo/> |
| 336 | `gemini-2-5-flash-tts` | Gemini 2.5 Flash TTS | Google | 音律 | N | 285 | → Gemini 3.1 Flash TTS Lv22 | 2025-05-01 | <https://models.dev/> |
| 337 | `gemini-3-1-flash-tts` | Gemini 3.1 Flash TTS | Google | 音律/对话 | R | 361 | ← Gemini 2.5 Flash TTS；→ Gemini 3.8 Flash TTS Lv29 | 2026-04-15 | <https://models.dev/> |
| 338 | `gemini-3-8-flash-tts` | Gemini 3.8 Flash TTS | Google | 音律/对话 | SR | 438 | ← Gemini 3.1 Flash TTS | 2026-09-22 | <https://9to5google.com/2026/09/02/gemini-3-8-flash-launch/> |
| 339 | `alphago-zero` | AlphaGo Zero | Google DeepMind | 推理/智能体 | SR | 455 | → AlphaZero Lv39 | 2017-10-18 | <https://deepmind.google/discover/blog/alphago-zero-starting-from-scratch/> |
| 340 | `alphazero` | AlphaZero | Google DeepMind | 推理/智能体 | SSR | 511 | ← AlphaGo Zero；→ MuZero Lv46 | 2017-12-05 | <https://deepmind.google/discover/blog/alphazero-shedding-new-light-on-chess-shogi-and-go/> |
| 341 | `muzero` | MuZero | Google DeepMind | 推理/算力 | SSR | 523 | ← AlphaZero | 2019-11-19 | <https://deepmind.google/discover/blog/muzero-mastering-go-chess-shogi-and-atari-without-rules/> |
| 342 | `dall-e-2` | DALL-E 2 | OpenAI | 视觉 | N | 285 | → DALL-E 3 Lv20 | 2022-04-06 | <https://openai.com/index/dall-e-2/> |
| 343 | `dall-e-3` | DALL-E 3 | OpenAI | 视觉/创作 | R | 368 | ← DALL-E 2 | 2023-09-20 | <https://openai.com/index/dall-e-3/> |
| 344 | `gpt-image-1-5` | GPT Image 1.5 | OpenAI | 视觉/创作 | SR | 458 | → GPT Image 2 Lv37 | 2025-11-25 | <https://models.dev/> |
| 345 | `gpt-image-2` | GPT Image 2 | OpenAI | 视觉/创作 | SSR | 523 | ← GPT Image 1.5；→ GPT Image 2.5 Flare Lv44 | 2026-04-21 | <https://models.dev/> |
| 346 | `gpt-image-2-5-flare` | GPT Image 2.5 Flare | OpenAI | 视觉/算力 | SSR | 531 | ← GPT Image 2 | 2026-09-08 | <https://www.atlabs.ai/blog/gpt-image-2.5-prompt-guide-2026-flare-vs-sunburst-quality-steps-and-consistent-characters> |
| 347 | `whisper-large-v3` | Whisper large-v3 | OpenAI | 音律/开源 | N | 318 | → Whisper large-v3-turbo Lv23 | 2023-11-06 | <https://github.com/openai/whisper> |
| 348 | `whisper-large-v3-turbo` | Whisper large-v3-turbo | OpenAI | 音律/开源 | R | 364 | ← Whisper large-v3 | 2024-10-01 | <https://models.dev/> |
| 349 | `gpt-realtime-2-1` | gpt-realtime-2.1 | OpenAI | 音律/对话 | R | 379 | → GPT-Live-1 Lv30 | 2026-07-06 | <https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896> |
| 350 | `gpt-live-1` | GPT-Live-1 | OpenAI | 音律/对话 | SR | 449 | ← gpt-realtime-2.1 | 2026-09-10 | <https://openai.com/index/introducing-gpt-live-1-in-the-api/> |
| 351 | `text-embedding-ada-002` | text-embedding-ada-002 | OpenAI | 检索/算力 | N | 277 | → text-embedding-3-small Lv18 | 2022-12-15 | <https://models.dev/> |
| 352 | `text-embedding-3-small` | text-embedding-3-small | OpenAI | 检索/算力 | N | 310 | ← text-embedding-ada-002；→ text-embedding-3-large Lv25 | 2024-01-25 | <https://models.dev/> |
| 353 | `text-embedding-3-large` | text-embedding-3-large | OpenAI | 检索/算力 | R | 364 | ← text-embedding-3-small | 2024-01-25 | <https://models.dev/> |
| 354 | `grok-imagine-image` | Grok Imagine Image | SpaceXAI (formerly xAI) | 视觉/幻觉 | R | 368 | → Grok Imagine Image 2.0 Lv31 | 2026-01-28 | <https://models.dev/> |
| 355 | `grok-imagine-image-2` | Grok Imagine Image 2.0 | SpaceXAI (formerly xAI) | 视觉/幻觉 | SR | 444 | ← Grok Imagine Image | 2026-08-07 | <https://models.dev/> |
| 356 | `midjourney-v1` | Midjourney V1 | Midjourney | 视觉/幻觉 | N | 269 | → Midjourney V4 Lv20 | 2022-02-01 | <https://en.wikipedia.org/wiki/Midjourney> |
| 357 | `midjourney-v4` | Midjourney V4 | Midjourney | 视觉/创作 | R | 364 | ← Midjourney V1 | 2022-11-05 | <https://en.wikipedia.org/wiki/Midjourney> |
| 358 | `niji-6` | Niji 6 | Midjourney | 视觉/创作 | R | 382 | → Niji 7 Lv30 | 2024-01-29 | <https://en.wikipedia.org/wiki/Midjourney> |
| 359 | `niji-7` | Niji 7 | Midjourney | 视觉/创作 | SR | 452 | ← Niji 6 | 2026-01-09 | <https://en.wikipedia.org/wiki/Midjourney> |
| 360 | `midjourney-video-v1` | Midjourney Video V1 | Midjourney | 影像/视觉 | SR | 435 | — | 2025-06-18 | <https://updates.midjourney.com/> |
| 361 | `stable-audio` | Stable Audio | Stability AI | 音律/开源 | N | 277 | → Stable Audio 2.0 Lv21 | 2023-09-13 | <https://en.wikipedia.org/wiki/Stability_AI> |
| 362 | `stable-audio-2` | Stable Audio 2.0 | Stability AI | 音律/开源 | R | 357 | ← Stable Audio；→ Stable Audio 3.0 Lv28 | 2024-04-03 | <https://en.wikipedia.org/wiki/Stability_AI> |
| 363 | `stable-audio-3` | Stable Audio 3.0 | Stability AI | 音律/开源 | SR | 438 | ← Stable Audio 2.0 | 2026-05-01 | <https://en.wikipedia.org/wiki/Stability_AI> |
| 364 | `flux-kontext` | FLUX.1 Kontext | Black Forest Labs | 视觉/开源 | SR | 449 | — | 2025-05-29 | <https://en.wikipedia.org/wiki/Black_Forest_Labs> |
| 365 | `flux-2-klein` | FLUX.2 Klein | Black Forest Labs | 视觉/开源 | R | 375 | — | 2026-01-01 | <https://en.wikipedia.org/wiki/Black_Forest_Labs> |
| 366 | `runway-gen-1` | Runway Gen-1 | Runway | 影像 | N | 269 | → Runway Gen-2 Lv16 | 2023-02-06 | <https://en.wikipedia.org/wiki/Runway_(company)> |
| 367 | `runway-gen-2` | Runway Gen-2 | Runway | 影像/视觉 | N | 310 | ← Runway Gen-1；→ Runway Gen-3 Alpha Lv23 | 2023-03-20 | <https://en.wikipedia.org/wiki/Runway_(company)> |
| 368 | `runway-gen-3-alpha` | Runway Gen-3 Alpha | Runway | 影像/视觉 | R | 375 | ← Runway Gen-2 | 2024-06-17 | <https://en.wikipedia.org/wiki/Runway_(company)> |
| 369 | `runway-aleph` | Runway Aleph | Runway | 影像/创作 | SR | 444 | — | 2025-07-25 | <https://en.wikipedia.org/wiki/Runway_(company)> |
| 370 | `suno-v4` | Suno v4 | Suno | 音律/创作 | R | 375 | → Suno v4.5 Lv32 | 2024-11-19 | <https://en.wikipedia.org/wiki/Suno_AI> |
| 371 | `suno-v4-5` | Suno v4.5 | Suno | 音律/创作 | SR | 444 | ← Suno v4；→ Suno v5.5 Lv39 | 2025-05-01 | <https://en.wikipedia.org/wiki/Suno_AI> |
| 372 | `suno-v5-5` | Suno v5.5 | Suno | 音律/创作 | SR | 463 | ← Suno v4.5 | 2026-03-26 | <https://en.wikipedia.org/wiki/Suno_AI> |
| 373 | `helix` | Helix | Figure AI | 智能体/影像 | R | 375 | → Helix 02 Lv30 | 2025-02-01 | <https://en.wikipedia.org/wiki/Figure_AI> |
| 374 | `helix-02` | Helix 02 | Figure AI | 智能体/影像 | SR | 449 | ← Helix | 2026-01-27 | <https://en.wikipedia.org/wiki/Figure_AI> |
| 375 | `qwen1-5` | 通义千问 Qwen1.5 | Alibaba (Qwen) | 开源/对话 | N | 277 | → 通义千问 Qwen2 Lv22 | 2024-02-04 | <https://qwenlm.github.io/blog/qwen1.5/> |
| 376 | `qwen2` | 通义千问 Qwen2 | Alibaba (Qwen) | 开源/对话 | R | 357 | ← 通义千问 Qwen1.5 | 2024-06-07 | <https://qwenlm.github.io/blog/qwen2/> |
| 377 | `qwen2-5-max` | 通义千问 Qwen2.5-Max | Alibaba (Qwen) | 对话/推理 | R | 375 | → 通义千问 Qwen3-Max Lv30 | 2025-01-28 | <https://qwenlm.github.io/blog/qwen2.5-max/> |
| 378 | `qwen3-max` | 通义千问 Qwen3-Max | Alibaba (Qwen) | 对话/推理 | SR | 449 | ← 通义千问 Qwen2.5-Max；→ 通义千问 Qwen3-Max-Thinking Lv40 | 2025-09-23 | <https://openrouter.ai/qwen/qwen3-max> |
| 379 | `qwen3-max-thinking` | 通义千问 Qwen3-Max-Thinking | Alibaba (Qwen) | 推理/对话 | SSR | 514 | ← 通义千问 Qwen3-Max | 2026-02-09 | <https://openrouter.ai/qwen/qwen3-max-thinking> |
| 380 | `qwen-plus` | 通义千问 Qwen-Plus | Alibaba (Qwen) | 对话/算力 | R | 357 | → 通义千问 Qwen3.5-Plus Lv29 | 2024-01-25 | <https://openrouter.ai/qwen/qwen-plus-2025-07-28> |
| 381 | `qwen3-5-plus` | 通义千问 Qwen3.5-Plus | Alibaba (Qwen) | 对话/算力 | SR | 444 | ← 通义千问 Qwen-Plus；→ 通义千问 Qwen3.7-Plus Lv36 | 2026-02-16 | <https://openrouter.ai/qwen/qwen3.5-plus-20260420> |
| 382 | `qwen3-7-plus` | 通义千问 Qwen3.7-Plus | Alibaba (Qwen) | 对话/算力 | SR | 466 | ← 通义千问 Qwen3.5-Plus | 2026-06-02 | <https://openrouter.ai/qwen/qwen3.7-plus> |
| 383 | `qwen-vl` | 通义千问 Qwen-VL | Alibaba (Qwen) | 视觉/开源 | N | 285 | → 通义千问 Qwen2.5-VL Lv21 | 2023-08-24 | <https://github.com/QwenLM/Qwen-VL> |
| 384 | `qwen2-5-vl` | 通义千问 Qwen2.5-VL | Alibaba (Qwen) | 视觉/开源 | R | 379 | ← 通义千问 Qwen-VL；→ 通义千问 Qwen3-VL Lv29 | 2025-01-28 | <https://qwenlm.github.io/blog/qwen2.5-vl/> |
| 385 | `qwen3-vl` | 通义千问 Qwen3-VL | Alibaba (Qwen) | 视觉/开源 | SR | 447 | ← 通义千问 Qwen2.5-VL | 2025-09-23 | <https://openrouter.ai/qwen/qwen3-vl-235b-a22b-instruct> |
| 386 | `qwq-32b` | QwQ-32B | Alibaba (Qwen) | 推理/开源 | R | 389 | — | 2025-03-05 | <https://models.dev/> |
| 387 | `deepseek-v2` | DeepSeek-V2 | DeepSeek | 开源/算力 | N | 310 | → DeepSeek-V2.5 Lv22 | 2024-05-06 | <https://api-docs.deepseek.com/updates/> |
| 388 | `deepseek-v2-5` | DeepSeek-V2.5 | DeepSeek | 开源/算力 | R | 364 | ← DeepSeek-V2；→ DeepSeek-V3-0324 Lv29 | 2024-09-05 | <https://api-docs.deepseek.com/updates/> |
| 389 | `deepseek-v3-0324` | DeepSeek-V3-0324 | DeepSeek | 开源/算力 | R | 393 | ← DeepSeek-V2.5 | 2025-03-24 | <https://api-docs.deepseek.com/updates/> |
| 390 | `deepseek-r1-0528` | DeepSeek-R1-0528 | DeepSeek | 推理/开源 | SSR | 523 | — | 2025-05-28 | <https://api-docs.deepseek.com/updates/> |
| 391 | `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek | 算力/开源 | SR | 452 | → DeepSeek-V4-Flash 0731 Lv31 | 2026-04-24 | <https://api-docs.deepseek.com/updates/> |
| 392 | `deepseek-v4-flash-0731` | DeepSeek-V4-Flash 0731 | DeepSeek | 算力/开源 | SR | 461 | ← DeepSeek-V4-Flash；→ DeepSeek-V4.1-Flash Lv38 | 2026-07-31 | <https://api-docs.deepseek.com/updates/> |
| 393 | `deepseek-v4-1-flash` | DeepSeek-V4.1-Flash | DeepSeek | 算力/开源 | SSR | 514 | ← DeepSeek-V4-Flash 0731 | 2026-09-10 | <https://api-docs.deepseek.com/updates/> |
| 394 | `kimi-k1-5` | Kimi k1.5 | Moonshot AI | 推理/智能体 | R | 375 | — | 2025-01-20 | <https://github.com/MoonshotAI/Kimi-k1.5> |
| 395 | `kimi-k2-7-code` | Kimi K2.7 Code | Moonshot AI | 代码/智能体 | SR | 455 | → Kimi K2.8 Preview Lv28 | 2026-06-12 | <https://openrouter.ai/moonshotai/kimi-k2.7-code> |
| 396 | `kimi-k2-8-preview` | Kimi K2.8 Preview | Moonshot AI | 代码/智能体 | SR | 466 | ← Kimi K2.7 Code | 2026-09-11 | <https://letsdatascience.com/news/moonshot-deploys-kimi-k28-preview-to-coding-tools-0d15f07f> |
| 397 | `glm-4` | GLM-4 | Zhipu AI (Z.ai) | 对话/开源 | R | 353 | → GLM-4.6 Lv20 | 2024-01-16 | <https://docs.z.ai/release-notes/new-released> |
| 398 | `glm-4-6` | GLM-4.6 | Zhipu AI (Z.ai) | 代码/智能体 | R | 386 | ← GLM-4；→ GLM-5.1 Lv31 | 2025-09-30 | <https://docs.z.ai/release-notes/new-released> |
| 399 | `glm-5-1` | GLM-5.1 | Zhipu AI (Z.ai) | 代码/开源 | SR | 458 | ← GLM-4.6 | 2026-04-07 | <https://docs.z.ai/release-notes/new-released> |
| 400 | `glm-4-5v` | GLM-4.5V | Zhipu AI (Z.ai) | 视觉/开源 | R | 368 | → GLM-4.6V Lv22 | 2025-08-11 | <https://docs.z.ai/release-notes/new-released> |
| 401 | `glm-4-6v` | GLM-4.6V | Zhipu AI (Z.ai) | 视觉/开源 | R | 382 | ← GLM-4.5V；→ GLM-5V-Turbo Lv31 | 2025-12-08 | <https://docs.z.ai/release-notes/new-released> |
| 402 | `glm-5v-turbo` | GLM-5V-Turbo | Zhipu AI (Z.ai) | 视觉/算力 | SR | 447 | ← GLM-4.6V | 2026-04-01 | <https://docs.z.ai/release-notes/new-released> |
| 403 | `minimax-01` | MiniMax-01 | MiniMax | 开源/对话 | R | 357 | → MiniMax-M1 Lv23 | 2025-01-15 | <https://openrouter.ai/minimax/minimax-01> |
| 404 | `minimax-m1` | MiniMax-M1 | MiniMax | 推理/开源 | R | 382 | ← MiniMax-01；→ MiniMax-M2.5 Lv30 | 2025-06-16 | <https://github.com/MiniMax-AI/MiniMax-M1> |
| 405 | `minimax-m2-5` | MiniMax-M2.5 | MiniMax | 代码/开源 | SR | 452 | ← MiniMax-M1 | 2026-02-12 | <https://openrouter.ai/minimax/minimax-m2.5> |
| 406 | `minimax-speech-2-5` | MiniMax Speech 2.5 | MiniMax | 音律 | R | 353 | → MiniMax Speech 2.6 Lv23 | 2025-08-07 | <https://invideo.io/blog/minimax-ai-voice-models/> |
| 407 | `minimax-speech-2-6` | MiniMax Speech 2.6 | MiniMax | 音律/对话 | R | 368 | ← MiniMax Speech 2.5；→ MiniMax Speech 2.8 Lv30 | 2025-10-30 | <https://invideo.io/blog/minimax-ai-voice-models/> |
| 408 | `minimax-speech-2-8` | MiniMax Speech 2.8 | MiniMax | 音律/对话 | SR | 435 | ← MiniMax Speech 2.6 | 2026-01-23 | <https://invideo.io/blog/minimax-ai-voice-models/> |
| 409 | `doubao-seed-1-6` | 豆包 Seed-1.6 | ByteDance Seed | 对话/智能体 | R | 375 | → 豆包 Seed-1.8 Lv32 | 2025-06-11 | <https://seed.bytedance.com/en/blog> |
| 410 | `doubao-seed-1-8` | 豆包 Seed-1.8 | ByteDance Seed | 对话/智能体 | SR | 444 | ← 豆包 Seed-1.6；→ 豆包 Seed-2.0 Code Lv39 | 2025-12-28 | <https://models.dev/> |
| 411 | `doubao-seed-2-0-code` | 豆包 Seed-2.0 Code | ByteDance Seed | 代码/智能体 | SR | 458 | ← 豆包 Seed-1.8 | 2026-02-14 | <https://openrouter.ai/bytedance-seed/seed-2.0-code> |
| 412 | `doubao-seed-1-6-flash` | 豆包 Seed-1.6 Flash | ByteDance Seed | 算力/对话 | N | 301 | → 豆包 Seed-2.0 Lite Lv22 | 2025-06-11 | <https://seed.bytedance.com/en/blog> |
| 413 | `doubao-seed-2-0-lite` | 豆包 Seed-2.0 Lite | ByteDance Seed | 算力/对话 | R | 361 | ← 豆包 Seed-1.6 Flash；→ 豆包 Seed-2.1 Turbo Lv29 | 2026-02-14 | <https://openrouter.ai/bytedance-seed/seed-2.0-lite> |
| 414 | `doubao-seed-2-1-turbo` | 豆包 Seed-2.1 Turbo | ByteDance Seed | 算力/智能体 | R | 389 | ← 豆包 Seed-2.0 Lite | 2026-06-23 | <https://datanorth.ai/news/bytedance-releases-seed-2-1-pro-and-seed-2-1-turbo> |
| 415 | `hunyuan-large` | 混元 Large | Tencent Hunyuan | 开源/算力 | R | 364 | → 混元 TurboS Lv22 | 2024-11-05 | <https://en.wikipedia.org/wiki/Tencent_Hy> |
| 416 | `hunyuan-turbos` | 混元 TurboS | Tencent Hunyuan | 对话/算力 | R | 386 | ← 混元 Large；→ 混元 T1 Lv31 | 2025-02-01 | <https://en.wikipedia.org/wiki/Tencent_Hy> |
| 417 | `hunyuan-t1` | 混元 T1 | Tencent Hunyuan | 推理/对话 | SR | 449 | ← 混元 TurboS | 2025-03-21 | <https://en.wikipedia.org/wiki/Tencent_Hy> |
| 418 | `hunyuan3d-2` | 混元 3D 2.0 | Tencent Hunyuan | 视觉/开源 | R | 375 | → 混元 3D 3.1 Lv28 | 2025-01-21 | <https://github.com/Tencent-Hunyuan/Hunyuan3D-2> |
| 419 | `hunyuan3d-3-1` | 混元 3D 3.1 | Tencent Hunyuan | 视觉/开源 | SR | 449 | ← 混元 3D 2.0 | 2026-02-01 | <https://www.vset3d.com/hunyuan-3d-3-1-international-version/> |
| 420 | `hunyuanworld-1-0` | 混元世界 1.0 | Tencent Hunyuan | 视觉/幻觉 | R | 368 | → 混元世界 1.5 Lv20 | 2025-07-26 | <https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0> |
| 421 | `hunyuanworld-1-5` | 混元世界 1.5 | Tencent Hunyuan | 视觉/幻觉 | R | 386 | ← 混元世界 1.0；→ HY-World 2.0 Lv30 | 2025-12-18 | <https://explainx.ai/blog/tencent-hunyuan-hy-world-2-world-mirror-3d-world-model-2026> |
| 422 | `hy-world-2` | HY-World 2.0 | Tencent Hunyuan | 视觉/幻觉 | SR | 449 | ← 混元世界 1.5 | 2026-04-16 | <https://explainx.ai/blog/tencent-hunyuan-hy-world-2-world-mirror-3d-world-model-2026> |
| 423 | `kling-2-0` | 可灵 2.0 | Kuaishou (Kling AI) | 影像/视觉 | R | 386 | → 可灵 2.5 Turbo Lv30 | 2025-04-15 | <https://www.globenewswire.com/news-release/2025/04/15/3062142/0/en/Kling-AI-Advances-to-the-2-0-Era-Empowering-Everyone-to-Tell-Great-Stories-with-AI.html> |
| 424 | `kling-2-5-turbo` | 可灵 2.5 Turbo | Kuaishou (Kling AI) | 影像/算力 | SR | 449 | ← 可灵 2.0；→ 可灵 2.6 Lv37 | 2025-09-23 | <https://ir.kuaishou.com/news-releases/news-release-details/kling-ai-launches-25-turbo-video-model-industry-leading> |
| 425 | `kling-2-6` | 可灵 2.6 | Kuaishou (Kling AI) | 影像/音律 | SR | 461 | ← 可灵 2.5 Turbo | 2025-12-03 | <https://app.klingai.com/global/release-notes/c605hp1tzd?type=dialog> |
| 426 | `mimo-v2-pro` | MiMo-V2-Pro | Xiaomi | 智能体/推理 | SR | 452 | → MiMo-V2.5-Pro Lv29 | 2026-03-18 | <https://en.wikipedia.org/wiki/Xiaomi_MiMo> |
| 427 | `mimo-v2-5-pro` | MiMo-V2.5-Pro | Xiaomi | 智能体/推理 | SR | 463 | ← MiMo-V2-Pro | 2026-04-22 | <https://openrouter.ai/xiaomi/mimo-v2.5-pro> |
| 428 | `yi-34b` | 零一万物 Yi-34B | 01.AI | 开源/对话 | N | 310 | → 零一万物 Yi-1.5 Lv23 | 2023-11-02 | <https://github.com/01-ai/Yi> |
| 429 | `yi-1-5` | 零一万物 Yi-1.5 | 01.AI | 开源/对话 | R | 364 | ← 零一万物 Yi-34B；→ 零一万物 Yi-Lightning Lv30 | 2024-05-13 | <https://github.com/01-ai/Yi> |
| 430 | `yi-lightning` | 零一万物 Yi-Lightning | 01.AI | 对话/算力 | R | 389 | ← 零一万物 Yi-1.5 | 2024-10-16 | <https://github.com/01-ai/Yi> |
| 431 | `internlm` | 书生 InternLM | Shanghai AI Laboratory | 开源/推理 | N | 277 | → 书生 InternLM2.5 Lv23 | 2023-06-07 | <https://github.com/InternLM/InternLM> |
| 432 | `internlm2-5` | 书生 InternLM2.5 | Shanghai AI Laboratory | 开源/推理 | R | 361 | ← 书生 InternLM；→ 书生 InternLM3 Lv30 | 2024-07-03 | <https://github.com/InternLM/InternLM> |
| 433 | `internlm3` | 书生 InternLM3 | Shanghai AI Laboratory | 开源/推理 | R | 386 | ← 书生 InternLM2.5 | 2025-01-15 | <https://github.com/InternLM/InternLM> |
| 434 | `ernie-x1` | 文心 X1 | Baidu | 推理/检索 | R | 379 | → 文心 X1.1 Lv32 | 2025-03-16 | <https://presenc.ai/research/baidu-ernie-model-lineage-2026> |
| 435 | `ernie-x1-1` | 文心 X1.1 | Baidu | 推理/检索 | SR | 441 | ← 文心 X1 | 2025-09-09 | <https://the-decoder.com/baidus-ernie-5-1-cuts-94-percent-of-pre-training-costs-while-competing-with-top-models/> |
| 436 | `step-2` | 阶跃 Step-2 | StepFun | 算力/对话 | R | 357 | → 阶跃 Step 3 Lv20 | 2024-07-01 | <https://platform.stepfun.com> |
| 437 | `step-3` | 阶跃 Step 3 | StepFun | 算力/智能体 | R | 382 | ← 阶跃 Step-2 | 2025-07-25 | <https://github.com/stepfun-ai/Step3> |
| 438 | `command-r-plus` | Command R+ | Cohere | 对话/检索 | R | 364 | → Command A Lv21 | 2024-04-04 | <https://cohere.com/blog/command-r-plus-microsoft-azure> |
| 439 | `command-a` | Command A | Cohere | 对话/检索 | R | 386 | ← Command R+；→ Command A+ Lv30 | 2025-03-13 | <https://cohere.com/blog/command-a> |
| 440 | `command-a-plus` | Command A+ | Cohere | 对话/检索 | SR | 447 | ← Command A | 2026-05-20 | <https://docs.cohere.com/docs/command-a-plus> |
| 441 | `sonar` | Sonar | Perplexity AI | 检索/对话 | R | 368 | → Sonar Pro Lv31 | 2025-01-21 | <https://en.wikipedia.org/wiki/Perplexity_AI> |
| 442 | `sonar-pro` | Sonar Pro | Perplexity AI | 检索/对话 | SR | 441 | ← Sonar；→ Sonar Pro Search Lv38 | 2025-01-21 | <https://docs.perplexity.ai/guides/models> |
| 443 | `sonar-pro-search` | Sonar Pro Search | Perplexity AI | 检索/智能体 | SR | 452 | ← Sonar Pro | 2025-10-30 | <https://openrouter.ai/perplexity/sonar-pro-search> |
| 444 | `nemotron-70b` | Llama-3.1-Nemotron-70B | NVIDIA | 开源/算力 | R | 364 | — | 2024-10-15 | <https://huggingface.co/nvidia/Llama-3.1-Nemotron-70B-Instruct-HF> |
| 445 | `nemotron-super-49b` | Llama-3.3-Nemotron-Super-49B | NVIDIA | 开源/算力 | R | 386 | — | 2025-03-18 | <https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-v1> |
| 446 | `nemotron-ultra-253b` | Llama-3.1-Nemotron-Ultra-253B | NVIDIA | 开源/推理 | SR | 452 | — | 2025-04-07 | <https://models.dev/> |
| 447 | `hermes-3-405b` | Hermes 3 405B | Nous Research | 开源/对话 | R | 375 | → Hermes 4 405B Lv31 | 2024-08-16 | <https://openrouter.ai/nousresearch/hermes-3-llama-3.1-405b> |
| 448 | `hermes-4-405b` | Hermes 4 405B | Nous Research | 开源/推理 | SR | 447 | ← Hermes 3 405B | 2025-08-26 | <https://openrouter.ai/nousresearch/hermes-4-405b> |

## 新增 / 变更的进化关系

| 进化 | 等级 | 说明 |
|---|---|---|
| GPT-5.4 → GPT-5.5「土豆」 | 28 | 新增形态的进化 |
| GPT-5.6 Luna → GPT-6 Luna（月） | 23 | 新增形态的进化 |
| Codex 初代 → GPT-5.3-Codex | 24 | 原：→ OpenAI Codex（编程智能体） Lv32 |
| GPT-5.3-Codex → OpenAI Codex（编程智能体） | 40 | 新增形态的进化 |
| gpt-oss-120b → gpt-oss-safeguard-120b | 29 | 新增形态的进化 |
| Sora（初代） → Sora 2（已停服） | 30 | 新增形态的进化 |
| ChatGPT Agent → ChatGPT dots（常驻智能体） | 28 | 新增形态的进化 |
| Claude Fable 5 → Claude Fable 5.1 | 36 | 新增形态的进化 |
| Claude Computer Use → Claude 应用（Cowork 合体） | 28 | 新增形态的进化 |
| Gemini 3.1 Flash Live → Gemini 3.8 Live | 37 | 新增形态的进化 |
| Gemma 2 → Gemma 3 | 23 | 新增形态的进化 |
| Gemma 3 → Gemma 4 | 30 | 新增形态的进化 |
| Nano Banana 2 → Nano Banana 2.1 | 46 | 新增形态的进化 |
| Veo 3 → Veo 3.1 | 26 | 原：→ Gemini Omni 1.1 Flash Lv38 |
| Veo 3.1 → Gemini Omni 1.1 Flash | 40 | 新增形态的进化 |
| Lyria 2 → Lyria 3 | 22 | 新增形态的进化 |
| Lyria 3 → Lyria 3.5 | 38 | 新增形态的进化 |
| Genie → Genie 2 | 31 | 新增形态的进化 |
| Genie 2 → Genie 3 精灵世界 | 45 | 新增形态的进化 |
| Gemini CLI → Google Antigravity 反重力 | 30 | 新增形态的进化 |
| Gemini Robotics → Gemini Robotics 1.5 | 31 | 新增形态的进化 |
| Gemini Robotics 1.5 → Gemini Robotics 2 | 39 | 新增形态的进化 |
| Muse Spark 1.1 → Muse Spark 1.2 | 30 | 新增形态的进化 |
| Muse Spark 1.2 → Muse Spark 灵感火花 | 47 | 新增形态的进化 |
| Mistral 7B → Mixtral 8x7B | 18 | 原：→ Mistral Medium 3.5 Lv26 |
| Mixtral 8x7B → Mistral Medium 3.5 | 34 | 新增形态的进化 |
| Phi-3 → Phi-4 | 22 | 新增形态的进化 |
| Phi-4 → Phi-4-reasoning | 38 | 新增形态的进化 |
| MAI-1-preview → MAI-Thinking-1 | 30 | 新增形态的进化 |
| MAI-Image-1 → MAI-Image-2 | 32 | 新增形态的进化 |
| MAI-Image-2 → MAI-Image-2.6 | 39 | 新增形态的进化 |
| SDXL → Stable Diffusion 3.5 | 34 | 新增形态的进化 |
| FLUX.1 → FLUX.2 | 24 | 原：→ FLUX 3 Lv36 |
| FLUX.2 → FLUX 3 | 40 | 新增形态的进化 |
| Runway Gen-4 → Runway Gen-4.5 | 30 | 新增形态的进化 |
| Luma Dream Machine (Ray1) → Luma Ray2 | 22 | 新增形态的进化 |
| Luma Ray2 → Luma Ray3 | 30 | 新增形态的进化 |
| ElevenLabs 多语言 v2 → Eleven v3 | 26 | 原：→ Eleven v4 Lv34 |
| Eleven v3 → Eleven v4 | 42 | 新增形态的进化 |
| LangChain → LangGraph | 32 | 新增形态的进化 |
| π0.5 → π*0.6 | 30 | 新增形态的进化 |
| π*0.6 → π0.7 物理智能 | 38 | 新增形态的进化 |
| 通义万相 2.1 → 通义万相 2.2 | 24 | 原：→ 通义万相 3.0 Lv38 |
| 通义万相 2.2 → 通义万相 3.0 | 42 | 新增形态的进化 |
| 即梦 Seedream 3.0 → 即梦 Seedream 4.0 | 22 | 原：→ 即梦 Seedream 5.0 Lv30 |
| 即梦 Seedream 4.0 → 即梦 Seedream 5.0 | 38 | 新增形态的进化 |
| 混元生图 3.0 → 混元生图 3.5（预览） | 30 | 新增形态的进化 |
| 阶跃 Step 3.5 Flash → 阶跃 Step 3.7 Flash | 24 | 原：→ 阶跃 Step 5 Preview Lv36 |
| 阶跃 Step 3.7 Flash → 阶跃 Step 5 Preview | 40 | 新增形态的进化 |
| 美团 LongCat-Flash → 美团 LongCat 2.0 | 24 | 原：→ 美团龙猫 LongCat-2.5 Lv34 |
| 美团 LongCat 2.0 → 美团龙猫 LongCat-2.5 | 40 | 新增形态的进化 |
| SkyReels V2 → SkyReels V3 | 32 | 新增形态的进化 |
| SkyReels V3 → 天工 SkyReels V4 | 39 | 新增形态的进化 |
| 海螺 Video-01 → 海螺 02 | 24 | 原：→ 海螺 H3 Lv34 |
| 海螺 02 → 海螺 H3 | 40 | 新增形态的进化 |
| 宇树 H1 → 宇树 G1/H2 | 37 | 新增形态的进化 |
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
| Mistral Large 2 → Mistral Large 3 | 22 | 新增形态的进化 |
| Mistral Large 3 → Mistral Large 4 | 32 | 新增形态的进化 |
| Devstral Small → Devstral Medium | 21 | 新增形态的进化 |
| Devstral Medium → Devstral 2 | 28 | 新增形态的进化 |
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
| GPT-4 Turbo → GPT-4.1 | 31 | 新增形态的进化 |
| GPT-5.1 → GPT-5.2 | 37 | 新增形态的进化 |
| GPT-4o mini → GPT-5 mini | 22 | 新增形态的进化 |
| GPT-5 mini → GPT-5.4 mini | 29 | 新增形态的进化 |
| GPT-4.1 nano → GPT-5 nano | 18 | 新增形态的进化 |
| GPT-5 nano → GPT-5.4 nano | 25 | 新增形态的进化 |
| GPT-5-Codex → GPT-5.1-Codex-Max | 37 | 新增形态的进化 |
| GPT-5.1-Codex-Max → GPT-5.2-Codex | 44 | 新增形态的进化 |
| gpt-oss-20b → gpt-oss-safeguard-20b | 22 | 新增形态的进化 |
| Claude 1 → Claude 2 | 22 | 新增形态的进化 |
| Claude 3.7 Sonnet → Claude Sonnet 4 | 28 | 新增形态的进化 |
| Claude Sonnet 4 → Claude Sonnet 4.6 | 35 | 新增形态的进化 |
| Claude Opus 4.1 → Claude Opus 4.6 | 30 | 新增形态的进化 |
| Claude Opus 4.6 → Claude Opus 5 | 37 | 新增形态的进化 |
| Grok-2 → Grok 3 | 29 | 新增形态的进化 |
| Grok 3 → Grok 4.1 Fast | 36 | 新增形态的进化 |
| Grok 4.3 → Grok 4.6 | 36 | 新增形态的进化 |
| Llama 2 → Llama 3 | 24 | 新增形态的进化 |
| Llama 3 → Llama 3.3 | 31 | 新增形态的进化 |
| Mistral Small 3 → Mistral Small 3.2 | 21 | 新增形态的进化 |
| Mistral Small 3.2 → Mistral Small 4 | 28 | 新增形态的进化 |
| Magistral Small → Magistral Medium | 31 | 新增形态的进化 |
| Pixtral 12B → Pixtral Large | 22 | 新增形态的进化 |
| MAI-Code-1-Flash → MAI-Code-1.1-Flash | 20 | 新增形态的进化 |
| Gemini 3.6 Flash → Gemini 3.7 Flash | 39 | 新增形态的进化 |
| Imagen 3 → Imagen 4 | 30 | 新增形态的进化 |
| Veo → Veo 2 | 28 | 新增形态的进化 |
| Gemini 2.5 Flash TTS → Gemini 3.1 Flash TTS | 22 | 新增形态的进化 |
| Gemini 3.1 Flash TTS → Gemini 3.8 Flash TTS | 29 | 新增形态的进化 |
| AlphaGo Zero → AlphaZero | 39 | 新增形态的进化 |
| AlphaZero → MuZero | 46 | 新增形态的进化 |
| DALL-E 2 → DALL-E 3 | 20 | 新增形态的进化 |
| GPT Image 1.5 → GPT Image 2 | 37 | 新增形态的进化 |
| GPT Image 2 → GPT Image 2.5 Flare | 44 | 新增形态的进化 |
| Whisper large-v3 → Whisper large-v3-turbo | 23 | 新增形态的进化 |
| gpt-realtime-2.1 → GPT-Live-1 | 30 | 新增形态的进化 |
| text-embedding-ada-002 → text-embedding-3-small | 18 | 新增形态的进化 |
| text-embedding-3-small → text-embedding-3-large | 25 | 新增形态的进化 |
| Grok Imagine Image → Grok Imagine Image 2.0 | 31 | 新增形态的进化 |
| Midjourney V1 → Midjourney V4 | 20 | 新增形态的进化 |
| Niji 6 → Niji 7 | 30 | 新增形态的进化 |
| Stable Audio → Stable Audio 2.0 | 21 | 新增形态的进化 |
| Stable Audio 2.0 → Stable Audio 3.0 | 28 | 新增形态的进化 |
| Runway Gen-1 → Runway Gen-2 | 16 | 新增形态的进化 |
| Runway Gen-2 → Runway Gen-3 Alpha | 23 | 新增形态的进化 |
| Suno v4 → Suno v4.5 | 32 | 新增形态的进化 |
| Suno v4.5 → Suno v5.5 | 39 | 新增形态的进化 |
| Helix → Helix 02 | 30 | 新增形态的进化 |
| 通义千问 Qwen1.5 → 通义千问 Qwen2 | 22 | 新增形态的进化 |
| 通义千问 Qwen2.5-Max → 通义千问 Qwen3-Max | 30 | 新增形态的进化 |
| 通义千问 Qwen3-Max → 通义千问 Qwen3-Max-Thinking | 40 | 新增形态的进化 |
| 通义千问 Qwen-Plus → 通义千问 Qwen3.5-Plus | 29 | 新增形态的进化 |
| 通义千问 Qwen3.5-Plus → 通义千问 Qwen3.7-Plus | 36 | 新增形态的进化 |
| 通义千问 Qwen-VL → 通义千问 Qwen2.5-VL | 21 | 新增形态的进化 |
| 通义千问 Qwen2.5-VL → 通义千问 Qwen3-VL | 29 | 新增形态的进化 |
| DeepSeek-V2 → DeepSeek-V2.5 | 22 | 新增形态的进化 |
| DeepSeek-V2.5 → DeepSeek-V3-0324 | 29 | 新增形态的进化 |
| DeepSeek-V4-Flash → DeepSeek-V4-Flash 0731 | 31 | 新增形态的进化 |
| DeepSeek-V4-Flash 0731 → DeepSeek-V4.1-Flash | 38 | 新增形态的进化 |
| Kimi K2.7 Code → Kimi K2.8 Preview | 28 | 新增形态的进化 |
| GLM-4 → GLM-4.6 | 20 | 新增形态的进化 |
| GLM-4.6 → GLM-5.1 | 31 | 新增形态的进化 |
| GLM-4.5V → GLM-4.6V | 22 | 新增形态的进化 |
| GLM-4.6V → GLM-5V-Turbo | 31 | 新增形态的进化 |
| MiniMax-01 → MiniMax-M1 | 23 | 新增形态的进化 |
| MiniMax-M1 → MiniMax-M2.5 | 30 | 新增形态的进化 |
| MiniMax Speech 2.5 → MiniMax Speech 2.6 | 23 | 新增形态的进化 |
| MiniMax Speech 2.6 → MiniMax Speech 2.8 | 30 | 新增形态的进化 |
| 豆包 Seed-1.6 → 豆包 Seed-1.8 | 32 | 新增形态的进化 |
| 豆包 Seed-1.8 → 豆包 Seed-2.0 Code | 39 | 新增形态的进化 |
| 豆包 Seed-1.6 Flash → 豆包 Seed-2.0 Lite | 22 | 新增形态的进化 |
| 豆包 Seed-2.0 Lite → 豆包 Seed-2.1 Turbo | 29 | 新增形态的进化 |
| 混元 Large → 混元 TurboS | 22 | 新增形态的进化 |
| 混元 TurboS → 混元 T1 | 31 | 新增形态的进化 |
| 混元 3D 2.0 → 混元 3D 3.1 | 28 | 新增形态的进化 |
| 混元世界 1.0 → 混元世界 1.5 | 20 | 新增形态的进化 |
| 混元世界 1.5 → HY-World 2.0 | 30 | 新增形态的进化 |
| 可灵 2.0 → 可灵 2.5 Turbo | 30 | 新增形态的进化 |
| 可灵 2.5 Turbo → 可灵 2.6 | 37 | 新增形态的进化 |
| MiMo-V2-Pro → MiMo-V2.5-Pro | 29 | 新增形态的进化 |
| 零一万物 Yi-34B → 零一万物 Yi-1.5 | 23 | 新增形态的进化 |
| 零一万物 Yi-1.5 → 零一万物 Yi-Lightning | 30 | 新增形态的进化 |
| 书生 InternLM → 书生 InternLM2.5 | 23 | 新增形态的进化 |
| 书生 InternLM2.5 → 书生 InternLM3 | 30 | 新增形态的进化 |
| 文心 X1 → 文心 X1.1 | 32 | 新增形态的进化 |
| 阶跃 Step-2 → 阶跃 Step 3 | 20 | 新增形态的进化 |
| Command R+ → Command A | 21 | 新增形态的进化 |
| Command A → Command A+ | 30 | 新增形态的进化 |
| Sonar → Sonar Pro | 31 | 新增形态的进化 |
| Sonar Pro → Sonar Pro Search | 38 | 新增形态的进化 |
| Hermes 3 405B → Hermes 4 405B | 31 | 新增形态的进化 |

## 因进化链变化而重算的既有智灵

阶数变化的既有智灵（末形态顺延）会重新生成 `learnset` / `teachable` / `catchRate` / `baseExp` / `size`，种族值、特性、栖息地、文案不变；家族最高稀有度变化的家族，`growth` 随之重算。

`gpt-5-5`、`gpt-5-6`、`gpt-6-luna`、`gpt-6-sol`、`openai-codex`、`sora-2`、`chatgpt-dots`、`claude-fable`、`claude-mythos`、`claude-cowork`、`gemini-live`、`gemma-4`、`gemini-omni`、`lyria`、`genie-3`、`google-antigravity`、`gemini-robotics`、`muse-spark`、`mistral-medium`、`phi-4`、`mai-thinking`、`mai-image`、`sd-1-5`、`sdxl`、`flux-3`、`runway`、`luma-ray3`、`eleven-v4`、`langchain`、`pi-zero`、`wan-3`、`seedream-5`、`hunyuan-image`、`step-5`、`longcat-2-5`、`skyreels`、`minimax-h3`、`unitree`、`unitree-gd01`（共 39 只）。

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
| Genie 2 → Genie 3 精灵世界 | SR → UR | Lv45 |
| Grok 4 → Grok 4.7 | SR → UR | Lv44 |
| Muse Spark 1.2 → Muse Spark 灵感火花 | SR → UR | Lv47 |
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

## Boss 候选（`bossCandidate: true`）

源数据 `docs/research/roster-final.json` 中带 `bossCandidate: true` 的顶级形态，供 #27 Boss 战使用；本单只打标记，不实现机制（该字段不进入 `content/species.json`）。

| id | 名称 | 公司 | 稀有度 |
|---|---|---|---|
| `qwen3-8-max` | 通义千问 3.8-Max | Alibaba | UR |
| `wan-3` | 通义万相 3.0 | Alibaba (Tongyi) | UR |
| `claude-code` | Claude Code | Anthropic | UR |
| `claude-fable` | Claude Fable 5.1 | Anthropic | UR |
| `claude-mythos` | Claude Mythos 5.1 | Anthropic | MYTHIC |
| `claude-opus` | Claude Opus 5.5 | Anthropic | UR |
| `claude-sonnet` | Claude Sonnet 5.5 | Anthropic | UR |
| `cursor` | Cursor | Anysphere (SpaceX / SpaceXAI) | UR |
| `doubao-app` | 豆包 | ByteDance | UR |
| `seedance-2-5` | 即梦 Seedance 2.5 | ByteDance Seed | UR |
| `deepseek-v4` | DeepSeek-V4 / V4.1 | DeepSeek | UR |
| `eleven-v4` | Eleven v4 | ElevenLabs | UR |
| `gemini-argon` | Gemini 4 Argon（氩） | Google | UR |
| `genie-3` | Genie 3 精灵世界 | Google | UR |
| `alpha` | 阿尔法（AlphaGo / AlphaFold） | Google DeepMind | MYTHIC |
| `muse-spark` | Muse Spark 灵感火花 | Meta | UR |
| `minimax-h3` | 海螺 H3 | MiniMax | UR |
| `kimi-k3` | Kimi K3 | Moonshot AI | UR |
| `chatgpt` | ChatGPT（超级应用） | OpenAI | UR |
| `gpt-6-astra` | GPT-6 Astra（星） | OpenAI | UR |
| `gpt-6-sol` | GPT-6.1 Sol（日） | OpenAI | UR |
| `gpt-image-2-5` | GPT Image 2.5 | OpenAI | UR |
| `openai-codex` | OpenAI Codex（编程智能体） | OpenAI | UR |
| `openclaw` | OpenClaw 小龙虾 | OpenClaw Foundation | UR |
| `grok-4-7` | Grok 4.7 | SpaceXAI (formerly xAI) | UR |
| `suno-v6` | Suno v6 | Suno | UR |
| `unitree-gd01` | 宇树 GD01 载人机甲 | Unitree Robotics | UR |
| `agi` | AGI 奇点 | Unknown (all labs) | MYTHIC |
| `mimo-v2-6-pro` | MiMo-V2.6-Pro | Xiaomi | UR |
| `glm-5-3` | GLM-5.3 | Zhipu AI (Z.ai) | UR |
