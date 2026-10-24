// 补测：点卡片进编辑 / 加连接点工具 / 抽屉宽度把手
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const edge = spawn(EDGE, ['--remote-debugging-port=9334', '--headless=new', '--disable-gpu',
  '--window-size=1440,900', 'http://127.0.0.1:4317/'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map(); const errors = [];
function connect(){ return fetch('http://127.0.0.1:9334/json').then(r => r.json()).then(pages => new Promise((res, rej) => { ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl); ws.onopen = res; ws.onerror = rej; })); }
function send(method, params = {}){ return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }); }
function wire(){ ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exc');
  if (m.id && pending.has(m.id)){ const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); } }; }
async function js(expr){ const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js'); return r.result?.value; }
const shot = async n => { const d = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('C:/Users/18480/WorkBuddy/前端/preview/' + n, Buffer.from(d.data, 'base64')); console.log('  📸', n); };
async function mouse(type, x, y, btn = 'left', clicks = 1){ await send('Input.dispatchMouseEvent', { type, x, y, button: btn, clickCount: clicks, pointerType: 'mouse' }); }

async function main(){
  await connect(); wire();
  await send('Page.enable'); await send('Runtime.enable');
  for (let i = 0; i < 60; i++){ if (await js('window.__ready === true')) break; await sleep(250); }
  await sleep(1200);

  // 把 n1 居中到屏幕，保证后续点击坐标有效
  await js(`(()=>{const n=__dbg.nodeById('n1'); __dbg.view.x = innerWidth/2 - (n.x+n.w/2)*__dbg.view.s; __dbg.view.y = innerHeight/2 - (n.y+n.h/2)*__dbg.view.s; __dbg.applyView&&__dbg.applyView();})()`);
  await sleep(300);

  // 取 n1 屏幕坐标
  const sc = await js(`(()=>{const n=__dbg.nodeById('n1'); return {x:(n.x+n.w/2)*__dbg.vS()+__dbg.vX(), y:(n.y+n.h/2)*__dbg.vS()+__dbg.vY()}})()`);
  console.log('== A. 点击卡片任意位置进编辑 ==');
  await mouse('mousePressed', sc.x, sc.y); await sleep(80); await mouse('mouseReleased', sc.x, sc.y);
  await sleep(600);
  const opened = await js(`document.querySelector('#drawer').classList.contains('show')`);
  console.log('  单击卡片 → 抽屉打开 =', opened);
  if (!opened) throw new Error('单击未打开编辑');
  // 拖动不应打开：先关掉
  await js(`__dbg.closeDrawer()`); await sleep(300);
  await mouse('mousePressed', sc.x, sc.y);
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', sc.x + i * 8, sc.y + i * 5);
  await mouse('mouseReleased', sc.x + 80, sc.y + 50);
  await sleep(400);
  const openedAfterDrag = await js(`document.querySelector('#drawer').classList.contains('show')`);
  const movedBack = await js(`(()=>{const n=__dbg.nodeById('n1'); return n.x;})()`);
  console.log('  拖动后抽屉打开 =', openedAfterDrag, '(应为 false)');
  if (openedAfterDrag) throw new Error('拖动误触发编辑');

  console.log('== B. 工具箱「加连接点」==');
  await js(`document.querySelector('#toolbox .ttool[data-tool="port"]').click()`); await sleep(200);
  const m0 = await js(`__dbg.mode`);
  const pBefore = await js(`__dbg.nodeById('n1').ports.length`);
  // 点击 n1 卡片右上角边缘位置（靠 e 边 t≈0.3）
  const pe = await js(`(()=>{const n=__dbg.nodeById('n1'); return {x:(n.x+n.w)*__dbg.vS()+__dbg.vX(), y:(n.y+n.h*0.3)*__dbg.vS()+__dbg.vY()}})()`);
  await mouse('mousePressed', pe.x, pe.y); await sleep(60); await mouse('mouseReleased', pe.x, pe.y);
  await sleep(300);
  const pAfter = await js(`__dbg.nodeById('n1').ports.length`);
  const newPort = await js(`JSON.stringify(__dbg.nodeById('n1').ports[__dbg.nodeById('n1').ports.length-1])`);
  console.log(`  模式=${m0} 端口 ${pBefore} -> ${pAfter}`, newPort);
  if (pAfter !== pBefore + 1) throw new Error('加连接点失败');
  const mAfter = await js(`__dbg.mode`);
  console.log('  加完后保持模式（可连续加点）=', mAfter === 'port');
  await js(`__dbg.setMode(null)`);
  await shot('feature-4-port-tool.png');

  console.log('== C. 抽屉宽度把手 ==');
  await js(`__dbg.openDrawer(__dbg.nodeById('n1').id)`); await sleep(500);
  const w0 = await js(`document.querySelector('#drawer').offsetWidth`);
  const hx = await js(`(()=>{const r=document.querySelector('#dresize').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}})()`);
  await mouse('mousePressed', hx.x, hx.y);
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', hx.x - i * 12, hx.y);
  await mouse('mouseReleased', hx.x - 120, hx.y);
  await sleep(300);
  const w1 = await js(`document.querySelector('#drawer').offsetWidth`);
  console.log(`  抽屉宽度 ${w0} -> ${w1}`);
  if (w1 <= w0) throw new Error('抽屉宽度拖拽无效');
  await shot('feature-5-drawer-wide.png');

  await sleep(400);
  if (errors.length){ console.log('❌ JS 报错:', errors.slice(0, 5)); throw new Error('有报错'); }
  console.log('✅ 全部 PASS，无 JS 报错');
}
main().then(() => { edge.kill(); process.exit(0); }).catch(e => { console.log('❌ FAIL:', e.message); console.log(errors.slice(0, 8)); edge.kill(); process.exit(1); });
