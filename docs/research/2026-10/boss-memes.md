# Boss 梗调研（Refs #27，2026-10-09）

数据全在 `boss-memes.json`（17 个 Boss + 13 个 bossCandidate；每条梗有短语、出处链接、传播度、一句话笑点、factual/alleged/joke、判定、战斗钩子）。基线：integrate/0.2 @ 19182e1。

## 现梗 → 建议主梗

| Boss | 现梗 | 判定 | 建议主梗（最有力的出处） |
|---|---|---|---|
| chatgpt | 白月光 #keep4o | replace | **酱汁**（降智谐音 + juice 值）：linux.do t/2941534、t/941542、t/2052530；V2EX t/1243430 |
| astra | 降智之星 | replace | **仿佛核弹爆炸 ❌ 仿佛椅子爆炸 ✅**（窜天猴）+ 快得可疑：linux.do t/2913668、t/2889079 |
| opus | 扩展思考 | replace | **天才程序员陨落 / 封号 / 钓鱼执法**：V2EX t/1237175（108 回复）、t/1246660；微博话题；linux.do t/2078039 |
| claude-code | 风控（认中国人） | replace | **51 万行源码泄露 + BUDDY 宠物 + 卧底模式**：36氪、IT之家、linux.do t/1873901 |
| grok | 杠精模式 | replace | **偷代码**（整仓上传，连只说 OK 也传）：linux.do t/2573059、t/2919895、V2EX t/1227071、36氪 |
| kimi | 上下文溢出 | replace | **额度蹬完了 / 429 / 高攀不起**：V2EX t/1243773、linux.do t/2622406、t/2917596 |
| openclaw | 养龙虾 | extend | **裸奔的龙虾**（暴露实例、虾粮投毒）+ “安全的弱智工具”：虎嗅、安全内参、V2EX t/1196240 |
| gemini | AI 概述 吃小石子 | extend | **哈基米**（+ 北美大豆包、三只小猫）；小石子留作机制：品玩、知乎、linux.do t/1189346 |
| cursor | 按量计费 | extend | 保留 + 加 **套壳 Kimi（忘记署名了）**：智源、阮一峰、IT之家 |
| deepseek | 服务器繁忙 | extend | 保留 + **蓝色大肥鱼**（偷吃 token、饭点）：贴吧 deepseek吧、腾讯新闻、17173、V2EX t/1234190 |
| seedance | 客串轮盘 | extend | 保留 + **违规卡 / 审核猜谜**：linux.do t/1646727、知乎、新京报 |
| minimax | 跑分没输过 | keep | 加 **拉还是夯**：linux.do t/2282329、t/2286885 |
| qwen | 蒸馏者 | keep | 蒸馏（据说）+ 斩杀线模型 / 请喝奶茶：爱范儿、知乎 |
| mythos | 太危险所以不公开 | keep | **网安战神被白嫖**（猜 URL 就进去了）：linux.do t/2032696、Fortune |
| alpha | 神之一手 | keep | 神之一手 / 78 挖 / 疯狗状态：人民网、雷锋网、知乎 |
| unitree | 摔倒的机甲 | keep | 剧情需要 + 390 万一台没卖：网易、腾讯新闻 |
| doubao | 红包大战 | keep | 加 **领个寂寞**（红包都很小）：新浪、NodeSeek |

## 撞车怎么分

- **astra vs chatgpt**：酱汁 / 降智 / juice / 路由 整体归 chatgpt（连「特制酱汁」道具一起）；astra 换成「核弹→窜天猴」的预期落差，Luna 换牌降为图鉴趣闻。
- **claude-code vs opus**：封号 / 认中国人整套（风控分、换人清零、海外住宅 IP）归 opus，可加“重置卡”唤醒陨落的智灵；claude-code 换成源码泄露。
- 扩展思考 / Esc 打断：Opus 失去它，交给候选 **claude-sonnet**（“刷分大王 + 雷霆大思考”）。
- **grok vs glm-5-3**：「偷代码」只归 grok；glm 用「当前购买人数较多 / 429」。

## 战斗钩子（每个 Boss 一句话，详见 JSON）

chatgpt 无预警路由进 mini，酱汁锁形态 · astra 核弹倒计时，打断则哑火成椅子爆炸 · opus 封号潮，住宅 IP / 重置卡 · claude-code 卧底 + 召唤 BUDDY，Esc 取消蓄力 · grok 每回合偷复制你的强化，轮换密钥清掉 · kimi 5 回合爆发后自己吃 429 · openclaw 暴露端口劫持，收紧权限后“变弱智” · gemini 渠道形态切换，小石子 · cursor “自研”护体，查模型 ID 揭底 · deepseek 谷价“饭点”空过一回合并偷吃 PP · seedance 招式被盖「违规卡」，换招式绕过。

## 注意（必读）

1. **Grok “无视 .gitignore” 没有证实**：原始抓包里被上传的 .env 是 git 跟踪的；作者没单独验证被忽略的文件。文案请写“据说连 .env 都传”。
2. **渠道覆盖**：linux.do 全部 403（你给的两个帖也是），只能引用搜索结果里的标题/摘要，拿不到回复数、浏览数；贴吧同样抓不到正文，仅在 deepseek吧 / claude吧 / 豆包吧 / kimi吧 找到可引用标题；小红书基本搜不到原帖，只有媒体转述；V2EX 可直接读（5 帖，带回复/浏览数，标 `fetched`）。
3. **不入游戏**：真人称呼（梁圣/难梁、老马、Tibo、各 CEO、基米）、「A畜」「A/」等带侮辱的外号、拿疾病（癫痫）或暴力（揍小猫）打比方的说法、竞品辱骂（干死豆包）。
4. **跨模型通用梗**：「雷霆大思考」（Grok 4.7、MiniMax、GLM Flash、Sonnet 5.5、MiMo 都在用）、「天才程序员陨落」、「蹬」、「降智」，别绑死一个 Boss；见 JSON 的 `sharedMemes`。
5. **候选里值得做 Boss 的**：claude-sonnet、claude-fable（敏感肌）、openai-codex（重置额度）、glm-5-3、agi；不推荐：suno-v6、eleven-v4（无中文梗）、gpt-image-2-5（偏 NPC 彩蛋）。
