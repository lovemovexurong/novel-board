# 小说看板 · Novel Board

一个给长篇小说作者用的**结构看板 + 写作工作台**：横向时间树管理章节关系，点卡片写正文，右侧 AI 参谋陪聊，背景是缓慢漂移的字符氛围。提供浏览器版与 Windows 桌面版。

![看板](docs/screenshots/board-light.png)

![正文与 AI 分栏](docs/screenshots/editor-ai-split.png)

## 功能

- **横向时间树**：卡片自由拖拽/缩放，四边端口连线（可任意增删端口、拖拽调位置），连线强锚定卡片，拖动不跑偏
- **悬浮工具箱**：选择 / 连线 / 加连接点 / 删线 / 新章节
- **写作抽屉**：正文与 AI 参谋**左右分栏**同时可见，Ctrl+S 写回原 `.md` 文件
- **AI 参谋**：OpenAI 兼容端点（Base URL / Key / 模型），每章独立会话 + 跨章共享摘要自动维护
- **视觉**：纯黑白灰、无渐变；细方格背景 + 漂移字符；深浅双主题；点阵/浓度/节点尺寸可调
- **数据安全**：状态原子写 + 自动备份（保留 60 份）+ hash 冲突检测
- **桌面端**：Electron，单实例、托盘、窗口记忆、书稿目录可选、API Key 走系统加密存储

## 目录

```
board/        浏览器版（零依赖 Node 服务 + 单文件前端）
desktop/      Windows 桌面版（Electron + electron-builder）
preview/      实测截图
```

## 下载

Windows 安装包见 [Releases](https://github.com/lovemovexurong/novel-board/releases)（`小说看板-<版本>-x64.exe`，per-user 安装，免管理员）。

## 浏览器版

```bash
cd board
node server.mjs          # http://127.0.0.1:4317/
```

章节 `.md` 放在 `board/chapters/`，看板状态存 `board/.board-state.json`。

## 桌面版（Windows 11）

```bash
cd desktop
npm install
npm run dev:browser      # 浏览器开发模式
npm run dev              # Electron 开发模式
npm run build            # 产出 dist/小说看板-<ver>-x64.exe（NSIS，per-user 免管理员）
```

详见 `desktop/README-构建.md`。

## 操作速查

| 操作 | 方式 |
|---|---|
| 打开编辑 | 单击卡片任意位置 |
| 移动卡片 | 按住拖动 |
| 连线 | 工具箱「连线」→ 依次点两个端口；或直接拖端口 |
| 加连接点 | 工具箱「加连接点」→ 点卡片边缘 |
| 端口挪位置 | Alt + 拖动端口 |
| 删端口 | 右键端口（挂在上面的线一并清理） |
| 删线 | 工具箱「删线」→ 点线 |
| 保存正文 | Ctrl+S |
| 缩放/平移 | 滚轮 / 中键拖动 |

## 技术

- 前端：原生 JS + Canvas（ASCII 背景），单文件 `index.html`
- 服务：Node 零依赖 HTTP，状态/文件/AI 代理，只绑 `127.0.0.1`
- 桌面：Electron 33，主进程内嵌服务（随机端口），`safeStorage` 加密密钥

## License

MIT
