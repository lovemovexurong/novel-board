import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ 配置 */
const PORT = 4317;
// 服务根目录：所有工作区、状态、备份、章节目录都在这下面
const ROOT = path.resolve(process.cwd());
const CHAPTERS_DEFAULT = 'chapters';      // 相对每个工作区，可在 .board-config.json 里改
const BACKUP_DIR = path.join(ROOT, '.board-backup');
const STATE_FILE = path.join(ROOT, '.board-state.json');         // 兼容旧版：根目录单看板
const CONFIG_FILE = path.join(ROOT, '.board-config.json');
const SESSIONS_FILE = path.join(ROOT, '.board-sessions.json');
const USAGE_FILE = path.join(ROOT, '.board-usage.json');         // token 用量持久化
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

/* ------------------------------------------------------------------ 工作区（按文件夹划分） */
// 目录布局：ROOT/workspaces/<小说>/ 为顶级工作区；其下任意子目录为子工作区。
// 每个工作区一个 <name>.board-state.json + chapters/ 章节目录（或 .board-config.json 里指定的章节目录）。
// 工作区用相对路径标识（用 '/' 分隔，不含前导/尾随斜杠），顶层为空字符串表示根目录旧看板。
const WS_DIR = path.join(ROOT, 'workspaces');
const WS_STATE = '.board-state.json';        // 每个工作区目录内状态文件名
const WS_CHAPTERS = 'chapters';              // 每个工作区默认章节目录

function wsDir(ws){
  if (!ws) return ROOT;
  const p = safeJoin(WS_DIR, ws);
  return p;
}
function wsStateFile(ws){ return path.join(wsDir(ws), WS_STATE); }
function wsChaptersDir(ws){
  const base = wsDir(ws);
  const cfg = readJson(path.join(base, '.board-config.json'), {});
  return path.join(base, cfg.chaptersRoot || WS_CHAPTERS);
}
function wsConfigFile(ws){ return path.join(wsDir(ws), '.board-config.json'); }
function wsSessionsFile(ws){ return path.join(wsDir(ws), '.board-sessions.json'); }

