// 桌面版冒烟验证：连接运行中的 Electron（CDP 9444）
import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9444;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pending = new Map();
let id = 0, ws;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('❌ 没有页面目标'); process.exit(1); }

await new Promise((res, rej) => { ws = new WebSocket(page.webSocketDebuggerUrl); ws.onopen = res; ws.onerror = rej; });
const errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const shot = async name => {
  const d = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('C:/Users/18480/WorkBuddy/前端/preview/' + name, Buffer.from(d.data, 'base64'));
  console.log('  📸', name);
};

await send('Page.enable');
await send('Runtime.enable');
for (let i = 0; i < 60; i++) { if (await js('window.__ready === true')) break; await sleep(250); }
await sleep(1500);

console.log('== 1. 桌面桥 ==');
const hasBridge = await js('!!window.boardDesktop');
console.log('  window.boardDesktop =', hasBridge);
if (!hasBridge) throw new Error('preload 桥未注入');

const info = await js('window.boardDesktop.getInfo()');
console.log('  info:', JSON.stringify(info));

console.log('== 2. 桌面设置区 ==');
const sectionShown = await js(`getComputedStyle(document.querySelector('#deskSection')).display !== 'none'`);
const closeVal = await js(`document.querySelector('#deskClose').value`);
const dirText = await js(`document.querySelector('#deskDir').textContent`);
console.log('  设置区可见 =', sectionShown, '| 关闭行为 =', closeVal, '| 书稿目录 =', dirText);
if (!sectionShown) throw new Error('桌面设置区未显示');

console.log('== 3. 章节目录（走注入路径）==');
const cfg = await js(`fetch('/api/config').then(r=>r.json())`);
console.log('  /api/config =', JSON.stringify(cfg));
const files = await js(`fetch('/api/files').then(r=>r.json())`);
console.log('  章节数 =', files.files?.length, '| root =', files.root);
if (!files.files?.length) throw new Error('章节列表为空');

console.log('== 4. 高分屏 ==');
const dpr = await js('window.devicePixelRatio');
const canvasDpr = await js(`(()=>{const c=document.querySelector('#bg');return {w:c.width,h:c.height,cw:innerWidth,ch:innerHeight}})()`);
console.log('  dpr =', dpr, '| canvas =', JSON.stringify(canvasDpr));
if (Math.abs(canvasDpr.w - canvasDpr.cw * dpr) > 2) throw new Error('canvas 未按 dpr 缩放');

console.log('== 5. 渲染与交互 ==');
const nodes = await js('__dbg.state.nodes.length');
const wires = await js('__dbg.state.connections.length');
console.log('  节点 =', nodes, '| 连线 =', wires);
await js(`document.querySelector('#styleBtn').click()`);
await sleep(400);
await shot('desktop-1-settings.png');
await js(`document.querySelector('#stylePanel .x').click()`);

console.log('== 6. 编辑抽屉 ==');
await js(`__dbg.openDrawer(__dbg.state.nodes[0].id)`);
await sleep(700);
const editorLoaded = await js(`document.querySelector('#editor').value.length > 0`);
const aiPane = await js(`document.querySelector('#aiWrap').offsetParent !== null`);
console.log('  正文已载入 =', editorLoaded, '| AI 分栏可见 =', aiPane);
await shot('desktop-2-editor.png');

console.log('== 7. JS 报错 ==');
if (errors.length) { console.log('  ❌', errors.slice(0, 5)); throw new Error('有 JS 报错'); }
console.log('  ✅ 无');

console.log('\n全部 PASS ✅');
process.exit(0);
