# 小说看板 · Windows 桌面版

时间树看板 + 章节写作 + AI 参谋，打包为 Win11 x64 桌面应用（Electron）。

## 目录结构

```
desktop/
├─ package.json              依赖与 electron-builder(NSIS) 打包配置
├─ electron/
│  ├─ main.mjs               主进程：单实例、窗口、托盘、首启选目录、safeStorage
│  └─ preload.cjs            受控桥：window.boardDesktop（目录选择/关闭行为/打开目录）
├─ app/
│  ├─ index.html             前端（与浏览器版同源，含桌面设置区与 DPI 适配）
│  └─ server.mjs             本地零依赖服务（可嵌入主进程，端口/数据目录注入）
├─ build/icon.ico            应用与安装包图标（scripts/make-icon.mjs 生成）
└─ scripts/make-icon.mjs     零依赖生成 PNG + ICO
```

## 开发

```bash
npm install

# 浏览器模式（和原来的 board/ 一致，用于快速改前端）
npm run dev:browser      # http://127.0.0.1:4317/

# 桌面模式（带 DevTools）
npm run dev
```

## 打包

```bash
npm run build            # 产出 dist/小说看板-1.0.0-x64.exe（NSIS 安装包，per-user 免管理员）
npm run pack             # 只解包到 dist/win-unpacked/ 便于验证
```

没有代码签名证书时，首次安装/运行会出现 SmartScreen 提示：**更多信息 → 仍要运行**。

## 数据位置

| 内容 | 路径 |
|---|---|
| 章节 Markdown | 首启选择的书稿目录（默认 `文档\小说看板`，可在「外观 → 桌面端」改） |
| 看板状态 / 备份 / AI 会话 | `%APPDATA%\novel-board\`（state、backups、sessions、board-config.json、settings.json） |
| AI API Key | `%APPDATA%\novel-board\ai-key.bin`（DPAPI/safeStorage 加密，不落明文） |
| 安装目录 | `%LOCALAPPDATA%\Programs\novel-board\`（per-user 安装，无需管理员） |

卸载不会删除用户数据（`deleteAppDataOnUninstall: false`）。

## 系统适配

- **高分屏**：Chromium 自带 per-monitor DPI；页面监听 `devicePixelRatio` 变化重建 canvas，跨屏拖动不模糊
- **端口**：服务绑定 `127.0.0.1` 随机端口，避免 4317 冲突；仅本机可访问
- **单实例**：重复启动会把已有窗口唤到前台
- **托盘**：关闭行为可在应用内或托盘右键切换（最小化到托盘 / 直接退出）
- **外部链接**：一律交给系统浏览器，应用内不开新窗口
- **路径安全**：章节读写经 `safeJoin` 校验，禁止越出书稿目录
- **虚拟机 / 远程桌面**：若显卡不可用导致 GPU 进程崩溃，可设环境变量 `BOARD_SOFTWARE_RENDER=1` 强制软件渲染

## 旧数据迁移

首次启动可用环境变量指定旧版数据目录，自动导入看板状态、AI 会话与配置（已存在则不覆盖）：

```bash
set BOARD_LEGACY_DIR=C:\path\to\old\board
```

对应导入：`.board-state.json → board-state.json`、`.board-config.json`、`.board-sessions.json`。章节 `.md` 直接把旧 `chapters/` 里的文件拷进所选书稿目录即可。
