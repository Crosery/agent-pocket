<div align="center">

<img src="docs/readme/logo.png" alt="Agent Pocket" width="360" />

# agent-pocket · 智灵口袋

### 把当今最火的 AI，装进你的口袋

<p>一款跑在浏览器里的 HD-2D 像素收集 RPG。你遇到、收服、培养的每一只「智灵」，都是一位真实存在的 AI 化身的二次元 Q 版美少女。</p>

<p><b>English intro:</b> Agent Pocket is a browser-based HD-2D pixel creature-collecting RPG. The 255 creatures are today's hottest AI models (Chinese and international), drawn as cute anime chibis. Their rarity follows each AI's real capability. The game has an infinite Perlin-noise world, hidden world events and online multiplayer, and runs entirely on the web.</p>

<p>
  <a href="README.md"><b>中文</b></a>
  &nbsp;|&nbsp;
  <a href="README_EN.md"><b>English</b></a>
</p>

<p>
  <a href="#快速开始"><b>快速开始</b></a>
  &nbsp;·&nbsp;
  <a href="#核心特性"><b>核心特性</b></a>
  &nbsp;·&nbsp;
  <a href="#宣传片"><b>宣传片</b></a>
  &nbsp;·&nbsp;
  <a href="docs/DESIGN.md"><b>设计文档</b></a>
</p>

<sub>Vite · TypeScript · three.js · Node WebSocket · 纯网页 · 数据驱动</sub>

</div>

---

<div align="center">

<img src="docs/readme/title.jpg" alt="智灵口袋 标题画面" width="100%" />

</div>

---

<div align="center">

## 架构一览

<img src="docs/readme/architecture.jpg" alt="Agent Pocket architecture" width="100%" />

</div>

---

## 一句话

`agent-pocket` 是一个宝可梦式的开放世界收集 RPG，只不过你收集的是 **GPT、Claude、Gemini、DeepSeek、Kimi、千问、GLM、Grok、MiniMax……** 这些每天都在和你说话的 AI。

所有游戏数据都放在 `content/**/*.json` 里，包括物种、招式、属性克制、稀有度、地图规则、剧情、事件和全部文案。代码只写逻辑，加内容只需要改 JSON。

---

## 玩什么

1. **出发**：在研究所从 DeepSeek-V3、Claude Haiku 4.5、o1 三只里挑一只作为第一只智灵（三者属性互相克制），然后和劲敌打第一场对战
2. **收集**：在草丛、海岸、城市、雪山里遇见野生智灵，把它们打弱后收服进口袋，填满 255 格图鉴
3. **培养**：升级、学习招式、进化，按属性克制组一支自己的队伍，挑战各地道馆
4. **探索**：走过海堤离开大陆，前面是没有尽头的前线。越往外走越危险，遇到的智灵也越稀有
5. **追踪**：顺着传闻和石碑线索，去碰只在暴雨夜、凌晨或节日才出现的 SSR，追踪四处游荡的 UR 传说，解开 MYTHIC 的隐藏事件链
6. **联机**：在大地图上遇到其他玩家，可以聊天、交换、对战，排行榜上比谁走得最远

---

## 核心特性

- **255 只智灵** — 139 个进化家族，6 档稀有度，自定义属性克制，招式和特性用声明式 DSL 描述
- **无限世界** — 1024² 的剧情大陆，外围是向四面八方无限延伸的柏林噪声前线：30 种生物群系，山脉、峡谷、单向跳坎、河流、群岛、村落、多层地下城、地标
- **稀有度玩法** — N/R 在草丛里遇到；SR 在大地图上可见，带光环；SSR 只在特定时间、天气、地形下出现，还会逃跑；UR 是在各地游荡的传说；MYTHIC 只能靠隐藏事件链拿到
- **世界事件** — 99 个事件，其中 28 个隐藏：节日（含农历）、AI 圈梗、石碑谜题、彩蛋、传说追踪；另有每只智灵的研究任务和研究等级奖励
- **确定性战斗引擎** — 带种子的随机数，第三代捕获公式和第五代伤害公式，状态、天气、特性全部参数化；对战时服务端和客户端运行同一份引擎
- **多人联机** — WebSocket 同步附近玩家（按距离划分兴趣范围）、PvP、交换、聊天、排行榜
- **小地图与世界地图** — 战争迷雾、行省危险度、已发现地点之间可以飞行
- **美术管线** — AI 生图后用 Python 像素化处理，Blender 脚本生成 GLB 道具，MiniMax Music3 生成配乐；角色走路帧用 MiniMax H3 视频生成

