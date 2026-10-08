# 智灵口袋 · 图鉴总表

> 由 `python3 tools/data/build_species.py` 根据 `docs/research/roster-final.json` + `tools/data/species_rules.json` 生成，勿手改。

共 310 只，159 个家族；3 只初始伙伴。

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
| N | 普通 | 24 | 240–330 | 150–255 |
| R | 稀有 | 81 | 330–420 | 90–190 |
| SR | 超稀有 | 106 | 420–490 | 45–120 |
| SSR | 史诗 | 69 | 490–550 | 25–60 |
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
| 42 | Gemini 3.8 Live | Google | US | 音律/对话 | SSR | 535 | — |
| 43 | Gemini 1.5 Pro | Google | US | 检索/视觉 | R | 366 | → Gemini 2.5 Pro Lv26 |
| 44 | Gemini 2.5 Pro | Google | US | 推理/代码 | SR | 440 | ← Gemini 1.5 Pro；→ Gemini 3.1 Pro Preview Lv40 |
| 45 | Gemini 3.1 Pro Preview | Google | US | 推理/视觉 | SR | 470 | ← Gemini 2.5 Pro |
| 46 | Gemma 3 | Google | US | 开源/视觉 | R | 372 | → Gemma 4 Lv30 |
| 47 | Gemma 4 | Google | US | 开源/视觉 | SR | 470 | ← Gemma 3 |
| 48 | Nano Banana 纳米香蕉 | Google | US | 视觉 | SR | 485 | → Nano Banana 2 Lv34 |
| 49 | Nano Banana 2 | Google | US | 视觉/算力 | SSR | 535 | ← Nano Banana 纳米香蕉；→ Nano Banana 2.1 Lv46 |
| 50 | Nano Banana 2.1 | Google | US | 视觉/算力 | SSR | 548 | ← Nano Banana 2 |
| 51 | Veo 3 | Google | US | 影像/音律 | SR | 480 | → Veo 3.1 Lv26 |
| 52 | Veo 3.1 | Google | US | 影像/音律 | SR | 488 | ← Veo 3；→ Gemini Omni 1.1 Flash Lv40 |
| 53 | Gemini Omni 1.1 Flash | Google | US | 影像/视觉 | SSR | 545 | ← Veo 3.1 |
| 54 | Lyria 2 | Google | US | 音律 | R | 385 | → Lyria 3 Lv22 |
| 55 | Lyria 3 | Google | US | 音律/创作 | SR | 452 | ← Lyria 2；→ Lyria 3.5 Lv38 |
| 56 | Lyria 3.5 | Google | US | 音律/创作 | SR | 470 | ← Lyria 3 |
| 57 | Genie 3 精灵世界 | Google | US | 影像/智能体 | UR | 600 | — |
| 58 | NotebookLM | Google | US | 检索/创作 | SSR | 545 | — |
| 59 | Gemini CLI | Google | US | 代码/智能体 | R | 395 | → Google Antigravity 反重力 Lv30 |
| 60 | Google Antigravity 反重力 | Google | US | 代码/智能体 | SSR | 545 | ← Gemini CLI |
| 61 | Gemini Robotics 2 | Google | US | 智能体/影像 | SSR | 530 | — |
| 62 | 阿尔法（AlphaGo / AlphaFold） | Google DeepMind | UK | 推理/检索 | MYTHIC | 665 | — |
| 63 | Grok-1 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | N | 267 | → Grok 4 Lv24 |
| 64 | Grok 4 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 464 | ← Grok-1；→ Grok 4.7 Lv44 |
| 65 | Grok 4.7 | SpaceXAI (formerly xAI) | US | 推理/代码 | UR | 583 | ← Grok 4 |
| 66 | Ani（Grok 陪伴） | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 400 | — |
| 67 | Grok Imagine | SpaceXAI (formerly xAI) | US | 影像/音律 | SSR | 545 | — |
| 68 | LLaMA 初代 | Meta | US | 开源 | N | 260 | → Llama 3.1 405B Lv20 |
| 69 | Llama 3.1 405B | Meta | US | 开源/推理 | R | 367 | ← LLaMA 初代；→ Llama 4（Scout / Maverick） Lv38 |
| 70 | Llama 4（Scout / Maverick） | Meta | US | 开源/幻觉 | R | 385 | ← Llama 3.1 405B |
| 71 | Muse Spark 1.1 | Meta | US | 推理/视觉 | SR | 449 | → Muse Spark 1.2 Lv30 |
| 72 | Muse Spark 1.2 | Meta | US | 推理/视觉 | SR | 461 | ← Muse Spark 1.1；→ Muse Spark 灵感火花 Lv47 |
| 73 | Muse Spark 灵感火花 | Meta | US | 推理/视觉 | UR | 592 | ← Muse Spark 1.2 |
| 74 | Meta Muse 个人智能体 | Meta | US | 智能体/对话 | SSR | 545 | — |
| 75 | Moltbook 智能体论坛 | Meta (acquired) | US | 幻觉/对话 | R | 387 | — |
| 76 | Mistral 7B | Mistral AI | FR | 开源/算力 | N | 265 | → Mixtral 8x7B Lv18 |
| 77 | Mixtral 8x7B | Mistral AI | FR | 开源/算力 | R | 350 | ← Mistral 7B；→ Mistral Medium 3.5 Lv34 |
| 78 | Mistral Medium 3.5 | Mistral AI | FR | 开源/代码 | R | 400 | ← Mixtral 8x7B |
| 79 | Phi-3 | Microsoft | US | 推理 | N | 300 | → Phi-4 Lv22 |
| 80 | Phi-4 | Microsoft | US | 推理/算力 | R | 362 | ← Phi-3；→ Phi-4-reasoning Lv38 |
| 81 | Phi-4-reasoning | Microsoft | US | 推理/开源 | SR | 438 | ← Phi-4 |
| 82 | MAI-1-preview | Microsoft | US | 对话/算力 | R | 368 | → MAI-Thinking-1 Lv30 |
| 83 | MAI-Thinking-1 | Microsoft | US | 推理/代码 | SR | 478 | ← MAI-1-preview |
| 84 | MAI-Image-1 | Microsoft | US | 视觉 | R | 375 | → MAI-Image-2 Lv32 |
| 85 | MAI-Image-2 | Microsoft | US | 视觉/创作 | SR | 449 | ← MAI-Image-1；→ MAI-Image-2.6 Lv39 |
| 86 | MAI-Image-2.6 | Microsoft | US | 视觉/检索 | SSR | 530 | ← MAI-Image-2 |
| 87 | GitHub Copilot | GitHub (Microsoft) | US | 代码/智能体 | SSR | 545 | — |
| 88 | Amazon Kiro | Amazon (AWS) | US | 代码/幻觉 | SR | 470 | — |
| 89 | Nemotron 3 Super | NVIDIA | US | 开源/算力 | SR | 440 | → Nemotron 3 Ultra Lv34 |
| 90 | Nemotron 3 Ultra | NVIDIA | US | 开源/算力 | SR | 478 | ← Nemotron 3 Super |
| 91 | Apple 智能（基础模型 3） | Apple | US | 对话/对齐 | SR | 462 | — |
| 92 | Sakana Fugu 河豚 | Sakana AI | JP | 智能体/推理 | SR | 485 | — |
| 93 | Solar Pro 4 | Upstage | KR | 智能体/检索 | R | 388 | — |
| 94 | Inkling 灵念 | Thinking Machines Lab | US | 开源/视觉 | SR | 480 | — |
| 95 | Midjourney V5 | Midjourney | US | 视觉 | R | 373 | → Midjourney V7 Lv24 |
| 96 | Midjourney V7 | Midjourney | US | 视觉/创作 | SR | 476 | ← Midjourney V5；→ Midjourney V8 Lv42 |
| 97 | Midjourney V8 | Midjourney | US | 视觉/创作 | SSR | 542 | ← Midjourney V7 |
| 98 | Stable Diffusion 1.x | Stability AI | UK | 视觉/开源 | N | 270 | → SDXL Lv20 |
| 99 | SDXL | Stability AI | UK | 视觉/开源 | R | 352 | ← Stable Diffusion 1.x；→ Stable Diffusion 3.5 Lv34 |
| 100 | Stable Diffusion 3.5 | Stability AI | UK | 视觉/开源 | SR | 440 | ← SDXL |
| 101 | FLUX.1 | Black Forest Labs | DE | 视觉/开源 | R | 390 | → FLUX.2 Lv24 |
| 102 | FLUX.2 | Black Forest Labs | DE | 视觉/开源 | SR | 470 | ← FLUX.1；→ FLUX 3 Lv40 |
| 103 | FLUX 3 | Black Forest Labs | DE | 影像/视觉 | SSR | 545 | ← FLUX.2 |
| 104 | Runway Gen-4 | Runway | US | 影像/创作 | SR | 438 | → Runway Gen-4.5 Lv30 |
| 105 | Runway Gen-4.5 | Runway | US | 影像/创作 | SR | 468 | ← Runway Gen-4 |
| 106 | Luma Ray3 | Luma AI | US | 影像/视觉 | SR | 465 | — |
| 107 | Suno v3 | Suno | US | 音律/创作 | R | 379 | → Suno v5 Lv24 |
| 108 | Suno v5 | Suno | US | 音律/创作 | SR | 485 | ← Suno v3；→ Suno v6 Lv44 |
| 109 | Suno v6 | Suno | US | 音律/创作 | UR | 615 | ← Suno v5 |
| 110 | ElevenLabs 多语言 v2 | ElevenLabs | US | 音律/对话 | R | 415 | → Eleven v3 Lv26 |
| 111 | Eleven v3 | ElevenLabs | US | 音律/对话 | SR | 478 | ← ElevenLabs 多语言 v2；→ Eleven v4 Lv42 |
| 112 | Eleven v4 | ElevenLabs | US | 音律/对话 | UR | 572 | ← Eleven v3 |
| 113 | Marble 世界大理石 | World Labs | US | 视觉/影像 | SSR | 537 | — |
| 114 | Cursor | Anysphere (SpaceX / SpaceXAI) | US | 代码/智能体 | UR | 608 | — |
| 115 | Windsurf 风帆 | Codeium -> Cognition | US | 代码/智能体 | SR | 472 | — |
| 116 | Devin（AI 软件工程师） | Cognition | US | 智能体/代码 | SSR | 545 | — |
| 117 | Replit Agent | Replit | US | 代码/智能体 | SR | 485 | — |
| 118 | Lovable | Lovable | SE | 代码/创作 | SSR | 539 | — |
| 119 | OpenCode | Anomaly (formerly SST) | US | 开源/代码 | SSR | 544 | — |
| 120 | Manus | Butterfly Effect (Meta deal being unwound) | SG | 智能体 | SR | 485 | → Manus 2.0（Manus Studio） Lv32 |
| 121 | Manus 2.0（Manus Studio） | Butterfly Effect (Meta deal being unwound) | SG | 智能体/算力 | SSR | 545 | ← Manus |
| 122 | Perplexity | Perplexity AI | US | 检索 | SR | 470 | → Comet 彗星浏览器 Lv28 |
| 123 | Comet 彗星浏览器 | Perplexity AI | US | 检索/智能体 | SR | 488 | ← Perplexity；→ Perplexity Computer Lv40 |
| 124 | Perplexity Computer | Perplexity AI | US | 检索/智能体 | SSR | 542 | ← Comet 彗星浏览器 |
| 125 | Character.AI | Character Technologies | US | 对话/创作 | R | 415 | — |
| 126 | Neuro-sama（牛肉） | Vedal (independent) | UK | 对话/幻觉 | SR | 470 | — |
| 127 | Clawdbot | Peter Steinberger (community) | AT | 智能体/开源 | R | 415 | → Moltbot（蜕壳期） Lv18 |
| 128 | Moltbot（蜕壳期） | Peter Steinberger (community) | AT | 智能体/开源 | SR | 480 | ← Clawdbot；→ OpenClaw 小龙虾 Lv36 |
| 129 | OpenClaw 小龙虾 | OpenClaw Foundation | AT | 智能体/开源 | UR | 607 | ← Moltbot（蜕壳期） |
| 130 | Hermes Agent 爱马仕智能体 | Nous Research | US | 智能体/开源 | SSR | 545 | — |
| 131 | AutoGPT | Significant Gravitas | UK | 智能体/幻觉 | R | 391 | — |
| 132 | LangChain | LangChain | US | 智能体/开源 | SR | 485 | → LangGraph Lv32 |
| 133 | LangGraph | LangChain | US | 智能体/开源 | SSR | 520 | ← LangChain |
| 134 | Figure 03 | Figure AI | US | 智能体/视觉 | SSR | 545 | — |
| 135 | 特斯拉 Optimus | Tesla | US | 智能体/算力 | SR | 485 | — |
| 136 | π0.7 物理智能 | Physical Intelligence | US | 智能体/开源 | SSR | 530 | — |
| 137 | AGI 奇点 | Unknown (all labs) | INTL | 推理/对齐 | MYTHIC | 715 | — |
| 138 | DeepSeek-V3 | DeepSeek | CN | 算力 | R | 340 | → DeepSeek-R1 深度思考 Lv16 |
| 139 | DeepSeek-R1 深度思考 | DeepSeek | CN | 推理/开源 | SSR | 512 | ← DeepSeek-V3；→ DeepSeek-V4 / V4.1 Lv36 |
| 140 | DeepSeek-V4 / V4.1 | DeepSeek | CN | 开源/推理 | UR | 585 | ← DeepSeek-R1 深度思考 |
| 141 | DeepSeek Harness 虎鲸 | DeepSeek | CN | 智能体/开源 | SSR | 531 | — |
| 142 | 通义千问 1.0 | Alibaba | CN | 对话/开源 | N | 247 | → 通义千问 2.5 Lv18 |
| 143 | 通义千问 2.5 | Alibaba | CN | 开源 | R | 352 | ← 通义千问 1.0；→ 通义千问 3.8-Max Lv38 |
| 144 | 通义千问 3.8-Max | Alibaba | CN | 推理/智能体 | UR | 564 | ← 通义千问 2.5 |
| 145 | Qwen3.8-Flash-Next | Alibaba | CN | 算力/开源 | SSR | 521 | — |
| 146 | 千问 App | Alibaba | CN | 对话/智能体 | SSR | 545 | — |
| 147 | 千问图像 3.1 | Alibaba (Qwen) | CN | 视觉/创作 | SR | 488 | — |
| 148 | 千问语音 3.1 | Alibaba (Qwen) | CN | 音律/对话 | SSR | 540 | — |
| 149 | 通义万相 2.1 | Alibaba (Tongyi) | CN | 影像/开源 | R | 388 | → 通义万相 2.2 Lv24 |
| 150 | 通义万相 2.2 | Alibaba (Tongyi) | CN | 影像/开源 | SR | 455 | ← 通义万相 2.1；→ 通义万相 3.0 Lv42 |
| 151 | 通义万相 3.0 | Alibaba (Tongyi) | CN | 影像/音律 | UR | 610 | ← 通义万相 2.2 |
| 152 | 快乐小马 HappyHorse | Alibaba ATH (Taotian Future Life Lab) | CN | 影像/算力 | SR | 478 | — |
| 153 | 快乐生蚝 HappyOyster | Alibaba ATH | CN | 影像/智能体 | SR | 475 | — |
| 154 | 快乐虾米 HappyShrimp | Alibaba ATH | CN | 音律/创作 | SR | 465 | — |
| 155 | Qoder | Alibaba | CN | 代码/智能体 | SR | 485 | — |
| 156 | Kimi 智能助手 | Moonshot AI | CN | 对话/检索 | R | 357 | → Kimi K2 Lv24 |
| 157 | Kimi K2 | Moonshot AI | CN | 智能体/开源 | SR | 448 | ← Kimi 智能助手；→ Kimi K3 Lv44 |
| 158 | Kimi K3 | Moonshot AI | CN | 开源/智能体 | UR | 570 | ← Kimi K2 |
| 159 | Kimi Work | Moonshot AI | CN | 智能体 | SSR | 539 | — |
| 160 | ChatGLM-6B | Zhipu AI (Z.ai) | CN | 对话/开源 | N | 255 | → GLM-4.5 Lv22 |
| 161 | GLM-4.5 | Zhipu AI (Z.ai) | CN | 智能体/开源 | SR | 442 | ← ChatGLM-6B；→ GLM-5.3 Lv42 |
| 162 | GLM-5.3 | Zhipu AI (Z.ai) | CN | 代码/开源 | UR | 565 | ← GLM-4.5 |
| 163 | AutoGLM | Zhipu AI (Z.ai) | CN | 智能体/视觉 | SR | 484 | — |
| 164 | 豆包大模型 Pro | ByteDance | CN | 对话/算力 | N | 278 | → 豆包 Seed 2.0 Lv20 |
| 165 | 豆包 Seed 2.0 | ByteDance | CN | 智能体/算力 | SR | 469 | ← 豆包大模型 Pro；→ 豆包 Seed 2.1 Pro Lv42 |
| 166 | 豆包 Seed 2.1 Pro | ByteDance | CN | 智能体/视觉 | SSR | 526 | ← 豆包 Seed 2.0 |
| 167 | 豆包 | ByteDance | CN | 对话/音律 | UR | 590 | — |
| 168 | 即梦 Seedream 3.0 | ByteDance Seed | CN | 视觉/创作 | R | 407 | → 即梦 Seedream 4.0 Lv22 |
| 169 | 即梦 Seedream 4.0 | ByteDance Seed | CN | 视觉/创作 | SR | 458 | ← 即梦 Seedream 3.0；→ 即梦 Seedream 5.0 Lv38 |
| 170 | 即梦 Seedream 5.0 | ByteDance Seed | CN | 视觉/推理 | SSR | 505 | ← 即梦 Seedream 4.0 |
| 171 | 即梦 Seedance 1.0 | ByteDance Seed | CN | 影像 | SR | 462 | → 即梦 Seedance 2.0 Lv26 |
| 172 | 即梦 Seedance 2.0 | ByteDance Seed | CN | 影像/幻觉 | SSR | 545 | ← 即梦 Seedance 1.0；→ 即梦 Seedance 2.5 Lv46 |
| 173 | 即梦 Seedance 2.5 | ByteDance Seed | CN | 影像/音律 | UR | 612 | ← 即梦 Seedance 2.0 |
| 174 | Trae | ByteDance | CN | 代码/智能体 | SR | 485 | — |
| 175 | 扣子 Coze | ByteDance | CN | 智能体/创作 | SSR | 537 | — |
| 176 | 腾讯混元 | Tencent | CN | 对话 | N | 251 | → 混元 Hy3 Lv24 |
| 177 | 混元 Hy3 | Tencent | CN | 推理/开源 | SR | 456 | ← 腾讯混元；→ 混元 Hy4 Preview Lv44 |
| 178 | 混元 Hy4 Preview | Tencent | CN | 智能体/开源 | SSR | 525 | ← 混元 Hy3 |
| 179 | 腾讯元宝 | Tencent | CN | 对话/检索 | SSR | 528 | — |
| 180 | 混元生图 3.0 | Tencent Hunyuan | CN | 视觉/开源 | SR | 450 | → 混元生图 3.5（预览） Lv30 |
| 181 | 混元生图 3.5（预览） | Tencent Hunyuan | CN | 视觉/开源 | SR | 476 | ← 混元生图 3.0 |
| 182 | WorkBuddy | Tencent | CN | 智能体/对话 | SSR | 538 | — |
| 183 | 文心一言 3.5 | Baidu | CN | 对话/检索 | N | 265 | → 文心 4.5 Lv22 |
| 184 | 文心 4.5 | Baidu | CN | 视觉/开源 | R | 362 | ← 文心一言 3.5；→ 文心 5.1 Preview Lv40 |
| 185 | 文心 5.1 Preview | Baidu | CN | 对话/算力 | SR | 466 | ← 文心 4.5 |
| 186 | 阶跃 Step 3.5 Flash | StepFun | CN | 算力/开源 | R | 374 | → 阶跃 Step 3.7 Flash Lv24 |
| 187 | 阶跃 Step 3.7 Flash | StepFun | CN | 算力/开源 | SR | 452 | ← 阶跃 Step 3.5 Flash；→ 阶跃 Step 5 Preview Lv40 |
| 188 | 阶跃 Step 5 Preview | StepFun | CN | 智能体/视觉 | SSR | 542 | ← 阶跃 Step 3.7 Flash |
| 189 | 讯飞星火 V4.0 | iFlytek | CN | 音律/对话 | N | 266 | → 讯飞星火 X2.5 Lv28 |
| 190 | 讯飞星火 X2.5 | iFlytek | CN | 推理/算力 | R | 390 | ← 讯飞星火 V4.0 |
| 191 | 商汤日日新 6.7 Flash-Lite | SenseTime | CN | 视觉/创作 | R | 370 | — |
| 192 | 百川 2 | Baichuan AI | CN | 对话/开源 | N | 249 | → 百川 M3 Lv26 |
| 193 | 百川 M3 | Baichuan AI | CN | 对齐/检索 | R | 385 | ← 百川 2 |
| 194 | 小米 MiMo-7B | Xiaomi | CN | 推理/开源 | N | 268 | → MiMo-V2-Flash Lv22 |
| 195 | MiMo-V2-Flash | Xiaomi | CN | 算力/开源 | SR | 434 | ← 小米 MiMo-7B；→ MiMo-V2.6-Pro Lv44 |
| 196 | MiMo-V2.6-Pro | Xiaomi | CN | 开源/推理 | UR | 580 | ← MiMo-V2-Flash |
| 197 | 美团 LongCat-Flash | Meituan | CN | 算力/智能体 | R | 379 | → 美团 LongCat 2.0 Lv24 |
| 198 | 美团 LongCat 2.0 | Meituan | CN | 智能体/算力 | SR | 435 | ← 美团 LongCat-Flash；→ 美团龙猫 LongCat-2.5 Lv40 |
| 199 | 美团龙猫 LongCat-2.5 | Meituan | CN | 智能体/视觉 | SR | 460 | ← 美团 LongCat 2.0 |
| 200 | 蚂蚁百灵 Ling 3.0 / Ring 2.6 | Ant Group | CN | 推理/开源 | R | 371 | — |
| 201 | 蚂蚁阿福 | Ant Group | CN | 对话/对齐 | SSR | 520 | — |
| 202 | 可灵 1.0 | Kuaishou (Kling AI) | CN | 影像 | R | 351 | → 可灵 3.0 Lv28 |
| 203 | 可灵 3.0 | Kuaishou (Kling AI) | CN | 影像/音律 | SSR | 530 | ← 可灵 1.0；→ 可灵 4.0 Lv48 |
| 204 | 可灵 4.0 | Kling AI (Kuaishou spin-off) | CN | 影像/视觉 | SSR | 548 | ← 可灵 3.0 |
| 205 | 书生 Intern-S2 | Shanghai AI Laboratory | CN | 检索/推理 | R | 381 | — |
| 206 | 天工 Mureka V9 | Kunlun Tech (Skywork AI) | CN | 音律/创作 | SR | 482 | — |
| 207 | 天工 SkyReels V4 | Skywork AI (Kunlun Tech) | CN | 影像/创作 | SR | 488 | — |
| 208 | 华为盘古 5.5 | Huawei | CN | 对齐/算力 | N | 296 | → 华为 openPangu 2.0 Pro Lv30 |
| 209 | 华为 openPangu 2.0 Pro | Huawei | CN | 开源/算力 | R | 379 | ← 华为盘古 5.5 |
| 210 | 面壁 MiniCPM | ModelBest | CN | 算力/开源 | R | 354 | — |
| 211 | 生数 Vidu | ShengShu Technology | CN | 影像 | R | 352 | → 生数 Vidu Q3 Lv30 |
| 212 | 生数 Vidu Q3 | ShengShu Technology | CN | 影像/创作 | SR | 477 | ← 生数 Vidu |
| 213 | 拍我AI PixVerse V6 | PixVerse (爱诗科技) | CN | 影像/智能体 | SR | 479 | — |
| 214 | MiniMax abab6.5 | MiniMax | CN | 对话/创作 | N | 260 | → MiniMax-M2 Lv24 |
| 215 | MiniMax-M2 | MiniMax | CN | 代码/开源 | R | 380 | ← MiniMax abab6.5；→ MiniMax-M3 Lv40 |
| 216 | MiniMax-M3 | MiniMax | CN | 代码/视觉 | SR | 461 | ← MiniMax-M2 |
| 217 | 海螺 Video-01 | MiniMax | CN | 影像 | R | 358 | → 海螺 02 Lv24 |
| 218 | 海螺 02 | MiniMax | CN | 影像 | SR | 455 | ← 海螺 Video-01；→ 海螺 H3 Lv40 |
| 219 | 海螺 H3 | MiniMax | CN | 影像/开源 | UR | 565 | ← 海螺 02 |
| 220 | MiniMax 音乐 3.0 | MiniMax | CN | 音律/创作 | SR | 485 | — |
| 221 | Tripo H3.1 | VAST (Tripo AI) | CN | 视觉/算力 | SR | 485 | — |
| 222 | 宇树 G1/H2 | Unitree Robotics | CN | 智能体/算力 | SSR | 543 | → 宇树 GD01 载人机甲 Lv50 |
| 223 | 宇树 GD01 载人机甲 | Unitree Robotics | CN | 算力/智能体 | UR | 570 | ← 宇树 G1/H2 |
| 224 | 智元机器人 | AgiBot | CN | 智能体/视觉 | SSR | 541 | — |
| 225 | o3-mini | OpenAI | US | 推理 | R | 368 | → o3 Lv20 |
| 226 | o3 | OpenAI | US | 推理/代码 | SR | 448 | ← o3-mini；→ o3-pro Lv40 |
| 227 | o3-pro | OpenAI | US | 推理/算力 | SR | 486 | ← o3 |
| 228 | Claude Opus 4 | Anthropic | US | 代码/对齐 | R | 400 | → Claude Opus 4.5 Lv22 |
| 229 | Claude Opus 4.5 | Anthropic | US | 代码/对齐 | SR | 458 | ← Claude Opus 4；→ Claude Opus 4.7 Lv40 |
| 230 | Claude Opus 4.7 | Anthropic | US | 代码/推理 | SSR | 515 | ← Claude Opus 4.5 |
| 231 | Claude Sonnet 4.5 | Anthropic | US | 代码/创作 | SR | 450 | → Claude Sonnet 5 Lv34 |
| 232 | Claude Sonnet 5 | Anthropic | US | 代码/创作 | SSR | 530 | ← Claude Sonnet 4.5 |
| 233 | Claude 3 Haiku | Anthropic | US | 代码 | N | 295 | → Claude 3.5 Haiku Lv18 |
| 234 | Claude 3.5 Haiku | Anthropic | US | 代码 | R | 372 | ← Claude 3 Haiku；→ Claude Haiku 5.5 Lv34 |
| 235 | Claude Haiku 5.5 | Anthropic | US | 代码/智能体 | SR | 440 | ← Claude 3.5 Haiku |
| 236 | Gemini 2.5 Flash | Google | US | 算力 | R | 398 | → Gemini 3 Flash Lv24 |
| 237 | Gemini 3 Flash | Google | US | 算力/对话 | SR | 462 | ← Gemini 2.5 Flash；→ Gemini 3.5 Flash Lv40 |
| 238 | Gemini 3.5 Flash | Google | US | 算力/智能体 | SSR | 520 | ← Gemini 3 Flash |
| 239 | Grok Build | SpaceXAI (formerly xAI) | US | 代码/智能体 | SR | 462 | — |
| 240 | Grok 4.20 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 470 | → Grok 4.5 Lv36 |
| 241 | Grok 4.5 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SSR | 525 | ← Grok 4.20 |
| 242 | Muse Image | Meta | US | 视觉/创作 | SR | 470 | — |
| 243 | Mistral Large 2 | Mistral AI | FR | 开源/对话 | R | 339 | → Mistral Large 3 Lv22 |
| 244 | Mistral Large 3 | Mistral AI | FR | 开源/推理 | R | 398 | ← Mistral Large 2；→ Mistral Large 4 Lv32 |
| 245 | Mistral Large 4 | Mistral AI | FR | 开源/推理 | SR | 460 | ← Mistral Large 3 |
| 246 | Devstral Small | Mistral AI | FR | 代码/开源 | R | 353 | → Devstral Medium Lv21 |
| 247 | Devstral Medium | Mistral AI | FR | 代码/开源 | R | 389 | ← Devstral Small；→ Devstral 2 Lv28 |
| 248 | Devstral 2 | Mistral AI | FR | 代码/开源 | SR | 440 | ← Devstral Medium |
| 249 | DeepSeek-V3.1 | DeepSeek | CN | 算力/推理 | R | 372 | → DeepSeek-V3.2 Lv22 |
| 250 | DeepSeek-V3.2 | DeepSeek | CN | 算力/推理 | SR | 450 | ← DeepSeek-V3.1；→ DeepSeek-V3.2-Speciale Lv38 |
| 251 | DeepSeek-V3.2-Speciale | DeepSeek | CN | 推理/开源 | SSR | 508 | ← DeepSeek-V3.2 |
| 252 | DeepSeek 应用 | DeepSeek | CN | 对话/检索 | SSR | 530 | — |
| 253 | 通义千问 Qwen3 | Alibaba | CN | 开源/对话 | R | 378 | → 通义千问 Qwen3.5 Lv24 |
| 254 | 通义千问 Qwen3.5 | Alibaba | CN | 开源/视觉 | SR | 452 | ← 通义千问 Qwen3；→ 通义千问 Qwen3.7-Max Lv40 |
| 255 | 通义千问 Qwen3.7-Max | Alibaba | CN | 开源/推理 | SSR | 520 | ← 通义千问 Qwen3.5 |
| 256 | Qwen3-Coder | Alibaba | CN | 代码/开源 | SR | 440 | → Qwen3-Coder-Next Lv32 |
| 257 | Qwen3-Coder-Next | Alibaba | CN | 代码/智能体 | SSR | 502 | ← Qwen3-Coder |
| 258 | Kimi K2 Thinking | Moonshot AI | CN | 推理/智能体 | SR | 430 | → Kimi K2.5 Lv26 |
| 259 | Kimi K2.5 | Moonshot AI | CN | 智能体/视觉 | SR | 470 | ← Kimi K2 Thinking；→ Kimi K2.6 Lv40 |
| 260 | Kimi K2.6 | Moonshot AI | CN | 智能体/代码 | SSR | 515 | ← Kimi K2.5 |
| 261 | GLM-4.7 | Zhipu AI (Z.ai) | CN | 智能体/代码 | SR | 438 | → GLM-5 Lv26 |
| 262 | GLM-5 | Zhipu AI (Z.ai) | CN | 代码/开源 | SR | 478 | ← GLM-4.7；→ GLM-5.2 Lv40 |
| 263 | GLM-5.2 | Zhipu AI (Z.ai) | CN | 代码/开源 | SSR | 530 | ← GLM-5 |
| 264 | MiniMax-M2.1 | MiniMax | CN | 代码/开源 | R | 395 | → MiniMax-M2.7 Lv30 |
| 265 | MiniMax-M2.7 | MiniMax | CN | 代码/开源 | SR | 455 | ← MiniMax-M2.1 |
| 266 | GPT-4 Turbo | OpenAI | US | 对话/算力 | R | 361 | → GPT-4.1 Lv31 |
| 267 | GPT-4.1 | OpenAI | US | 代码/对话 | SR | 441 | ← GPT-4 Turbo |
| 268 | GPT-5.1 | OpenAI | US | 推理/对话 | SSR | 520 | → GPT-5.2 Lv37 |
| 269 | GPT-5.2 | OpenAI | US | 推理/算力 | SSR | 529 | ← GPT-5.1 |
| 270 | GPT-4o mini | OpenAI | US | 对话 | N | 285 | → GPT-5 mini Lv22 |
| 271 | GPT-5 mini | OpenAI | US | 对话/算力 | R | 371 | ← GPT-4o mini；→ GPT-5.4 mini Lv29 |
| 272 | GPT-5.4 mini | OpenAI | US | 对话/智能体 | SR | 448 | ← GPT-5 mini |
| 273 | GPT-4.1 nano | OpenAI | US | 算力 | N | 260 | → GPT-5 nano Lv18 |
| 274 | GPT-5 nano | OpenAI | US | 算力/对话 | N | 301 | ← GPT-4.1 nano；→ GPT-5.4 nano Lv25 |
| 275 | GPT-5.4 nano | OpenAI | US | 算力/智能体 | R | 357 | ← GPT-5 nano |
| 276 | GPT-5-Codex | OpenAI | US | 代码/智能体 | SR | 458 | → GPT-5.1-Codex-Max Lv37 |
| 277 | GPT-5.1-Codex-Max | OpenAI | US | 代码/智能体 | SSR | 517 | ← GPT-5-Codex；→ GPT-5.2-Codex Lv44 |
| 278 | GPT-5.2-Codex | OpenAI | US | 代码/推理 | SSR | 526 | ← GPT-5.1-Codex-Max |
| 279 | o4-mini | OpenAI | US | 推理/算力 | R | 386 | — |
| 280 | gpt-oss-20b | OpenAI | US | 开源/算力 | R | 364 | → gpt-oss-safeguard-20b Lv22 |
| 281 | gpt-oss-safeguard-20b | OpenAI | US | 开源/对齐 | R | 375 | ← gpt-oss-20b |
| 282 | GPT-5.6 Terra | OpenAI | US | 推理/创作 | SR | 463 | — |
| 283 | Claude 1 | Anthropic | US | 对话/对齐 | N | 252 | → Claude 2 Lv22 |
| 284 | Claude 2 | Anthropic | US | 对话/创作 | R | 339 | ← Claude 1；→ Claude 3 Sonnet Lv29 |
| 285 | Claude 3 Sonnet | Anthropic | US | 对话/对齐 | R | 368 | ← Claude 2 |
| 286 | Claude 3.7 Sonnet | Anthropic | US | 代码/创作 | R | 379 | → Claude Sonnet 4 Lv28 |
| 287 | Claude Sonnet 4 | Anthropic | US | 代码/创作 | SR | 444 | ← Claude 3.7 Sonnet；→ Claude Sonnet 4.6 Lv35 |
| 288 | Claude Sonnet 4.6 | Anthropic | US | 代码/智能体 | SR | 466 | ← Claude Sonnet 4 |
| 289 | Claude Opus 4.1 | Anthropic | US | 代码/对齐 | SR | 449 | → Claude Opus 4.6 Lv30 |
| 290 | Claude Opus 4.6 | Anthropic | US | 代码/推理 | SR | 472 | ← Claude Opus 4.1；→ Claude Opus 5 Lv37 |
| 291 | Claude Opus 5 | Anthropic | US | 代码/推理 | SSR | 537 | ← Claude Opus 4.6 |
| 292 | Grok-2 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 357 | → Grok 3 Lv29 |
| 293 | Grok 3 | SpaceXAI (formerly xAI) | US | 对话/推理 | SR | 444 | ← Grok-2；→ Grok 4.1 Fast Lv36 |
| 294 | Grok 4.1 Fast | SpaceXAI (formerly xAI) | US | 对话/算力 | SR | 461 | ← Grok 3 |
| 295 | Grok 4.3 | SpaceXAI (formerly xAI) | US | 对话/推理 | SR | 472 | → Grok 4.6 Lv36 |
| 296 | Grok 4.6 | SpaceXAI (formerly xAI) | US | 对话/推理 | SSR | 531 | ← Grok 4.3 |
| 297 | Llama 2 | Meta | US | 开源/对话 | N | 277 | → Llama 3 Lv24 |
| 298 | Llama 3 | Meta | US | 开源/对话 | R | 361 | ← Llama 2；→ Llama 3.3 Lv31 |
| 299 | Llama 3.3 | Meta | US | 开源/算力 | R | 397 | ← Llama 3 |
| 300 | Muse Glimmer | Meta | US | 对话/算力 | R | 375 | — |
| 301 | Muse Code | Meta | US | 代码/智能体 | SR | 444 | — |
| 302 | Mistral Small 3 | Mistral AI | FR | 开源/算力 | R | 346 | → Mistral Small 3.2 Lv21 |
| 303 | Mistral Small 3.2 | Mistral AI | FR | 开源/算力 | R | 364 | ← Mistral Small 3；→ Mistral Small 4 Lv28 |
| 304 | Mistral Small 4 | Mistral AI | FR | 开源/智能体 | SR | 441 | ← Mistral Small 3.2 |
| 305 | Magistral Small | Mistral AI | FR | 推理/开源 | R | 357 | → Magistral Medium Lv31 |
| 306 | Magistral Medium | Mistral AI | FR | 推理/开源 | SR | 441 | ← Magistral Small |
| 307 | Pixtral 12B | Mistral AI | FR | 视觉/开源 | N | 285 | → Pixtral Large Lv22 |
| 308 | Pixtral Large | Mistral AI | FR | 视觉/开源 | R | 364 | ← Pixtral 12B |
| 309 | MAI-Code-1-Flash | Microsoft | US | 代码/算力 | R | 357 | → MAI-Code-1.1-Flash Lv20 |
| 310 | MAI-Code-1.1-Flash | Microsoft | US | 代码/算力 | R | 382 | ← MAI-Code-1-Flash |
