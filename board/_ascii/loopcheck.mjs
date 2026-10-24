import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:4400/_ascii/index.html';
const PORT = 9460;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = `C:/Users/18480/AppData/Local/Temp/ascii-loop-${Date.now()}`;
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--disable-gpu', '--no-first-run', '--window-size=1200,720', URL], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 80 && !target; i++){ await sleep(300); try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page' && t.url.includes('4400')); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
await send('Page.enable');
for (let i = 0; i < 80; i++){ if (await js('window.__ready === true')) break; await sleep(250); }
await js('window.__seek(23.3)');
await sleep(700);
await js('window.__play()');
for (let i = 0; i < 10; i++){
  await sleep(200);
  const st = await js('JSON.stringify({t: vA.currentTime, a: vA.paused, b: vB.currentTime})');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`D:/下载app/dsh/小说辅助/board/_shot/loop-${i}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(i, st);
}
ws.close(); proc.kill();
