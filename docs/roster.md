# 智灵口袋 · 图鉴总表

> 由 `python3 tools/data/build_species.py` 根据 `docs/research/roster-final.json` + `tools/data/species_rules.json` 生成，勿手改。

共 448 只，215 个家族；3 只初始伙伴。

## 初始伙伴三角

三只初始伙伴均为 1 阶，属性构成循环克制（攻击方 → 防守方 = 2×）：

- **o1**（推理）克制 **DeepSeek-V3**（算力）
- **Claude Haiku 4.5**（代码）克制 **o1**（推理）
- **DeepSeek-V3**（算力）克制 **Claude Haiku 4.5**（代码）

| 初始伙伴 | 公司 | 属性 | 稀有度 | BST | 进化链 |
|---|---|---|---|---|---|
| o1 | OpenAI | 推理 | R | 340 | o1 (Lv16) → GPT-5 (Lv36) → GPT-6 Astra（星） |
| Claude Haiku 4.5 | Anthropic | 代码 | R | 340 | Claude Haiku 4.5 (Lv16) → Claude Opus 4.8 (Lv36) → Claude Opus 5.5 |
| DeepSeek-V3 | DeepSeek | 算力 | R | 340 | DeepSeek-V3 (Lv16) → DeepSeek-R1 深度思考 (Lv36) → DeepSeek-V4 / V4.1 |

## 稀有度分布

| 稀有度 | 名称 | 数量 | BST 区间 | 捕获率区间 |
|---|---|---|---|---|
| N | 普通 | 40 | 240–330 | 150–255 |
| R | 稀有 | 143 | 330–420 | 90–190 |
| SR | 超稀有 | 156 | 420–490 | 45–120 |
| SSR | 史诗 | 79 | 490–550 | 25–60 |
| UR | 传说 | 27 | 560–630 | 8–30 |
| MYTHIC | 神话 | 3 | 640–720 | 3–3 |

## BST 校正

全部研究数据的 BST 均在稀有度区间内，未做缩放。

## 全图鉴

