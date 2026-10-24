/**
 * 小说看板 · Electron 主进程（CommonJS，兼容性最好）
 * - 单实例、窗口记忆、托盘
 * - 首启选择书稿目录（之后可在「外观 → 桌面端」改）
 * - 本地服务跑在主进程内（随机端口，仅 127.0.0.1）
 * - API Key 用 safeStorage 加密存于 userData
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, shell, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.join(__dirname, '..', 'app');
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const isDev = !app.isPackaged && process.env.BOARD_DEV === '1';

/* 数据目录固定为 ASCII 路径（避免中文路径带来的工具链/备份兼容问题） */
app.setPath('userData', path.join(app.getPath('appData'), 'novel-board'));

/* 某些虚拟机/远程桌面无可用 GPU，可用环境变量强制软件渲染 */
if (process.env.BOARD_SOFTWARE_RENDER === '1') app.disableHardwareAcceleration();

let win = null;
let tray = null;
let trayMenu = null;
let boardServer = null;
let serverUrl = '';
let quitting = false;
let createBoardServer = null;      // 动态 import 的 ESM 服务

/* ---------------- 设置 ---------------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');

const DEFAULT_SETTINGS = {
  chaptersDir: '',
  closeBehavior: 'tray',                     // 'tray' | 'quit'
  window: { width: 1360, height: 880, maximized: false },
  trayHintShown: false,
};

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...s, window: { ...DEFAULT_SETTINGS.window, ...(s.window || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch (e) { console.error('[settings]', e.message); }
  rebuildTrayMenu();
  return s;
}

/* ---------------- API Key（safeStorage） ---------------- */
function getApiKey() {
  try {
    if (!fs.existsSync(keyFile())) return '';
    const raw = fs.readFileSync(keyFile());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(raw);
    return raw.toString('utf8');
  } catch { return ''; }
}
function setApiKey(key) {
  try {
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    if (!key) { if (fs.existsSync(keyFile())) fs.unlinkSync(keyFile()); return; }
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
    fs.writeFileSync(keyFile(), buf);
  } catch (e) { console.error('[key]', e.message); }
}

