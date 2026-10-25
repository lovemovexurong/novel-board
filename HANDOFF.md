# 小说看板 · 交接说明（HANDOFF）

> 给接手的 agent：这份文档描述**当前真实状态**。先读完再动手。
> 上一版 HANDOFF 讲的是早期 ASCII 背景实验（`board/_ascii/`），已作废，仅作历史记录。
> 仓库：https://github.com/lovemovexurong/novel-board （Public）

## 1. 这是什么

长篇小说写作工具：横向时间树管理章节关系（卡片 + 连线），点卡片写正文，右侧 AI 参谋，背景是慢速漂移字符。

**两种形态，共享同一套前端逻辑**：

| 形态 | 入口 | 服务 |
|---|---|---|
| 浏览器版 | `board/index.html` | `board/server.mjs`（固定 `127.0.0.1:4317`，数据在 `board/` 目录内） |
| Windows 桌面版 | `desktop/app/index.html` | `desktop/app/server.mjs`（`createBoardServer()` 工厂，随机端口，数据在 `%APPDATA%\novel-board`） |

## 2. 文件清单

### 根目录
| 文件 | 作用 | 备注 |
|---|---|---|
| `README.md` | 对外说明、功能、操作速查、下载入口 | 改功能后记得同步 |
| `LICENSE` | MIT | |
| `.gitignore` | 排除 node_modules/dist/运行数据/个人书稿 | 别把 `.board-*` 提交上去 |
| `启动预览.cmd` | 双击起浏览器版 | |
| `HANDOFF.md` | 本文件 | |

### `board/`（浏览器版，零依赖）
| 文件 | 作用 |
|---|---|
| `server.mjs` | 约 300 行 HTTP 服务：静态托管 + 12 个 API + AI 代理；`ROOT = process.cwd()` |
| `index.html` | **核心**，约 1600 行单文件前端（全部逻辑 + CSS + Canvas 背景） |
| `chapters/` | 章节 Markdown（个人书稿，`.gitignore` 已排除，只留示例） |
| `verify.mjs` `featuretest.mjs` `interacttest.mjs` `uitest.mjs` `pantest.mjs` `shoot.mjs` `dbg-port.mjs` | headless Edge CDP 实测脚本，见第 6 节 |
| `_ascii/` `_shot/` | 早期背景实验与素材，**可整目录删除**，不影响运行 |

### `desktop/`（Electron 桌面版）
| 文件 | 作用 |
|---|---|
| `electron/main.cjs` | 主进程：单实例、窗口记忆、托盘、IPC、safeStorage 密钥、首启选书稿目录、旧数据迁移（`BOARD_LEGACY_DIR`）、`app.setPath('userData', %APPDATA%\novel-board)` |
| `electron/preload.cjs` | 暴露 `window.boardDesktop`（getInfo / pickChaptersDir / setCloseBehavior / openDataDir / openChaptersDir / setZoom） |
| `app/server.mjs` | `createBoardServer({appRoot,dataDir,port,getChaptersRoot,getApiKey,setApiKey})`，`port:0` 随机；`opts.setApiKey` 存在时密钥不进明文配置 |
| `app/index.html` | 前端 = `board/index.html` + 桌面设置区 + DPI 监听（见第 4 节） |
| `build/icon.ico` | 图标（由 `scripts/make-icon.mjs` 零依赖生成） |
| `scripts/smoke.mjs` | 桌面版 CDP 冒烟（桥/设置区/章节/DPI/抽屉/报错） |
| `README-构建.md` | 开发、打包、数据位置、系统适配、迁移 |
| `package.json` | electron 33 + electron-builder 25，`build` 字段是 NSIS 配置 |

### `.github/workflows/build-desktop.yml`
推 `v*` tag 或手动触发 → windows-latest 构建 NSIS → 上传 artifact → tag 时发 Release。已实测通过（约 1.5 分钟）。

## 3. 数据模型（`board-state.json`）

