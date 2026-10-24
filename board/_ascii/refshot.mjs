/* 抓参考视频某一帧到 ../preview/ */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:4317/_ascii/refview.html';
const times = process.argv.slice(2).map(Number).filter(Number.isFinite);
const list = times.length ? times : [4, 8, 12];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9550 + Math.floor(Math.random() * 60);
const profile = `C:/Users/18480/AppData/Local/Temp/refv-${Date.now()}`;
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', '--window-size=1440,1200', '--hide-scrollbars', URL], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 60 && !target; i++){
  await sleep(300);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page' && t.url.includes('refview')); } catch {}
}
if (!target){ console.log('NO TARGET'); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
await send('Page.enable');
for (let i = 0; i < 60; i++){ if (await js('window.__ready === true')) break; await sleep(200); }
await sleep(500);
for (const t of list){
  await js(`window.__seek(${t})`);
  for (let i = 0; i < 30; i++){ if (await js('window.__drawn === true')) break; await sleep(150); }
  await sleep(300);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`C:/Users/18480/WorkBuddy/前端/preview/ref-${t}.png`, Buffer.from(s.result.data, 'base64'));
  console.log('ref frame', t);
}
ws.close(); proc.kill();
