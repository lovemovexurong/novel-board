/**
 * 小说看板 · 本地服务（零依赖，可嵌入 Electron 主进程）
 *
 * 可独立运行（开发模式）：node app/server.mjs  →  http://127.0.0.1:4317/
 * 也可被主进程 createBoardServer({ ... }) 调用，端口与数据目录全部注入。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const now = () => new Date().toISOString().replace(/[:.]/g, '-');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + (path.sep + String(rel).replace(/^\/+/, '')));
  if (!p.toLowerCase().startsWith(base.toLowerCase() + path.sep) && p !== base) return null;
  return p;
}

/**
 * @param {object} opts
 * @param {string} [opts.appRoot]      静态资源根（index.html 所在）
 * @param {string} [opts.dataDir]      状态/备份/会话/配置落盘目录
 * @param {()=>string} [opts.getChaptersRoot]  章节根目录
 * @param {()=>string} [opts.getApiKey]        AI 密钥提供者（桌面端走 safeStorage）
 * @param {(k:string)=>void} [opts.setApiKey]  保存密钥（桌面端加密落盘）
 * @param {number} [opts.port]         0 = 随机可用端口
 * @param {string} [opts.host]
 */
export function createBoardServer(opts = {}) {
  const APP_ROOT = path.resolve(opts.appRoot || __dirname);
  const DATA_DIR = path.resolve(opts.dataDir || APP_ROOT);
  const HOST = opts.host || '127.0.0.1';
  const PORT = Number.isFinite(opts.port) ? opts.port : 0;

  const BACKUP_DIR = path.join(DATA_DIR, 'backups');
  const STATE_FILE = path.join(DATA_DIR, 'board-state.json');
  const CONFIG_FILE = path.join(DATA_DIR, 'board-config.json');
  const SESSIONS_FILE = path.join(DATA_DIR, 'board-sessions.json');
  const MAX_BACKUPS = 60;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ensureBackupDir = () => { try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {} };

  function backupFile(file) {
    try {
      if (!fs.existsSync(file)) return;
      ensureBackupDir();
      const base = path.basename(file).replace(/(\.[^.]+)$/, '');
      const ext = RegExp.$1 || '';
      fs.copyFileSync(file, path.join(BACKUP_DIR, `${base}-${now()}${ext}`));
      const all = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(base + '-')).sort();
      while (all.length > MAX_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    } catch (e) { console.error('[backup]', e.message); }
  }

  /* ---------------- 配置 / AI 会话 ---------------- */
  let config = readJson(CONFIG_FILE, {});
  const saveConfig = () => {
    const plain = JSON.parse(JSON.stringify(config));
    if (opts.setApiKey) delete (plain.ai || {}).apiKey;       // 密钥不进明文文件
    atomicWrite(CONFIG_FILE, JSON.stringify(plain, null, 2));
  };

  const apiKey = () => {
    const k = opts.getApiKey ? opts.getApiKey() : config.ai?.apiKey;
    return k || '';
  };
  const aiReady = () => !!(config.ai?.baseUrl && apiKey() && config.ai?.model);

  const ai = { sharedSummary: '', sessions: {} };
  let aiDirty = false;
  const loadSessions = () => {
    const s = readJson(SESSIONS_FILE, null);
    if (s && typeof s === 'object') { ai.sharedSummary = s.sharedSummary || ''; ai.sessions = s.sessions || {}; }
  };
  const saveSessions = () => {
    try { atomicWrite(SESSIONS_FILE, JSON.stringify(ai, null, 2)); aiDirty = false; }
    catch (e) { console.error('[sessions]', e.message); }
  };
  loadSessions();
  const timer = setInterval(() => { if (aiDirty) saveSessions(); }, 3000);
  timer.unref?.();

  const chaptersRoot = () => path.resolve(
    opts.getChaptersRoot ? opts.getChaptersRoot() : path.join(DATA_DIR, 'chapters')
  );

  function buildSystemPrompt(chapterFile) {
    return [
      '你是网文创作参谋，与作者围绕某一章展开讨论。',
      '回答用简体中文，简洁、具体、可直接执行，不要空话。',
      '除本章外，以下摘要汇总了作者在其他章节会话里讨论过的要点，供跨章参考：',
      ai.sharedSummary ? ai.sharedSummary.slice(0, 4000) : '（暂无）',
      `当前讨论章节：${chapterFile}`,
    ].join('\n');
  }

  async function refreshSharedSummary() {
    try {
      const cfg = config.ai || {};
      const recent = [];
      for (const [k, s] of Object.entries(ai.sessions))
        recent.push(`【${k}】` + s.messages.slice(-2).map(m => m.role + ': ' + m.content.slice(0, 160)).join(' | '));
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: '你是摘要器。把作者与参谋在多章会话里的讨论要点压缩成一份要点式摘要（每行一条，不超过 30 行，中文）。只输出摘要本身。' },
            { role: 'user', content: '旧摘要：\n' + (ai.sharedSummary || '（无）') + '\n\n最近对话：\n' + recent.join('\n').slice(0, 6000) },
          ],
          max_tokens: 600,
        }),
      });
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content?.trim();
      if (text) { ai.sharedSummary = text; aiDirty = true; }
    } catch (e) { console.error('[summary]', e.message); }
  }

  /* ---------------- 路由 ---------------- */
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  async function handleApi(req, res, u, q) {
    if (u === '/api/state' && req.method === 'GET') {
      const text = fs.existsSync(STATE_FILE)
        ? fs.readFileSync(STATE_FILE, 'utf8')
        : JSON.stringify({ version: 1, nodes: [], connections: [], appearance: null });
      return json(res, 200, { state: JSON.parse(text), hash: sha1(text) });
    }
    if (u === '/api/state' && req.method === 'PUT') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const text = JSON.stringify(body.state ?? {}, null, 2);
      const cur = fs.existsSync(STATE_FILE) ? sha1(fs.readFileSync(STATE_FILE, 'utf8')) : null;
      if (body.baseHash && cur && body.baseHash !== cur) return json(res, 409, { error: 'conflict', hash: cur });
      backupFile(STATE_FILE);
      atomicWrite(STATE_FILE, text);
      return json(res, 200, { hash: sha1(text) });
    }

    if (u === '/api/files' && req.method === 'GET') {
      const dir = chaptersRoot();
      if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
      const out = [];
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isFile() && /\.(md|txt)$/i.test(name)) out.push({ name, size: st.size, mtime: st.mtimeMs });
      }
      out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return json(res, 200, { root: dir, files: out });
    }
    if (u === '/api/file' && req.method === 'GET') {
      const p = safeJoin(chaptersRoot(), q.get('p') || '');
      if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return json(res, 404, { error: 'not found' });
      const text = fs.readFileSync(p, 'utf8');
      return json(res, 200, { content: text, hash: sha1(text), mtime: fs.statSync(p).mtimeMs });
    }
    if (u === '/api/file' && req.method === 'PUT') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const p = safeJoin(chaptersRoot(), body.p || '');
      if (!p) return json(res, 403, { error: 'bad path' });
      const content = String(body.content ?? '');
      if (fs.existsSync(p)) {
        const cur = sha1(fs.readFileSync(p, 'utf8'));
        if (body.baseHash && body.baseHash !== cur) return json(res, 409, { error: 'conflict', hash: cur });
        backupFile(p);
      }
      atomicWrite(p, content);
      return json(res, 200, { hash: sha1(content), mtime: fs.statSync(p).mtimeMs });
    }
    if (u === '/api/file/create' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      let name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: '需要文件名' });
      if (!/\.(md|txt)$/i.test(name)) name += '.md';
      if (/[\\/:*?"<>|]/.test(name)) return json(res, 400, { error: '文件名含非法字符' });
      const p = safeJoin(chaptersRoot(), name);
      if (!p) return json(res, 403, { error: 'bad path' });
      if (fs.existsSync(p)) return json(res, 409, { error: '同名文件已存在', name });
      const title = String(body.title || name.replace(/\.(md|txt)$/i, ''));
      const content = `# ${title}\n\n`;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      atomicWrite(p, content);
      return json(res, 200, { name, hash: sha1(content) });
    }
    if (u === '/api/file/delete' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const p = safeJoin(chaptersRoot(), body.p || '');
      if (!p || !fs.existsSync(p)) return json(res, 404, { error: 'not found' });
      backupFile(p);
      fs.unlinkSync(p);
      return json(res, 200, { ok: true });
    }

    if (u === '/api/ai/status' && req.method === 'GET') {
      return json(res, 200, {
        configured: aiReady(), model: config.ai?.model || '',
        baseUrl: config.ai?.baseUrl || '', sharedSummary: ai.sharedSummary,
      });
    }
    if (u === '/api/ai/chat' && req.method === 'POST') {
      const cfg = config.ai || {};
      if (!aiReady()) return json(res, 501, { error: '未配置 AI：请在右侧 AI 面板填写 Base URL / API Key / 模型。' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const key = String(body.chapter || '默认');
      const message = String(body.message || '').trim();
      if (!message) return json(res, 400, { error: '消息为空' });
      const s = ai.sessions[key] || (ai.sessions[key] = { messages: [] });
      s.messages.push({ role: 'user', content: message });
      if (s.messages.length > 60) s.messages.splice(0, s.messages.length - 60);
      let chapterExcerpt = '';
      try {
        const p = safeJoin(chaptersRoot(), key);
        if (p && fs.existsSync(p)) chapterExcerpt = fs.readFileSync(p, 'utf8').slice(0, 3000);
      } catch {}
      try {
        const res2 = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: buildSystemPrompt(key) },
              ...(chapterExcerpt ? [{ role: 'system', content: '本章正文节选：\n' + chapterExcerpt }] : []),
              ...s.messages,
            ],
          }),
        });
        const j = await res2.json();
        const reply = j?.choices?.[0]?.message?.content;
        if (!reply) return json(res, 502, { error: '上游无返回：' + (j?.error?.message || JSON.stringify(j).slice(0, 200)) });
        s.messages.push({ role: 'assistant', content: reply });
        aiDirty = true;
        refreshSharedSummary();
        return json(res, 200, { reply, sharedSummary: ai.sharedSummary });
      } catch (e) {
        return json(res, 502, { error: '请求上游失败：' + e.message });
      }
    }
    if (u === '/api/ai/clear' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      if (body.all) ai.sessions = {}; else delete ai.sessions[String(body.chapter || '')];
      aiDirty = true;
      return json(res, 200, { ok: true });
    }

    if (u === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        dataDir: DATA_DIR,
        chaptersRoot: chaptersRoot(),
        aiConfigured: aiReady(),
        ai: { baseUrl: config.ai?.baseUrl || '', model: config.ai?.model || '' },
      });
    }
    if (u === '/api/config' && req.method === 'PUT') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      if (body.chaptersRoot) config.chaptersRoot = String(body.chaptersRoot);
      if (body.ai) {
        const { apiKey: k, ...rest } = body.ai;
        config.ai = { ...(config.ai || {}), ...rest };
        if (k !== undefined) {
          if (opts.setApiKey) opts.setApiKey(String(k));
          else config.ai.apiKey = String(k);
        }
      }
      saveConfig();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'no api' });
  }

  /* ---------------- 静态资源 ---------------- */
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = safeJoin(APP_ROOT, rel);
    if (!file) { res.writeHead(403); return res.end('no'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      if (range && /^bytes=/.test(range)) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = s ? parseInt(s, 10) : 0;
        const end = e ? Math.min(parseInt(e, 10), st.size - 1) : st.size - 1;
        if (start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, {
          'Content-Type': type, 'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const u = decodeURIComponent(url.pathname);
    try {
      if (u.startsWith('/api/')) return await handleApi(req, res, u, url.searchParams);
      return serveStatic(req, res, u);
    } catch (e) {
      console.error('[api]', e);
      try { json(res, 500, { error: e.message }); } catch {}
    }
  });

  return {
    server,
    dataDir: DATA_DIR,
    appRoot: APP_ROOT,
    chaptersRoot,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => {
          ensureBackupDir();
          const addr = server.address();
          resolve({ port: addr.port, url: `http://${HOST}:${addr.port}/` });
        });
      });
    },
    close() {
      clearInterval(timer);
      if (aiDirty) saveSessions();
      return new Promise(r => server.close(() => r()));
    },
  };
}

/* ---------------- 独立运行（浏览器开发模式） ---------------- */
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const inst = createBoardServer({
    appRoot: __dirname,
    dataDir: __dirname,
    port: Number(process.env.PORT || 4317),
  });
  inst.listen().then(({ url }) => {
    console.log(`小说结构看板（浏览器模式）  ${url}`);
    console.log(`数据目录 ${inst.dataDir}`);
    console.log(`章节目录 ${inst.chaptersRoot()}`);
  }).catch(e => { console.error('启动失败', e); process.exit(1); });
}