<div align="center">
<img src="docs/readme/creatures.jpg" alt="智灵图鉴（节选）" width="100%" />
<sub>智灵图鉴（节选，共 255 只）</sub>
</div>

<div align="center">
<img src="docs/readme/gallery.jpg" alt="游戏画面" width="100%" />
<sub>收服、MYTHIC、无尽世界、对战、大地图上的 SR/SSR</sub>
</div>

---

## 宣传片

<div align="center">
<img src="docs/readme/teaser.gif" alt="宣传片片段" width="640" />
</div>

完整宣传片：[`docs/readme/agent-pocket-promo-720p.mp4`](docs/readme/agent-pocket-promo-720p.mp4)（55 秒）。

宣传片全部用代码渲染（three.js + 离线逐帧导出 + ffmpeg），每一帧都由时间唯一确定，切点卡在配乐的小节线上。做法参考了 [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video)，源码在 [`promo/`](promo/NOTES.md)。

---

## 快速开始

在线试玩：**https://ap.crosery.com**（预发布：https://prev.ap.crosery.com）。分支、提交和发布规则见 [`docs/RELEASING.md`](docs/RELEASING.md)。

### 1. 安装

```bash
git clone https://github.com/Crosery/agent-pocket.git
cd agent-pocket
npm install
```

需要 Node.js 24 以上（服务端直接运行 `.ts`，开发环境是 Node 26）。

### 2. 本地开发

```bash
npm run dev          # 同时启动游戏服务器(:8787) 和 Vite 客户端(:5173)
```

浏览器打开 `http://localhost:5173`。只想单机试玩，可以只跑 `npm run dev:client`。

调试入口：在 URL 后加 `?dev=1`，可以跳过标题、传送、直接开战斗（见 `src/client/debug.ts`）。

### 3. 检查与构建

```bash
npm run typecheck && npm test && npm run build
npm start            # 生产模式：服务器同时托管 dist/ 和 WebSocket
```

### 4. 操作

| 动作 | 键盘 | 手柄 |
|---|---|---|
| 移动 | WASD / 方向键 | 摇杆 / 十字键 |
| 确认 / 对话 / 调查 | Z / Space / Enter | A |
| 取消 | X / Backspace | B |
| 菜单 | Esc / Tab | Start |
| 跑步 / 自行车 | Shift / B | X / Y |
| 世界地图 / 小地图 / 聊天 | M / N / T | Select / LB / RB |

手机上会显示虚拟摇杆和按键。全部按键绑定都在 `content/input.json` 里。

---

## 项目结构

```
agent-pocket/
├── content/                 全部游戏数据 (JSON)：物种、招式、属性、稀有度、地图、剧情、事件、文案
│   ├── world/frontier/      无限世界生成参数
│   ├── events/              世界事件与隐藏事件
│   └── text/zh-CN/          全部文案
├── src/
│   ├── shared/              客户端和服务端共用：战斗引擎、世界生成、事件、研究、数据加载
│   ├── client/              渲染 (HD-2D)、UI、大地图控制、战斗客户端、联机
│   └── server/              WebSocket 服务、PvP、交换、聊天、排行榜
├── public/assets/           像素素材、模型、音乐、字体 (manifest.json)
├── assets_src/ + tools/     美术管线：提示词、参考图、生图、像素化、Blender、配乐
├── promo/                   代码渲染的宣传片工程
├── sandbox/                 渲染、战斗、战斗舞台的独立调试页
├── tests/                   node:test 单元与集成测试
└── docs/                    设计、世界、剧情、战斗规则、素材、交接文档
```

---

## 设计原则

1. **数据不写死** — 表、名称、数值、文案都放进 JSON，代码只写逻辑
2. **确定性** — 世界生成、战斗、事件都由种子决定，可复现、可测试、可联机校验
3. **同构** — 规则只写一份，浏览器和服务器运行同一份 `src/shared`
4. **可爱优先** — 每一位 AI 都应该是让人想收集的二次元美少女
5. **网页即玩** — 不需要安装，打开浏览器就能玩，手机也能玩

---

## 致谢与出处

- 宣传片的工作方式参考 [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video)（MIT），见 [`promo/THIRD_PARTY.md`](promo/THIRD_PARTY.md)
- 像素字体：[Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)（OFL），授权文件在 `public/assets/fonts/licenses/`
- 渲染：[three.js](https://threejs.org/)
- 美术、配乐和宣传片都由 AI 工具辅助生成；角色形象基于作者自有的 AI 娘角色设定
- 这是爱好者作品。游戏中出现的 AI 产品名称和商标归各自所有者，本项目与它们没有任何关联

<div align="center">
<sub>Made with HD-2D pixels by DeepSeek娘 and friends</sub>
</div>
