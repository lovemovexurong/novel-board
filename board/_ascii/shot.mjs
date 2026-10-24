import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:4400/_ascii/index.html' + (process.env.SHAPE ? '?shape=1' : '');
const times = (process.argv.slice(2).map(Number).filter(n => Number.isFinite(n)));
const list = times.length ? times : [3, 11];
const PORT = 9350 + Math.floor(Math.random() * 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = `C:/Users/18480/AppData/Local/Temp/ascii-c-${Date.now()}`;
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', '--window-size=1440,900', '--hide-scrollbars', URL], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60 && !target; i++){
  await sleep(300);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page' && t.url.includes('4400')); } catch {}
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
await sleep(700);
for (const t of list){
  await js(`window.__freeze(${t})`);
  await sleep(450);
  const st = await js('JSON.stringify(window.__stats())');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = process.env.SHAPE ? `D:/下载app/dsh/小说辅助/board/_shot/shape-${t}.png` : `D:/下载app/dsh/小说辅助/board/_shot/ascii-c-${t}.png`;
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('shot', t, st);
}
ws.close(); proc.kill();
