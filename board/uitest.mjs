/* 只读 UI 检查：✎ 按钮开抽屉、AI 快捷 chips、不改动任何数据 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9850 + Math.floor(Math.random() * 60);
const profile = `C:/Users/18480/AppData/Local/Temp/board-ui-${Date.now()}`;
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', '--window-size=1440,900', '--hide-scrollbars', 'http://127.0.0.1:4317/'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 60 && !target; i++){
  await sleep(300);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page' && t.url.includes('4317')); } catch {}
}
if (!target){ console.log('NO TARGET'); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
const errs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description); };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
await send('Page.enable'); await send('Runtime.enable');
for (let i = 0; i < 60; i++){ if (await js('window.__ready === true')) break; await sleep(250); }
await sleep(800);
console.log('editBtn 存在:', await js(`!!document.querySelector('.node .editBtn')`));
await js(`document.querySelector('.node .editBtn').click()`);
await sleep(900);
console.log('抽屉打开:', await js(`document.getElementById('drawer').classList.contains('show')`));
console.log('正文非空:', await js(`document.getElementById('editor').value.length > 0`));
await js(`document.querySelector('.dtab[data-tab=ai]').click()`);
await sleep(500);
console.log('AI 快捷按钮数:', await js(`document.querySelectorAll('#aiQuick button').length`));
const s = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('C:/Users/18480/WorkBuddy/前端/preview/board-ai.png', Buffer.from(s.result.data, 'base64'));
console.log('shot board-ai.png');
console.log('js errors:', errs.length ? errs.slice(0, 3) : '无');
ws.close(); proc.kill();
