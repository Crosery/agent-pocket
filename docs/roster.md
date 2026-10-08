# 智灵口袋 · 图鉴总表

> 由 `python3 tools/data/build_species.py` 根据 `docs/research/roster-final.json` + `tools/data/species_rules.json` 生成，勿手改。

共 255 只，139 个家族；3 只初始伙伴。

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
| N | 普通 | 18 | 240–330 | 150–255 |
| R | 稀有 | 56 | 330–420 | 90–190 |
| SR | 超稀有 | 88 | 420–490 | 45–120 |
| SSR | 史诗 | 63 | 490–550 | 25–60 |
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
| 11 | GPT-6 Luna（月） | OpenAI | US | 算力/对话 | SR | 485 | → GPT-6.1 Sol（日） Lv30 |
| 12 | GPT-6.1 Sol（日） | OpenAI | US | 代码/推理 | UR | 600 | ← GPT-6 Luna（月） |
| 13 | Codex 初代 | OpenAI | US | 代码 | N | 268 | → GPT-5.3-Codex Lv24 |
| 14 | GPT-5.3-Codex | OpenAI | US | 代码/智能体 | SSR | 520 | ← Codex 初代；→ OpenAI Codex（编程智能体） Lv40 |
| 15 | OpenAI Codex（编程智能体） | OpenAI | US | 代码/智能体 | UR | 623 | ← GPT-5.3-Codex |
| 16 | gpt-oss-120b | OpenAI | US | 开源/推理 | R | 395 | — |
| 17 | DALL·E | OpenAI | US | 视觉 | R | 360 | → GPT Image 1（吉卜力风暴） Lv22 |
| 18 | GPT Image 1（吉卜力风暴） | OpenAI | US | 视觉/对话 | SR | 475 | ← DALL·E；→ GPT Image 2.5 Lv44 |
| 19 | GPT Image 2.5 | OpenAI | US | 视觉/推理 | UR | 623 | ← GPT Image 1（吉卜力风暴） |
| 20 | Sora（初代） | OpenAI | US | 影像 | R | 405 | → Sora 2（已停服） Lv30 |
| 21 | Sora 2（已停服） | OpenAI | US | 影像/幻觉 | SSR | 527 | ← Sora（初代） |
| 22 | ChatGPT Agent | OpenAI | US | 智能体/对话 | SR | 472 | → ChatGPT dots（常驻智能体） Lv28 |
| 23 | ChatGPT dots（常驻智能体） | OpenAI | US | 智能体 | SSR | 545 | ← ChatGPT Agent |
| 24 | Claude Haiku 4.5 | Anthropic | US | 代码 | R | 340 | → Claude Opus 4.8 Lv16 |
| 25 | Claude Opus 4.8 | Anthropic | US | 代码/对齐 | SSR | 512 | ← Claude Haiku 4.5；→ Claude Opus 5.5 Lv36 |
| 26 | Claude Opus 5.5 | Anthropic | US | 代码/推理 | UR | 630 | ← Claude Opus 4.8 |
| 27 | Claude 3 Opus | Anthropic | US | 创作/对齐 | R | 365 | → Claude 3.5 Sonnet Lv26 |
| 28 | Claude 3.5 Sonnet | Anthropic | US | 代码/创作 | SR | 436 | ← Claude 3 Opus；→ Claude Sonnet 5.5 Lv40 |
| 29 | Claude Sonnet 5.5 | Anthropic | US | 代码/创作 | UR | 622 | ← Claude 3.5 Sonnet |
| 30 | Claude Fable 5 | Anthropic | US | 推理/对齐 | SSR | 528 | → Claude Fable 5.1 Lv36 |
| 31 | Claude Fable 5.1 | Anthropic | US | 推理/对齐 | UR | 612 | ← Claude Fable 5 |
| 32 | Claude Mythos Preview | Anthropic | US | 代码/对齐 | SSR | 548 | — |
| 33 | Claude Mythos 5.1 | Anthropic | US | 代码/幻觉 | MYTHIC | 642 | — |
| 34 | Claude Code | Anthropic | US | 代码/智能体 | UR | 625 | — |
| 35 | Claude Computer Use | Anthropic | US | 智能体/视觉 | R | 392 | → Claude 应用（Cowork 合体） Lv28 |
| 36 | Claude 应用（Cowork 合体） | Anthropic | US | 智能体/创作 | SSR | 545 | ← Claude Computer Use |
| 37 | Gemini 3.5 Flash-Lite | Google | US | 算力 | R | 403 | → Gemini 3.8 Flash Lv20 |
| 38 | Gemini 3.8 Flash | Google | US | 算力/推理 | SSR | 549 | ← Gemini 3.5 Flash-Lite；→ Gemini 4 Argon（氩） Lv48 |
| 39 | Gemini 4 Argon（氩） | Google | US | 推理/对齐 | UR | 613 | ← Gemini 3.8 Flash |
| 40 | Gemini 3.8 Live | Google | US | 音律/对话 | SSR | 535 | — |
| 41 | Gemini 1.5 Pro | Google | US | 检索/视觉 | R | 366 | → Gemini 2.5 Pro Lv26 |
| 42 | Gemini 2.5 Pro | Google | US | 推理/代码 | SR | 440 | ← Gemini 1.5 Pro；→ Gemini 3.1 Pro Preview Lv40 |
| 43 | Gemini 3.1 Pro Preview | Google | US | 推理/视觉 | SR | 470 | ← Gemini 2.5 Pro |
| 44 | Gemma 3 | Google | US | 开源/视觉 | R | 372 | → Gemma 4 Lv30 |
| 45 | Gemma 4 | Google | US | 开源/视觉 | SR | 470 | ← Gemma 3 |
| 46 | Nano Banana 纳米香蕉 | Google | US | 视觉 | SR | 485 | → Nano Banana 2 Lv34 |
| 47 | Nano Banana 2 | Google | US | 视觉/算力 | SSR | 535 | ← Nano Banana 纳米香蕉；→ Nano Banana 2.1 Lv46 |
| 48 | Nano Banana 2.1 | Google | US | 视觉/算力 | SSR | 548 | ← Nano Banana 2 |
| 49 | Veo 3 | Google | US | 影像/音律 | SR | 480 | → Veo 3.1 Lv26 |
| 50 | Veo 3.1 | Google | US | 影像/音律 | SR | 488 | ← Veo 3；→ Gemini Omni 1.1 Flash Lv40 |
| 51 | Gemini Omni 1.1 Flash | Google | US | 影像/视觉 | SSR | 545 | ← Veo 3.1 |
| 52 | Lyria 2 | Google | US | 音律 | R | 385 | → Lyria 3 Lv22 |
| 53 | Lyria 3 | Google | US | 音律/创作 | SR | 452 | ← Lyria 2；→ Lyria 3.5 Lv38 |
| 54 | Lyria 3.5 | Google | US | 音律/创作 | SR | 470 | ← Lyria 3 |
| 55 | Genie 3 精灵世界 | Google | US | 影像/智能体 | UR | 600 | — |
| 56 | NotebookLM | Google | US | 检索/创作 | SSR | 545 | — |
| 57 | Gemini CLI | Google | US | 代码/智能体 | R | 395 | → Google Antigravity 反重力 Lv30 |
| 58 | Google Antigravity 反重力 | Google | US | 代码/智能体 | SSR | 545 | ← Gemini CLI |
| 59 | Gemini Robotics 2 | Google | US | 智能体/影像 | SSR | 530 | — |
| 60 | 阿尔法（AlphaGo / AlphaFold） | Google DeepMind | UK | 推理/检索 | MYTHIC | 665 | — |
| 61 | Grok-1 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | N | 267 | → Grok 4 Lv24 |
| 62 | Grok 4 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 464 | ← Grok-1；→ Grok 4.7 Lv44 |
| 63 | Grok 4.7 | SpaceXAI (formerly xAI) | US | 推理/代码 | UR | 583 | ← Grok 4 |
| 64 | Ani（Grok 陪伴） | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 400 | — |
| 65 | Grok Imagine | SpaceXAI (formerly xAI) | US | 影像/音律 | SSR | 545 | — |
| 66 | LLaMA 初代 | Meta | US | 开源 | N | 260 | → Llama 3.1 405B Lv20 |
| 67 | Llama 3.1 405B | Meta | US | 开源/推理 | R | 367 | ← LLaMA 初代；→ Llama 4（Scout / Maverick） Lv38 |
| 68 | Llama 4（Scout / Maverick） | Meta | US | 开源/幻觉 | R | 385 | ← Llama 3.1 405B |
| 69 | Muse Spark 灵感火花 | Meta | US | 推理/视觉 | UR | 592 | — |
| 70 | Meta Muse 个人智能体 | Meta | US | 智能体/对话 | SSR | 545 | — |
| 71 | Moltbook 智能体论坛 | Meta (acquired) | US | 幻觉/对话 | R | 387 | — |
| 72 | Mistral 7B | Mistral AI | FR | 开源/算力 | N | 265 | → Mixtral 8x7B Lv18 |
| 73 | Mixtral 8x7B | Mistral AI | FR | 开源/算力 | R | 350 | ← Mistral 7B；→ Mistral Medium 3.5 Lv34 |
| 74 | Mistral Medium 3.5 | Mistral AI | FR | 开源/代码 | R | 400 | ← Mixtral 8x7B |
| 75 | Phi-3 | Microsoft | US | 推理 | N | 300 | → Phi-4 Lv22 |
| 76 | Phi-4 | Microsoft | US | 推理/算力 | R | 362 | ← Phi-3；→ Phi-4-reasoning Lv38 |
| 77 | Phi-4-reasoning | Microsoft | US | 推理/开源 | SR | 438 | ← Phi-4 |
| 78 | MAI-Thinking-1 | Microsoft | US | 推理/代码 | SR | 478 | — |
| 79 | MAI-Image-2.6 | Microsoft | US | 视觉/检索 | SSR | 530 | — |
| 80 | GitHub Copilot | GitHub (Microsoft) | US | 代码/智能体 | SSR | 545 | — |
| 81 | Amazon Kiro | Amazon (AWS) | US | 代码/幻觉 | SR | 470 | — |
| 82 | Nemotron 3 Super | NVIDIA | US | 开源/算力 | SR | 440 | → Nemotron 3 Ultra Lv34 |
| 83 | Nemotron 3 Ultra | NVIDIA | US | 开源/算力 | SR | 478 | ← Nemotron 3 Super |
| 84 | Apple 智能（基础模型 3） | Apple | US | 对话/对齐 | SR | 462 | — |
| 85 | Sakana Fugu 河豚 | Sakana AI | JP | 智能体/推理 | SR | 485 | — |
| 86 | Solar Pro 4 | Upstage | KR | 智能体/检索 | R | 388 | — |
| 87 | Inkling 灵念 | Thinking Machines Lab | US | 开源/视觉 | SR | 480 | — |
| 88 | Midjourney V5 | Midjourney | US | 视觉 | R | 373 | → Midjourney V7 Lv24 |
| 89 | Midjourney V7 | Midjourney | US | 视觉/创作 | SR | 476 | ← Midjourney V5；→ Midjourney V8 Lv42 |
| 90 | Midjourney V8 | Midjourney | US | 视觉/创作 | SSR | 542 | ← Midjourney V7 |
| 91 | Stable Diffusion 1.x | Stability AI | UK | 视觉/开源 | N | 270 | → SDXL Lv20 |
| 92 | SDXL | Stability AI | UK | 视觉/开源 | R | 352 | ← Stable Diffusion 1.x；→ Stable Diffusion 3.5 Lv34 |
| 93 | Stable Diffusion 3.5 | Stability AI | UK | 视觉/开源 | SR | 440 | ← SDXL |
| 94 | FLUX.1 | Black Forest Labs | DE | 视觉/开源 | R | 390 | → FLUX.2 Lv24 |
| 95 | FLUX.2 | Black Forest Labs | DE | 视觉/开源 | SR | 470 | ← FLUX.1；→ FLUX 3 Lv40 |
| 96 | FLUX 3 | Black Forest Labs | DE | 影像/视觉 | SSR | 545 | ← FLUX.2 |
| 97 | Runway Gen-4 | Runway | US | 影像/创作 | SR | 438 | → Runway Gen-4.5 Lv30 |
| 98 | Runway Gen-4.5 | Runway | US | 影像/创作 | SR | 468 | ← Runway Gen-4 |
| 99 | Luma Ray3 | Luma AI | US | 影像/视觉 | SR | 465 | — |
| 100 | Suno v3 | Suno | US | 音律/创作 | R | 379 | → Suno v5 Lv24 |
| 101 | Suno v5 | Suno | US | 音律/创作 | SR | 485 | ← Suno v3；→ Suno v6 Lv44 |
| 102 | Suno v6 | Suno | US | 音律/创作 | UR | 615 | ← Suno v5 |
| 103 | ElevenLabs 多语言 v2 | ElevenLabs | US | 音律/对话 | R | 415 | → Eleven v3 Lv26 |
| 104 | Eleven v3 | ElevenLabs | US | 音律/对话 | SR | 478 | ← ElevenLabs 多语言 v2；→ Eleven v4 Lv42 |
| 105 | Eleven v4 | ElevenLabs | US | 音律/对话 | UR | 572 | ← Eleven v3 |
| 106 | Marble 世界大理石 | World Labs | US | 视觉/影像 | SSR | 537 | — |
| 107 | Cursor | Anysphere (SpaceX / SpaceXAI) | US | 代码/智能体 | UR | 608 | — |
| 108 | Windsurf 风帆 | Codeium -> Cognition | US | 代码/智能体 | SR | 472 | — |
| 109 | Devin（AI 软件工程师） | Cognition | US | 智能体/代码 | SSR | 545 | — |
| 110 | Replit Agent | Replit | US | 代码/智能体 | SR | 485 | — |
| 111 | Lovable | Lovable | SE | 代码/创作 | SSR | 539 | — |
| 112 | OpenCode | Anomaly (formerly SST) | US | 开源/代码 | SSR | 544 | — |
| 113 | Manus | Butterfly Effect (Meta deal being unwound) | SG | 智能体 | SR | 485 | → Manus 2.0（Manus Studio） Lv32 |
| 114 | Manus 2.0（Manus Studio） | Butterfly Effect (Meta deal being unwound) | SG | 智能体/算力 | SSR | 545 | ← Manus |
| 115 | Perplexity | Perplexity AI | US | 检索 | SR | 470 | → Comet 彗星浏览器 Lv28 |
| 116 | Comet 彗星浏览器 | Perplexity AI | US | 检索/智能体 | SR | 488 | ← Perplexity；→ Perplexity Computer Lv40 |
| 117 | Perplexity Computer | Perplexity AI | US | 检索/智能体 | SSR | 542 | ← Comet 彗星浏览器 |
| 118 | Character.AI | Character Technologies | US | 对话/创作 | R | 415 | — |
| 119 | Neuro-sama（牛肉） | Vedal (independent) | UK | 对话/幻觉 | SR | 470 | — |
| 120 | Clawdbot | Peter Steinberger (community) | AT | 智能体/开源 | R | 415 | → Moltbot（蜕壳期） Lv18 |
| 121 | Moltbot（蜕壳期） | Peter Steinberger (community) | AT | 智能体/开源 | SR | 480 | ← Clawdbot；→ OpenClaw 小龙虾 Lv36 |
| 122 | OpenClaw 小龙虾 | OpenClaw Foundation | AT | 智能体/开源 | UR | 607 | ← Moltbot（蜕壳期） |
| 123 | Hermes Agent 爱马仕智能体 | Nous Research | US | 智能体/开源 | SSR | 545 | — |
| 124 | AutoGPT | Significant Gravitas | UK | 智能体/幻觉 | R | 391 | — |
| 125 | LangChain | LangChain | US | 智能体/开源 | SR | 485 | → LangGraph Lv32 |
| 126 | LangGraph | LangChain | US | 智能体/开源 | SSR | 520 | ← LangChain |
| 127 | Figure 03 | Figure AI | US | 智能体/视觉 | SSR | 545 | — |
| 128 | 特斯拉 Optimus | Tesla | US | 智能体/算力 | SR | 485 | — |
| 129 | π0.7 物理智能 | Physical Intelligence | US | 智能体/开源 | SSR | 530 | — |
| 130 | AGI 奇点 | Unknown (all labs) | INTL | 推理/对齐 | MYTHIC | 715 | — |
| 131 | DeepSeek-V3 | DeepSeek | CN | 算力 | R | 340 | → DeepSeek-R1 深度思考 Lv16 |
| 132 | DeepSeek-R1 深度思考 | DeepSeek | CN | 推理/开源 | SSR | 512 | ← DeepSeek-V3；→ DeepSeek-V4 / V4.1 Lv36 |
| 133 | DeepSeek-V4 / V4.1 | DeepSeek | CN | 开源/推理 | UR | 585 | ← DeepSeek-R1 深度思考 |
| 134 | DeepSeek Harness 虎鲸 | DeepSeek | CN | 智能体/开源 | SSR | 531 | — |
| 135 | 通义千问 1.0 | Alibaba | CN | 对话/开源 | N | 247 | → 通义千问 2.5 Lv18 |
| 136 | 通义千问 2.5 | Alibaba | CN | 开源 | R | 352 | ← 通义千问 1.0；→ 通义千问 3.8-Max Lv38 |
| 137 | 通义千问 3.8-Max | Alibaba | CN | 推理/智能体 | UR | 564 | ← 通义千问 2.5 |
| 138 | Qwen3.8-Flash-Next | Alibaba | CN | 算力/开源 | SSR | 521 | — |
| 139 | 千问 App | Alibaba | CN | 对话/智能体 | SSR | 545 | — |
| 140 | 千问图像 3.1 | Alibaba (Qwen) | CN | 视觉/创作 | SR | 488 | — |
| 141 | 千问语音 3.1 | Alibaba (Qwen) | CN | 音律/对话 | SSR | 540 | — |
| 142 | 通义万相 2.1 | Alibaba (Tongyi) | CN | 影像/开源 | R | 388 | → 通义万相 2.2 Lv24 |
| 143 | 通义万相 2.2 | Alibaba (Tongyi) | CN | 影像/开源 | SR | 455 | ← 通义万相 2.1；→ 通义万相 3.0 Lv42 |
| 144 | 通义万相 3.0 | Alibaba (Tongyi) | CN | 影像/音律 | UR | 610 | ← 通义万相 2.2 |
| 145 | 快乐小马 HappyHorse | Alibaba ATH (Taotian Future Life Lab) | CN | 影像/算力 | SR | 478 | — |
| 146 | 快乐生蚝 HappyOyster | Alibaba ATH | CN | 影像/智能体 | SR | 475 | — |
| 147 | 快乐虾米 HappyShrimp | Alibaba ATH | CN | 音律/创作 | SR | 465 | — |
| 148 | Qoder | Alibaba | CN | 代码/智能体 | SR | 485 | — |
| 149 | Kimi 智能助手 | Moonshot AI | CN | 对话/检索 | R | 357 | → Kimi K2 Lv24 |
| 150 | Kimi K2 | Moonshot AI | CN | 智能体/开源 | SR | 448 | ← Kimi 智能助手；→ Kimi K3 Lv44 |
| 151 | Kimi K3 | Moonshot AI | CN | 开源/智能体 | UR | 570 | ← Kimi K2 |
| 152 | Kimi Work | Moonshot AI | CN | 智能体 | SSR | 539 | — |
| 153 | ChatGLM-6B | Zhipu AI (Z.ai) | CN | 对话/开源 | N | 255 | → GLM-4.5 Lv22 |
| 154 | GLM-4.5 | Zhipu AI (Z.ai) | CN | 智能体/开源 | SR | 442 | ← ChatGLM-6B；→ GLM-5.3 Lv42 |
| 155 | GLM-5.3 | Zhipu AI (Z.ai) | CN | 代码/开源 | UR | 565 | ← GLM-4.5 |
| 156 | AutoGLM | Zhipu AI (Z.ai) | CN | 智能体/视觉 | SR | 484 | — |
| 157 | 豆包大模型 Pro | ByteDance | CN | 对话/算力 | N | 278 | → 豆包 Seed 2.0 Lv20 |
| 158 | 豆包 Seed 2.0 | ByteDance | CN | 智能体/算力 | SR | 469 | ← 豆包大模型 Pro；→ 豆包 Seed 2.1 Pro Lv42 |
| 159 | 豆包 Seed 2.1 Pro | ByteDance | CN | 智能体/视觉 | SSR | 526 | ← 豆包 Seed 2.0 |
| 160 | 豆包 | ByteDance | CN | 对话/音律 | UR | 590 | — |
| 161 | 即梦 Seedream 3.0 | ByteDance Seed | CN | 视觉/创作 | R | 407 | → 即梦 Seedream 4.0 Lv22 |
| 162 | 即梦 Seedream 4.0 | ByteDance Seed | CN | 视觉/创作 | SR | 458 | ← 即梦 Seedream 3.0；→ 即梦 Seedream 5.0 Lv38 |
| 163 | 即梦 Seedream 5.0 | ByteDance Seed | CN | 视觉/推理 | SSR | 505 | ← 即梦 Seedream 4.0 |
| 164 | 即梦 Seedance 1.0 | ByteDance Seed | CN | 影像 | SR | 462 | → 即梦 Seedance 2.0 Lv26 |
| 165 | 即梦 Seedance 2.0 | ByteDance Seed | CN | 影像/幻觉 | SSR | 545 | ← 即梦 Seedance 1.0；→ 即梦 Seedance 2.5 Lv46 |
| 166 | 即梦 Seedance 2.5 | ByteDance Seed | CN | 影像/音律 | UR | 612 | ← 即梦 Seedance 2.0 |
| 167 | Trae | ByteDance | CN | 代码/智能体 | SR | 485 | — |
| 168 | 扣子 Coze | ByteDance | CN | 智能体/创作 | SSR | 537 | — |
| 169 | 腾讯混元 | Tencent | CN | 对话 | N | 251 | → 混元 Hy3 Lv24 |
| 170 | 混元 Hy3 | Tencent | CN | 推理/开源 | SR | 456 | ← 腾讯混元；→ 混元 Hy4 Preview Lv44 |
| 171 | 混元 Hy4 Preview | Tencent | CN | 智能体/开源 | SSR | 525 | ← 混元 Hy3 |
| 172 | 腾讯元宝 | Tencent | CN | 对话/检索 | SSR | 528 | — |
| 173 | 混元生图 3.0 | Tencent Hunyuan | CN | 视觉/开源 | SR | 450 | → 混元生图 3.5（预览） Lv30 |
| 174 | 混元生图 3.5（预览） | Tencent Hunyuan | CN | 视觉/开源 | SR | 476 | ← 混元生图 3.0 |
| 175 | WorkBuddy | Tencent | CN | 智能体/对话 | SSR | 538 | — |
| 176 | 文心一言 3.5 | Baidu | CN | 对话/检索 | N | 265 | → 文心 4.5 Lv22 |
| 177 | 文心 4.5 | Baidu | CN | 视觉/开源 | R | 362 | ← 文心一言 3.5；→ 文心 5.1 Preview Lv40 |
| 178 | 文心 5.1 Preview | Baidu | CN | 对话/算力 | SR | 466 | ← 文心 4.5 |
| 179 | 阶跃 Step 3.5 Flash | StepFun | CN | 算力/开源 | R | 374 | → 阶跃 Step 3.7 Flash Lv24 |
| 180 | 阶跃 Step 3.7 Flash | StepFun | CN | 算力/开源 | SR | 452 | ← 阶跃 Step 3.5 Flash；→ 阶跃 Step 5 Preview Lv40 |
| 181 | 阶跃 Step 5 Preview | StepFun | CN | 智能体/视觉 | SSR | 542 | ← 阶跃 Step 3.7 Flash |
| 182 | 讯飞星火 V4.0 | iFlytek | CN | 音律/对话 | N | 266 | → 讯飞星火 X2.5 Lv28 |
| 183 | 讯飞星火 X2.5 | iFlytek | CN | 推理/算力 | R | 390 | ← 讯飞星火 V4.0 |
| 184 | 商汤日日新 6.7 Flash-Lite | SenseTime | CN | 视觉/创作 | R | 370 | — |
| 185 | 百川 2 | Baichuan AI | CN | 对话/开源 | N | 249 | → 百川 M3 Lv26 |
| 186 | 百川 M3 | Baichuan AI | CN | 对齐/检索 | R | 385 | ← 百川 2 |
| 187 | 小米 MiMo-7B | Xiaomi | CN | 推理/开源 | N | 268 | → MiMo-V2-Flash Lv22 |
| 188 | MiMo-V2-Flash | Xiaomi | CN | 算力/开源 | SR | 434 | ← 小米 MiMo-7B；→ MiMo-V2.6-Pro Lv44 |
| 189 | MiMo-V2.6-Pro | Xiaomi | CN | 开源/推理 | UR | 580 | ← MiMo-V2-Flash |
| 190 | 美团 LongCat-Flash | Meituan | CN | 算力/智能体 | R | 379 | → 美团 LongCat 2.0 Lv24 |
| 191 | 美团 LongCat 2.0 | Meituan | CN | 智能体/算力 | SR | 435 | ← 美团 LongCat-Flash；→ 美团龙猫 LongCat-2.5 Lv40 |
| 192 | 美团龙猫 LongCat-2.5 | Meituan | CN | 智能体/视觉 | SR | 460 | ← 美团 LongCat 2.0 |
| 193 | 蚂蚁百灵 Ling 3.0 / Ring 2.6 | Ant Group | CN | 推理/开源 | R | 371 | — |
| 194 | 蚂蚁阿福 | Ant Group | CN | 对话/对齐 | SSR | 520 | — |
| 195 | 可灵 1.0 | Kuaishou (Kling AI) | CN | 影像 | R | 351 | → 可灵 3.0 Lv28 |
| 196 | 可灵 3.0 | Kuaishou (Kling AI) | CN | 影像/音律 | SSR | 530 | ← 可灵 1.0；→ 可灵 4.0 Lv48 |
| 197 | 可灵 4.0 | Kling AI (Kuaishou spin-off) | CN | 影像/视觉 | SSR | 548 | ← 可灵 3.0 |
| 198 | 书生 Intern-S2 | Shanghai AI Laboratory | CN | 检索/推理 | R | 381 | — |
| 199 | 天工 Mureka V9 | Kunlun Tech (Skywork AI) | CN | 音律/创作 | SR | 482 | — |
| 200 | 天工 SkyReels V4 | Skywork AI (Kunlun Tech) | CN | 影像/创作 | SR | 488 | — |
| 201 | 华为盘古 5.5 | Huawei | CN | 对齐/算力 | N | 296 | → 华为 openPangu 2.0 Pro Lv30 |
| 202 | 华为 openPangu 2.0 Pro | Huawei | CN | 开源/算力 | R | 379 | ← 华为盘古 5.5 |
| 203 | 面壁 MiniCPM | ModelBest | CN | 算力/开源 | R | 354 | — |
| 204 | 生数 Vidu | ShengShu Technology | CN | 影像 | R | 352 | → 生数 Vidu Q3 Lv30 |
| 205 | 生数 Vidu Q3 | ShengShu Technology | CN | 影像/创作 | SR | 477 | ← 生数 Vidu |
| 206 | 拍我AI PixVerse V6 | PixVerse (爱诗科技) | CN | 影像/智能体 | SR | 479 | — |
| 207 | MiniMax abab6.5 | MiniMax | CN | 对话/创作 | N | 260 | → MiniMax-M2 Lv24 |
| 208 | MiniMax-M2 | MiniMax | CN | 代码/开源 | R | 380 | ← MiniMax abab6.5；→ MiniMax-M3 Lv40 |
| 209 | MiniMax-M3 | MiniMax | CN | 代码/视觉 | SR | 461 | ← MiniMax-M2 |
| 210 | 海螺 Video-01 | MiniMax | CN | 影像 | R | 358 | → 海螺 02 Lv24 |
| 211 | 海螺 02 | MiniMax | CN | 影像 | SR | 455 | ← 海螺 Video-01；→ 海螺 H3 Lv40 |
| 212 | 海螺 H3 | MiniMax | CN | 影像/开源 | UR | 565 | ← 海螺 02 |
| 213 | MiniMax 音乐 3.0 | MiniMax | CN | 音律/创作 | SR | 485 | — |
| 214 | Tripo H3.1 | VAST (Tripo AI) | CN | 视觉/算力 | SR | 485 | — |
| 215 | 宇树 G1/H2 | Unitree Robotics | CN | 智能体/算力 | SSR | 543 | → 宇树 GD01 载人机甲 Lv50 |
| 216 | 宇树 GD01 载人机甲 | Unitree Robotics | CN | 算力/智能体 | UR | 570 | ← 宇树 G1/H2 |
| 217 | 智元机器人 | AgiBot | CN | 智能体/视觉 | SSR | 541 | — |
| 218 | o3-mini | OpenAI | US | 推理 | R | 368 | → o3 Lv20 |
| 219 | o3 | OpenAI | US | 推理/代码 | SR | 448 | ← o3-mini；→ o3-pro Lv40 |
| 220 | o3-pro | OpenAI | US | 推理/算力 | SR | 486 | ← o3 |
| 221 | Claude Opus 4 | Anthropic | US | 代码/对齐 | R | 400 | → Claude Opus 4.5 Lv22 |
| 222 | Claude Opus 4.5 | Anthropic | US | 代码/对齐 | SR | 458 | ← Claude Opus 4；→ Claude Opus 4.7 Lv40 |
| 223 | Claude Opus 4.7 | Anthropic | US | 代码/推理 | SSR | 515 | ← Claude Opus 4.5 |
| 224 | Claude Sonnet 4.5 | Anthropic | US | 代码/创作 | SR | 450 | → Claude Sonnet 5 Lv34 |
| 225 | Claude Sonnet 5 | Anthropic | US | 代码/创作 | SSR | 530 | ← Claude Sonnet 4.5 |
| 226 | Claude 3 Haiku | Anthropic | US | 代码 | N | 295 | → Claude 3.5 Haiku Lv18 |
| 227 | Claude 3.5 Haiku | Anthropic | US | 代码 | R | 372 | ← Claude 3 Haiku；→ Claude Haiku 5.5 Lv34 |
| 228 | Claude Haiku 5.5 | Anthropic | US | 代码/智能体 | SR | 440 | ← Claude 3.5 Haiku |
| 229 | Gemini 2.5 Flash | Google | US | 算力 | R | 398 | → Gemini 3 Flash Lv24 |
| 230 | Gemini 3 Flash | Google | US | 算力/对话 | SR | 462 | ← Gemini 2.5 Flash；→ Gemini 3.5 Flash Lv40 |
| 231 | Gemini 3.5 Flash | Google | US | 算力/智能体 | SSR | 520 | ← Gemini 3 Flash |
| 232 | Grok Build | SpaceXAI (formerly xAI) | US | 代码/智能体 | SR | 462 | — |
| 233 | Grok 4.20 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 470 | → Grok 4.5 Lv36 |
| 234 | Grok 4.5 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SSR | 525 | ← Grok 4.20 |
| 235 | Muse Image | Meta | US | 视觉/创作 | SR | 470 | — |
| 236 | Mistral Large 3 | Mistral AI | FR | 开源/推理 | R | 398 | → Mistral Large 4 Lv32 |
| 237 | Mistral Large 4 | Mistral AI | FR | 开源/推理 | SR | 460 | ← Mistral Large 3 |
| 238 | Devstral 2 | Mistral AI | FR | 代码/开源 | SR | 440 | — |
| 239 | DeepSeek-V3.1 | DeepSeek | CN | 算力/推理 | R | 372 | → DeepSeek-V3.2 Lv22 |
| 240 | DeepSeek-V3.2 | DeepSeek | CN | 算力/推理 | SR | 450 | ← DeepSeek-V3.1；→ DeepSeek-V3.2-Speciale Lv38 |
| 241 | DeepSeek-V3.2-Speciale | DeepSeek | CN | 推理/开源 | SSR | 508 | ← DeepSeek-V3.2 |
| 242 | DeepSeek 应用 | DeepSeek | CN | 对话/检索 | SSR | 530 | — |
| 243 | 通义千问 Qwen3 | Alibaba | CN | 开源/对话 | R | 378 | → 通义千问 Qwen3.5 Lv24 |
| 244 | 通义千问 Qwen3.5 | Alibaba | CN | 开源/视觉 | SR | 452 | ← 通义千问 Qwen3；→ 通义千问 Qwen3.7-Max Lv40 |
| 245 | 通义千问 Qwen3.7-Max | Alibaba | CN | 开源/推理 | SSR | 520 | ← 通义千问 Qwen3.5 |
| 246 | Qwen3-Coder | Alibaba | CN | 代码/开源 | SR | 440 | → Qwen3-Coder-Next Lv32 |
| 247 | Qwen3-Coder-Next | Alibaba | CN | 代码/智能体 | SSR | 502 | ← Qwen3-Coder |
| 248 | Kimi K2 Thinking | Moonshot AI | CN | 推理/智能体 | SR | 430 | → Kimi K2.5 Lv26 |
| 249 | Kimi K2.5 | Moonshot AI | CN | 智能体/视觉 | SR | 470 | ← Kimi K2 Thinking；→ Kimi K2.6 Lv40 |
| 250 | Kimi K2.6 | Moonshot AI | CN | 智能体/代码 | SSR | 515 | ← Kimi K2.5 |
| 251 | GLM-4.7 | Zhipu AI (Z.ai) | CN | 智能体/代码 | SR | 438 | → GLM-5 Lv26 |
| 252 | GLM-5 | Zhipu AI (Z.ai) | CN | 代码/开源 | SR | 478 | ← GLM-4.7；→ GLM-5.2 Lv40 |
| 253 | GLM-5.2 | Zhipu AI (Z.ai) | CN | 代码/开源 | SSR | 530 | ← GLM-5 |
| 254 | MiniMax-M2.1 | MiniMax | CN | 代码/开源 | R | 395 | → MiniMax-M2.7 Lv30 |
| 255 | MiniMax-M2.7 | MiniMax | CN | 代码/开源 | SR | 455 | ← MiniMax-M2.1 |
