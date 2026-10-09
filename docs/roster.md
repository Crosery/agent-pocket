# 智灵口袋 · 图鉴总表

> 由 `python3 tools/data/build_species.py` 根据 `docs/research/roster-final.json` + `tools/data/species_rules.json` 生成，勿手改。

共 448 只，232 个家族；3 只初始伙伴。

## 初始伙伴三角

三只初始伙伴均为 1 阶，属性构成循环克制（攻击方 → 防守方 = 2×）：

- **o1**（推理）克制 **DeepSeek-V3**（算力）
- **Claude Haiku 4.5**（代码）克制 **o1**（推理）
- **DeepSeek-V3**（算力）克制 **Claude Haiku 4.5**（代码）

| 初始伙伴 | 公司 | 属性 | 稀有度 | BST | 进化链 |
|---|---|---|---|---|---|
| o1 | OpenAI | 推理 | R | 348 | o1 (Lv16) → o3 (Lv40) → OpenAI Codex（编程智能体） |
| Claude Haiku 4.5 | Anthropic | 代码 | R | 348 | Claude Haiku 4.5 (Lv16) → Claude Haiku 5.5 |
| DeepSeek-V3 | DeepSeek | 算力 | R | 348 | DeepSeek-V3 (Lv16) → DeepSeek-R1 深度思考 (Lv36) → DeepSeek-R1-0528 |

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

- o1: BST 340 outside R [348,420] -> scaled to 348
- claude-haiku: BST 340 outside R [348,420] -> scaled to 348
- claude-mythos: BST 642 outside MYTHIC [656,720] -> scaled to 656
- eleven-v4: BST 572 outside UR [574,630] -> scaled to 574
- deepseek-v3: BST 340 outside R [348,420] -> scaled to 348
- qwen-1: BST 247 outside N [258,330] -> scaled to 258
- qwen3-8-max: BST 564 outside UR [574,630] -> scaled to 574
- kimi-k3: BST 570 outside UR [574,630] -> scaled to 574
- chatglm: BST 255 outside N [258,330] -> scaled to 258
- glm-5-3: BST 565 outside UR [574,630] -> scaled to 574
- hunyuan: BST 251 outside N [258,330] -> scaled to 258
- baichuan-2: BST 249 outside N [258,330] -> scaled to 258
- minimax-h3: BST 565 outside UR [574,630] -> scaled to 574
- unitree-gd01: BST 570 outside UR [574,630] -> scaled to 574
- kimi-k2-thinking: BST 430 outside SR [434,490] -> scaled to 434
- claude-1: BST 252 outside N [258,330] -> scaled to 258
- claude-2: BST 339 outside R [348,420] -> scaled to 348
- mistral-large-2: BST 339 outside R [348,420] -> scaled to 348
- mistral-small-3: BST 346 outside R [348,420] -> scaled to 348
- genie-2: BST 433 outside SR [434,490] -> scaled to 434
- nano-banana-2 -> nano-banana-2-1: evolution step set to BST 509 -> 550
- veo-3 -> veo-3-1: evolution step set to BST 453 -> 490
- grok-1 -> grok-4: evolution step set to BST 290 -> 464
- llama-3-1 -> llama-4: evolution step set to BST 367 -> 397
- perplexity -> perplexity-comet: evolution step set to BST 453 -> 490
- langchain -> langgraph: evolution step set to BST 485 -> 524
- deepseek-r1 -> deepseek-r1-0528: evolution step set to BST 509 -> 550
- chatglm -> glm-4-5: evolution step set to BST 277 -> 442
- doubao-pro -> doubao-seed-2: evolution step set to BST 294 -> 469
- hunyuan -> hy3: evolution step set to BST 285 -> 456
- mimo-7b -> mimo-v2-flash: evolution step set to BST 272 -> 434
- kling-3 -> kling-4: evolution step set to BST 509 -> 550
- lyria-3 -> lyria: evolution step set to BST 452 -> 489
- runway-gen-4 -> runway: evolution step set to BST 438 -> 474
- hunyuan-image-3 -> hunyuan-image: evolution step set to BST 450 -> 487
- longcat-2 -> longcat-2-5: evolution step set to BST 435 -> 470
- gpt-5-1 -> gpt-5-2: evolution step set to BST 509 -> 550
- gpt-5-1-codex-max -> gpt-5-2-codex: evolution step set to BST 509 -> 550
- gpt-oss-20b -> gpt-oss-safeguard-20b: evolution step set to BST 364 -> 394
- claude-sonnet-4 -> claude-sonnet-4-6: evolution step set to BST 444 -> 480
- claude-opus-4-1 -> claude-opus-4-6: evolution step set to BST 449 -> 485
- grok-3 -> grok-4-1-fast: evolution step set to BST 444 -> 480
- muse-spark-1-1 -> muse-spark-1-2: evolution step set to BST 449 -> 485
- mistral-small-3 -> mistral-small-3-2: evolution step set to BST 348 -> 376
- mai-code-1-flash -> mai-code-1-1-flash: evolution step set to BST 357 -> 386
- gemini-3-7-flash -> gemini-flash: evolution step set to BST 509 -> 550
- alphazero -> muzero: evolution step set to BST 509 -> 550
- gpt-image-2 -> gpt-image-2-5-flare: evolution step set to BST 509 -> 550
- luma-ray1 -> luma-ray2: evolution step set to BST 357 -> 386
- suno-v4-5 -> suno-v5-5: evolution step set to BST 444 -> 480
- qwen3-max-thinking -> qwen3-7: evolution step set to BST 509 -> 550
- qwen3-5-plus -> qwen3-7-plus: evolution step set to BST 444 -> 480
- deepseek-v2-5 -> deepseek-v3-0324: evolution step set to BST 364 -> 394
- deepseek-v4-flash -> deepseek-v4-flash-0731: evolution step set to BST 452 -> 489
- deepseek-v4-flash-0731 -> deepseek-v4-1-flash: evolution step set to BST 489 -> 529
- kimi-k2-7-code -> kimi-k2-8-preview: evolution step set to BST 453 -> 490
- glm-4-5v -> glm-4-6v: evolution step set to BST 368 -> 398
- minimax-01 -> minimax-m1: evolution step set to BST 357 -> 386
- minimax-speech-2-5 -> minimax-speech-2-6: evolution step set to BST 353 -> 382
- doubao-seed-1-8 -> doubao-seed-2-0-code: evolution step set to BST 444 -> 480
- doubao-seed-2-0-lite -> doubao-seed-2-1-turbo: evolution step set to BST 361 -> 390
- hunyuan-large -> hunyuan-turbos: evolution step set to BST 364 -> 394
- hunyuanworld-1-0 -> hunyuanworld-1-5: evolution step set to BST 368 -> 398
- kling-2-5-turbo -> kling-2-6: evolution step set to BST 449 -> 485
- mimo-v2-pro -> mimo-v2-5-pro: evolution step set to BST 452 -> 489
- yi-1-5 -> yi-lightning: evolution step set to BST 364 -> 394
- internlm2-5 -> internlm3: evolution step set to BST 361 -> 390
- skyreels-v2 -> skyreels-v3: evolution step set to BST 435 -> 470
- skyreels-v3 -> skyreels: evolution step set to BST 453 -> 490
- step-2 -> step-3: evolution step set to BST 357 -> 386
- command-r-plus -> command-a: evolution step set to BST 364 -> 394
- sonar-pro -> sonar-pro-search: evolution step set to BST 441 -> 477
- nano-banana -> nano-banana-2: evolution step set to BST 485 -> 524
- nano-banana-2 -> nano-banana-2-1: evolution step set to BST 509 -> 550
- qwen3-7 -> qwen3-8-max: evolution step set to BST 550 -> 594
- skyreels-v2 -> skyreels-v3: evolution step set to BST 435 -> 470
- skyreels-v3 -> skyreels: evolution step set to BST 453 -> 490
- nano-banana -> nano-banana-2: evolution step set to BST 485 -> 524
- nano-banana-2 -> nano-banana-2-1: evolution step set to BST 509 -> 550
- skyreels-v2 -> skyreels-v3: evolution step set to BST 435 -> 470
- skyreels-v3 -> skyreels: evolution step set to BST 453 -> 490

## 全图鉴