/* 校验工作区 id：只允许目录名，禁止越界/非法字符 */
function validWsId(ws){
  if (typeof ws !== 'string' || !ws) return false;
  if (/[\\]/.test(ws)) return false;
  const parts = ws.split('/').filter(Boolean);
  for (const p of parts){
    if (!p || p === '.' || p === '..' || /[<>:"|?*]/.test(p)) return false;
  }
  return true;
}
function wsIdOf(rel){
  // 由 /api/ws 相对路径转 id：去掉前导斜杠
  return String(rel || '').replace(/^\/+/, '').replace(/\/+$/, '');
}
/* 枚举某工作区下的直接子工作区：默认看板的子工作区在 workspaces/ 下，其余在各自目录下 */
function listSubWs(ws){
  const base = ws ? wsDir(ws) : WS_DIR;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch {}
  for (const name of names){
    if (name.startsWith('.')) continue;
    if (name === WS_CHAPTERS) continue;      // 章节目录不是工作区
    const p = path.join(base, name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const id = ws ? (ws + '/' + name) : name;
    out.push({ id, name, parent: ws, hasState: fs.existsSync(path.join(p, WS_STATE)), children: [] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}
/* 递归枚举工作区树（含顶层） */
function wsTree(){
  const root = { id: '', name: '看板（默认）', parent: null, hasState: fs.existsSync(STATE_FILE), children: [] };
  const walk = (node) => {
    for (const c of listSubWs(node.id)){ node.children.push(c); walk(c); }
  };
  walk(root);
  return root;
}
function wsBreadcrumb(ws){
  return ws ? ws.split('/').map((p, i, a) => a.slice(0, i + 1).join('/')) : [];
}

/* ------------------------------------------------------------------ AI 配置与会话（分工作区） */
// 根级 .board-config.json 仍是全局 AI 配置（Base URL / Key / model 跨工作区共享）
let config = readJson(CONFIG_FILE, {});
const aiByWs = {};                            // ws -> { sharedSummary, sessions }
function aiOf(ws){
  if (!aiByWs[ws]) aiByWs[ws] = { sharedSummary: '', sessions: {}, dirty: false };
  return aiByWs[ws];
}
function loadSessions(){
  // 兼容旧版：根级 .board-sessions.json 视为默认工作区的会话
  const s = readJson(SESSIONS_FILE, null);
  if (s && typeof s === 'object'){ const a = aiOf(''); a.sharedSummary = s.sharedSummary || ''; a.sessions = s.sessions || {}; }
  // 各工作区目录内 .board-sessions.json
  const loadWs = (dir) => {
    let names = []; try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names){
      if (name.startsWith('.')) continue;
      const p = path.join(dir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()){
        const id = path.relative(WS_DIR, p).split(path.sep).join('/');
        const sj = readJson(path.join(p, '.board-sessions.json'), null);
        if (sj && typeof sj === 'object'){ const a = aiOf(id); a.sharedSummary = sj.sharedSummary || ''; a.sessions = sj.sessions || {}; }
        loadWs(p);
      }
    }
  };
  if (fs.existsSync(WS_DIR)) loadWs(WS_DIR);
}
function saveSessions(){
  for (const [ws, a] of Object.entries(aiByWs)){
    if (!a.dirty) continue;
    const file = ws ? wsSessionsFile(ws) : SESSIONS_FILE;
    try { atomicWrite(file, JSON.stringify({ sharedSummary: a.sharedSummary, sessions: a.sessions }, null, 2)); a.dirty = false; }
    catch (e) { console.error('save sessions fail', e.message); }
  }
}
loadSessions();
setInterval(saveSessions, 3000);

/* ------------------------------------------------------------------ Token 用量 */
// 结构：{ byChapter: { ws|file: {prompt, completion, total} }, daily: { 'YYYY-MM-DD': {prompt, completion, total} }, total: {...} }
let usage = readJson(USAGE_FILE, { byChapter: {}, daily: {}, total: { prompt: 0, completion: 0, total: 0 } });
let usageDirty = false;
function todayKey(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addUsage(ws, chapter, u){
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
}
function saveUsage(){
  if (!usageDirty) return;
  try { atomicWrite(USAGE_FILE, JSON.stringify(usage, null, 2)); usageDirty = false; }
  catch (e) { console.error('save usage fail', e.message); }
}
setInterval(saveUsage, 3000);

const chaptersRoot = (ws) => ws ? wsChaptersDir(ws) : path.join(ROOT, config.chaptersRoot || CHAPTERS_DEFAULT);

function buildSystemPrompt(chapterFile, ai){
  const lines = [
    '你是网文创作参谋，与作者围绕某一章展开讨论。',
    '回答用简体中文，简洁、具体、可直接执行，不要空话。',
    '除本章外，以下摘要汇总了作者在其他章节会话里讨论过的要点，供跨章参考：',
    ai.sharedSummary ? ai.sharedSummary.slice(0, 4000) : '（暂无）',
    `当前讨论章节：${chapterFile}`,
  ];
  return lines.join('\n');
}
async function refreshSharedSummary(ai, ws){
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
    if (text){ ai.sharedSummary = text; ai.dirty = true; }
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
  const ws = validWsId(q.get('ws') || '') ? wsIdOf(q.get('ws') || '') : '';
  const stateFile = ws ? wsStateFile(ws) : STATE_FILE;

  /* ---- 工作区 ---- */
  if (u === '/api/ws/tree' && req.method === 'GET'){
    return json(res, 200, { tree: wsTree() });
  }
  if (u === '/api/ws/create' && req.method === 'POST'){
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
  if (u === '/api/ws/delete' && req.method === 'POST'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const id = wsIdOf(body.ws || '');
    if (!id) return json(res, 400, { error: '不能删除默认看板' });
    if (!validWsId(id)) return json(res, 400, { error: '非法路径' });
    const dir = wsDir(id);
    if (!fs.existsSync(dir)) return json(res, 404, { error: '工作区不存在' });
    // 安全：仅删除该目录（递归），先备份状态
    const st = wsStateFile(id);
    if (fs.existsSync(st)) backupFile(st);
    fs.rmSync(dir, { recursive: true, force: true });
    delete aiByWs[id];
    return json(res, 200, { ok: true });
  }
  if (u === '/api/ws/rename' && req.method === 'POST'){
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
    // 迁移内存中的会话
    if (aiByWs[id]){ aiByWs[newId] = aiByWs[id]; delete aiByWs[id]; }
    return json(res, 200, { id: newId, name });
  }

  /* ---- 看板状态 ---- */
  if (u === '/api/state' && req.method === 'GET'){
    const text = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : JSON.stringify({ version: 1, nodes: [], connections: [], appearance: null });
    return json(res, 200, { state: JSON.parse(text), hash: sha1(text) });
  }
  if (u === '/api/state' && req.method === 'PUT'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const text = JSON.stringify(body.state ?? {}, null, 2);
    const cur = fs.existsSync(stateFile) ? sha1(fs.readFileSync(stateFile, 'utf8')) : null;
    if (body.baseHash && cur && body.baseHash !== cur) return json(res, 409, { error: 'conflict', hash: cur });
    backupFile(stateFile);
    atomicWrite(stateFile, text);
    return json(res, 200, { hash: sha1(text) });
  }

  /* ---- 章节文件 ---- */
  if (u === '/api/files' && req.method === 'GET'){
    const dir = chaptersRoot(ws);
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
    const p = safeJoin(chaptersRoot(ws), q.get('p') || '');
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return json(res, 404, { error: 'not found' });
    const text = fs.readFileSync(p, 'utf8');
    return json(res, 200, { content: text, hash: sha1(text), mtime: fs.statSync(p).mtimeMs });
  }
  if (u === '/api/file' && req.method === 'PUT'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const p = safeJoin(chaptersRoot(ws), body.p || '');
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
    const p = safeJoin(chaptersRoot(ws), name);
    if (!p) return json(res, 403, { error: 'bad path' });
    if (fs.existsSync(p)) return json(res, 409, { error: '同名文件已存在', name });
    const title = String(body.title || name.replace(/\.(md|txt)$/i, ''));
    const content = `# ${title}\n\n`;
    atomicWrite(p, content);
    return json(res, 200, { name, hash: sha1(content) });
  }
  if (u === '/api/file/delete' && req.method === 'POST'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const p = safeJoin(chaptersRoot(ws), body.p || '');
    if (!p || !fs.existsSync(p)) return json(res, 404, { error: 'not found' });
    backupFile(p);
    fs.unlinkSync(p);
    return json(res, 200, { ok: true });
  }

  /* ---- AI ---- */
  if (u === '/api/ai/status' && req.method === 'GET'){
    const c = config.ai || {};
    const ai = aiOf(ws);
    return json(res, 200, { configured: !!(c.baseUrl && c.apiKey && c.model), model: c.model || '', baseUrl: c.baseUrl || '', sharedSummary: ai.sharedSummary });
  }
  /* 列出当前 key 可用的模型（代理上游 /models） */
  if (u === '/api/ai/models' && req.method === 'GET'){
    const c = config.ai || {};
    if (!(c.baseUrl && c.apiKey)) return json(res, 200, { models: [], error: '请先填写 Base URL 与 API Key' });
    try {
      const res2 = await fetch(c.baseUrl.replace(/\/$/, '') + '/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + c.apiKey },
      });
      const j = await res2.json();
      const arr = j?.data || j?.models || (Array.isArray(j) ? j : []);
      const models = arr.map(m => (typeof m === 'string' ? m : m.id || m.name || m.model)).filter(Boolean).sort();
      return json(res, 200, { models });
    } catch (e) {
      return json(res, 200, { models: [], error: '获取模型列表失败：' + e.message });
    }
  }
  if (u === '/api/ai/chat' && req.method === 'POST'){
    const cfg = config.ai || {};
    if (!(cfg.baseUrl && cfg.apiKey && cfg.model)) return json(res, 501, { error: '未配置 AI。请填写 API Key 并选择模型。' });
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
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
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
      const u = j?.usage;
      addUsage(ws, key, u);
      refreshSharedSummary(ai, ws);                    // 异步，不等待
      return json(res, 200, { reply, sharedSummary: ai.sharedSummary, usage: u || null });
    } catch (e) {
      return json(res, 502, { error: '请求上游失败：' + e.message });
    }
  }
  if (u === '/api/ai/clear' && req.method === 'POST'){
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const ai = aiOf(ws);
    if (body.all) ai.sessions = {}; else delete ai.sessions[String(body.chapter || '')];
    ai.dirty = true;
    return json(res, 200, { ok: true });
  }
  /* Token 用量：本章 / 总 / 今日 */
  if (u === '/api/ai/usage' && req.method === 'GET'){
    const chapter = q.get('chapter') || '';
    const ck = (ws ? ws + '|' : '') + (chapter || '默认');
    const today = usage.daily[todayKey()] || { prompt: 0, completion: 0, total: 0 };
    return json(res, 200, {
      total: usage.total || { prompt: 0, completion: 0, total: 0 },
      today,
      chapter: usage.byChapter[ck] || { prompt: 0, completion: 0, total: 0 },
    });
  }

  /* ---- 服务端配置（不回传 key） ---- */
  if (u === '/api/config' && req.method === 'GET'){
    return json(res, 200, { root: ROOT, chaptersRoot: path.relative(ROOT, chaptersRoot(ws)) || '.', aiConfigured: !!(config.ai?.baseUrl && config.ai?.apiKey && config.ai?.model) });
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