/* ---------------- 目录选择 ---------------- */
async function pickChaptersDir(parent, current) {
  const res = await dialog.showOpenDialog(parent || win || undefined, {
    title: '选择书稿目录（存放章节 .md 文件）',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || app.getPath('documents'),
    buttonLabel: '用这个目录',
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

/* 首次启动迁移旧版数据（旧 board/.board-state.json、.board-config.json、.board-sessions.json）
   可通过环境变量 BOARD_LEGACY_DIR 指定旧目录；已存在则不覆盖。 */
function migrateLegacyData() {
  const legacy = process.env.BOARD_LEGACY_DIR;
  if (!legacy || !fs.existsSync(legacy)) return;
  const pairs = [
    ['.board-state.json', 'board-state.json'],
    ['.board-config.json', 'board-config.json'],
    ['.board-sessions.json', 'board-sessions.json'],
  ];
  for (const [from, to] of pairs) {
    const src = path.join(legacy, from);
    const dst = path.join(app.getPath('userData'), to);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        console.log('[migrate]', from, '→', to);
      }
    } catch (e) { console.error('[migrate]', e.message); }
  }
}

/* ---------------- 服务 ---------------- */
async function startServer() {
  if (!createBoardServer) {
    const { pathToFileURL } = require('node:url');
    const mod = await import(pathToFileURL(path.join(APP_ROOT, 'server.mjs')).href);
    createBoardServer = mod.createBoardServer;
  }

  migrateLegacyData();

  let chaptersDir = readSettings().chaptersDir;
  if (!chaptersDir || !fs.existsSync(chaptersDir)) {
    const fallback = path.join(app.getPath('documents'), '小说看板');
    const picked = await pickChaptersDir(null, fs.existsSync(fallback) ? fallback : app.getPath('documents'));
    chaptersDir = picked || fallback;
    fs.mkdirSync(chaptersDir, { recursive: true });
    writeSettings({ chaptersDir });
  }

  boardServer = createBoardServer({
    appRoot: APP_ROOT,
    dataDir: app.getPath('userData'),
    port: 0,
    getChaptersRoot: () => readSettings().chaptersDir || chaptersDir,
    getApiKey,
    setApiKey,
  });
  const { port, url } = await boardServer.listen();
  serverUrl = url;
  console.log('[board]', url, '| chapters:', chaptersDir, '| data:', app.getPath('userData'));
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const s = readSettings();
  win = new BrowserWindow({
    width: s.window.width,
    height: s.window.height,
    x: s.window.x,
    y: s.window.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#fbfbfb',
    title: '小说看板',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (s.window.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(serverUrl);

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverUrl)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    const cur = readSettings();
    cur.window = { ...b, maximized: win.isMaximized() };
    try { fs.writeFileSync(settingsFile(), JSON.stringify(cur, null, 2)); } catch {}
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  win.on('close', (e) => {
    if (quitting) return;
    if (readSettings().closeBehavior === 'tray' && tray) {
      e.preventDefault();
      win.hide();
      if (!readSettings().trayHintShown) {
        writeSettings({ trayHintShown: true });
        try { tray.displayBalloon({ title: '小说看板仍在后台', content: '点托盘图标可重新打开；右键可退出。' }); } catch {}
      }
    }
  });

  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- 托盘 ---------------- */
function rebuildTrayMenu() {
  if (!tray) return;
  const s = readSettings();
  trayMenu = Menu.buildFromTemplate([
    { label: '打开看板', click: showWindow },
    { type: 'separator' },
    { label: '关闭窗口时最小化到托盘', type: 'radio', checked: (s.closeBehavior || 'tray') === 'tray',
      click: () => writeSettings({ closeBehavior: 'tray' }) },
    { label: '关闭窗口时直接退出', type: 'radio', checked: s.closeBehavior === 'quit',
      click: () => writeSettings({ closeBehavior: 'quit' }) },
    { type: 'separator' },
    { label: '打开书稿目录', click: () => { const d = readSettings().chaptersDir; if (d) shell.openPath(d); } },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(trayMenu);
}

function createTray() {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('小说看板');
  rebuildTrayMenu();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('board:info', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    chaptersDir: readSettings().chaptersDir,
    closeBehavior: readSettings().closeBehavior,
    platform: process.platform,
  }));

  ipcMain.handle('board:pickChaptersDir', async () => {
    const picked = await pickChaptersDir(win, readSettings().chaptersDir);
    if (!picked) return { ok: false };
    fs.mkdirSync(picked, { recursive: true });
    writeSettings({ chaptersDir: picked });
    return { ok: true, dir: picked };
  });

  ipcMain.handle('board:setCloseBehavior', (_e, v) => {
    if (!['tray', 'quit'].includes(v)) return { ok: false };
    writeSettings({ closeBehavior: v });
    return { ok: true };
  });

  ipcMain.handle('board:openDataDir', () => { shell.openPath(app.getPath('userData')); return { ok: true }; });
  ipcMain.handle('board:openChaptersDir', () => {
    const d = readSettings().chaptersDir;
    if (d) shell.openPath(d);
    return { ok: !!d };
  });
  ipcMain.handle('board:setZoom', (_e, factor) => {
    if (!win) return { ok: false };
    win.webContents.setZoomFactor(Math.min(2, Math.max(0.6, Number(factor) || 1)));
    return { ok: true, factor: win.webContents.getZoomFactor() };
  });
}

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerIpc();
    try {
      await startServer();
    } catch (e) {
      console.error(e);
      dialog.showErrorBox('启动失败', '本地服务无法启动：\n' + (e && e.message ? e.message : String(e)));
      app.quit();
      return;
    }
    createWindow();
    createTray();
  });

  app.on('window-all-closed', () => {
    if (readSettings().closeBehavior === 'quit') { quitting = true; app.quit(); }
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { try { boardServer && boardServer.close(); } catch {} });
}