```jsonc
{
  "version": 1,
  "nodes": [{
    "id": "n0", "file": "第一章 风起.md", "title": "风起", "sub": "山雨欲来。",
    "x": 83, "y": 547, "w": 220, "h": 96,
    "ports": [{ "id": "p1", "side": "n|e|s|w", "t": 0.5 }]   // t = 边上 0~1 位置
  }],
  "connections": [{
    "id": "c0",
    "from": { "node": "n0", "portId": "p1" },                 // 强锚定端口，不是边
    "to":   { "node": "n1", "portId": "p2" },
    "bend": 0
  }],
  "appearance": { "theme": "light", "dots": true, "shark": true, "sharkAlpha": 1,
                  "nodeW": 220, "nodeH": 96, "gapX": 80, "gapY": 60, "fontSize": 13 },
  "viewport": { "x": 0, "y": 0, "s": 1 }
}
```

- 老数据（`from:{node,side,t}`）由 `migrateConnectionEndpoints()` 自动迁移成 `portId`
- 每个节点至少 1 个端口；删端口会连带删掉挂在它上面的连线

### 服务端 API
`GET/PUT /api/state`（带 `baseHash`，冲突返回 409）、`GET /api/files`、`GET/PUT /api/file`、`POST /api/file/create`、`POST /api/file/delete`、`GET /api/ai/status`、`POST /api/ai/chat`、`POST /api/ai/clear`、`GET/PUT /api/config`。

## 4. ⚠️ 两份前端必须同步改

`desktop/app/index.html` 是 `board/index.html` 的副本（diff 约 65 行）。桌面版只多三块：

1. 「外观 → 桌面端」设置区（`#deskSection`、`initDesktop()`）
2. `watchDpr()`：监听 `devicePixelRatio` 变化重建 canvas
3. AI 未配置文案区分桌面/浏览器

**改 UI/交互时改 `board/index.html`，再把这三块同步过去**，否则两端行为会分叉。

行号偏移：桌面版整体比浏览器版多约 16 行（`renderNodes` 759 vs 775、`renderWires` 970 vs 986、`openDrawer` 1325 vs 1384）。

## 5. 前端关键函数索引（`board/index.html` 行号）

| 行 | 函数 | 说明 |
|---|---|---|
| 397 / 408 | `state` / `app` | 全局状态与外观配置（`APP_DEFAULT` 在 406） |
| 419 | `scheduleSave()` | 500ms 防抖保存，走 `/api/state` |
| 489 / 506 | `applyView` / `fitView` | 世界变换（`translate + scale`） |
| 532 | `resizeBG` | canvas 尺寸与 dpr |
| 587 | `drawBG` | 网格 + 点阵 + 环境字符（鱼由 `FISH` 开关关闭） |
| 705 / 728 | `sidePoint` / `portPoint` | 端口世界坐标 |
| 759 / 780 | `renderNodes` / `renderPorts` | 卡片与端口 DOM |
| 858 | `addPortAtClick` | 工具箱「加连接点」，按世界坐标找最近卡片（**不要依赖 e.target，边缘亚像素会落到 stage**） |
| 952 / 970 | `wireGeometry` / `renderWires` | 贝塞尔连线几何与 SVG 渲染 |
| 1037 | `snapToPort` | 26px 端口级吸附 |
| 1058-1128 | `startConnect` / `moveConnect` / `endConnect` / `moveEndpoint` / `startMovePort` | 拖拽连线、端点、端口位置 |
| 1130 / 1158 | `setMode` / `syncToolbox` | 模式（`null` / `placing` / `placing-file` / `cut` / `connect` / `port`）与工具箱高亮 |
| 1200 | `connectClickPort` | 连线模式：点两个端口 |
| 1325 / 1337 / 1424 | `openDrawer` / `closeDrawer` / `renderAI` | 抽屉（正文 + AI 分栏） |

事件入口集中在 `#stage` 的 `pointerdown/move/up`（约 818 行起）：端口 → 缩放柄 → 卡片拖动（位移 >4px 才算拖动，否则松手打开编辑）→ 空白处按模式分流。

## 6. 测试脚本（headless Edge + CDP）

```bash
cd board && node server.mjs      # 先起服务（4317）

node shoot.mjs          # 只读截图（浅色/暗色两版）
node featuretest.mjs    # 8 项：端口初始化、分栏、工具箱、连线、拖动跟随、多端口、删线
node interacttest.mjs   # 3 项：单击卡片开抽屉、加连接点、抽屉宽度拖拽
```

