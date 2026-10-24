/* 只读截图：不动看板数据（不切断线、不建节点）。 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:4317/' + (process.env.URLQ || '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9650 + Math.floor(Math.random() * 60);
const profile = `C:/Users/18480/AppData/Local/Temp/board-s-${Date.now()}`;
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', '--window-size=1440,900', '--hide-scrollbars', URL], { stdio: 'ignore' });
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
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('C:/Users/18480/WorkBuddy/前端/preview/' + name, Buffer.from(s.result.data, 'base64')); console.log('shot', name); };
await send('Page.enable');
await send('Runtime.enable');
for (let i = 0; i < 60; i++){ if (await js('window.__ready === true')) break; await sleep(250); }
await sleep(2500);                              // 等鲨鱼游到画面里
console.log('js errors:', errs.length ? errs.slice(0, 3) : '无');
console.log('nodes:', await js(`document.querySelectorAll('.node').length`), 'wires:', await js(`document.querySelectorAll('#wires .wire').length`));
console.log('no-gradient:', await js(`!document.querySelector('style').textContent.includes('gradient(')`));
await shot('board-1-main.png');
await js(`document.getElementById('themeBtn').click()`);   // 暗色（会保存，随后切回）
await sleep(800);
await shot('board-3-dark.png');
await js(`document.getElementById('themeBtn').click()`);   // 切回亮色
await sleep(300);
ws.close(); proc.kill();
