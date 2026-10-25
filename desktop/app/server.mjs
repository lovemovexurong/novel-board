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
  const USAGE_FILE = path.join(DATA_DIR, 'board-usage.json');
  const MAX_BACKUPS = 60;

  /* ---------------- 工作区（按文件夹划分） ---------------- */
  const WS_DIR = path.join(DATA_DIR, 'workspaces');
  const WS_STATE = 'board-state.json';
  const WS_CHAPTERS = 'chapters';
  const wsDir = (ws) => (ws ? safeJoin(WS_DIR, ws) : DATA_DIR);
  const wsStateFile = (ws) => path.join(wsDir(ws), WS_STATE);
  const wsChaptersDir = (ws) => {
    const base = wsDir(ws);
    const cfg = readJson(path.join(base, 'board-config.json'), {});
    return path.join(base, cfg.chaptersRoot || WS_CHAPTERS);
  };
  const wsSessionsFile = (ws) => path.join(wsDir(ws), 'board-sessions.json');
  const validWsId = (ws) => {
    if (typeof ws !== 'string' || !ws) return false;
    if (/[\\]/.test(ws)) return false;
    return ws.split('/').filter(Boolean).every(p => p && p !== '.' && p !== '..' && !/[<>:"|?*]/.test(p));
  };
  const wsIdOf = (rel) => String(rel || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const listSubWs = (ws) => {
    const base = ws ? wsDir(ws) : WS_DIR;
    const out = [];
    let names = []; try { names = fs.readdirSync(base); } catch {}
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (name === WS_CHAPTERS) continue;
      const p = path.join(base, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      const id = ws ? (ws + '/' + name) : name;
      out.push({ id, name, parent: ws, hasState: fs.existsSync(path.join(p, WS_STATE)), children: [] });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  };
  const wsTree = () => {
    const root = { id: '', name: '看板（默认）', parent: null, hasState: fs.existsSync(STATE_FILE), children: [] };
    const walk = (node) => { for (const c of listSubWs(node.id)) { node.children.push(c); walk(c); } };
    walk(root);
    return root;
  };

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

  const aiByWs = {};
  const aiOf = (ws) => { if (!aiByWs[ws]) aiByWs[ws] = { sharedSummary: '', sessions: {}, dirty: false }; return aiByWs[ws]; };
  const loadSessions = () => {
    const s = readJson(SESSIONS_FILE, null);
    if (s && typeof s === 'object') { const a = aiOf(''); a.sharedSummary = s.sharedSummary || ''; a.sessions = s.sessions || {}; }
    const loadWs = (dir) => {
      let names = []; try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const p = path.join(dir, name);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) {
          const id = path.relative(WS_DIR, p).split(path.sep).join('/');
          const sj = readJson(path.join(p, 'board-sessions.json'), null);
          if (sj && typeof sj === 'object') { const a = aiOf(id); a.sharedSummary = sj.sharedSummary || ''; a.sessions = sj.sessions || {}; }
          loadWs(p);
        }
      }
    };
    if (fs.existsSync(WS_DIR)) loadWs(WS_DIR);
  };
  const saveSessions = () => {
    for (const [ws, a] of Object.entries(aiByWs)) {
      if (!a.dirty) continue;
      const file = ws ? wsSessionsFile(ws) : SESSIONS_FILE;
      try { atomicWrite(file, JSON.stringify({ sharedSummary: a.sharedSummary, sessions: a.sessions }, null, 2)); a.dirty = false; }
      catch (e) { console.error('[sessions]', e.message); }
    }
  };
  loadSessions();
  const timer = setInterval(saveSessions, 3000);
  timer.unref?.();

  /* ---------------- Token 用量 ---------------- */
  let usage = readJson(USAGE_FILE, { byChapter: {}, daily: {}, total: { prompt: 0, completion: 0, total: 0 } });
  let usageDirty = false;
  const todayKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const addUsage = (ws, chapter, u) => {
    if (!u || typeof u.prompt_tokens !== 'number') return;
    const p = u.prompt_tokens || 0, c = u.completion_tokens || 0, t = u.total_tokens || (p + c);
    usage.total.prompt += p; usage.total.completion += c; usage.total.total += t;
    const dk = todayKey();
    const d = usage.daily[dk] || (usage.daily[dk] = { prompt: 0, completion: 0, total: 0 });
    d.prompt += p; d.completion += c; d.total += t;
    const ck = (ws ? ws + '|' : '') + (chapter || '默认');
    const cu = usage.byChapter[ck] || (usage.byChapter[ck] = { prompt: 0, completion: 0, total: 0 });
    cu.prompt += p; cu.completion += c; cu.total += t;
    usageDirty = true;
  };
  const saveUsage = () => {
    if (!usageDirty) return;
    try { atomicWrite(USAGE_FILE, JSON.stringify(usage, null, 2)); usageDirty = false; }
    catch (e) { console.error('[usage]', e.message); }
  };
  const usageTimer = setInterval(saveUsage, 3000);
  usageTimer.unref?.();

  const chaptersRoot = (ws) => path.resolve(
    opts.getChaptersRoot
      ? path.join(opts.getChaptersRoot(), ws ? ws.split('/').join(path.sep) : '')
      : (ws ? wsChaptersDir(ws) : path.join(DATA_DIR, 'chapters'))
  );

  function buildSystemPrompt(chapterFile, ai) {
    return [
      '你是网文创作参谋，与作者围绕某一章展开讨论。',
      '回答用简体中文，简洁、具体、可直接执行，不要空话。',
      '除本章外，以下摘要汇总了作者在其他章节会话里讨论过的要点，供跨章参考：',
      ai.sharedSummary ? ai.sharedSummary.slice(0, 4000) : '（暂无）',
      `当前讨论章节：${chapterFile}`,
    ].join('\n');
  }

  async function refreshSharedSummary(ai) {
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
      if (text) { ai.sharedSummary = text; ai.dirty = true; }
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
    const ws = validWsId(q.get('ws') || '') ? wsIdOf(q.get('ws') || '') : '';
    const stateFile = ws ? wsStateFile(ws) : STATE_FILE;

    /* ---------------- 工作区 ---------------- */
    if (u === '/api/ws/tree' && req.method === 'GET') return json(res, 200, { tree: wsTree() });
    if (u === '/api/ws/create' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const parent = validWsId(body.parent || '') ? wsIdOf(body.parent || '') : '';
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: '需要工作区名称' });
      if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return json(res, 400, { error: '名称含非法字符' });
      const id = parent ? parent + '/' + name : name;
      if (!validWsId(id)) return json(res, 400, { error: '非法路径' });
      const dir = wsDir(id);
      if (fs.existsSync(dir)) return json(res, 409, { error: '同名工作区已存在' });
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, WS_CHAPTERS), { recursive: true });
      atomicWrite(wsStateFile(id), JSON.stringify({ version: 1, nodes: [], connections: [], appearance: null }, null, 2));
      return json(res, 200, { id, name });
    }
    if (u === '/api/ws/delete' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const id = wsIdOf(body.ws || '');
      if (!id) return json(res, 400, { error: '不能删除默认看板' });
      if (!validWsId(id)) return json(res, 400, { error: '非法路径' });
      const dir = wsDir(id);
      if (!fs.existsSync(dir)) return json(res, 404, { error: '工作区不存在' });
      const st = wsStateFile(id);
      if (fs.existsSync(st)) backupFile(st);
      fs.rmSync(dir, { recursive: true, force: true });
      delete aiByWs[id];
      return json(res, 200, { ok: true });
    }
    if (u === '/api/ws/rename' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const id = wsIdOf(body.ws || '');
      if (!id) return json(res, 400, { error: '不能重命名默认看板' });
      if (!validWsId(id)) return json(res, 400, { error: '非法路径' });
      const name = String(body.name || '').trim();
      if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return json(res, 400, { error: '名称非法' });
      const dir = wsDir(id);
      if (!fs.existsSync(dir)) return json(res, 404, { error: '工作区不存在' });
      const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
      const newId = parent ? parent + '/' + name : name;
      const newDir = wsDir(newId);
      if (fs.existsSync(newDir)) return json(res, 409, { error: '同名工作区已存在' });
      fs.renameSync(dir, newDir);
      if (aiByWs[id]) { aiByWs[newId] = aiByWs[id]; delete aiByWs[id]; }
      return json(res, 200, { id: newId, name });
    }

    /* ---------------- 看板状态 ---------------- */
    if (u === '/api/state' && req.method === 'GET') {
      const text = fs.existsSync(stateFile)
        ? fs.readFileSync(stateFile, 'utf8')
        : JSON.stringify({ version: 1, nodes: [], connections: [], appearance: null });
      return json(res, 200, { state: JSON.parse(text), hash: sha1(text) });
    }
    if (u === '/api/state' && req.method === 'PUT') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const text = JSON.stringify(body.state ?? {}, null, 2);
      const cur = fs.existsSync(stateFile) ? sha1(fs.readFileSync(stateFile, 'utf8')) : null;
      if (body.baseHash && cur && body.baseHash !== cur) return json(res, 409, { error: 'conflict', hash: cur });
      backupFile(stateFile);
      atomicWrite(stateFile, text);
      return json(res, 200, { hash: sha1(text) });
    }

    /* ---------------- 章节文件 ---------------- */
    if (u === '/api/files' && req.method === 'GET') {
      const dir = chaptersRoot(ws);
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
      const p = safeJoin(chaptersRoot(ws), q.get('p') || '');
      if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return json(res, 404, { error: 'not found' });
      const text = fs.readFileSync(p, 'utf8');
      return json(res, 200, { content: text, hash: sha1(text), mtime: fs.statSync(p).mtimeMs });
    }
    if (u === '/api/file' && req.method === 'PUT') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const p = safeJoin(chaptersRoot(ws), body.p || '');
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
      const p = safeJoin(chaptersRoot(ws), name);
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
      const p = safeJoin(chaptersRoot(ws), body.p || '');
      if (!p || !fs.existsSync(p)) return json(res, 404, { error: 'not found' });
      backupFile(p);
      fs.unlinkSync(p);
      return json(res, 200, { ok: true });
    }

    /* ---------------- AI ---------------- */
    if (u === '/api/ai/status' && req.method === 'GET') {
      const ai = aiOf(ws);
      return json(res, 200, {
        configured: aiReady(), model: config.ai?.model || '',
        baseUrl: config.ai?.baseUrl || '', sharedSummary: ai.sharedSummary,
      });
    }
    if (u === '/api/ai/models' && req.method === 'GET') {
      const c = config.ai || {};
      if (!(c.baseUrl && apiKey())) return json(res, 200, { models: [], error: '请先填写 Base URL 与 API Key' });
      try {
        const res2 = await fetch(c.baseUrl.replace(/\/$/, '') + '/models', {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + apiKey() },
        });
        const j = await res2.json();
        const arr = j?.data || j?.models || (Array.isArray(j) ? j : []);
        const models = arr.map(m => (typeof m === 'string' ? m : m.id || m.name || m.model)).filter(Boolean).sort();
        return json(res, 200, { models });
      } catch (e) {
        return json(res, 200, { models: [], error: '获取模型列表失败：' + e.message });
      }
    }
    if (u === '/api/ai/chat' && req.method === 'POST') {
      const cfg = config.ai || {};
      if (!aiReady()) return json(res, 501, { error: '未配置 AI：请填写 API Key 并选择模型。' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const key = String(body.chapter || '默认');
      const message = String(body.message || '').trim();
      if (!message) return json(res, 400, { error: '消息为空' });
      const ai = aiOf(ws);
      const s = ai.sessions[key] || (ai.sessions[key] = { messages: [] });
      s.messages.push({ role: 'user', content: message });
      if (s.messages.length > 60) s.messages.splice(0, s.messages.length - 60);
      let chapterExcerpt = '';
      try {
        const p = safeJoin(chaptersRoot(ws), key);
        if (p && fs.existsSync(p)) chapterExcerpt = fs.readFileSync(p, 'utf8').slice(0, 3000);
      } catch {}
      try {
        const res2 = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: buildSystemPrompt(key, ai) },
              ...(chapterExcerpt ? [{ role: 'system', content: '本章正文节选：\n' + chapterExcerpt }] : []),
              ...s.messages,
            ],
          }),
        });
        const j = await res2.json();
        const reply = j?.choices?.[0]?.message?.content;
        if (!reply) return json(res, 502, { error: '上游无返回：' + (j?.error?.message || JSON.stringify(j).slice(0, 200)) });
        s.messages.push({ role: 'assistant', content: reply });
        ai.dirty = true;
        addUsage(ws, key, j?.usage);
        refreshSharedSummary(ai);
        return json(res, 200, { reply, sharedSummary: ai.sharedSummary, usage: j?.usage || null });
      } catch (e) {
        return json(res, 502, { error: '请求上游失败：' + e.message });
      }
    }
    if (u === '/api/ai/clear' && req.method === 'POST') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const ai = aiOf(ws);
      if (body.all) ai.sessions = {}; else delete ai.sessions[String(body.chapter || '')];
      ai.dirty = true;
      return json(res, 200, { ok: true });
    }
    if (u === '/api/ai/usage' && req.method === 'GET') {
      const chapter = q.get('chapter') || '';
      const ck = (ws ? ws + '|' : '') + (chapter || '默认');
      const today = usage.daily[todayKey()] || { prompt: 0, completion: 0, total: 0 };
      return json(res, 200, {
        total: usage.total || { prompt: 0, completion: 0, total: 0 },
        today,
        chapter: usage.byChapter[ck] || { prompt: 0, completion: 0, total: 0 },
      });
    }

    if (u === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        dataDir: DATA_DIR,
        chaptersRoot: chaptersRoot(ws),
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
      clearInterval(usageTimer);
      saveSessions();
      saveUsage();
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
