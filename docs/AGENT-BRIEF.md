# 给接手 Agent 的开场简报（复制粘贴用）

> 用法：把下面「---」之间的内容整段发给接手的 agent，再把项目位置告诉它。

---

你要接手一个已经上线运行的本地项目「小说看板」（长篇小说写作工具，**已有 2 个提交的版本在跑，用户正在用**）。

**第一步（必须做）**：读项目根目录的 `HANDOFF.md`，那里有完整的文件清单、数据模型、函数索引、修改边界和踩坑记录。读完再动手，不要凭猜测改代码。

**项目位置**
- 本地：`C:\Users\18480\WorkBuddy\前端`
- 仓库（Public）：https://github.com/lovemovexurong/novel-board

**项目形态（重要）**
- 浏览器版：`board/index.html` + `board/server.mjs`（端口 4317，数据在 `board/` 内）
- Windows 桌面版：`desktop/app/index.html` + `desktop/app/server.mjs`（Electron，数据在 `%APPDATA%\novel-board`）
- 两个 `index.html` 是同一份前端，桌面版只多「桌面设置区 / DPI 监听 / 文案区分」三块，**改 UI 必须两边同步**

**硬约束（违反会被打回）**
1. 配色只能是黑白灰，**禁止任何 CSS 渐变**
2. 端口模型是 `ports:[{id,side,t}]`，连线锚定 `{node,portId}`；改动需同步 `ensurePorts` / `migrateConnectionEndpoints` / `wireGeometry` / `snapToPort`
3. 两份 `server.mjs` 是两套实现，改 API 两边都要改
4. 桌面端 AI 密钥只能经 `safeStorage`（`getApiKey`/`setApiKey`），不得写入明文配置
5. 不要提交 `node_modules`、`dist`、`.board-*`、个人书稿（`board/chapters/*.md`）

**本机环境坑（否则起不来）**
1. shell 里有 `ELECTRON_RUN_AS_NODE=1`，跑 Electron 必须 `env -u ELECTRON_RUN_AS_NODE`
2. 无 GPU 环境要设 `BOARD_SOFTWARE_RENDER=1`（必要时加 `--disable-gpu --in-process-gpu`）
3. 启浏览器版：`cd board && node server.mjs`（4317）
4. 桌面版构建：`cd desktop && npm run build`

**验证方式（改完必须跑）**
```bash
cd board && node server.mjs      # 起服务
node shoot.mjs                   # 只读截图，确认无 JS 报错、无渐变
node featuretest.mjs             # 8 项功能自检
node interacttest.mjs            # 3 项交互自检
```
注意：`featuretest` / `interacttest` 会真实改写看板状态（移动卡片、加连线），**跑完必须从 `board/.board-backup/` 或 `%APPDATA%\novel-board\backups\` 回滚**，不要留下测试数据污染用户看板。

**工作方式**
- 改完前端要**主动打开预览**（`http://127.0.0.1:4317/`）给用户看，不要等用户自己刷新
- 需要操作浏览器时用 browser-skill（`bsk`），**不要强杀用户的浏览器进程**
- 有疑问先问，别猜用户意图；这个项目的历史反馈显示用户对交互细节（连线、拖拽、DPI）要求很高

---

## 交接方式备选

| 方式 | 做法 | 适用 |
|---|---|---|
| 仓库 clone | `git clone https://github.com/lovemovexurong/novel-board.git` | 对方有网络、有 git |
| 本地目录 | 直接把 `C:\Users\18480\WorkBuddy\前端` 路径给它 | 同一台机器上的 agent |
| 离线压缩包 | 用 `前端-交接包-*.zip`（已排除 node_modules/dist/.git/preview） | 跨机器、无网络 |
