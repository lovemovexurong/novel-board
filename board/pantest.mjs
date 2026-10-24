/* 拖动实测：真实鼠标事件平移画布，验证背景小黑点跟随。 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:4317/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9750 + Math.floor(Math.random() * 60);
const profile = `C:/Users/18480/AppData/Local/Temp/board-pan-${Date.now()}`;
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
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description); };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('C:/Users/18480/WorkBuddy/前端/preview/' + name, Buffer.from(s.result.data, 'base64')); console.log('shot', name); };
await send('Page.enable'); await send('Runtime.enable');
for (let i = 0; i < 60; i++){ if (await js('window.__ready === true')) break; await sleep(250); }
await sleep(1200);
/* 冻结动画时间，排除自身漂移干扰（把 rAF 停掉，仅手动重绘） */
await js(`(()=>{ window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = ()=>0; return true; })()`);
console.log('before:', await js('JSON.stringify(window.__bgDebug())'));
const crop = async name => {
  const data = await js(`(()=>{ const src=document.getElementById('bg'); const c=document.createElement('canvas');
    c.width=1000; c.height=700; const x=c.getContext('2d');
    x.imageSmoothingEnabled=false; x.drawImage(src, 300,150, 1000,700, 0,0, 1000,700);
    return c.toDataURL('image/png').slice(22); })()`);
  fs.writeFileSync('C:/Users/18480/WorkBuddy/前端/preview/' + name, Buffer.from(data, 'base64'));
  console.log('crop', name);
};
await crop('pan-zoom-before.png');
await shot('pan-before.png');
const mouse = async (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
await mouse('mousePressed', 700, 620);
for (let i = 1; i <= 10; i++){ await mouse('mouseMoved', 700 + i * 18, 620 + i * 9); await sleep(30); }
await mouse('mouseReleased', 880, 710);
await sleep(400);
console.log('after:', await js('JSON.stringify(window.__bgDebug())'));
await crop('pan-zoom-after.png');
await shot('pan-after.png');
console.log('js errors:', errs.length ? errs.slice(0, 3) : '无');
ws.close(); proc.kill();