| # | 名称 | 公司 | 国家 | 属性 | 稀有度 | BST | 进化 |
|---|---|---|---|---|---|---|---|
| 1 | GPT-3.5 | OpenAI | US | 对话 | N | 298 | → GPT-4 Lv18 |
| 2 | GPT-4 | OpenAI | US | 对话/推理 | R | 370 | ← GPT-3.5；→ GPT-4o Lv34 |
| 3 | GPT-4o | OpenAI | US | 对话/音律 | SR | 443 | ← GPT-4 |
| 4 | ChatGPT（超级应用） | OpenAI | US | 对话/智能体 | UR | 615 | — |
| 5 | o1 | OpenAI | US | 推理 | R | 348 | → o3 Lv16 |
| 6 | o3 | OpenAI | US | 推理/代码 | SR | 448 | ← o1；→ OpenAI Codex（编程智能体） Lv40 |
| 7 | OpenAI Codex（编程智能体） | OpenAI | US | 代码/智能体 | UR | 623 | ← o3 |
| 8 | GPT-4.1 | OpenAI | US | 代码/对话 | SR | 441 | → GPT-5 Lv24 |
| 9 | GPT-5 | OpenAI | US | 推理/对话 | SSR | 512 | ← GPT-4.1；→ GPT-6 Astra（星） Lv36 |
| 10 | GPT-6 Astra（星） | OpenAI | US | 推理/算力 | UR | 612 | ← GPT-5 |
| 11 | GPT-5.4 | OpenAI | US | 推理/对话 | SR | 478 | → GPT-5.5「土豆」 Lv28 |
| 12 | GPT-5.5「土豆」 | OpenAI | US | 推理/幻觉 | SSR | 520 | ← GPT-5.4 |
| 13 | GPT-5.6（日 / 地 / 月） | OpenAI | US | 推理/对齐 | SSR | 545 | → GPT-6.1 Sol（日） Lv40 |
| 14 | GPT-6.1 Sol（日） | OpenAI | US | 代码/推理 | UR | 600 | ← GPT-5.6（日 / 地 / 月） |
| 15 | GPT-5.6 Luna | OpenAI | US | 算力/对话 | R | 375 | → GPT-6 Luna（月） Lv23 |
| 16 | GPT-6 Luna（月） | OpenAI | US | 算力/对话 | SR | 485 | ← GPT-5.6 Luna |
| 17 | Codex 初代 | OpenAI | US | 代码 | N | 268 | — |
| 18 | gpt-oss-120b | OpenAI | US | 开源/推理 | R | 395 | → gpt-oss-safeguard-120b Lv29 |
| 19 | gpt-oss-safeguard-120b | OpenAI | US | 开源/对齐 | SR | 447 | ← gpt-oss-120b |
| 20 | DALL·E | OpenAI | US | 视觉 | R | 360 | → GPT Image 1（吉卜力风暴） Lv22 |
| 21 | GPT Image 1（吉卜力风暴） | OpenAI | US | 视觉/对话 | SR | 475 | ← DALL·E；→ GPT Image 2.5 Lv44 |
| 22 | GPT Image 2.5 | OpenAI | US | 视觉/推理 | UR | 623 | ← GPT Image 1（吉卜力风暴） |
| 23 | Sora（初代） | OpenAI | US | 影像 | R | 405 | → Sora 2（已停服） Lv30 |
| 24 | Sora 2（已停服） | OpenAI | US | 影像/幻觉 | SSR | 527 | ← Sora（初代） |
| 25 | ChatGPT Agent | OpenAI | US | 智能体/对话 | SR | 472 | → ChatGPT dots（常驻智能体） Lv28 |
| 26 | ChatGPT dots（常驻智能体） | OpenAI | US | 智能体 | SSR | 545 | ← ChatGPT Agent |
| 27 | Claude Haiku 4.5 | Anthropic | US | 代码 | R | 348 | → Claude Haiku 5.5 Lv16 |
| 28 | Claude Haiku 5.5 | Anthropic | US | 代码/智能体 | SR | 440 | ← Claude Haiku 4.5 |
| 29 | Claude 3 Opus | Anthropic | US | 创作/对齐 | R | 365 | → Claude Opus 4.8 Lv24 |
| 30 | Claude Opus 4.8 | Anthropic | US | 代码/对齐 | SSR | 512 | ← Claude 3 Opus；→ Claude Opus 5.5 Lv36 |
| 31 | Claude Opus 5.5 | Anthropic | US | 代码/推理 | UR | 630 | ← Claude Opus 4.8 |
| 32 | Claude 3 Sonnet | Anthropic | US | 对话/对齐 | R | 368 | → Claude 3.5 Sonnet Lv26 |
| 33 | Claude 3.5 Sonnet | Anthropic | US | 代码/创作 | SR | 436 | ← Claude 3 Sonnet；→ Claude Sonnet 5.5 Lv40 |
| 34 | Claude Sonnet 5.5 | Anthropic | US | 代码/创作 | UR | 622 | ← Claude 3.5 Sonnet |
| 35 | Claude Fable 5 | Anthropic | US | 推理/对齐 | SSR | 528 | → Claude Fable 5.1 Lv36 |
| 36 | Claude Fable 5.1 | Anthropic | US | 推理/对齐 | UR | 612 | ← Claude Fable 5 |
| 37 | Claude Mythos Preview | Anthropic | US | 代码/对齐 | SSR | 548 | — |
| 38 | Claude Mythos 5.1 | Anthropic | US | 代码/幻觉 | MYTHIC | 656 | — |
| 39 | Claude Code | Anthropic | US | 代码/智能体 | UR | 625 | — |
| 40 | Claude Computer Use | Anthropic | US | 智能体/视觉 | R | 392 | → Claude 应用（Cowork 合体） Lv28 |
| 41 | Claude 应用（Cowork 合体） | Anthropic | US | 智能体/创作 | SSR | 545 | ← Claude Computer Use |
| 42 | Gemini 3.5 Flash-Lite | Google | US | 算力 | R | 403 | — |
| 43 | Gemini 3.6 Flash | Google | US | 算力/智能体 | SR | 455 | → Gemini 3.7 Flash Lv32 |
| 44 | Gemini 3.7 Flash | Google | US | 算力/智能体 | SSR | 509 | ← Gemini 3.6 Flash；→ Gemini 3.8 Flash Lv44 |
| 45 | Gemini 3.8 Flash | Google | US | 算力/推理 | SSR | 550 | ← Gemini 3.7 Flash |
| 46 | Gemini 3.1 Pro Preview | Google | US | 推理/视觉 | SR | 470 | → Gemini 4 Argon（氩） Lv48 |
| 47 | Gemini 4 Argon（氩） | Google | US | 推理/对齐 | UR | 613 | ← Gemini 3.1 Pro Preview |
| 48 | Gemini 3.1 Flash Live | Google | US | 音律/对话 | R | 375 | → Gemini 3.8 Live Lv37 |
| 49 | Gemini 3.8 Live | Google | US | 音律/对话 | SSR | 535 | ← Gemini 3.1 Flash Live |
| 50 | Gemini 1.5 Pro | Google | US | 检索/视觉 | R | 366 | → Gemini 2.5 Pro Lv26 |
| 51 | Gemini 2.5 Pro | Google | US | 推理/代码 | SR | 440 | ← Gemini 1.5 Pro；→ Gemini 3 Pro Lv40 |
| 52 | Gemini 3 Pro | Google | US | 推理/视觉 | SSR | 526 | ← Gemini 2.5 Pro |
| 53 | Gemma 2 | Google | US | 开源/对话 | N | 277 | → Gemma 3 Lv23 |
| 54 | Gemma 3 | Google | US | 开源/视觉 | R | 372 | ← Gemma 2；→ Gemma 4 Lv30 |
| 55 | Gemma 4 | Google | US | 开源/视觉 | SR | 470 | ← Gemma 3 |
| 56 | Nano Banana 纳米香蕉 | Google | US | 视觉 | SR | 485 | → Nano Banana 2 Lv34 |
| 57 | Nano Banana 2 | Google | US | 视觉/算力 | SSR | 509 | ← Nano Banana 纳米香蕉；→ Nano Banana 2.1 Lv46 |
| 58 | Nano Banana 2.1 | Google | US | 视觉/算力 | SSR | 550 | ← Nano Banana 2 |
| 59 | Veo 3 | Google | US | 影像/音律 | SR | 453 | → Veo 3.1 Lv26 |
| 60 | Veo 3.1 | Google | US | 影像/音律 | SR | 490 | ← Veo 3；→ Gemini Omni 1.1 Flash Lv40 |
| 61 | Gemini Omni 1.1 Flash | Google | US | 影像/视觉 | SSR | 545 | ← Veo 3.1 |
| 62 | Lyria 2 | Google | US | 音律 | R | 385 | → Lyria 3 Lv22 |
| 63 | Lyria 3 | Google | US | 音律/创作 | SR | 452 | ← Lyria 2；→ Lyria 3.5 Lv38 |
| 64 | Lyria 3.5 | Google | US | 音律/创作 | SR | 489 | ← Lyria 3 |
| 65 | Genie | Google DeepMind | US | 影像/幻觉 | R | 350 | → Genie 2 Lv31 |
| 66 | Genie 2 | Google DeepMind | US | 影像/视觉 | SR | 434 | ← Genie；→ Genie 3 精灵世界 Lv45 |
| 67 | Genie 3 精灵世界 | Google | US | 影像/智能体 | UR | 600 | ← Genie 2 |
| 68 | NotebookLM | Google | US | 检索/创作 | SSR | 545 | — |
| 69 | Gemini CLI | Google | US | 代码/智能体 | R | 395 | → Google Antigravity 反重力 Lv30 |
| 70 | Google Antigravity 反重力 | Google | US | 代码/智能体 | SSR | 545 | ← Gemini CLI |
| 71 | Gemini Robotics | Google DeepMind | US | 智能体/视觉 | R | 379 | → Gemini Robotics 1.5 Lv31 |
| 72 | Gemini Robotics 1.5 | Google DeepMind | US | 智能体/视觉 | SR | 452 | ← Gemini Robotics；→ Gemini Robotics 2 Lv39 |
| 73 | Gemini Robotics 2 | Google | US | 智能体/影像 | SSR | 530 | ← Gemini Robotics 1.5 |
| 74 | 阿尔法（AlphaGo / AlphaFold） | Google DeepMind | UK | 推理/检索 | MYTHIC | 665 | — |
| 75 | Grok-1 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | N | 290 | → Grok 4 Lv24 |
| 76 | Grok 4 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 464 | ← Grok-1；→ Grok 4.7 Lv44 |
| 77 | Grok 4.7 | SpaceXAI (formerly xAI) | US | 推理/代码 | UR | 583 | ← Grok 4 |
| 78 | Ani（Grok 陪伴） | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 400 | — |
| 79 | Grok Imagine | SpaceXAI (formerly xAI) | US | 影像/音律 | SSR | 545 | — |
| 80 | LLaMA 初代 | Meta | US | 开源 | N | 260 | → Llama 3.1 405B Lv20 |
| 81 | Llama 3.1 405B | Meta | US | 开源/推理 | R | 367 | ← LLaMA 初代；→ Llama 4（Scout / Maverick） Lv38 |
| 82 | Llama 4（Scout / Maverick） | Meta | US | 开源/幻觉 | R | 397 | ← Llama 3.1 405B |
| 83 | Muse Spark 1.1 | Meta | US | 推理/视觉 | SR | 449 | → Muse Spark 1.2 Lv30 |
| 84 | Muse Spark 1.2 | Meta | US | 推理/视觉 | SR | 485 | ← Muse Spark 1.1；→ Muse Spark 灵感火花 Lv47 |
| 85 | Muse Spark 灵感火花 | Meta | US | 推理/视觉 | UR | 592 | ← Muse Spark 1.2 |
| 86 | Meta Muse 个人智能体 | Meta | US | 智能体/对话 | SSR | 545 | — |
| 87 | Moltbook 智能体论坛 | Meta (acquired) | US | 幻觉/对话 | R | 387 | — |
| 88 | Mistral 7B | Mistral AI | FR | 开源/算力 | N | 265 | → Mixtral 8x7B Lv18 |
| 89 | Mixtral 8x7B | Mistral AI | FR | 开源/算力 | R | 350 | ← Mistral 7B |
| 90 | Mistral Medium 3.5 | Mistral AI | FR | 开源/代码 | R | 400 | — |
| 91 | Phi-3 | Microsoft | US | 推理 | N | 300 | → Phi-4 Lv22 |
| 92 | Phi-4 | Microsoft | US | 推理/算力 | R | 362 | ← Phi-3；→ Phi-4-reasoning Lv38 |
| 93 | Phi-4-reasoning | Microsoft | US | 推理/开源 | SR | 438 | ← Phi-4 |
| 94 | MAI-Thinking-1 | Microsoft | US | 推理/代码 | SR | 478 | — |
| 95 | MAI-Image-1 | Microsoft | US | 视觉 | R | 375 | → MAI-Image-2 Lv32 |
| 96 | MAI-Image-2 | Microsoft | US | 视觉/创作 | SR | 449 | ← MAI-Image-1；→ MAI-Image-2.6 Lv39 |
| 97 | MAI-Image-2.6 | Microsoft | US | 视觉/检索 | SSR | 530 | ← MAI-Image-2 |
| 98 | GitHub Copilot | GitHub (Microsoft) | US | 代码/智能体 | SSR | 545 | — |
| 99 | Amazon Kiro | Amazon (AWS) | US | 代码/幻觉 | SR | 470 | — |
| 100 | Nemotron 3 Ultra | NVIDIA | US | 开源/算力 | SR | 478 | — |
| 101 | Apple 智能（基础模型 3） | Apple | US | 对话/对齐 | SR | 462 | — |
| 102 | Sakana Fugu 河豚 | Sakana AI | JP | 智能体/推理 | SR | 485 | — |
| 103 | Solar Pro 4 | Upstage | KR | 智能体/检索 | R | 388 | — |
| 104 | Inkling 灵念 | Thinking Machines Lab | US | 开源/视觉 | SR | 480 | — |
| 105 | Midjourney V5 | Midjourney | US | 视觉 | R | 373 | → Midjourney V7 Lv24 |
| 106 | Midjourney V7 | Midjourney | US | 视觉/创作 | SR | 476 | ← Midjourney V5；→ Midjourney V8 Lv42 |
| 107 | Midjourney V8 | Midjourney | US | 视觉/创作 | SSR | 542 | ← Midjourney V7 |
| 108 | Stable Diffusion 1.x | Stability AI | UK | 视觉/开源 | N | 270 | → SDXL Lv20 |
| 109 | SDXL | Stability AI | UK | 视觉/开源 | R | 352 | ← Stable Diffusion 1.x；→ Stable Diffusion 3.5 Lv34 |
| 110 | Stable Diffusion 3.5 | Stability AI | UK | 视觉/开源 | SR | 440 | ← SDXL |
| 111 | FLUX.1 | Black Forest Labs | DE | 视觉/开源 | R | 390 | → FLUX.2 Lv24 |
| 112 | FLUX.2 | Black Forest Labs | DE | 视觉/开源 | SR | 470 | ← FLUX.1；→ FLUX 3 Lv40 |
| 113 | FLUX 3 | Black Forest Labs | DE | 影像/视觉 | SSR | 545 | ← FLUX.2 |
| 114 | Runway Gen-4 | Runway | US | 影像/创作 | SR | 438 | → Runway Gen-4.5 Lv30 |
| 115 | Runway Gen-4.5 | Runway | US | 影像/创作 | SR | 474 | ← Runway Gen-4 |
| 116 | Luma Dream Machine (Ray1) | Luma AI | US | 影像 | R | 357 | → Luma Ray2 Lv22 |
| 117 | Luma Ray2 | Luma AI | US | 影像/视觉 | R | 386 | ← Luma Dream Machine (Ray1)；→ Luma Ray3 Lv30 |
| 118 | Luma Ray3 | Luma AI | US | 影像/视觉 | SR | 465 | ← Luma Ray2 |
| 119 | Suno v3 | Suno | US | 音律/创作 | R | 379 | → Suno v5 Lv24 |
| 120 | Suno v5 | Suno | US | 音律/创作 | SR | 485 | ← Suno v3；→ Suno v6 Lv44 |
| 121 | Suno v6 | Suno | US | 音律/创作 | UR | 615 | ← Suno v5 |
| 122 | ElevenLabs 多语言 v2 | ElevenLabs | US | 音律/对话 | R | 415 | → Eleven v3 Lv26 |
| 123 | Eleven v3 | ElevenLabs | US | 音律/对话 | SR | 478 | ← ElevenLabs 多语言 v2；→ Eleven v4 Lv42 |
| 124 | Eleven v4 | ElevenLabs | US | 音律/对话 | UR | 574 | ← Eleven v3 |
| 125 | Marble 世界大理石 | World Labs | US | 视觉/影像 | SSR | 537 | — |
| 126 | Cursor | Anysphere (SpaceX / SpaceXAI) | US | 代码/智能体 | UR | 608 | — |
| 127 | Windsurf 风帆 | Codeium -> Cognition | US | 代码/智能体 | SR | 472 | — |
| 128 | Devin（AI 软件工程师） | Cognition | US | 智能体/代码 | SSR | 545 | — |
| 129 | Replit Agent | Replit | US | 代码/智能体 | SR | 485 | — |
| 130 | Lovable | Lovable | SE | 代码/创作 | SSR | 539 | — |
| 131 | OpenCode | Anomaly (formerly SST) | US | 开源/代码 | SSR | 544 | — |
| 132 | Manus | Butterfly Effect (Meta deal being unwound) | SG | 智能体 | SR | 485 | → Manus 2.0（Manus Studio） Lv32 |
| 133 | Manus 2.0（Manus Studio） | Butterfly Effect (Meta deal being unwound) | SG | 智能体/算力 | SSR | 545 | ← Manus |
| 134 | Perplexity | Perplexity AI | US | 检索 | SR | 453 | → Comet 彗星浏览器 Lv28 |
| 135 | Comet 彗星浏览器 | Perplexity AI | US | 检索/智能体 | SR | 490 | ← Perplexity；→ Perplexity Computer Lv40 |
| 136 | Perplexity Computer | Perplexity AI | US | 检索/智能体 | SSR | 542 | ← Comet 彗星浏览器 |
| 137 | Character.AI | Character Technologies | US | 对话/创作 | R | 415 | — |
| 138 | Neuro-sama（牛肉） | Vedal (independent) | UK | 对话/幻觉 | SR | 470 | — |
| 139 | Clawdbot | Peter Steinberger (community) | AT | 智能体/开源 | R | 415 | → Moltbot（蜕壳期） Lv18 |
| 140 | Moltbot（蜕壳期） | Peter Steinberger (community) | AT | 智能体/开源 | SR | 480 | ← Clawdbot；→ OpenClaw 小龙虾 Lv36 |
| 141 | OpenClaw 小龙虾 | OpenClaw Foundation | AT | 智能体/开源 | UR | 607 | ← Moltbot（蜕壳期） |
| 142 | Hermes Agent 爱马仕智能体 | Nous Research | US | 智能体/开源 | SSR | 545 | — |
| 143 | AutoGPT | Significant Gravitas | UK | 智能体/幻觉 | R | 391 | — |
| 144 | LangChain | LangChain | US | 智能体/开源 | SR | 485 | → LangGraph Lv32 |
| 145 | LangGraph | LangChain | US | 智能体/开源 | SSR | 524 | ← LangChain |
| 146 | Figure 03 | Figure AI | US | 智能体/视觉 | SSR | 545 | — |
| 147 | 特斯拉 Optimus | Tesla | US | 智能体/算力 | SR | 485 | — |
| 148 | π0.5 | Physical Intelligence | US | 智能体/视觉 | R | 386 | → π*0.6 Lv30 |
| 149 | π*0.6 | Physical Intelligence | US | 智能体/视觉 | SR | 458 | ← π0.5；→ π0.7 物理智能 Lv38 |
| 150 | π0.7 物理智能 | Physical Intelligence | US | 智能体/开源 | SSR | 530 | ← π*0.6 |
| 151 | AGI 奇点 | Unknown (all labs) | INTL | 推理/对齐 | MYTHIC | 715 | — |
| 152 | DeepSeek-V3 | DeepSeek | CN | 算力 | R | 348 | → DeepSeek-R1 深度思考 Lv16 |
| 153 | DeepSeek-R1 深度思考 | DeepSeek | CN | 推理/开源 | SSR | 509 | ← DeepSeek-V3；→ DeepSeek-R1-0528 Lv36 |
| 154 | DeepSeek-R1-0528 | DeepSeek | CN | 推理/开源 | SSR | 550 | ← DeepSeek-R1 深度思考 |
| 155 | DeepSeek-V3.1 | DeepSeek | CN | 算力/推理 | R | 372 | → DeepSeek-V3.2 Lv22 |
| 156 | DeepSeek-V3.2 | DeepSeek | CN | 算力/推理 | SR | 450 | ← DeepSeek-V3.1；→ DeepSeek-V4 / V4.1 Lv38 |
| 157 | DeepSeek-V4 / V4.1 | DeepSeek | CN | 开源/推理 | UR | 585 | ← DeepSeek-V3.2 |
| 158 | DeepSeek Harness 虎鲸 | DeepSeek | CN | 智能体/开源 | SSR | 531 | — |
| 159 | 通义千问 1.0 | Alibaba | CN | 对话/开源 | N | 258 | → 通义千问 2.5 Lv18 |
| 160 | 通义千问 2.5 | Alibaba | CN | 开源 | R | 352 | ← 通义千问 1.0 |
| 161 | 通义千问 Qwen3-Max-Thinking | Alibaba (Qwen) | CN | 推理/对话 | SSR | 509 | → 通义千问 Qwen3.7-Max Lv30 |
| 162 | 通义千问 Qwen3.7-Max | Alibaba | CN | 开源/推理 | SSR | 550 | ← 通义千问 Qwen3-Max-Thinking；→ 通义千问 3.8-Max Lv44 |
| 163 | 通义千问 3.8-Max | Alibaba | CN | 推理/智能体 | UR | 594 | ← 通义千问 Qwen3.7-Max |
| 164 | Qwen3.8-Flash-Next | Alibaba | CN | 算力/开源 | SSR | 521 | — |
| 165 | 千问 App | Alibaba | CN | 对话/智能体 | SSR | 545 | — |
| 166 | 千问图像 3.1 | Alibaba (Qwen) | CN | 视觉/创作 | SR | 488 | — |
| 167 | 千问语音 3.1 | Alibaba (Qwen) | CN | 音律/对话 | SSR | 540 | — |
| 168 | 通义万相 2.1 | Alibaba (Tongyi) | CN | 影像/开源 | R | 388 | → 通义万相 2.2 Lv24 |
| 169 | 通义万相 2.2 | Alibaba (Tongyi) | CN | 影像/开源 | SR | 455 | ← 通义万相 2.1；→ 通义万相 3.0 Lv42 |
| 170 | 通义万相 3.0 | Alibaba (Tongyi) | CN | 影像/音律 | UR | 610 | ← 通义万相 2.2 |
| 171 | 快乐小马 HappyHorse | Alibaba ATH (Taotian Future Life Lab) | CN | 影像/算力 | SR | 478 | — |
| 172 | 快乐生蚝 HappyOyster | Alibaba ATH | CN | 影像/智能体 | SR | 475 | — |
| 173 | 快乐虾米 HappyShrimp | Alibaba ATH | CN | 音律/创作 | SR | 465 | — |
| 174 | Qoder | Alibaba | CN | 代码/智能体 | SR | 485 | — |
| 175 | Kimi 智能助手 | Moonshot AI | CN | 对话/检索 | R | 357 | → Kimi K2 Lv24 |
| 176 | Kimi K2 | Moonshot AI | CN | 智能体/开源 | SR | 448 | ← Kimi 智能助手；→ Kimi K3 Lv44 |
| 177 | Kimi K3 | Moonshot AI | CN | 开源/智能体 | UR | 574 | ← Kimi K2 |
| 178 | Kimi Work | Moonshot AI | CN | 智能体 | SSR | 539 | — |
| 179 | ChatGLM-6B | Zhipu AI (Z.ai) | CN | 对话/开源 | N | 277 | → GLM-4.5 Lv22 |
| 180 | GLM-4.5 | Zhipu AI (Z.ai) | CN | 智能体/开源 | SR | 442 | ← ChatGLM-6B；→ GLM-5.3 Lv42 |
| 181 | GLM-5.3 | Zhipu AI (Z.ai) | CN | 代码/开源 | UR | 574 | ← GLM-4.5 |
| 182 | AutoGLM | Zhipu AI (Z.ai) | CN | 智能体/视觉 | SR | 484 | — |
| 183 | 豆包大模型 Pro | ByteDance | CN | 对话/算力 | N | 294 | → 豆包 Seed 2.0 Lv20 |
| 184 | 豆包 Seed 2.0 | ByteDance | CN | 智能体/算力 | SR | 469 | ← 豆包大模型 Pro；→ 豆包 Seed 2.1 Pro Lv42 |
| 185 | 豆包 Seed 2.1 Pro | ByteDance | CN | 智能体/视觉 | SSR | 526 | ← 豆包 Seed 2.0 |
| 186 | 豆包 | ByteDance | CN | 对话/音律 | UR | 590 | — |
| 187 | 即梦 Seedream 3.0 | ByteDance Seed | CN | 视觉/创作 | R | 407 | → 即梦 Seedream 4.0 Lv22 |
| 188 | 即梦 Seedream 4.0 | ByteDance Seed | CN | 视觉/创作 | SR | 458 | ← 即梦 Seedream 3.0；→ 即梦 Seedream 5.0 Lv38 |
| 189 | 即梦 Seedream 5.0 | ByteDance Seed | CN | 视觉/推理 | SSR | 505 | ← 即梦 Seedream 4.0 |
| 190 | 即梦 Seedance 1.0 | ByteDance Seed | CN | 影像 | SR | 462 | → 即梦 Seedance 2.0 Lv26 |
| 191 | 即梦 Seedance 2.0 | ByteDance Seed | CN | 影像/幻觉 | SSR | 545 | ← 即梦 Seedance 1.0；→ 即梦 Seedance 2.5 Lv46 |
| 192 | 即梦 Seedance 2.5 | ByteDance Seed | CN | 影像/音律 | UR | 612 | ← 即梦 Seedance 2.0 |
| 193 | Trae | ByteDance | CN | 代码/智能体 | SR | 485 | — |
| 194 | 扣子 Coze | ByteDance | CN | 智能体/创作 | SSR | 537 | — |
| 195 | 腾讯混元 | Tencent | CN | 对话 | N | 285 | → 混元 Hy3 Lv24 |
| 196 | 混元 Hy3 | Tencent | CN | 推理/开源 | SR | 456 | ← 腾讯混元；→ 混元 Hy4 Preview Lv44 |
| 197 | 混元 Hy4 Preview | Tencent | CN | 智能体/开源 | SSR | 525 | ← 混元 Hy3 |
| 198 | 腾讯元宝 | Tencent | CN | 对话/检索 | SSR | 528 | — |
| 199 | 混元生图 3.0 | Tencent Hunyuan | CN | 视觉/开源 | SR | 450 | → 混元生图 3.5（预览） Lv30 |
| 200 | 混元生图 3.5（预览） | Tencent Hunyuan | CN | 视觉/开源 | SR | 487 | ← 混元生图 3.0 |
| 201 | WorkBuddy | Tencent | CN | 智能体/对话 | SSR | 538 | — |
| 202 | 文心一言 3.5 | Baidu | CN | 对话/检索 | N | 265 | → 文心 4.5 Lv22 |
| 203 | 文心 4.5 | Baidu | CN | 视觉/开源 | R | 362 | ← 文心一言 3.5；→ 文心 5.1 Preview Lv40 |
| 204 | 文心 5.1 Preview | Baidu | CN | 对话/算力 | SR | 466 | ← 文心 4.5 |
| 205 | 阶跃 Step 3.5 Flash | StepFun | CN | 算力/开源 | R | 374 | → 阶跃 Step 3.7 Flash Lv24 |
| 206 | 阶跃 Step 3.7 Flash | StepFun | CN | 算力/开源 | SR | 452 | ← 阶跃 Step 3.5 Flash；→ 阶跃 Step 5 Preview Lv40 |
| 207 | 阶跃 Step 5 Preview | StepFun | CN | 智能体/视觉 | SSR | 542 | ← 阶跃 Step 3.7 Flash |
| 208 | 讯飞星火 V4.0 | iFlytek | CN | 音律/对话 | N | 266 | → 讯飞星火 X2.5 Lv28 |
| 209 | 讯飞星火 X2.5 | iFlytek | CN | 推理/算力 | R | 390 | ← 讯飞星火 V4.0 |
| 210 | 商汤日日新 6.7 Flash-Lite | SenseTime | CN | 视觉/创作 | R | 370 | — |
| 211 | 百川 2 | Baichuan AI | CN | 对话/开源 | N | 258 | — |
| 212 | 百川 M3 | Baichuan AI | CN | 对齐/检索 | R | 385 | — |
| 213 | 小米 MiMo-7B | Xiaomi | CN | 推理/开源 | N | 272 | → MiMo-V2-Flash Lv22 |
| 214 | MiMo-V2-Flash | Xiaomi | CN | 算力/开源 | SR | 434 | ← 小米 MiMo-7B |
| 215 | MiMo-V2-Pro | Xiaomi | CN | 智能体/推理 | SR | 452 | → MiMo-V2.5-Pro Lv29 |
| 216 | MiMo-V2.5-Pro | Xiaomi | CN | 智能体/推理 | SR | 489 | ← MiMo-V2-Pro；→ MiMo-V2.6-Pro Lv44 |
| 217 | MiMo-V2.6-Pro | Xiaomi | CN | 开源/推理 | UR | 580 | ← MiMo-V2.5-Pro |
| 218 | 美团 LongCat-Flash | Meituan | CN | 算力/智能体 | R | 379 | → 美团 LongCat 2.0 Lv24 |
| 219 | 美团 LongCat 2.0 | Meituan | CN | 智能体/算力 | SR | 435 | ← 美团 LongCat-Flash；→ 美团龙猫 LongCat-2.5 Lv40 |
| 220 | 美团龙猫 LongCat-2.5 | Meituan | CN | 智能体/视觉 | SR | 470 | ← 美团 LongCat 2.0 |
| 221 | 蚂蚁百灵 Ling 3.0 / Ring 2.6 | Ant Group | CN | 推理/开源 | R | 371 | — |
| 222 | 蚂蚁阿福 | Ant Group | CN | 对话/对齐 | SSR | 520 | — |
| 223 | 可灵 1.0 | Kuaishou (Kling AI) | CN | 影像 | R | 351 | → 可灵 3.0 Lv28 |
| 224 | 可灵 3.0 | Kuaishou (Kling AI) | CN | 影像/音律 | SSR | 509 | ← 可灵 1.0；→ 可灵 4.0 Lv48 |
| 225 | 可灵 4.0 | Kling AI (Kuaishou spin-off) | CN | 影像/视觉 | SSR | 550 | ← 可灵 3.0 |
| 226 | 书生 Intern-S2 | Shanghai AI Laboratory | CN | 检索/推理 | R | 381 | — |
| 227 | 天工 Mureka V9 | Kunlun Tech (Skywork AI) | CN | 音律/创作 | SR | 482 | — |
| 228 | SkyReels V2 | Skywork AI (Kunlun Tech) | CN | 影像/开源 | SR | 435 | → SkyReels V3 Lv32 |
| 229 | SkyReels V3 | Skywork AI (Kunlun Tech) | CN | 影像/开源 | SR | 453 | ← SkyReels V2；→ 天工 SkyReels V4 Lv39 |
| 230 | 天工 SkyReels V4 | Skywork AI (Kunlun Tech) | CN | 影像/创作 | SR | 490 | ← SkyReels V3 |
| 231 | 华为盘古 5.5 | Huawei | CN | 对齐/算力 | N | 296 | — |
| 232 | 华为 openPangu 2.0 Pro | Huawei | CN | 开源/算力 | R | 379 | — |
| 233 | 面壁 MiniCPM | ModelBest | CN | 算力/开源 | R | 354 | — |
| 234 | 生数 Vidu | ShengShu Technology | CN | 影像 | R | 352 | → 生数 Vidu Q3 Lv30 |
| 235 | 生数 Vidu Q3 | ShengShu Technology | CN | 影像/创作 | SR | 477 | ← 生数 Vidu |
| 236 | 拍我AI PixVerse V6 | PixVerse (爱诗科技) | CN | 影像/智能体 | SR | 479 | — |
| 237 | MiniMax abab6.5 | MiniMax | CN | 对话/创作 | N | 260 | → MiniMax-M2 Lv24 |
| 238 | MiniMax-M2 | MiniMax | CN | 代码/开源 | R | 380 | ← MiniMax abab6.5；→ MiniMax-M3 Lv40 |
| 239 | MiniMax-M3 | MiniMax | CN | 代码/视觉 | SR | 461 | ← MiniMax-M2 |
| 240 | 海螺 Video-01 | MiniMax | CN | 影像 | R | 358 | → 海螺 02 Lv24 |
| 241 | 海螺 02 | MiniMax | CN | 影像 | SR | 455 | ← 海螺 Video-01；→ 海螺 H3 Lv40 |
| 242 | 海螺 H3 | MiniMax | CN | 影像/开源 | UR | 574 | ← 海螺 02 |
| 243 | MiniMax 音乐 3.0 | MiniMax | CN | 音律/创作 | SR | 485 | — |
| 244 | Tripo H3.1 | VAST (Tripo AI) | CN | 视觉/算力 | SR | 485 | — |
| 245 | 宇树 H1 | Unitree Robotics | CN | 影像/智能体 | R | 375 | → 宇树 G1/H2 Lv37 |
| 246 | 宇树 G1/H2 | Unitree Robotics | CN | 智能体/算力 | SSR | 543 | ← 宇树 H1 |
| 247 | 宇树 GD01 载人机甲 | Unitree Robotics | CN | 算力/智能体 | UR | 574 | — |
| 248 | 智元机器人 | AgiBot | CN | 智能体/视觉 | SSR | 541 | — |
| 249 | o3-mini | OpenAI | US | 推理 | R | 368 | — |
| 250 | o3-pro | OpenAI | US | 推理/算力 | SR | 486 | — |
| 251 | GPT-5.3-Codex | OpenAI | US | 代码/智能体 | SSR | 520 | — |
| 252 | Claude Opus 4 | Anthropic | US | 代码/对齐 | R | 400 | → Claude Opus 4.5 Lv22 |
| 253 | Claude Opus 4.5 | Anthropic | US | 代码/对齐 | SR | 458 | ← Claude Opus 4；→ Claude Opus 4.7 Lv40 |
| 254 | Claude Opus 4.7 | Anthropic | US | 代码/推理 | SSR | 515 | ← Claude Opus 4.5 |
| 255 | Claude Sonnet 4.5 | Anthropic | US | 代码/创作 | SR | 450 | → Claude Sonnet 5 Lv34 |
| 256 | Claude Sonnet 5 | Anthropic | US | 代码/创作 | SSR | 530 | ← Claude Sonnet 4.5 |
| 257 | Claude 3 Haiku | Anthropic | US | 代码 | N | 295 | → Claude 3.5 Haiku Lv18 |
| 258 | Claude 3.5 Haiku | Anthropic | US | 代码 | R | 372 | ← Claude 3 Haiku |
| 259 | Gemini 2.5 Flash | Google | US | 算力 | R | 398 | → Gemini 3 Flash Lv24 |
| 260 | Gemini 3 Flash | Google | US | 算力/对话 | SR | 462 | ← Gemini 2.5 Flash；→ Gemini 3.5 Flash Lv40 |
| 261 | Gemini 3.5 Flash | Google | US | 算力/智能体 | SSR | 520 | ← Gemini 3 Flash |
| 262 | Grok Build | SpaceXAI (formerly xAI) | US | 代码/智能体 | SR | 462 | — |
| 263 | Grok 4.20 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SR | 470 | → Grok 4.5 Lv36 |
| 264 | Grok 4.5 | SpaceXAI (formerly xAI) | US | 推理/幻觉 | SSR | 525 | ← Grok 4.20 |
| 265 | Muse Image | Meta | US | 视觉/创作 | SR | 470 | — |
| 266 | Mistral Large 2 | Mistral AI | FR | 开源/对话 | R | 348 | → Mistral Large 3 Lv22 |
| 267 | Mistral Large 3 | Mistral AI | FR | 开源/推理 | R | 398 | ← Mistral Large 2；→ Mistral Large 4 Lv32 |
| 268 | Mistral Large 4 | Mistral AI | FR | 开源/推理 | SR | 460 | ← Mistral Large 3 |
| 269 | Devstral Medium | Mistral AI | FR | 代码/开源 | R | 389 | → Devstral 2 Lv28 |
| 270 | Devstral 2 | Mistral AI | FR | 代码/开源 | SR | 440 | ← Devstral Medium |
| 271 | Nemotron 3 Super | NVIDIA | US | 开源/算力 | SR | 440 | — |
| 272 | DeepSeek-V3.2-Speciale | DeepSeek | CN | 推理/开源 | SSR | 508 | — |
| 273 | DeepSeek 应用 | DeepSeek | CN | 对话/检索 | SSR | 530 | — |
| 274 | 通义千问 Qwen3 | Alibaba | CN | 开源/对话 | R | 378 | → 通义千问 Qwen3.5 Lv24 |
| 275 | 通义千问 Qwen3.5 | Alibaba | CN | 开源/视觉 | SR | 452 | ← 通义千问 Qwen3 |
| 276 | Qwen3-Coder | Alibaba | CN | 代码/开源 | SR | 440 | → Qwen3-Coder-Next Lv32 |
| 277 | Qwen3-Coder-Next | Alibaba | CN | 代码/智能体 | SSR | 502 | ← Qwen3-Coder |
| 278 | Kimi K2 Thinking | Moonshot AI | CN | 推理/智能体 | SR | 434 | → Kimi K2.5 Lv26 |
| 279 | Kimi K2.5 | Moonshot AI | CN | 智能体/视觉 | SR | 470 | ← Kimi K2 Thinking；→ Kimi K2.6 Lv40 |
| 280 | Kimi K2.6 | Moonshot AI | CN | 智能体/代码 | SSR | 515 | ← Kimi K2.5 |
| 281 | GLM-4.7 | Zhipu AI (Z.ai) | CN | 智能体/代码 | SR | 438 | → GLM-5 Lv26 |
| 282 | GLM-5 | Zhipu AI (Z.ai) | CN | 代码/开源 | SR | 478 | ← GLM-4.7；→ GLM-5.2 Lv40 |
| 283 | GLM-5.2 | Zhipu AI (Z.ai) | CN | 代码/开源 | SSR | 530 | ← GLM-5 |
| 284 | MiniMax-M2.1 | MiniMax | CN | 代码/开源 | R | 395 | → MiniMax-M2.7 Lv30 |
| 285 | MiniMax-M2.7 | MiniMax | CN | 代码/开源 | SR | 455 | ← MiniMax-M2.1 |
| 286 | GPT-4 Turbo | OpenAI | US | 对话/算力 | R | 361 | — |
| 287 | GPT-5.1 | OpenAI | US | 推理/对话 | SSR | 509 | → GPT-5.2 Lv37 |
| 288 | GPT-5.2 | OpenAI | US | 推理/算力 | SSR | 550 | ← GPT-5.1 |
| 289 | GPT-4o mini | OpenAI | US | 对话 | N | 285 | → GPT-5 mini Lv22 |
| 290 | GPT-5 mini | OpenAI | US | 对话/算力 | R | 371 | ← GPT-4o mini；→ GPT-5.4 mini Lv29 |
| 291 | GPT-5.4 mini | OpenAI | US | 对话/智能体 | SR | 448 | ← GPT-5 mini |
| 292 | GPT-4.1 nano | OpenAI | US | 算力 | N | 260 | → GPT-5 nano Lv18 |
| 293 | GPT-5 nano | OpenAI | US | 算力/对话 | N | 301 | ← GPT-4.1 nano；→ GPT-5.4 nano Lv25 |
| 294 | GPT-5.4 nano | OpenAI | US | 算力/智能体 | R | 357 | ← GPT-5 nano |
| 295 | GPT-5-Codex | OpenAI | US | 代码/智能体 | SR | 458 | → GPT-5.1-Codex-Max Lv37 |
| 296 | GPT-5.1-Codex-Max | OpenAI | US | 代码/智能体 | SSR | 509 | ← GPT-5-Codex；→ GPT-5.2-Codex Lv44 |
| 297 | GPT-5.2-Codex | OpenAI | US | 代码/推理 | SSR | 550 | ← GPT-5.1-Codex-Max |
| 298 | o4-mini | OpenAI | US | 推理/算力 | R | 386 | — |
| 299 | gpt-oss-20b | OpenAI | US | 开源/算力 | R | 364 | → gpt-oss-safeguard-20b Lv22 |
| 300 | gpt-oss-safeguard-20b | OpenAI | US | 开源/对齐 | R | 394 | ← gpt-oss-20b |
| 301 | GPT-5.6 Terra | OpenAI | US | 推理/创作 | SR | 463 | — |
| 302 | Claude 1 | Anthropic | US | 对话/对齐 | N | 258 | → Claude 2 Lv22 |
| 303 | Claude 2 | Anthropic | US | 对话/创作 | R | 348 | ← Claude 1 |
| 304 | Claude 3.7 Sonnet | Anthropic | US | 代码/创作 | R | 379 | → Claude Sonnet 4 Lv28 |
| 305 | Claude Sonnet 4 | Anthropic | US | 代码/创作 | SR | 444 | ← Claude 3.7 Sonnet；→ Claude Sonnet 4.6 Lv35 |
| 306 | Claude Sonnet 4.6 | Anthropic | US | 代码/智能体 | SR | 480 | ← Claude Sonnet 4 |
| 307 | Claude Opus 4.1 | Anthropic | US | 代码/对齐 | SR | 449 | → Claude Opus 4.6 Lv30 |
| 308 | Claude Opus 4.6 | Anthropic | US | 代码/推理 | SR | 485 | ← Claude Opus 4.1；→ Claude Opus 5 Lv37 |
| 309 | Claude Opus 5 | Anthropic | US | 代码/推理 | SSR | 537 | ← Claude Opus 4.6 |
| 310 | Grok-2 | SpaceXAI (formerly xAI) | US | 对话/幻觉 | R | 357 | → Grok 3 Lv29 |
| 311 | Grok 3 | SpaceXAI (formerly xAI) | US | 对话/推理 | SR | 444 | ← Grok-2；→ Grok 4.1 Fast Lv36 |
| 312 | Grok 4.1 Fast | SpaceXAI (formerly xAI) | US | 对话/算力 | SR | 480 | ← Grok 3 |
| 313 | Grok 4.3 | SpaceXAI (formerly xAI) | US | 对话/推理 | SR | 472 | → Grok 4.6 Lv36 |
| 314 | Grok 4.6 | SpaceXAI (formerly xAI) | US | 对话/推理 | SSR | 531 | ← Grok 4.3 |
| 315 | Llama 2 | Meta | US | 开源/对话 | N | 277 | → Llama 3 Lv24 |
| 316 | Llama 3 | Meta | US | 开源/对话 | R | 361 | ← Llama 2；→ Llama 3.3 Lv31 |
| 317 | Llama 3.3 | Meta | US | 开源/算力 | R | 397 | ← Llama 3 |
| 318 | Muse Glimmer | Meta | US | 对话/算力 | R | 375 | — |
| 319 | Muse Code | Meta | US | 代码/智能体 | SR | 444 | — |
| 320 | Mistral Small 3 | Mistral AI | FR | 开源/算力 | R | 348 | → Mistral Small 3.2 Lv21 |
| 321 | Mistral Small 3.2 | Mistral AI | FR | 开源/算力 | R | 376 | ← Mistral Small 3；→ Mistral Small 4 Lv28 |
| 322 | Mistral Small 4 | Mistral AI | FR | 开源/智能体 | SR | 441 | ← Mistral Small 3.2 |
| 323 | Devstral Small | Mistral AI | FR | 代码/开源 | R | 353 | — |
| 324 | Magistral Small | Mistral AI | FR | 推理/开源 | R | 357 | — |
| 325 | Magistral Medium | Mistral AI | FR | 推理/开源 | SR | 441 | — |
| 326 | Pixtral 12B | Mistral AI | FR | 视觉/开源 | N | 285 | → Pixtral Large Lv22 |
| 327 | Pixtral Large | Mistral AI | FR | 视觉/开源 | R | 364 | ← Pixtral 12B |
| 328 | MAI-1-preview | Microsoft | US | 对话/算力 | R | 368 | — |
| 329 | MAI-Code-1-Flash | Microsoft | US | 代码/算力 | R | 357 | → MAI-Code-1.1-Flash Lv20 |
| 330 | MAI-Code-1.1-Flash | Microsoft | US | 代码/算力 | R | 386 | ← MAI-Code-1-Flash |
| 331 | Gemini 1.0 | Google | US | 对话/视觉 | R | 350 | — |
| 332 | Gemini 2.0 Flash | Google | US | 算力/对话 | R | 368 | — |
| 333 | DiffusionGemma | Google | US | 开源/幻觉 | SR | 435 | — |
| 334 | Nano Banana Pro | Google | US | 视觉/创作 | SSR | 526 | — |
| 335 | Nano Banana 2 Lite | Google | US | 视觉/算力 | SR | 452 | — |
| 336 | Imagen 3 | Google | US | 视觉 | R | 368 | → Imagen 4 Lv30 |
| 337 | Imagen 4 | Google | US | 视觉/创作 | SR | 444 | ← Imagen 3 |
| 338 | Veo | Google | US | 影像 | R | 361 | → Veo 2 Lv28 |
| 339 | Veo 2 | Google | US | 影像/视觉 | SR | 438 | ← Veo |
| 340 | Gemini 2.5 Flash TTS | Google | US | 音律 | N | 285 | → Gemini 3.1 Flash TTS Lv22 |
| 341 | Gemini 3.1 Flash TTS | Google | US | 音律/对话 | R | 361 | ← Gemini 2.5 Flash TTS；→ Gemini 3.8 Flash TTS Lv29 |
| 342 | Gemini 3.8 Flash TTS | Google | US | 音律/对话 | SR | 438 | ← Gemini 3.1 Flash TTS |
| 343 | AlphaGo Zero | Google DeepMind | US | 推理/智能体 | SR | 455 | → AlphaZero Lv39 |
| 344 | AlphaZero | Google DeepMind | US | 推理/智能体 | SSR | 509 | ← AlphaGo Zero；→ MuZero Lv46 |
| 345 | MuZero | Google DeepMind | US | 推理/算力 | SSR | 550 | ← AlphaZero |
| 346 | DALL-E 2 | OpenAI | US | 视觉 | N | 285 | → DALL-E 3 Lv20 |
| 347 | DALL-E 3 | OpenAI | US | 视觉/创作 | R | 368 | ← DALL-E 2 |
| 348 | GPT Image 1.5 | OpenAI | US | 视觉/创作 | SR | 458 | → GPT Image 2 Lv37 |
| 349 | GPT Image 2 | OpenAI | US | 视觉/创作 | SSR | 509 | ← GPT Image 1.5；→ GPT Image 2.5 Flare Lv44 |
| 350 | GPT Image 2.5 Flare | OpenAI | US | 视觉/算力 | SSR | 550 | ← GPT Image 2 |
| 351 | Whisper large-v3 | OpenAI | US | 音律/开源 | N | 318 | → Whisper large-v3-turbo Lv23 |
| 352 | Whisper large-v3-turbo | OpenAI | US | 音律/开源 | R | 364 | ← Whisper large-v3 |
| 353 | gpt-realtime-2.1 | OpenAI | US | 音律/对话 | R | 379 | → GPT-Live-1 Lv30 |
| 354 | GPT-Live-1 | OpenAI | US | 音律/对话 | SR | 449 | ← gpt-realtime-2.1 |
| 355 | text-embedding-ada-002 | OpenAI | US | 检索/算力 | N | 277 | → text-embedding-3-small Lv18 |
| 356 | text-embedding-3-small | OpenAI | US | 检索/算力 | N | 310 | ← text-embedding-ada-002 |
| 357 | text-embedding-3-large | OpenAI | US | 检索/算力 | R | 364 | — |
| 358 | Grok Imagine Image | SpaceXAI (formerly xAI) | US | 视觉/幻觉 | R | 368 | → Grok Imagine Image 2.0 Lv31 |
| 359 | Grok Imagine Image 2.0 | SpaceXAI (formerly xAI) | US | 视觉/幻觉 | SR | 444 | ← Grok Imagine Image |
| 360 | Midjourney V1 | Midjourney | US | 视觉/幻觉 | N | 269 | → Midjourney V4 Lv20 |
| 361 | Midjourney V4 | Midjourney | US | 视觉/创作 | R | 364 | ← Midjourney V1 |
| 362 | Niji 6 | Midjourney | US | 视觉/创作 | R | 382 | → Niji 7 Lv30 |
| 363 | Niji 7 | Midjourney | US | 视觉/创作 | SR | 452 | ← Niji 6 |
| 364 | Midjourney Video V1 | Midjourney | US | 影像/视觉 | SR | 435 | — |
| 365 | Stable Audio | Stability AI | UK | 音律/开源 | N | 277 | → Stable Audio 2.0 Lv21 |
| 366 | Stable Audio 2.0 | Stability AI | UK | 音律/开源 | R | 357 | ← Stable Audio；→ Stable Audio 3.0 Lv28 |
| 367 | Stable Audio 3.0 | Stability AI | UK | 音律/开源 | SR | 438 | ← Stable Audio 2.0 |
| 368 | FLUX.1 Kontext | Black Forest Labs | DE | 视觉/开源 | SR | 449 | — |
| 369 | FLUX.2 Klein | Black Forest Labs | DE | 视觉/开源 | R | 375 | — |
| 370 | Runway Gen-1 | Runway | US | 影像 | N | 269 | → Runway Gen-2 Lv16 |
| 371 | Runway Gen-2 | Runway | US | 影像/视觉 | N | 310 | ← Runway Gen-1；→ Runway Gen-3 Alpha Lv23 |
| 372 | Runway Gen-3 Alpha | Runway | US | 影像/视觉 | R | 375 | ← Runway Gen-2 |
| 373 | Runway Aleph | Runway | US | 影像/创作 | SR | 444 | — |
| 374 | Suno v4 | Suno | US | 音律/创作 | R | 375 | → Suno v4.5 Lv32 |
| 375 | Suno v4.5 | Suno | US | 音律/创作 | SR | 444 | ← Suno v4；→ Suno v5.5 Lv39 |
| 376 | Suno v5.5 | Suno | US | 音律/创作 | SR | 480 | ← Suno v4.5 |
| 377 | Helix | Figure AI | US | 智能体/影像 | R | 375 | → Helix 02 Lv30 |
| 378 | Helix 02 | Figure AI | US | 智能体/影像 | SR | 449 | ← Helix |
| 379 | 通义千问 Qwen1.5 | Alibaba (Qwen) | CN | 开源/对话 | N | 277 | → 通义千问 Qwen2 Lv22 |
| 380 | 通义千问 Qwen2 | Alibaba (Qwen) | CN | 开源/对话 | R | 357 | ← 通义千问 Qwen1.5 |
| 381 | 通义千问 Qwen2.5-Max | Alibaba (Qwen) | CN | 对话/推理 | R | 375 | → 通义千问 Qwen3-Max Lv30 |
| 382 | 通义千问 Qwen3-Max | Alibaba (Qwen) | CN | 对话/推理 | SR | 449 | ← 通义千问 Qwen2.5-Max |
| 383 | 通义千问 Qwen-Plus | Alibaba (Qwen) | CN | 对话/算力 | R | 357 | → 通义千问 Qwen3.5-Plus Lv29 |
| 384 | 通义千问 Qwen3.5-Plus | Alibaba (Qwen) | CN | 对话/算力 | SR | 444 | ← 通义千问 Qwen-Plus；→ 通义千问 Qwen3.7-Plus Lv36 |
| 385 | 通义千问 Qwen3.7-Plus | Alibaba (Qwen) | CN | 对话/算力 | SR | 480 | ← 通义千问 Qwen3.5-Plus |
| 386 | 通义千问 Qwen-VL | Alibaba (Qwen) | CN | 视觉/开源 | N | 285 | → 通义千问 Qwen2.5-VL Lv21 |
| 387 | 通义千问 Qwen2.5-VL | Alibaba (Qwen) | CN | 视觉/开源 | R | 379 | ← 通义千问 Qwen-VL；→ 通义千问 Qwen3-VL Lv29 |
| 388 | 通义千问 Qwen3-VL | Alibaba (Qwen) | CN | 视觉/开源 | SR | 447 | ← 通义千问 Qwen2.5-VL |
| 389 | QwQ-32B | Alibaba (Qwen) | CN | 推理/开源 | R | 389 | — |
| 390 | DeepSeek-V2 | DeepSeek | CN | 开源/算力 | N | 310 | → DeepSeek-V2.5 Lv22 |
| 391 | DeepSeek-V2.5 | DeepSeek | CN | 开源/算力 | R | 364 | ← DeepSeek-V2；→ DeepSeek-V3-0324 Lv29 |
| 392 | DeepSeek-V3-0324 | DeepSeek | CN | 开源/算力 | R | 394 | ← DeepSeek-V2.5 |
| 393 | DeepSeek-V4-Flash | DeepSeek | CN | 算力/开源 | SR | 452 | → DeepSeek-V4-Flash 0731 Lv31 |
| 394 | DeepSeek-V4-Flash 0731 | DeepSeek | CN | 算力/开源 | SR | 489 | ← DeepSeek-V4-Flash；→ DeepSeek-V4.1-Flash Lv38 |
| 395 | DeepSeek-V4.1-Flash | DeepSeek | CN | 算力/开源 | SSR | 529 | ← DeepSeek-V4-Flash 0731 |
| 396 | Kimi k1.5 | Moonshot AI | CN | 推理/智能体 | R | 375 | — |
| 397 | Kimi K2.7 Code | Moonshot AI | CN | 代码/智能体 | SR | 453 | → Kimi K2.8 Preview Lv28 |
| 398 | Kimi K2.8 Preview | Moonshot AI | CN | 代码/智能体 | SR | 490 | ← Kimi K2.7 Code |
| 399 | GLM-4 | Zhipu AI (Z.ai) | CN | 对话/开源 | R | 353 | → GLM-4.6 Lv20 |
| 400 | GLM-4.6 | Zhipu AI (Z.ai) | CN | 代码/智能体 | R | 386 | ← GLM-4；→ GLM-5.1 Lv31 |
| 401 | GLM-5.1 | Zhipu AI (Z.ai) | CN | 代码/开源 | SR | 458 | ← GLM-4.6 |
| 402 | GLM-4.5V | Zhipu AI (Z.ai) | CN | 视觉/开源 | R | 368 | → GLM-4.6V Lv22 |
| 403 | GLM-4.6V | Zhipu AI (Z.ai) | CN | 视觉/开源 | R | 398 | ← GLM-4.5V；→ GLM-5V-Turbo Lv31 |
| 404 | GLM-5V-Turbo | Zhipu AI (Z.ai) | CN | 视觉/算力 | SR | 447 | ← GLM-4.6V |
| 405 | MiniMax-01 | MiniMax | CN | 开源/对话 | R | 357 | → MiniMax-M1 Lv23 |
| 406 | MiniMax-M1 | MiniMax | CN | 推理/开源 | R | 386 | ← MiniMax-01；→ MiniMax-M2.5 Lv30 |
| 407 | MiniMax-M2.5 | MiniMax | CN | 代码/开源 | SR | 452 | ← MiniMax-M1 |
| 408 | MiniMax Speech 2.5 | MiniMax | CN | 音律 | R | 353 | → MiniMax Speech 2.6 Lv23 |
| 409 | MiniMax Speech 2.6 | MiniMax | CN | 音律/对话 | R | 382 | ← MiniMax Speech 2.5；→ MiniMax Speech 2.8 Lv30 |
| 410 | MiniMax Speech 2.8 | MiniMax | CN | 音律/对话 | SR | 435 | ← MiniMax Speech 2.6 |
| 411 | 豆包 Seed-1.6 | ByteDance Seed | CN | 对话/智能体 | R | 375 | → 豆包 Seed-1.8 Lv32 |
| 412 | 豆包 Seed-1.8 | ByteDance Seed | CN | 对话/智能体 | SR | 444 | ← 豆包 Seed-1.6；→ 豆包 Seed-2.0 Code Lv39 |
| 413 | 豆包 Seed-2.0 Code | ByteDance Seed | CN | 代码/智能体 | SR | 480 | ← 豆包 Seed-1.8 |
| 414 | 豆包 Seed-1.6 Flash | ByteDance Seed | CN | 算力/对话 | N | 301 | → 豆包 Seed-2.0 Lite Lv22 |
| 415 | 豆包 Seed-2.0 Lite | ByteDance Seed | CN | 算力/对话 | R | 361 | ← 豆包 Seed-1.6 Flash；→ 豆包 Seed-2.1 Turbo Lv29 |
| 416 | 豆包 Seed-2.1 Turbo | ByteDance Seed | CN | 算力/智能体 | R | 390 | ← 豆包 Seed-2.0 Lite |
| 417 | 混元 Large | Tencent Hunyuan | CN | 开源/算力 | R | 364 | → 混元 TurboS Lv22 |
| 418 | 混元 TurboS | Tencent Hunyuan | CN | 对话/算力 | R | 394 | ← 混元 Large；→ 混元 T1 Lv31 |
| 419 | 混元 T1 | Tencent Hunyuan | CN | 推理/对话 | SR | 449 | ← 混元 TurboS |
| 420 | 混元 3D 2.0 | Tencent Hunyuan | CN | 视觉/开源 | R | 375 | → 混元 3D 3.1 Lv28 |
| 421 | 混元 3D 3.1 | Tencent Hunyuan | CN | 视觉/开源 | SR | 449 | ← 混元 3D 2.0 |
| 422 | 混元世界 1.0 | Tencent Hunyuan | CN | 视觉/幻觉 | R | 368 | → 混元世界 1.5 Lv20 |
| 423 | 混元世界 1.5 | Tencent Hunyuan | CN | 视觉/幻觉 | R | 398 | ← 混元世界 1.0；→ HY-World 2.0 Lv30 |
| 424 | HY-World 2.0 | Tencent Hunyuan | CN | 视觉/幻觉 | SR | 449 | ← 混元世界 1.5 |
| 425 | 可灵 2.0 | Kuaishou (Kling AI) | CN | 影像/视觉 | R | 386 | → 可灵 2.5 Turbo Lv30 |
| 426 | 可灵 2.5 Turbo | Kuaishou (Kling AI) | CN | 影像/算力 | SR | 449 | ← 可灵 2.0；→ 可灵 2.6 Lv37 |
| 427 | 可灵 2.6 | Kuaishou (Kling AI) | CN | 影像/音律 | SR | 485 | ← 可灵 2.5 Turbo |
| 428 | 零一万物 Yi-34B | 01.AI | CN | 开源/对话 | N | 310 | → 零一万物 Yi-1.5 Lv23 |
| 429 | 零一万物 Yi-1.5 | 01.AI | CN | 开源/对话 | R | 364 | ← 零一万物 Yi-34B；→ 零一万物 Yi-Lightning Lv30 |
| 430 | 零一万物 Yi-Lightning | 01.AI | CN | 对话/算力 | R | 394 | ← 零一万物 Yi-1.5 |
| 431 | 书生 InternLM | Shanghai AI Laboratory | CN | 开源/推理 | N | 277 | → 书生 InternLM2.5 Lv23 |
| 432 | 书生 InternLM2.5 | Shanghai AI Laboratory | CN | 开源/推理 | R | 361 | ← 书生 InternLM；→ 书生 InternLM3 Lv30 |
| 433 | 书生 InternLM3 | Shanghai AI Laboratory | CN | 开源/推理 | R | 390 | ← 书生 InternLM2.5 |
| 434 | 文心 X1 | Baidu | CN | 推理/检索 | R | 379 | → 文心 X1.1 Lv32 |
| 435 | 文心 X1.1 | Baidu | CN | 推理/检索 | SR | 441 | ← 文心 X1 |
| 436 | 阶跃 Step-2 | StepFun | CN | 算力/对话 | R | 357 | → 阶跃 Step 3 Lv20 |
| 437 | 阶跃 Step 3 | StepFun | CN | 算力/智能体 | R | 386 | ← 阶跃 Step-2 |
| 438 | Command R+ | Cohere | CA | 对话/检索 | R | 364 | → Command A Lv21 |
| 439 | Command A | Cohere | CA | 对话/检索 | R | 394 | ← Command R+；→ Command A+ Lv30 |
| 440 | Command A+ | Cohere | CA | 对话/检索 | SR | 447 | ← Command A |
| 441 | Sonar | Perplexity AI | US | 检索/对话 | R | 368 | → Sonar Pro Lv31 |
| 442 | Sonar Pro | Perplexity AI | US | 检索/对话 | SR | 441 | ← Sonar；→ Sonar Pro Search Lv38 |
| 443 | Sonar Pro Search | Perplexity AI | US | 检索/智能体 | SR | 477 | ← Sonar Pro |
| 444 | Llama-3.1-Nemotron-70B | NVIDIA | US | 开源/算力 | R | 364 | — |
| 445 | Nemotron-Super-49B | NVIDIA | US | 开源/算力 | R | 386 | — |
| 446 | Nemotron-Ultra-253B | NVIDIA | US | 开源/推理 | SR | 452 | — |
| 447 | Hermes 3 405B | Nous Research | US | 开源/对话 | R | 375 | → Hermes 4 405B Lv31 |
| 448 | Hermes 4 405B | Nous Research | US | 开源/推理 | SR | 447 | ← Hermes 3 405B |
