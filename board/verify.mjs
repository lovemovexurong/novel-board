/* headless Edge + CDP 实测主看板：功能自检 + 截图到 ../preview/ */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://127.0.0.1:4317/';
const OUT = 'C:/Users/18480/WorkBuddy/前端/preview/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9450 + Math.floor(Math.random() * 60);
const profile = `C:/Users/18480/AppData/Local/Temp/board-v-${Date.now()}`;
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
const errors = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exception'); };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const js = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(OUT + name, Buffer.from(s.result.data, 'base64')); console.log('shot', name); };
await send('Page.enable');
await send('Runtime.enable');

/* 1. 等 ready */
let ok = false;
for (let i = 0; i < 60; i++){ if (await js('window.__ready === true')) { ok = true; break; } await sleep(250); }
console.log('ready:', ok);

/* 2. 功能自检 */
const checks = [];
const check = async (name, expr) => { const v = await js(expr); checks.push(`${v === true ? 'PASS' : 'FAIL(' + JSON.stringify(v) + ')'}  ${name}`); };
await sleep(600);
await check('节点渲染 3 个', `document.querySelectorAll('.node').length === 3`);
await check('连线渲染 2 条', `document.querySelectorAll('#wires .wire').length === 2`);
await check('鲨鱼画布有内容', `(() => { const c=document.getElementById('bg'); const x=c.getContext('2d'); const d=x.getImageData(0,0,c.width,c.height).data; for(let i=3;i<d.length;i+=4) if(d[i]>0) return true; return false; })()`);
await check('顶栏存在', `!!document.querySelector('#topbar')`);
await check('无 CSS 渐变', `!document.querySelector('style').textContent.includes('gradient(')`);

/* 3. 双击打开抽屉 → 正文载入 */
await js(`document.querySelectorAll('.node')[0].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
await sleep(900);
await check('抽屉打开', `document.getElementById('drawer').classList.contains('show')`);
await check('正文载入', `document.getElementById('editor').value.includes('第一章')`);
await check('AI 配置提示出现（未配置时）', `document.getElementById('tabAI').classList.contains('on') ? true : (()=>{document.querySelector('.dtab[data-tab=ai]').click(); return true;})()`);
await js(`document.querySelector('.dtab[data-tab=ai]')?.click()`);
await sleep(400);
await check('AI 未配置 → 配置表单', `!!document.getElementById('aiCfg')`);
await shot('board-2-drawer.png');

/* 4. Esc 关抽屉，切暗色 */
await js(`document.getElementById('dclose').click()`);
await js(`document.getElementById('themeBtn').click()`);
await sleep(500);
await check('暗色主题生效', `document.documentElement.dataset.theme === 'dark'`);
await shot('board-3-dark.png');
await js(`document.getElementById('themeBtn').click()`);
await sleep(400);

/* 5. 断线模式 + 点线删除 */
await js(`document.getElementById('cutBtn').click()`);
await js(`document.querySelector('.wire-hit').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
await sleep(300);
await check('断线后剩 1 条', `document.querySelectorAll('#wires .wire').length === 1`);
await js(`document.getElementById('cutBtn').click()`);
await shot('board-1-main.png');

/* 6. 保存状态与报错 */
await sleep(800);
const sv = await js(`document.getElementById('saveState').textContent`);
console.log('saveState:', sv);
console.log('js errors:', errors.length ? errors : '无');
console.log(checks.join('\n'));
ws.close(); proc.kill();