| # | 名称 | 公司 | 国家 | 属性 | 稀有度 | BST | 进化 |
|---|---|---|---|---|---|---|---|
| 1 | GPT-3.5 | OpenAI | US | 对话 | N | 298 | → GPT-4 Lv18 |
| 2 | GPT-4 | OpenAI | US | 对话/推理 | R | 370 | ← GPT-3.5；→ GPT-4o Lv34 |
| 3 | GPT-4o | OpenAI | US | 对话/音律 | SR | 443 | ← GPT-4 |
| 4 | ChatGPT（超级应用） | OpenAI | US | 对话/智能体 | UR | 615 | — |
| 5 | o1 | OpenAI | US | 推理 | R | 340 | → GPT-5 Lv16 |
| 6 | GPT-5 | OpenAI | US | 推理/对话 | SSR | 512 | ← o1；→ GPT-6 Astra（星） Lv36 |
| 7 | GPT-6 Astra（星） | OpenAI | US | 推理/算力 | UR | 612 | ← GPT-5 |
| 8 | GPT-5.4 | OpenAI | US | 推理/对话 | SR | 478 | → GPT-5.5「土豆」 Lv28 |
| 9 | GPT-5.5「土豆」 | OpenAI | US | 推理/幻觉 | SSR | 520 | ← GPT-5.4；→ GPT-5.6（日 / 地 / 月） Lv40 |
| 10 | GPT-5.6（日 / 地 / 月） | OpenAI | US | 推理/对齐 | SSR | 545 | ← GPT-5.5「土豆」 |
| 11 | GPT-5.6 Luna | OpenAI | US | 算力/对话 | R | 375 | → GPT-6 Luna（月） Lv23 |
| 12 | GPT-6 Luna（月） | OpenAI | US | 算力/对话 | SR | 485 | ← GPT-5.6 Luna；→ GPT-6.1 Sol（日） Lv30 |
| 13 | GPT-6.1 Sol（日） | OpenAI | US | 代码/推理 | UR | 600 | ← GPT-6 Luna（月） |
| 14 | Codex 初代 | OpenAI | US | 代码 | N | 268 | → GPT-5.3-Codex Lv24 |
| 15 | GPT-5.3-Codex | OpenAI | US | 代码/智能体 | SSR | 520 | ← Codex 初代；→ OpenAI Codex（编程智能体） Lv40 |
| 16 | OpenAI Codex（编程智能体） | OpenAI | US | 代码/智能体 | UR | 623 | ← GPT-5.3-Codex |
| 17 | gpt-oss-120b | OpenAI | US | 开源/推理 | R | 395 | → gpt-oss-safeguard-120b Lv29 |
| 18 | gpt-oss-safeguard-120b | OpenAI | US | 开源/对齐 | SR | 447 | ← gpt-oss-120b |
| 19 | DALL·E | OpenAI | US | 视觉 | R | 360 | → GPT Image 1（吉卜力风暴） Lv22 |
| 20 | GPT Image 1（吉卜力风暴） | OpenAI | US | 视觉/对话 | SR | 475 | ← DALL·E；→ GPT Image 2.5 Lv44 |
| 21 | GPT Image 2.5 | OpenAI | US | 视觉/推理 | UR | 623 | ← GPT Image 1（吉卜力风暴） |
| 22 | Sora（初代） | OpenAI | US | 影像 | R | 405 | → Sora 2（已停服） Lv30 |
| 23 | Sora 2（已停服） | OpenAI | US | 影像/幻觉 | SSR | 527 | ← Sora（初代） |
| 24 | ChatGPT Agent | OpenAI | US | 智能体/对话 | SR | 472 | → ChatGPT dots（常驻智能体） Lv28 |
| 25 | ChatGPT dots（常驻智能体） | OpenAI | US | 智能体 | SSR | 545 | ← ChatGPT Agent |
| 26 | Claude Haiku 4.5 | Anthropic | US | 代码 | R | 340 | → Claude Opus 4.8 Lv16 |
| 27 | Claude Opus 4.8 | Anthropic | US | 代码/对齐 | SSR | 512 | ← Claude Haiku 4.5；→ Claude Opus 5.5 Lv36 |
| 28 | Claude Opus 5.5 | Anthropic | US | 代码/推理 | UR | 630 | ← Claude Opus 4.8 |
| 29 | Claude 3 Opus | Anthropic | US | 创作/对齐 | R | 365 | → Claude 3.5 Sonnet Lv26 |
| 30 | Claude 3.5 Sonnet | Anthropic | US | 代码/创作 | SR | 436 | ← Claude 3 Opus；→ Claude Sonnet 5.5 Lv40 |
| 31 | Claude Sonnet 5.5 | Anthropic | US | 代码/创作 | UR | 622 | ← Claude 3.5 Sonnet |
| 32 | Claude Fable 5 | Anthropic | US | 推理/对齐 | SSR | 528 | → Claude Fable 5.1 Lv36 |
| 33 | Claude Fable 5.1 | Anthropic | US | 推理/对齐 | UR | 612 | ← Claude Fable 5 |
| 34 | Claude Mythos Preview | Anthropic | US | 代码/对齐 | SSR | 548 | — |
| 35 | Claude Mythos 5.1 | Anthropic | US | 代码/幻觉 | MYTHIC | 642 | — |
| 36 | Claude Code | Anthropic | US | 代码/智能体 | UR | 625 | — |
| 37 | Claude Computer Use | Anthropic | US | 智能体/视觉 | R | 392 | → Claude 应用（Cowork 合体） Lv28 |
| 38 | Claude 应用（Cowork 合体） | Anthropic | US | 智能体/创作 | SSR | 545 | ← Claude Computer Use |
| 39 | Gemini 3.5 Flash-Lite | Google | US | 算力 | R | 403 | → Gemini 3.8 Flash Lv20 |
| 40 | Gemini 3.8 Flash | Google | US | 算力/推理 | SSR | 549 | ← Gemini 3.5 Flash-Lite；→ Gemini 4 Argon（氩） Lv48 |
| 41 | Gemini 4 Argon（氩） | Google | US | 推理/对齐 | UR | 613 | ← Gemini 3.8 Flash |
| 42 | Gemini 3.1 Flash Live | Google | US | 音律/对话 | R | 375 | → Gemini 3.8 Live Lv37 |
| 43 | Gemini 3.8 Live | Google | US | 音律/对话 | SSR | 535 | ← Gemini 3.1 Flash Live |
| 44 | Gemini 1.5 Pro | Google | US | 检索/视觉 | R | 366 | → Gemini 2.5 Pro Lv26 |
| 45 | Gemini 2.5 Pro | Google | US | 推理/代码 | SR | 440 | ← Gemini 1.5 Pro；→ Gemini 3.1 Pro Preview Lv40 |
| 46 | Gemini 3.1 Pro Preview | Google | US | 推理/视觉 | SR | 470 | ← Gemini 2.5 Pro |
| 47 | Gemma 2 | Google | US | 开源/对话 | N | 277 | → Gemma 3 Lv23 |
| 48 | Gemma 3 | Google | US | 开源/视觉 | R | 372 | ← Gemma 2；→ Gemma 4 Lv30 |
| 49 | Gemma 4 | Google | US | 开源/视觉 | SR | 470 | ← Gemma 3 |
| 50 | Nano Banana 纳米香蕉 | Google | US | 视觉 | SR | 485 | → Nano Banana 2 Lv34 |
| 51 | Nano Banana 2 | Google | US | 视觉/算力 | SSR | 535 | ← Nano Banana 纳米香蕉；→ Nano Banana 2.1 Lv46 |
| 52 | Nano Banana 2.1 | Google | US | 视觉/算力 | SSR | 548 | ← Nano Banana 2 |
| 53 | Veo 3 | Google | US | 影像/音律 | SR | 480 | → Veo 3.1 Lv26 |
| 54 | Veo 3.1 | Google | US | 影像/音律 | SR | 488 | ← Veo 3；→ Gemini Omni 1.1 Flash Lv40 |
| 55 | Gemini Omni 1.1 Flash | Google | US | 影像/视觉 | SSR | 545 | ← Veo 3.1 |
| 56 | Lyria 2 | Google | US | 音律 | R | 385 | → Lyria 3 Lv22 |
| 57 | Lyria 3 | Google | US | 音律/创作 | SR | 452 | ← Lyria 2；→ Lyria 3.5 Lv38 |
| 58 | Lyria 3.5 | Google | US | 音律/创作 | SR | 470 | ← Lyria 3 |
| 59 | Genie | Google DeepMind | US | 影像/幻觉 | R | 350 | → Genie 2 Lv31 |
| 60 | Genie 2 | Google DeepMind | US | 影像/视觉 | SR | 433 | ← Genie；→ Genie 3 精灵世界 Lv45 |
| 61 | Genie 3 精灵世界 | Google | US | 影像/智能体 | UR | 600 | ← Genie 2 |
| 62 | NotebookLM | Google | US | 检索/创作 | SSR | 545 | — |
| 63 | Gemini CLI | Google | US | 代码/智能体 | R | 395 | → Google Antigravity 反重力 Lv30 |
| 64 | Google Antigravity 反重力 | Google | US | 代码/智能体 | SSR | 545 | ← Gemini CLI |
| 65 | Gemini Robotics | Google DeepMind | US | 智能体/视觉 | R | 379 | → Gemini Robotics 1.5 Lv31 |
| 66 | Gemini Robotics 1.5 | Google DeepMind | US | 智能体/视觉 | SR | 452 | ← Gemini Robotics；→ Gemini Robotics 2 Lv39 |
| 67 | Gemini Robotics 2 | Google | US | 智能体/影像 | SSR | 530 | ← Gemini Robotics 1.5 |
| 68 | 阿尔法（AlphaGo / AlphaFold） | Google DeepMind | UK | 推理/检索 | MYTHIC | 665 | — |
| 69 | Grok-1 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | N | 267 | → Grok 4 Lv24 |
| 70 | Grok 4 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 464 | ← Grok-1；→ Grok 4.7 Lv44 |
| 71 | Grok 4.7 | SpaceXAI (formerly xAI) | US | 推理/代码 | UR | 583 | ← Grok 4 |
| 72 | Ani（Grok 陪伴） | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 400 | — |
| 73 | Grok Imagine | SpaceXAI (formerly xAI) | US | 影像/音律 | SSR | 545 | — |
| 74 | LLaMA 初代 | Meta | US | 开源 | N | 260 | → Llama 3.1 405B Lv20 |
| 75 | Llama 3.1 405B | Meta | US | 开源/推理 | R | 367 | ← LLaMA 初代；→ Llama 4（Scout / Maverick） Lv38 |
| 76 | Llama 4（Scout / Maverick） | Meta | US | 开源/幻觉 | R | 385 | ← Llama 3.1 405B |
| 77 | Muse Spark 1.1 | Meta | US | 推理/视觉 | SR | 449 | → Muse Spark 1.2 Lv30 |
| 78 | Muse Spark 1.2 | Meta | US | 推理/视觉 | SR | 461 | ← Muse Spark 1.1；→ Muse Spark 灵感火花 Lv47 |
| 79 | Muse Spark 灵感火花 | Meta | US | 推理/视觉 | UR | 592 | ← Muse Spark 1.2 |
| 80 | Meta Muse 个人智能体 | Meta | US | 智能体/对话 | SSR | 545 | — |
| 81 | Moltbook 智能体论坛 | Meta (acquired) | US | 幻觉/对话 | R | 387 | — |
| 82 | Mistral 7B | Mistral AI | FR | 开源/算力 | N | 265 | → Mixtral 8x7B Lv18 |
| 83 | Mixtral 8x7B | Mistral AI | FR | 开源/算力 | R | 350 | ← Mistral 7B；→ Mistral Medium 3.5 Lv34 |
| 84 | Mistral Medium 3.5 | Mistral AI | FR | 开源/代码 | R | 400 | ← Mixtral 8x7B |
| 85 | Phi-3 | Microsoft | US | 推理 | N | 300 | → Phi-4 Lv22 |
| 86 | Phi-4 | Microsoft | US | 推理/算力 | R | 362 | ← Phi-3；→ Phi-4-reasoning Lv38 |
| 87 | Phi-4-reasoning | Microsoft | US | 推理/开源 | SR | 438 | ← Phi-4 |
| 88 | MAI-1-preview | Microsoft | US | 对话/算力 | R | 368 | → MAI-Thinking-1 Lv30 |
| 89 | MAI-Thinking-1 | Microsoft | US | 推理/代码 | SR | 478 | ← MAI-1-preview |
| 90 | MAI-Image-1 | Microsoft | US | 视觉 | R | 375 | → MAI-Image-2 Lv32 |
| 91 | MAI-Image-2 | Microsoft | US | 视觉/创作 | SR | 449 | ← MAI-Image-1；→ MAI-Image-2.6 Lv39 |
| 92 | MAI-Image-2.6 | Microsoft | US | 视觉/检索 | SSR | 530 | ← MAI-Image-2 |
| 93 | GitHub Copilot | GitHub (Microsoft) | US | 代码/智能体 | SSR | 545 | — |
| 94 | Amazon Kiro | Amazon (AWS) | US | 代码/幻觉 | SR | 470 | — |
| 95 | Nemotron 3 Super | NVIDIA | US | 开源/算力 | SR | 440 | → Nemotron 3 Ultra Lv34 |
| 96 | Nemotron 3 Ultra | NVIDIA | US | 开源/算力 | SR | 478 | ← Nemotron 3 Super |
| 97 | Apple 智能（基础模型 3） | Apple | US | 对话/对齐 | SR | 462 | — |
| 98 | Sakana Fugu 河豚 | Sakana AI | JP | 智能体/推理 | SR | 485 | — |
| 99 | Solar Pro 4 | Upstage | KR | 智能体/检索 | R | 388 | — |
| 100 | Inkling 灵念 | Thinking Machines Lab | US | 开源/视觉 | SR | 480 | — |
| 101 | Midjourney V5 | Midjourney | US | 视觉 | R | 373 | → Midjourney V7 Lv24 |
| 102 | Midjourney V7 | Midjourney | US | 视觉/创作 | SR | 476 | ← Midjourney V5；→ Midjourney V8 Lv42 |
| 103 | Midjourney V8 | Midjourney | US | 视觉/创作 | SSR | 542 | ← Midjourney V7 |
| 104 | Stable Diffusion 1.x | Stability AI | UK | 视觉/开源 | N | 270 | → SDXL Lv20 |
| 105 | SDXL | Stability AI | UK | 视觉/开源 | R | 352 | ← Stable Diffusion 1.x；→ Stable Diffusion 3.5 Lv34 |
| 106 | Stable Diffusion 3.5 | Stability AI | UK | 视觉/开源 | SR | 440 | ← SDXL |
| 107 | FLUX.1 | Black Forest Labs | DE | 视觉/开源 | R | 390 | → FLUX.2 Lv24 |
| 108 | FLUX.2 | Black Forest Labs | DE | 视觉/开源 | SR | 470 | ← FLUX.1；→ FLUX 3 Lv40 |
| 109 | FLUX 3 | Black Forest Labs | DE | 影像/视觉 | SSR | 545 | ← FLUX.2 |
| 110 | Runway Gen-4 | Runway | US | 影像/创作 | SR | 438 | → Runway Gen-4.5 Lv30 |
| 111 | Runway Gen-4.5 | Runway | US | 影像/创作 | SR | 468 | ← Runway Gen-4 |
| 112 | Luma Dream Machine (Ray1) | Luma AI | US | 影像 | R | 357 | → Luma Ray2 Lv22 |
| 113 | Luma Ray2 | Luma AI | US | 影像/视觉 | R | 382 | ← Luma Dream Machine (Ray1)；→ Luma Ray3 Lv30 |
| 114 | Luma Ray3 | Luma AI | US | 影像/视觉 | SR | 465 | ← Luma Ray2 |
| 115 | Suno v3 | Suno | US | 音律/创作 | R | 379 | → Suno v5 Lv24 |
| 116 | Suno v5 | Suno | US | 音律/创作 | SR | 485 | ← Suno v3；→ Suno v6 Lv44 |
| 117 | Suno v6 | Suno | US | 音律/创作 | UR | 615 | ← Suno v5 |
| 118 | ElevenLabs 多语言 v2 | ElevenLabs | US | 音律/对话 | R | 415 | → Eleven v3 Lv26 |
| 119 | Eleven v3 | ElevenLabs | US | 音律/对话 | SR | 478 | ← ElevenLabs 多语言 v2；→ Eleven v4 Lv42 |
| 120 | Eleven v4 | ElevenLabs | US | 音律/对话 | UR | 572 | ← Eleven v3 |
| 121 | Marble 世界大理石 | World Labs | US | 视觉/影像 | SSR | 537 | — |
| 122 | Cursor | Anysphere (SpaceX / SpaceXAI) | US | 代码/智能体 | UR | 608 | — |
| 123 | Windsurf 风帆 | Codeium -> Cognition | US | 代码/智能体 | SR | 472 | — |
| 124 | Devin（AI 软件工程师） | Cognition | US | 智能体/代码 | SSR | 545 | — |
| 125 | Replit Agent | Replit | US | 代码/智能体 | SR | 485 | — |
| 126 | Lovable | Lovable | SE | 代码/创作 | SSR | 539 | — |
| 127 | OpenCode | Anomaly (formerly SST) | US | 开源/代码 | SSR | 544 | — |
| 128 | Manus | Butterfly Effect (Meta deal being unwound) | SG | 智能体 | SR | 485 | → Manus 2.0（Manus Studio） Lv32 |
| 129 | Manus 2.0（Manus Studio） | Butterfly Effect (Meta deal being unwound) | SG | 智能体/算力 | SSR | 545 | ← Manus |
| 130 | Perplexity | Perplexity AI | US | 检索 | SR | 470 | → Comet 彗星浏览器 Lv28 |
| 131 | Comet 彗星浏览器 | Perplexity AI | US | 检索/智能体 | SR | 488 | ← Perplexity；→ Perplexity Computer Lv40 |
| 132 | Perplexity Computer | Perplexity AI | US | 检索/智能体 | SSR | 542 | ← Comet 彗星浏览器 |
| 133 | Character.AI | Character Technologies | US | 对话/创作 | R | 415 | — |
| 134 | Neuro-sama（牛肉） | Vedal (independent) | UK | 对话/幻觉 | SR | 470 | — |
| 135 | Clawdbot | Peter Steinberger (community) | AT | 智能体/开源 | R | 415 | → Moltbot（蜕壳期） Lv18 |
| 136 | Moltbot（蜕壳期） | Peter Steinberger (community) | AT | 智能体/开源 | SR | 480 | ← Clawdbot；→ OpenClaw 小龙虾 Lv36 |
| 137 | OpenClaw 小龙虾 | OpenClaw Foundation | AT | 智能体/开源 | UR | 607 | ← Moltbot（蜕壳期） |
| 138 | Hermes Agent 爱马仕智能体 | Nous Research | US | 智能体/开源 | SSR | 545 | — |
| 139 | AutoGPT | Significant Gravitas | UK | 智能体/幻觉 | R | 391 | — |
| 140 | LangChain | LangChain | US | 智能体/开源 | SR | 485 | → LangGraph Lv32 |
| 141 | LangGraph | LangChain | US | 智能体/开源 | SSR | 520 | ← LangChain |
| 142 | Figure 03 | Figure AI | US | 智能体/视觉 | SSR | 545 | — |
| 143 | 特斯拉 Optimus | Tesla | US | 智能体/算力 | SR | 485 | — |
| 144 | π0.5 | Physical Intelligence | US | 智能体/视觉 | R | 386 | → π*0.6 Lv30 |
| 145 | π*0.6 | Physical Intelligence | US | 智能体/视觉 | SR | 458 | ← π0.5；→ π0.7 物理智能 Lv38 |
| 146 | π0.7 物理智能 | Physical Intelligence | US | 智能体/开源 | SSR | 530 | ← π*0.6 |
| 147 | AGI 奇点 | Unknown (all labs) | INTL | 推理/对齐 | MYTHIC | 715 | — |
| 148 | DeepSeek-V3 | DeepSeek | CN | 算力 | R | 340 | → DeepSeek-R1 深度思考 Lv16 |
| 149 | DeepSeek-R1 深度思考 | DeepSeek | CN | 推理/开源 | SSR | 512 | ← DeepSeek-V3；→ DeepSeek-V4 / V4.1 Lv36 |
| 150 | DeepSeek-V4 / V4.1 | DeepSeek | CN | 开源/推理 | UR | 585 | ← DeepSeek-R1 深度思考 |
| 151 | DeepSeek Harness 虎鲸 | DeepSeek | CN | 智能体/开源 | SSR | 531 | — |
| 152 | 通义千问 1.0 | Alibaba | CN | 对话/开源 | N | 247 | → 通义千问 2.5 Lv18 |
| 153 | 通义千问 2.5 | Alibaba | CN | 开源 | R | 352 | ← 通义千问 1.0；→ 通义千问 3.8-Max Lv38 |
| 154 | 通义千问 3.8-Max | Alibaba | CN | 推理/智能体 | UR | 564 | ← 通义千问 2.5 |
| 155 | Qwen3.8-Flash-Next | Alibaba | CN | 算力/开源 | SSR | 521 | — |
| 156 | 千问 App | Alibaba | CN | 对话/智能体 | SSR | 545 | — |
| 157 | 千问图像 3.1 | Alibaba (Qwen) | CN | 视觉/创作 | SR | 488 | — |
| 158 | 千问语音 3.1 | Alibaba (Qwen) | CN | 音律/对话 | SSR | 540 | — |
| 159 | 通义万相 2.1 | Alibaba (Tongyi) | CN | 影像/开源 | R | 388 | → 通义万相 2.2 Lv24 |
| 160 | 通义万相 2.2 | Alibaba (Tongyi) | CN | 影像/开源 | SR | 455 | ← 通义万相 2.1；→ 通义万相 3.0 Lv42 |
| 161 | 通义万相 3.0 | Alibaba (Tongyi) | CN | 影像/音律 | UR | 610 | ← 通义万相 2.2 |
| 162 | 快乐小马 HappyHorse | Alibaba ATH (Taotian Future Life Lab) | CN | 影像/算力 | SR | 478 | — |
| 163 | 快乐生蚝 HappyOyster | Alibaba ATH | CN | 影像/智能体 | SR | 475 | — |
| 164 | 快乐虾米 HappyShrimp | Alibaba ATH | CN | 音律/创作 | SR | 465 | — |
| 165 | Qoder | Alibaba | CN | 代码/智能体 | SR | 485 | — |
| 166 | Kimi 智能助手 | Moonshot AI | CN | 对话/检索 | R | 357 | → Kimi K2 Lv24 |
| 167 | Kimi K2 | Moonshot AI | CN | 智能体/开源 | SR | 448 | ← Kimi 智能助手；→ Kimi K3 Lv44 |
| 168 | Kimi K3 | Moonshot AI | CN | 开源/智能体 | UR | 570 | ← Kimi K2 |
| 169 | Kimi Work | Moonshot AI | CN | 智能体 | SSR | 539 | — |
| 170 | ChatGLM-6B | Zhipu AI (Z.ai) | CN | 对话/开源 | N | 255 | → GLM-4.5 Lv22 |
| 171 | GLM-4.5 | Zhipu AI (Z.ai) | CN | 智能体/开源 | SR | 442 | ← ChatGLM-6B；→ GLM-5.3 Lv42 |
| 172 | GLM-5.3 | Zhipu AI (Z.ai) | CN | 代码/开源 | UR | 565 | ← GLM-4.5 |
| 173 | AutoGLM | Zhipu AI (Z.ai) | CN | 智能体/视觉 | SR | 484 | — |
| 174 | 豆包大模型 Pro | ByteDance | CN | 对话/算力 | N | 278 | → 豆包 Seed 2.0 Lv20 |
| 175 | 豆包 Seed 2.0 | ByteDance | CN | 智能体/算力 | SR | 469 | ← 豆包大模型 Pro；→ 豆包 Seed 2.1 Pro Lv42 |
| 176 | 豆包 Seed 2.1 Pro | ByteDance | CN | 智能体/视觉 | SSR | 526 | ← 豆包 Seed 2.0 |
| 177 | 豆包 | ByteDance | CN | 对话/音律 | UR | 590 | — |
| 178 | 即梦 Seedream 3.0 | ByteDance Seed | CN | 视觉/创作 | R | 407 | → 即梦 Seedream 4.0 Lv22 |
| 179 | 即梦 Seedream 4.0 | ByteDance Seed | CN | 视觉/创作 | SR | 458 | ← 即梦 Seedream 3.0；→ 即梦 Seedream 5.0 Lv38 |
| 180 | 即梦 Seedream 5.0 | ByteDance Seed | CN | 视觉/推理 | SSR | 505 | ← 即梦 Seedream 4.0 |
| 181 | 即梦 Seedance 1.0 | ByteDance Seed | CN | 影像 | SR | 462 | → 即梦 Seedance 2.0 Lv26 |
| 182 | 即梦 Seedance 2.0 | ByteDance Seed | CN | 影像/幻觉 | SSR | 545 | ← 即梦 Seedance 1.0；→ 即梦 Seedance 2.5 Lv46 |
| 183 | 即梦 Seedance 2.5 | ByteDance Seed | CN | 影像/音律 | UR | 612 | ← 即梦 Seedance 2.0 |
| 184 | Trae | ByteDance | CN | 代码/智能体 | SR | 485 | — |
| 185 | 扣子 Coze | ByteDance | CN | 智能体/创作 | SSR | 537 | — |
| 186 | 腾讯混元 | Tencent | CN | 对话 | N | 251 | → 混元 Hy3 Lv24 |
| 187 | 混元 Hy3 | Tencent | CN | 推理/开源 | SR | 456 | ← 腾讯混元；→ 混元 Hy4 Preview Lv44 |
| 188 | 混元 Hy4 Preview | Tencent | CN | 智能体/开源 | SSR | 525 | ← 混元 Hy3 |
| 189 | 腾讯元宝 | Tencent | CN | 对话/检索 | SSR | 528 | — |
| 190 | 混元生图 3.0 | Tencent Hunyuan | CN | 视觉/开源 | SR | 450 | → 混元生图 3.5（预览） Lv30 |
| 191 | 混元生图 3.5（预览） | Tencent Hunyuan | CN | 视觉/开源 | SR | 476 | ← 混元生图 3.0 |
| 192 | WorkBuddy | Tencent | CN | 智能体/对话 | SSR | 538 | — |
| 193 | 文心一言 3.5 | Baidu | CN | 对话/检索 | N | 265 | → 文心 4.5 Lv22 |
| 194 | 文心 4.5 | Baidu | CN | 视觉/开源 | R | 362 | ← 文心一言 3.5；→ 文心 5.1 Preview Lv40 |
| 195 | 文心 5.1 Preview | Baidu | CN | 对话/算力 | SR | 466 | ← 文心 4.5 |
| 196 | 阶跃 Step 3.5 Flash | StepFun | CN | 算力/开源 | R | 374 | → 阶跃 Step 3.7 Flash Lv24 |
| 197 | 阶跃 Step 3.7 Flash | StepFun | CN | 算力/开源 | SR | 452 | ← 阶跃 Step 3.5 Flash；→ 阶跃 Step 5 Preview Lv40 |
| 198 | 阶跃 Step 5 Preview | StepFun | CN | 智能体/视觉 | SSR | 542 | ← 阶跃 Step 3.7 Flash |
| 199 | 讯飞星火 V4.0 | iFlytek | CN | 音律/对话 | N | 266 | → 讯飞星火 X2.5 Lv28 |
| 200 | 讯飞星火 X2.5 | iFlytek | CN | 推理/算力 | R | 390 | ← 讯飞星火 V4.0 |
| 201 | 商汤日日新 6.7 Flash-Lite | SenseTime | CN | 视觉/创作 | R | 370 | — |
| 202 | 百川 2 | Baichuan AI | CN | 对话/开源 | N | 249 | → 百川 M3 Lv26 |
| 203 | 百川 M3 | Baichuan AI | CN | 对齐/检索 | R | 385 | ← 百川 2 |
| 204 | 小米 MiMo-7B | Xiaomi | CN | 推理/开源 | N | 268 | → MiMo-V2-Flash Lv22 |
| 205 | MiMo-V2-Flash | Xiaomi | CN | 算力/开源 | SR | 434 | ← 小米 MiMo-7B；→ MiMo-V2.6-Pro Lv44 |
| 206 | MiMo-V2.6-Pro | Xiaomi | CN | 开源/推理 | UR | 580 | ← MiMo-V2-Flash |
| 207 | 美团 LongCat-Flash | Meituan | CN | 算力/智能体 | R | 379 | → 美团 LongCat 2.0 Lv24 |
| 208 | 美团 LongCat 2.0 | Meituan | CN | 智能体/算力 | SR | 435 | ← 美团 LongCat-Flash；→ 美团龙猫 LongCat-2.5 Lv40 |
| 209 | 美团龙猫 LongCat-2.5 | Meituan | CN | 智能体/视觉 | SR | 460 | ← 美团 LongCat 2.0 |
| 210 | 蚂蚁百灵 Ling 3.0 / Ring 2.6 | Ant Group | CN | 推理/开源 | R | 371 | — |
| 211 | 蚂蚁阿福 | Ant Group | CN | 对话/对齐 | SSR | 520 | — |
| 212 | 可灵 1.0 | Kuaishou (Kling AI) | CN | 影像 | R | 351 | → 可灵 3.0 Lv28 |
| 213 | 可灵 3.0 | Kuaishou (Kling AI) | CN | 影像/音律 | SSR | 530 | ← 可灵 1.0；→ 可灵 4.0 Lv48 |
| 214 | 可灵 4.0 | Kling AI (Kuaishou spin-off) | CN | 影像/视觉 | SSR | 548 | ← 可灵 3.0 |
| 215 | 书生 Intern-S2 | Shanghai AI Laboratory | CN | 检索/推理 | R | 381 | — |
| 216 | 天工 Mureka V9 | Kunlun Tech (Skywork AI) | CN | 音律/创作 | SR | 482 | — |
| 217 | SkyReels V2 | Skywork AI (Kunlun Tech) | CN | 影像/开源 | SR | 435 | → SkyReels V3 Lv32 |
| 218 | SkyReels V3 | Skywork AI (Kunlun Tech) | CN | 影像/开源 | SR | 449 | ← SkyReels V2；→ 天工 SkyReels V4 Lv39 |
| 219 | 天工 SkyReels V4 | Skywork AI (Kunlun Tech) | CN | 影像/创作 | SR | 488 | ← SkyReels V3 |
| 220 | 华为盘古 5.5 | Huawei | CN | 对齐/算力 | N | 296 | → 华为 openPangu 2.0 Pro Lv30 |
| 221 | 华为 openPangu 2.0 Pro | Huawei | CN | 开源/算力 | R | 379 | ← 华为盘古 5.5 |
| 222 | 面壁 MiniCPM | ModelBest | CN | 算力/开源 | R | 354 | — |
| 223 | 生数 Vidu | ShengShu Technology | CN | 影像 | R | 352 | → 生数 Vidu Q3 Lv30 |
| 224 | 生数 Vidu Q3 | ShengShu Technology | CN | 影像/创作 | SR | 477 | ← 生数 Vidu |
| 225 | 拍我AI PixVerse V6 | PixVerse (爱诗科技) | CN | 影像/智能体 | SR | 479 | — |
| 226 | MiniMax abab6.5 | MiniMax | CN | 对话/创作 | N | 260 | → MiniMax-M2 Lv24 |
| 227 | MiniMax-M2 | MiniMax | CN | 代码/开源 | R | 380 | ← MiniMax abab6.5；→ MiniMax-M3 Lv40 |
| 228 | MiniMax-M3 | MiniMax | CN | 代码/视觉 | SR | 461 | ← MiniMax-M2 |
| 229 | 海螺 Video-01 | MiniMax | CN | 影像 | R | 358 | → 海螺 02 Lv24 |
| 230 | 海螺 02 | MiniMax | CN | 影像 | SR | 455 | ← 海螺 Video-01；→ 海螺 H3 Lv40 |
| 231 | 海螺 H3 | MiniMax | CN | 影像/开源 | UR | 565 | ← 海螺 02 |
| 232 | MiniMax 音乐 3.0 | MiniMax | CN | 音律/创作 | SR | 485 | — |
| 233 | Tripo H3.1 | VAST (Tripo AI) | CN | 视觉/算力 | SR | 485 | — |
| 234 | 宇树 H1 | Unitree Robotics | CN | 影像/智能体 | R | 375 | → 宇树 G1/H2 Lv37 |
| 235 | 宇树 G1/H2 | Unitree Robotics | CN | 智能体/算力 | SSR | 543 | ← 宇树 H1；→ 宇树 GD01 载人机甲 Lv50 |
| 236 | 宇树 GD01 载人机甲 | Unitree Robotics | CN | 算力/智能体 | UR | 570 | ← 宇树 G1/H2 |
| 237 | 智元机器人 | AgiBot | CN | 智能体/视觉 | SSR | 541 | — |
| 238 | o3-mini | OpenAI | US | 推理 | R | 368 | → o3 Lv20 |
| 239 | o3 | OpenAI | US | 推理/代码 | SR | 448 | ← o3-mini；→ o3-pro Lv40 |
| 240 | o3-pro | OpenAI | US | 推理/算力 | SR | 486 | ← o3 |
| 241 | Claude Opus 4 | Anthropic | US | 代码/对齐 | R | 400 | → Claude Opus 4.5 Lv22 |
| 242 | Claude Opus 4.5 | Anthropic | US | 代码/对齐 | SR | 458 | ← Claude Opus 4；→ Claude Opus 4.7 Lv40 |
| 243 | Claude Opus 4.7 | Anthropic | US | 代码/推理 | SSR | 515 | ← Claude Opus 4.5 |
| 244 | Claude Sonnet 4.5 | Anthropic | US | 代码/创作 | SR | 450 | → Claude Sonnet 5 Lv34 |
| 245 | Claude Sonnet 5 | Anthropic | US | 代码/创作 | SSR | 530 | ← Claude Sonnet 4.5 |
| 246 | Claude 3 Haiku | Anthropic | US | 代码 | N | 295 | → Claude 3.5 Haiku Lv18 |
| 247 | Claude 3.5 Haiku | Anthropic | US | 代码 | R | 372 | ← Claude 3 Haiku；→ Claude Haiku 5.5 Lv34 |
| 248 | Claude Haiku 5.5 | Anthropic | US | 代码/智能体 | SR | 440 | ← Claude 3.5 Haiku |
| 249 | Gemini 2.5 Flash | Google | US | 算力 | R | 398 | → Gemini 3 Flash Lv24 |
| 250 | Gemini 3 Flash | Google | US | 算力/对话 | SR | 462 | ← Gemini 2.5 Flash；→ Gemini 3.5 Flash Lv40 |
| 251 | Gemini 3.5 Flash | Google | US | 算力/智能体 | SSR | 520 | ← Gemini 3 Flash |
| 252 | Grok Build | SpaceXAI (formerly xAI) | US | 代码/智能体 | SR | 462 | — |
| 253 | Grok 4.20 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 470 | → Grok 4.5 Lv36 |
| 254 | Grok 4.5 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SSR | 525 | ← Grok 4.20 |
| 255 | Muse Image | Meta | US | 视觉/创作 | SR | 470 | — |
| 256 | Mistral Large 2 | Mistral AI | FR | 开源/对话 | R | 339 | → Mistral Large 3 Lv22 |
| 257 | Mistral Large 3 | Mistral AI | FR | 开源/推理 | R | 398 | ← Mistral Large 2；→ Mistral Large 4 Lv32 |
| 258 | Mistral Large 4 | Mistral AI | FR | 开源/推理 | SR | 460 | ← Mistral Large 3 |
| 259 | Devstral Small | Mistral AI | FR | 代码/开源 | R | 353 | → Devstral Medium Lv21 |
| 260 | Devstral Medium | Mistral AI | FR | 代码/开源 | R | 389 | ← Devstral Small；→ Devstral 2 Lv28 |
| 261 | Devstral 2 | Mistral AI | FR | 代码/开源 | SR | 440 | ← Devstral Medium |
| 262 | DeepSeek-V3.1 | DeepSeek | CN | 算力/推理 | R | 372 | → DeepSeek-V3.2 Lv22 |
| 263 | DeepSeek-V3.2 | DeepSeek | CN | 算力/推理 | SR | 450 | ← DeepSeek-V3.1；→ DeepSeek-V3.2-Speciale Lv38 |
| 264 | DeepSeek-V3.2-Speciale | DeepSeek | CN | 推理/开源 | SSR | 508 | ← DeepSeek-V3.2 |
| 265 | DeepSeek 应用 | DeepSeek | CN | 对话/检索 | SSR | 530 | — |
| 266 | 通义千问 Qwen3 | Alibaba | CN | 开源/对话 | R | 378 | → 通义千问 Qwen3.5 Lv24 |
| 267 | 通义千问 Qwen3.5 | Alibaba | CN | 开源/视觉 | SR | 452 | ← 通义千问 Qwen3；→ 通义千问 Qwen3.7-Max Lv40 |
| 268 | 通义千问 Qwen3.7-Max | Alibaba | CN | 开源/推理 | SSR | 520 | ← 通义千问 Qwen3.5 |
| 269 | Qwen3-Coder | Alibaba | CN | 代码/开源 | SR | 440 | → Qwen3-Coder-Next Lv32 |
| 270 | Qwen3-Coder-Next | Alibaba | CN | 代码/智能体 | SSR | 502 | ← Qwen3-Coder |
| 271 | Kimi K2 Thinking | Moonshot AI | CN | 推理/智能体 | SR | 430 | → Kimi K2.5 Lv26 |
| 272 | Kimi K2.5 | Moonshot AI | CN | 智能体/视觉 | SR | 470 | ← Kimi K2 Thinking；→ Kimi K2.6 Lv40 |
| 273 | Kimi K2.6 | Moonshot AI | CN | 智能体/代码 | SSR | 515 | ← Kimi K2.5 |
| 274 | GLM-4.7 | Zhipu AI (Z.ai) | CN | 智能体/代码 | SR | 438 | → GLM-5 Lv26 |
| 275 | GLM-5 | Zhipu AI (Z.ai) | CN | 代码/开源 | SR | 478 | ← GLM-4.7；→ GLM-5.2 Lv40 |
| 276 | GLM-5.2 | Zhipu AI (Z.ai) | CN | 代码/开源 | SSR | 530 | ← GLM-5 |
| 277 | MiniMax-M2.1 | MiniMax | CN | 代码/开源 | R | 395 | → MiniMax-M2.7 Lv30 |
| 278 | MiniMax-M2.7 | MiniMax | CN | 代码/开源 | SR | 455 | ← MiniMax-M2.1 |
| 279 | GPT-4 Turbo | OpenAI | US | 对话/算力 | R | 361 | → GPT-4.1 Lv31 |
| 280 | GPT-4.1 | OpenAI | US | 代码/对话 | SR | 441 | ← GPT-4 Turbo |
| 281 | GPT-5.1 | OpenAI | US | 推理/对话 | SSR | 520 | → GPT-5.2 Lv37 |
| 282 | GPT-5.2 | OpenAI | US | 推理/算力 | SSR | 529 | ← GPT-5.1 |
| 283 | GPT-4o mini | OpenAI | US | 对话 | N | 285 | → GPT-5 mini Lv22 |
| 284 | GPT-5 mini | OpenAI | US | 对话/算力 | R | 371 | ← GPT-4o mini；→ GPT-5.4 mini Lv29 |
| 285 | GPT-5.4 mini | OpenAI | US | 对话/智能体 | SR | 448 | ← GPT-5 mini |
| 286 | GPT-4.1 nano | OpenAI | US | 算力 | N | 260 | → GPT-5 nano Lv18 |
| 287 | GPT-5 nano | OpenAI | US | 算力/对话 | N | 301 | ← GPT-4.1 nano；→ GPT-5.4 nano Lv25 |
| 288 | GPT-5.4 nano | OpenAI | US | 算力/智能体 | R | 357 | ← GPT-5 nano |
| 289 | GPT-5-Codex | OpenAI | US | 代码/智能体 | SR | 458 | → GPT-5.1-Codex-Max Lv37 |
| 290 | GPT-5.1-Codex-Max | OpenAI | US | 代码/智能体 | SSR | 517 | ← GPT-5-Codex；→ GPT-5.2-Codex Lv44 |
| 291 | GPT-5.2-Codex | OpenAI | US | 代码/推理 | SSR | 526 | ← GPT-5.1-Codex-Max |
| 292 | o4-mini | OpenAI | US | 推理/算力 | R | 386 | — |
| 293 | gpt-oss-20b | OpenAI | US | 开源/算力 | R | 364 | → gpt-oss-safeguard-20b Lv22 |
| 294 | gpt-oss-safeguard-20b | OpenAI | US | 开源/对齐 | R | 375 | ← gpt-oss-20b |
| 295 | GPT-5.6 Terra | OpenAI | US | 推理/创作 | SR | 463 | — |
| 296 | Claude 1 | Anthropic | US | 对话/对齐 | N | 252 | → Claude 2 Lv22 |
| 297 | Claude 2 | Anthropic | US | 对话/创作 | R | 339 | ← Claude 1；→ Claude 3 Sonnet Lv29 |
| 298 | Claude 3 Sonnet | Anthropic | US | 对话/对齐 | R | 368 | ← Claude 2 |
| 299 | Claude 3.7 Sonnet | Anthropic | US | 代码/创作 | R | 379 | → Claude Sonnet 4 Lv28 |
| 300 | Claude Sonnet 4 | Anthropic | US | 代码/创作 | SR | 444 | ← Claude 3.7 Sonnet；→ Claude Sonnet 4.6 Lv35 |
| 301 | Claude Sonnet 4.6 | Anthropic | US | 代码/智能体 | SR | 466 | ← Claude Sonnet 4 |
| 302 | Claude Opus 4.1 | Anthropic | US | 代码/对齐 | SR | 449 | → Claude Opus 4.6 Lv30 |
| 303 | Claude Opus 4.6 | Anthropic | US | 代码/推理 | SR | 472 | ← Claude Opus 4.1；→ Claude Opus 5 Lv37 |
| 304 | Claude Opus 5 | Anthropic | US | 代码/推理 | SSR | 537 | ← Claude Opus 4.6 |
| 305 | Grok-2 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 357 | → Grok 3 Lv29 |
| 306 | Grok 3 | SpaceXAI (formerly xAI) | US | 对话/推理 | SR | 444 | ← Grok-2；→ Grok 4.1 Fast Lv36 |
| 307 | Grok 4.1 Fast | SpaceXAI (formerly xAI) | US | 对话/算力 | SR | 461 | ← Grok 3 |
| 308 | Grok 4.3 | SpaceXAI (formerly xAI) | US | 对话/推理 | SR | 472 | → Grok 4.6 Lv36 |
| 309 | Grok 4.6 | SpaceXAI (formerly xAI) | US | 对话/推理 | SSR | 531 | ← Grok 4.3 |
| 310 | Llama 2 | Meta | US | 开源/对话 | N | 277 | → Llama 3 Lv24 |
| 311 | Llama 3 | Meta | US | 开源/对话 | R | 361 | ← Llama 2；→ Llama 3.3 Lv31 |
| 312 | Llama 3.3 | Meta | US | 开源/算力 | R | 397 | ← Llama 3 |
| 313 | Muse Glimmer | Meta | US | 对话/算力 | R | 375 | — |
| 314 | Muse Code | Meta | US | 代码/智能体 | SR | 444 | — |
| 315 | Mistral Small 3 | Mistral AI | FR | 开源/算力 | R | 346 | → Mistral Small 3.2 Lv21 |
| 316 | Mistral Small 3.2 | Mistral AI | FR | 开源/算力 | R | 364 | ← Mistral Small 3；→ Mistral Small 4 Lv28 |
| 317 | Mistral Small 4 | Mistral AI | FR | 开源/智能体 | SR | 441 | ← Mistral Small 3.2 |
| 318 | Magistral Small | Mistral AI | FR | 推理/开源 | R | 357 | → Magistral Medium Lv31 |
| 319 | Magistral Medium | Mistral AI | FR | 推理/开源 | SR | 441 | ← Magistral Small |
| 320 | Pixtral 12B | Mistral AI | FR | 视觉/开源 | N | 285 | → Pixtral Large Lv22 |
| 321 | Pixtral Large | Mistral AI | FR | 视觉/开源 | R | 364 | ← Pixtral 12B |
| 322 | MAI-Code-1-Flash | Microsoft | US | 代码/算力 | R | 357 | → MAI-Code-1.1-Flash Lv20 |
| 323 | MAI-Code-1.1-Flash | Microsoft | US | 代码/算力 | R | 382 | ← MAI-Code-1-Flash |
| 324 | Gemini 1.0 | Google | US | 对话/视觉 | R | 350 | — |
| 325 | Gemini 3 Pro | Google | US | 推理/视觉 | SSR | 526 | — |
| 326 | Gemini 2.0 Flash | Google | US | 算力/对话 | R | 368 | — |
| 327 | Gemini 3.6 Flash | Google | US | 算力/智能体 | SR | 455 | → Gemini 3.7 Flash Lv39 |
| 328 | Gemini 3.7 Flash | Google | US | 算力/智能体 | SSR | 511 | ← Gemini 3.6 Flash |
| 329 | DiffusionGemma | Google | US | 开源/幻觉 | SR | 435 | — |
| 330 | Nano Banana Pro | Google | US | 视觉/创作 | SSR | 526 | — |
| 331 | Nano Banana 2 Lite | Google | US | 视觉/算力 | SR | 452 | — |
| 332 | Imagen 3 | Google | US | 视觉 | R | 368 | → Imagen 4 Lv30 |
| 333 | Imagen 4 | Google | US | 视觉/创作 | SR | 444 | ← Imagen 3 |
| 334 | Veo | Google | US | 影像 | R | 361 | → Veo 2 Lv28 |
| 335 | Veo 2 | Google | US | 影像/视觉 | SR | 438 | ← Veo |
| 336 | Gemini 2.5 Flash TTS | Google | US | 音律 | N | 285 | → Gemini 3.1 Flash TTS Lv22 |
| 337 | Gemini 3.1 Flash TTS | Google | US | 音律/对话 | R | 361 | ← Gemini 2.5 Flash TTS；→ Gemini 3.8 Flash TTS Lv29 |
| 338 | Gemini 3.8 Flash TTS | Google | US | 音律/对话 | SR | 438 | ← Gemini 3.1 Flash TTS |
| 339 | AlphaGo Zero | Google DeepMind | US | 推理/智能体 | SR | 455 | → AlphaZero Lv39 |
| 340 | AlphaZero | Google DeepMind | US | 推理/智能体 | SSR | 511 | ← AlphaGo Zero；→ MuZero Lv46 |
| 341 | MuZero | Google DeepMind | US | 推理/算力 | SSR | 523 | ← AlphaZero |
| 342 | DALL-E 2 | OpenAI | US | 视觉 | N | 285 | → DALL-E 3 Lv20 |
| 343 | DALL-E 3 | OpenAI | US | 视觉/创作 | R | 368 | ← DALL-E 2 |
| 344 | GPT Image 1.5 | OpenAI | US | 视觉/创作 | SR | 458 | → GPT Image 2 Lv37 |
| 345 | GPT Image 2 | OpenAI | US | 视觉/创作 | SSR | 523 | ← GPT Image 1.5；→ GPT Image 2.5 Flare Lv44 |
| 346 | GPT Image 2.5 Flare | OpenAI | US | 视觉/算力 | SSR | 531 | ← GPT Image 2 |
| 347 | Whisper large-v3 | OpenAI | US | 音律/开源 | N | 318 | → Whisper large-v3-turbo Lv23 |
| 348 | Whisper large-v3-turbo | OpenAI | US | 音律/开源 | R | 364 | ← Whisper large-v3 |
| 349 | gpt-realtime-2.1 | OpenAI | US | 音律/对话 | R | 379 | → GPT-Live-1 Lv30 |
| 350 | GPT-Live-1 | OpenAI | US | 音律/对话 | SR | 449 | ← gpt-realtime-2.1 |
| 351 | text-embedding-ada-002 | OpenAI | US | 检索/算力 | N | 277 | → text-embedding-3-small Lv18 |
| 352 | text-embedding-3-small | OpenAI | US | 检索/算力 | N | 310 | ← text-embedding-ada-002；→ text-embedding-3-large Lv25 |
| 353 | text-embedding-3-large | OpenAI | US | 检索/算力 | R | 364 | ← text-embedding-3-small |
| 354 | Grok Imagine Image | SpaceXAI (formerly xAI) | US | 视觉/幻觉 | R | 368 | → Grok Imagine Image 2.0 Lv31 |
| 355 | Grok Imagine Image 2.0 | SpaceXAI (formerly xAI) | US | 视觉/幻觉 | SR | 444 | ← Grok Imagine Image |
| 356 | Midjourney V1 | Midjourney | US | 视觉/幻觉 | N | 269 | → Midjourney V4 Lv20 |
| 357 | Midjourney V4 | Midjourney | US | 视觉/创作 | R | 364 | ← Midjourney V1 |
| 358 | Niji 6 | Midjourney | US | 视觉/创作 | R | 382 | → Niji 7 Lv30 |
| 359 | Niji 7 | Midjourney | US | 视觉/创作 | SR | 452 | ← Niji 6 |
| 360 | Midjourney Video V1 | Midjourney | US | 影像/视觉 | SR | 435 | — |
| 361 | Stable Audio | Stability AI | UK | 音律/开源 | N | 277 | → Stable Audio 2.0 Lv21 |
| 362 | Stable Audio 2.0 | Stability AI | UK | 音律/开源 | R | 357 | ← Stable Audio；→ Stable Audio 3.0 Lv28 |
| 363 | Stable Audio 3.0 | Stability AI | UK | 音律/开源 | SR | 438 | ← Stable Audio 2.0 |
| 364 | FLUX.1 Kontext | Black Forest Labs | DE | 视觉/开源 | SR | 449 | — |
| 365 | FLUX.2 Klein | Black Forest Labs | DE | 视觉/开源 | R | 375 | — |
| 366 | Runway Gen-1 | Runway | US | 影像 | N | 269 | → Runway Gen-2 Lv16 |
| 367 | Runway Gen-2 | Runway | US | 影像/视觉 | N | 310 | ← Runway Gen-1；→ Runway Gen-3 Alpha Lv23 |
| 368 | Runway Gen-3 Alpha | Runway | US | 影像/视觉 | R | 375 | ← Runway Gen-2 |
| 369 | Runway Aleph | Runway | US | 影像/创作 | SR | 444 | — |
| 370 | Suno v4 | Suno | US | 音律/创作 | R | 375 | → Suno v4.5 Lv32 |
| 371 | Suno v4.5 | Suno | US | 音律/创作 | SR | 444 | ← Suno v4；→ Suno v5.5 Lv39 |
| 372 | Suno v5.5 | Suno | US | 音律/创作 | SR | 463 | ← Suno v4.5 |
| 373 | Helix | Figure AI | US | 智能体/影像 | R | 375 | → Helix 02 Lv30 |
| 374 | Helix 02 | Figure AI | US | 智能体/影像 | SR | 449 | ← Helix |
| 375 | 通义千问 Qwen1.5 | Alibaba (Qwen) | CN | 开源/对话 | N | 277 | → 通义千问 Qwen2 Lv22 |
| 376 | 通义千问 Qwen2 | Alibaba (Qwen) | CN | 开源/对话 | R | 357 | ← 通义千问 Qwen1.5 |
| 377 | 通义千问 Qwen2.5-Max | Alibaba (Qwen) | CN | 对话/推理 | R | 375 | → 通义千问 Qwen3-Max Lv30 |
| 378 | 通义千问 Qwen3-Max | Alibaba (Qwen) | CN | 对话/推理 | SR | 449 | ← 通义千问 Qwen2.5-Max；→ 通义千问 Qwen3-Max-Thinking Lv40 |
| 379 | 通义千问 Qwen3-Max-Thinking | Alibaba (Qwen) | CN | 推理/对话 | SSR | 514 | ← 通义千问 Qwen3-Max |
| 380 | 通义千问 Qwen-Plus | Alibaba (Qwen) | CN | 对话/算力 | R | 357 | → 通义千问 Qwen3.5-Plus Lv29 |
| 381 | 通义千问 Qwen3.5-Plus | Alibaba (Qwen) | CN | 对话/算力 | SR | 444 | ← 通义千问 Qwen-Plus；→ 通义千问 Qwen3.7-Plus Lv36 |
| 382 | 通义千问 Qwen3.7-Plus | Alibaba (Qwen) | CN | 对话/算力 | SR | 466 | ← 通义千问 Qwen3.5-Plus |
| 383 | 通义千问 Qwen-VL | Alibaba (Qwen) | CN | 视觉/开源 | N | 285 | → 通义千问 Qwen2.5-VL Lv21 |
| 384 | 通义千问 Qwen2.5-VL | Alibaba (Qwen) | CN | 视觉/开源 | R | 379 | ← 通义千问 Qwen-VL；→ 通义千问 Qwen3-VL Lv29 |
| 385 | 通义千问 Qwen3-VL | Alibaba (Qwen) | CN | 视觉/开源 | SR | 447 | ← 通义千问 Qwen2.5-VL |
| 386 | QwQ-32B | Alibaba (Qwen) | CN | 推理/开源 | R | 389 | — |
| 387 | DeepSeek-V2 | DeepSeek | CN | 开源/算力 | N | 310 | → DeepSeek-V2.5 Lv22 |
| 388 | DeepSeek-V2.5 | DeepSeek | CN | 开源/算力 | R | 364 | ← DeepSeek-V2；→ DeepSeek-V3-0324 Lv29 |
| 389 | DeepSeek-V3-0324 | DeepSeek | CN | 开源/算力 | R | 393 | ← DeepSeek-V2.5 |
| 390 | DeepSeek-R1-0528 | DeepSeek | CN | 推理/开源 | SSR | 523 | — |
| 391 | DeepSeek-V4-Flash | DeepSeek | CN | 算力/开源 | SR | 452 | → DeepSeek-V4-Flash 0731 Lv31 |
| 392 | DeepSeek-V4-Flash 0731 | DeepSeek | CN | 算力/开源 | SR | 461 | ← DeepSeek-V4-Flash；→ DeepSeek-V4.1-Flash Lv38 |
| 393 | DeepSeek-V4.1-Flash | DeepSeek | CN | 算力/开源 | SSR | 514 | ← DeepSeek-V4-Flash 0731 |
| 394 | Kimi k1.5 | Moonshot AI | CN | 推理/智能体 | R | 375 | — |
| 395 | Kimi K2.7 Code | Moonshot AI | CN | 代码/智能体 | SR | 455 | → Kimi K2.8 Preview Lv28 |
| 396 | Kimi K2.8 Preview | Moonshot AI | CN | 代码/智能体 | SR | 466 | ← Kimi K2.7 Code |
| 397 | GLM-4 | Zhipu AI (Z.ai) | CN | 对话/开源 | R | 353 | → GLM-4.6 Lv20 |
| 398 | GLM-4.6 | Zhipu AI (Z.ai) | CN | 代码/智能体 | R | 386 | ← GLM-4；→ GLM-5.1 Lv31 |
| 399 | GLM-5.1 | Zhipu AI (Z.ai) | CN | 代码/开源 | SR | 458 | ← GLM-4.6 |
| 400 | GLM-4.5V | Zhipu AI (Z.ai) | CN | 视觉/开源 | R | 368 | → GLM-4.6V Lv22 |
| 401 | GLM-4.6V | Zhipu AI (Z.ai) | CN | 视觉/开源 | R | 382 | ← GLM-4.5V；→ GLM-5V-Turbo Lv31 |
| 402 | GLM-5V-Turbo | Zhipu AI (Z.ai) | CN | 视觉/算力 | SR | 447 | ← GLM-4.6V |
| 403 | MiniMax-01 | MiniMax | CN | 开源/对话 | R | 357 | → MiniMax-M1 Lv23 |
| 404 | MiniMax-M1 | MiniMax | CN | 推理/开源 | R | 382 | ← MiniMax-01；→ MiniMax-M2.5 Lv30 |
| 405 | MiniMax-M2.5 | MiniMax | CN | 代码/开源 | SR | 452 | ← MiniMax-M1 |
| 406 | MiniMax Speech 2.5 | MiniMax | CN | 音律 | R | 353 | → MiniMax Speech 2.6 Lv23 |
| 407 | MiniMax Speech 2.6 | MiniMax | CN | 音律/对话 | R | 368 | ← MiniMax Speech 2.5；→ MiniMax Speech 2.8 Lv30 |
| 408 | MiniMax Speech 2.8 | MiniMax | CN | 音律/对话 | SR | 435 | ← MiniMax Speech 2.6 |
| 409 | 豆包 Seed-1.6 | ByteDance Seed | CN | 对话/智能体 | R | 375 | → 豆包 Seed-1.8 Lv32 |
| 410 | 豆包 Seed-1.8 | ByteDance Seed | CN | 对话/智能体 | SR | 444 | ← 豆包 Seed-1.6；→ 豆包 Seed-2.0 Code Lv39 |
| 411 | 豆包 Seed-2.0 Code | ByteDance Seed | CN | 代码/智能体 | SR | 458 | ← 豆包 Seed-1.8 |
| 412 | 豆包 Seed-1.6 Flash | ByteDance Seed | CN | 算力/对话 | N | 301 | → 豆包 Seed-2.0 Lite Lv22 |
| 413 | 豆包 Seed-2.0 Lite | ByteDance Seed | CN | 算力/对话 | R | 361 | ← 豆包 Seed-1.6 Flash；→ 豆包 Seed-2.1 Turbo Lv29 |
| 414 | 豆包 Seed-2.1 Turbo | ByteDance Seed | CN | 算力/智能体 | R | 389 | ← 豆包 Seed-2.0 Lite |
| 415 | 混元 Large | Tencent Hunyuan | CN | 开源/算力 | R | 364 | → 混元 TurboS Lv22 |
| 416 | 混元 TurboS | Tencent Hunyuan | CN | 对话/算力 | R | 386 | ← 混元 Large；→ 混元 T1 Lv31 |
| 417 | 混元 T1 | Tencent Hunyuan | CN | 推理/对话 | SR | 449 | ← 混元 TurboS |
| 418 | 混元 3D 2.0 | Tencent Hunyuan | CN | 视觉/开源 | R | 375 | → 混元 3D 3.1 Lv28 |
| 419 | 混元 3D 3.1 | Tencent Hunyuan | CN | 视觉/开源 | SR | 449 | ← 混元 3D 2.0 |
| 420 | 混元世界 1.0 | Tencent Hunyuan | CN | 视觉/幻觉 | R | 368 | → 混元世界 1.5 Lv20 |
| 421 | 混元世界 1.5 | Tencent Hunyuan | CN | 视觉/幻觉 | R | 386 | ← 混元世界 1.0；→ HY-World 2.0 Lv30 |
| 422 | HY-World 2.0 | Tencent Hunyuan | CN | 视觉/幻觉 | SR | 449 | ← 混元世界 1.5 |
| 423 | 可灵 2.0 | Kuaishou (Kling AI) | CN | 影像/视觉 | R | 386 | → 可灵 2.5 Turbo Lv30 |
| 424 | 可灵 2.5 Turbo | Kuaishou (Kling AI) | CN | 影像/算力 | SR | 449 | ← 可灵 2.0；→ 可灵 2.6 Lv37 |
| 425 | 可灵 2.6 | Kuaishou (Kling AI) | CN | 影像/音律 | SR | 461 | ← 可灵 2.5 Turbo |
| 426 | MiMo-V2-Pro | Xiaomi | CN | 智能体/推理 | SR | 452 | → MiMo-V2.5-Pro Lv29 |
| 427 | MiMo-V2.5-Pro | Xiaomi | CN | 智能体/推理 | SR | 463 | ← MiMo-V2-Pro |
| 428 | 零一万物 Yi-34B | 01.AI | CN | 开源/对话 | N | 310 | → 零一万物 Yi-1.5 Lv23 |
| 429 | 零一万物 Yi-1.5 | 01.AI | CN | 开源/对话 | R | 364 | ← 零一万物 Yi-34B；→ 零一万物 Yi-Lightning Lv30 |
| 430 | 零一万物 Yi-Lightning | 01.AI | CN | 对话/算力 | R | 389 | ← 零一万物 Yi-1.5 |
| 431 | 书生 InternLM | Shanghai AI Laboratory | CN | 开源/推理 | N | 277 | → 书生 InternLM2.5 Lv23 |
| 432 | 书生 InternLM2.5 | Shanghai AI Laboratory | CN | 开源/推理 | R | 361 | ← 书生 InternLM；→ 书生 InternLM3 Lv30 |
| 433 | 书生 InternLM3 | Shanghai AI Laboratory | CN | 开源/推理 | R | 386 | ← 书生 InternLM2.5 |
| 434 | 文心 X1 | Baidu | CN | 推理/检索 | R | 379 | → 文心 X1.1 Lv32 |
| 435 | 文心 X1.1 | Baidu | CN | 推理/检索 | SR | 441 | ← 文心 X1 |
| 436 | 阶跃 Step-2 | StepFun | CN | 算力/对话 | R | 357 | → 阶跃 Step 3 Lv20 |
| 437 | 阶跃 Step 3 | StepFun | CN | 算力/智能体 | R | 382 | ← 阶跃 Step-2 |
| 438 | Command R+ | Cohere | CA | 对话/检索 | R | 364 | → Command A Lv21 |
| 439 | Command A | Cohere | CA | 对话/检索 | R | 386 | ← Command R+；→ Command A+ Lv30 |
| 440 | Command A+ | Cohere | CA | 对话/检索 | SR | 447 | ← Command A |
| 441 | Sonar | Perplexity AI | US | 检索/对话 | R | 368 | → Sonar Pro Lv31 |
| 442 | Sonar Pro | Perplexity AI | US | 检索/对话 | SR | 441 | ← Sonar；→ Sonar Pro Search Lv38 |
| 443 | Sonar Pro Search | Perplexity AI | US | 检索/智能体 | SR | 452 | ← Sonar Pro |
| 444 | Llama-3.1-Nemotron-70B | NVIDIA | US | 开源/算力 | R | 364 | → Llama-3.3-Nemotron-Super-49B Lv24 |
| 445 | Llama-3.3-Nemotron-Super-49B | NVIDIA | US | 开源/算力 | R | 386 | ← Llama-3.1-Nemotron-70B；→ Llama-3.1-Nemotron-Ultra-253B Lv31 |
| 446 | Llama-3.1-Nemotron-Ultra-253B | NVIDIA | US | 开源/推理 | SR | 452 | ← Llama-3.3-Nemotron-Super-49B |
| 447 | Hermes 3 405B | Nous Research | US | 开源/对话 | R | 375 | → Hermes 4 405B Lv31 |
| 448 | Hermes 4 405B | Nous Research | US | 开源/推理 | SR | 447 | ← Hermes 3 405B |