**重要**：`featuretest` / `interacttest` 会**真实改写看板状态**（移动卡片、加连线/端口）。跑完必须回滚：
- 浏览器版备份：`board/.board-backup/`
- 桌面版备份：`%APPDATA%\novel-board\backups\`

前端暴露测试句柄 `window.__dbg`（`state` / `mode` / `view` / `vS` / `vX` / `vY` / `nodeById` / `portPoint` / `connectClickPort` / `setMode` / `openDrawer` / `renderNodes` / `updateNodeEl` / `applyView` / `uid`），新写测试直接用。

桌面版冒烟：带 `--remote-debugging-port=<p>` 启动应用，再 `CDP_PORT=<p> node desktop/scripts/smoke.mjs`。

## 7. 桌面端构建与发布

```bash
cd desktop && npm install
npm run dev:browser     # 浏览器模式，改前端最快
npm run dev             # Electron + DevTools
npm run build           # → desktop/dist/小说看板-<ver>-x64.exe
```

发布：`git tag v1.0.1 && git push origin v1.0.1`，CI 自动构建并挂 Release。

### 踩过的坑（别重复踩）

1. **`ELECTRON_RUN_AS_NODE=1`**：本机 shell 环境带这个变量，直接跑 Electron 会当纯 Node 执行并报 `Cannot read properties of undefined (reading 'exports')`。启动用 `env -u ELECTRON_RUN_AS_NODE`。
2. **GPU 崩溃**：无 GPU 环境（VM/远程桌面）下 Electron 报 `GPU process isn't usable`。设 `BOARD_SOFTWARE_RENDER=1`（主进程会 `disableHardwareAcceleration()`），必要时加 `--disable-gpu --in-process-gpu`。
3. **主进程用 CJS**：ESM 主进程 import `electron` 会崩，用 `main.cjs` + `pathToFileURL` 动态 import ESM 服务。
4. **electron-builder 解压 winCodeSign 失败**（压缩包含 macOS 符号链接、无权限创建）：手动 `7za x <cache>/winCodeSign/*.7z -owinCodeSign-2.6.0 -snl-` 后重试。
5. **git 推送**：本机走本地代理，schannel 报 `CRYPT_E_NO_REVOCATION_CHECK`；仓库已配 `http.schannelCheckRevoke=false`，必要时加 `-c http.sslVerify=false`（不要持久化）。
6. **别杀用户的浏览器进程**：需要操作浏览器时用 browser-skill（`bsk`）借用已登录会话。

## 8. 修改边界

- **视觉**：颜色只走 `:root` / `html[data-theme="dark"]` 变量；**禁止 CSS 渐变**（用户硬性要求）；配色只能是黑白灰
- **端口/连线**：改 `ports` 模型必须同步 `ensurePorts` / `migrateConnectionEndpoints` / `wireGeometry` / `snapToPort`，否则老数据错位
- **API**：两份 `server.mjs` 是两套实现，改接口两边都要改（浏览器版用 `ROOT`，桌面版用注入的 `dataDir` / `chaptersRoot`）
- **AI 密钥**：桌面端只经 `getApiKey` / `setApiKey`（safeStorage），**不要**把 key 写回 `board-config.json`
- 不要提交：`node_modules`、`dist`、`.board-*`、个人书稿、`.workbuddy`

## 9. 已知遗留 / 可做

- `preview/` 里 29 张调试截图仍在仓库里（约 6MB），可清理
- 背景鱼形代码保留但 `FISH = false` 关闭（`drawBG` 内），想恢复改开关
- 章节文件被外部编辑器改动时没有监听/重载提示
- 没有自动更新（`electron-updater` 未接）
- AI 只支持 OpenAI 兼容 `/chat/completions`，无流式输出

---

## 附：历史（已作废）

`board/_ascii/` 是早期「ASCII 鲨鱼背景」实验，三个方案里最终采用程序化闭合路径（不依赖视频、循环无缝）。主看板后来重构过，这套实验代码只剩参考价值，可删。
