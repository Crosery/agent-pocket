<!--
PR 正文契约：docs/conventions/PULL-REQUESTS.md。CI 的 pr-contract 检查会逐项核对下面九个段落（### 标题逐字保留，可在后面加括号说明）。
一件事 = 一个 issue = 一个 task/<issue>/<slug> 分支 = 一个 PR。PR 只进 stage（热修复除外），合并方式 merge commit，标题写 `type(scope): 中文简述`。
合并进 stage 后 issue 自动关闭、分支自动删除。发布规则见 docs/RELEASING.md。
进展按 docs/conventions/TRACKING.md 的格式写成评论，不要改写已经发出的评论。
填写时把每段里的注释删掉，写实际内容。
-->

### 目的
<!-- 解决什么问题、为什么现在做。引用 issue 里的原话。 -->

### 关联
Closes #<!-- issue 号，必须与分支名 task/<issue>/<slug> 一致 -->
<!-- 相关但不由本 PR 关闭的 issue / PR 用 Refs #n；依赖的 PR 写 Depends on #n。 -->

### 变更范围
<!-- 按端列出改了什么（client、render、battle、world、content、art、server、deploy、docs），再写明「不做什么」。 -->

### 解决链路
<!--
按顺序写，让没参与的人能复盘：
1. 复现：怎么触发、在哪个环境、看到了什么。
2. 定位：根因是什么，怎么确认的（命令、日志、截图）。
3. 修复：改了什么、为什么这样改、否决了哪些方案。
4. 验证：怎么证明修好了、有没有测试能区分修复前后。
新功能没有「复现」时，写需求场景、方案取舍和验证方式。
-->

### 验证命令与结果
<!-- 实际跑过的命令 + 真实输出摘要（npm run typecheck、npm test、npm run build）。失败、跳过、未验证的项逐条列出。 -->

### 验收证据
<!--
界面或画面改动：同一地点、同一时间的改前 / 改后截图，动作和动画放逐帧拼图或录屏（直接拖进 GitHub 编辑框上传，本机路径别人看不到，不算证据）。
每个证据写编号、视口尺寸 / 设备、对应的验收点，例如：
证据 1｜1280×720 Chrome｜新手村广场夜景，灯光不再过曝｜![](https://github.com/user-attachments/assets/...)
没有界面变化时写：无界面变化：<理由>
-->

### 人工验收步骤
<!--
写给验收人的操作清单，每一步都有「应看到」：
1. 打开 <地址>（本机 dev，或 https://prev.ap.crosery.com，并写版本或 commit）
2. 做 <操作>
3. 应看到 <结果>
-->

### 审查结论
<!-- 按 docs/conventions/CODE-REVIEW.md 逐项；审查人、时间、被审查 commit、逐条结论，最后一行 **结论：通过** / **结论：有条件通过** / **结论：阻塞**。 -->

### 风险与回滚
<!-- 已知风险、没覆盖到的环境、回滚方式（revert 合并提交）。涉及存档或服务端数据格式的，写清旧数据怎么办。 -->
