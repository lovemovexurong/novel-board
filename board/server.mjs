import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ 配置 */
const PORT = 4317;
// 服务根目录：所有 .board-*.json 状态、备份、章节目录都在这下面
const ROOT = path.resolve(process.cwd());
const CHAPTERS_DEFAULT = 'chapters';      // 相对 ROOT，可在 .board-config.json 里改
const BACKUP_DIR = path.join(ROOT, '.board-backup');
const STATE_FILE = path.join(ROOT, '.board-state.json');
const CONFIG_FILE = path.join(ROOT, '.board-config.json');
const SESSIONS_FILE = path.join(ROOT, '.board-sessions.json');
const MAX_BACKUPS = 60;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4',
};

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const now = () => new Date().toISOString().replace(/[:.]/g, '-');

function ensureBackupDir(){ try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {} }
function backupFile(file){                    // 覆盖前留一份
  try {
    if (!fs.existsSync(file)) return;
    ensureBackupDir();
    const base = path.basename(file).replace(/(\.[^.]+)$/, '');
    const ext = RegExp.$1 || '';
    fs.copyFileSync(file, path.join(BACKUP_DIR, `${base}-${now()}${ext}`));
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(base + '-')).sort();
    while (all.length > MAX_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
  } catch (e) { console.error('backup fail', e.message); }
}
function atomicWrite(file, text){             // 临时文件 + rename，避免写一半
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readJson(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function safeJoin(base, rel){
  const p = path.resolve(base, '.' + (path.sep + rel.replace(/^\/+/, '')));   // 保持相对语义，避免 Windows 盘符根
  if (!p.toLowerCase().startsWith(base.toLowerCase() + path.sep) && p !== base) return null;
  return p;
}

/* ------------------------------------------------------------------ AI 配置与会话 */
// .board-config.json: { "chaptersRoot": "chapters", "ai": { "baseUrl": "https://.../v1", "apiKey": "...", "model": "..." } }
let config = readJson(CONFIG_FILE, {});
let ai = {
  sharedSummary: '',
  sessions: {},                               // chapterFile -> { messages: [{role, content}] }
};
let aiDirty = false;
function loadSessions(){
  const s = readJson(SESSIONS_FILE, null);
  if (s && typeof s === 'object'){ ai.sharedSummary = s.sharedSummary || ''; ai.sessions = s.sessions || {}; }
}
function saveSessions(){
  try { atomicWrite(SESSIONS_FILE, JSON.stringify(ai, null, 2)); aiDirty = false; }
  catch (e) { console.error('save sessions fail', e.message); }
}
loadSessions();
setInterval(() => { if (aiDirty) saveSessions(); }, 3000);

const chaptersRoot = () => path.join(ROOT, config.chaptersRoot || CHAPTERS_DEFAULT);

function buildSystemPrompt(chapterFile){
  const lines = [
    '你是网文创作参谋，与作者围绕某一章展开讨论。',
    '回答用简体中文，简洁、具体、可直接执行，不要空话。',
    '除本章外，以下摘要汇总了作者在其他章节会话里讨论过的要点，供跨章参考：',
    ai.sharedSummary ? ai.sharedSummary.slice(0, 4000) : '（暂无）',
    `当前讨论章节：${chapterFile}`,
  ];
  return lines.join('\n');
}
// 每轮对话后异步维护跨章共享摘要（失败静默，不阻塞回答）
async function refreshSharedSummary(){
  try {
    const cfg = config.ai || {};
    const recent = [];
    for (const [k, s] of Object.entries(ai.sessions)) recent.push(`【${k}】` + (s.messages.slice(-2).map(m => m.role + ': ' + m.content.slice(0, 160)).join(' | ')));
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
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
    if (text){ ai.sharedSummary = text; aiDirty = true; }
  } catch (e) { console.error('summary refresh fail:', e.message); }
}

/* ------------------------------------------------------------------ 路由 */
function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 32 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function handleApi(req, res, u, q){
  /* ---- 看板状态 ---- */
  if (u === '/api/state' && req.method === 'GET'){
    const text = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : JSON.stringify({ version: 1, nodes: [], connections: [], appearance: null });
    return json(res, 200, { state: JSON.parse(text), hash: sha1(text) });
  }
  if (u === '/api/state' && req.method === 'PUT'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const text = JSON.stringify(body.state ?? {}, null, 2);
    const cur = fs.existsSync(STATE_FILE) ? sha1(fs.readFileSync(STATE_FILE, 'utf8')) : null;
    if (body.baseHash && cur && body.baseHash !== cur) return json(res, 409, { error: 'conflict', hash: cur });
    backupFile(STATE_FILE);
    atomicWrite(STATE_FILE, text);
    return json(res, 200, { hash: sha1(text) });
  }

  /* ---- 章节文件 ---- */
  if (u === '/api/files' && req.method === 'GET'){
    const dir = chaptersRoot();
    if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
    const out = [];
    for (const name of fs.readdirSync(dir)){
      const p = path.join(dir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isFile() && /\.(md|txt)$/i.test(name)) out.push({ name, size: st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return json(res, 200, { root: path.relative(ROOT, dir) || '.', files: out });
  }
  if (u === '/api/file' && req.method === 'GET'){
    const p = safeJoin(chaptersRoot(), q.get('p') || '');
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return json(res, 404, { error: 'not found' });
    const text = fs.readFileSync(p, 'utf8');
    return json(res, 200, { content: text, hash: sha1(text), mtime: fs.statSync(p).mtimeMs });
  }
  if (u === '/api/file' && req.method === 'PUT'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const p = safeJoin(chaptersRoot(), body.p || '');
    if (!p) return json(res, 403, { error: 'bad path' });
    const content = String(body.content ?? '');
    if (fs.existsSync(p)){
      const cur = sha1(fs.readFileSync(p, 'utf8'));
      if (body.baseHash && body.baseHash !== cur) return json(res, 409, { error: 'conflict', hash: cur });
      backupFile(p);
    }
    atomicWrite(p, content);
    return json(res, 200, { hash: sha1(content), mtime: fs.statSync(p).mtimeMs });
  }
  if (u === '/api/file/create' && req.method === 'POST'){
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
    atomicWrite(p, content);
    return json(res, 200, { name, hash: sha1(content) });
  }
  if (u === '/api/file/delete' && req.method === 'POST'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const p = safeJoin(chaptersRoot(), body.p || '');
    if (!p || !fs.existsSync(p)) return json(res, 404, { error: 'not found' });
    backupFile(p);
    fs.unlinkSync(p);
    return json(res, 200, { ok: true });
  }

  /* ---- AI ---- */
  if (u === '/api/ai/status' && req.method === 'GET'){
    const c = config.ai || {};
    return json(res, 200, { configured: !!(c.baseUrl && c.apiKey && c.model), model: c.model || '', sharedSummary: ai.sharedSummary });
  }
  if (u === '/api/ai/chat' && req.method === 'POST'){
    const cfg = config.ai || {};
    if (!(cfg.baseUrl && cfg.apiKey && cfg.model)) return json(res, 501, { error: '未配置 AI。请在 .board-config.json 填写 ai.baseUrl / apiKey / model。' });
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
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
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
      refreshSharedSummary();                    // 异步，不等待
      return json(res, 200, { reply, sharedSummary: ai.sharedSummary });
    } catch (e) {
      return json(res, 502, { error: '请求上游失败：' + e.message });
    }
  }
  if (u === '/api/ai/clear' && req.method === 'POST'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.all) ai.sessions = {}; else delete ai.sessions[String(body.chapter || '')];
    aiDirty = true;
    return json(res, 200, { ok: true });
  }

  /* ---- 服务端配置（不回传 key） ---- */
  if (u === '/api/config' && req.method === 'GET'){
    return json(res, 200, { root: ROOT, chaptersRoot: path.relative(ROOT, chaptersRoot()) || '.', aiConfigured: !!(config.ai?.baseUrl && config.ai?.apiKey && config.ai?.model) });
  }
  if (u === '/api/config' && req.method === 'PUT'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    if (body.chaptersRoot) config.chaptersRoot = String(body.chaptersRoot);
    if (body.ai) config.ai = { ...(config.ai || {}), ...body.ai };
    atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2));
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'no api' });
}

/* ------------------------------------------------------------------ 静态文件 */
function serveStatic(req, res, pathname){
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = safeJoin(ROOT, rel);
  if (!file) { res.writeHead(403); return res.end('no'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()){
      // 单页兜底：/board/* 下未命中的 html 路径回 index
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)){
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = s ? parseInt(s, 10) : 0;
      const end = e ? Math.min(parseInt(e, 10), st.size - 1) : st.size - 1;
      if (start >= st.size || end < start){ res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const u = decodeURIComponent(url.pathname);
  try {
    if (u.startsWith('/api/')) return await handleApi(req, res, u, url.searchParams);
    return serveStatic(req, res, u);
  } catch (e) {
    console.error(e);
    try { json(res, 500, { error: e.message }); } catch {}
  }
}).listen(PORT, '127.0.0.1', () => {
  ensureBackupDir();
  console.log(`小说结构看板  http://127.0.0.1:${PORT}/`);
  console.log(`根目录 ${ROOT}`);
});
