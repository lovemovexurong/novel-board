// 综合实测：分栏 / 工具箱 / 多端口 / 连线跟随
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const URL = 'http://127.0.0.1:4317/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', URL,
], { stdio: 'ignore' });

let ws = null, id = 0;
const pending = new Map();
const errors = [];
let sessionId = null;

function connect() {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json()).then(pages => {
      const page = pages.find(p => p.type === 'page') || pages[0];
      ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.onopen = () => resolve();
      ws.onerror = e => reject(e);
    }).catch(reject);
  });
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    if (sessionId) params.sessionId = sessionId;
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
ws && (ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
});
// 修正：onmessage 在 connect 后统一绑定
function wireMessages() {
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args?.map(a => a.value).join(' ') || ''));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
}

async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const shot = async (name) => {
  const d = await send('Page.captureScreenshot', { format: 'png' });
  const dir = 'C:/Users/18480/WorkBuddy/前端/preview';
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + '/' + name, Buffer.from(d.data, 'base64'));
  console.log('  📸', name);
};

async function main() {
  await connect();
  wireMessages();
  await send('Page.enable');
  await send('Runtime.enable');
  // 等就绪
  for (let i = 0; i < 60; i++) { if (await js('window.__ready === true')) break; await sleep(250); }
  await sleep(1500);

  console.log('== 1. 基础渲染 ==');
  const nodes = await js(`__dbg.state.nodes.length`);
  const conns = await js(`__dbg.state.connections.length`);
  const ports0 = await js(`(()=>{const n=__dbg.state.nodes[0]; return n.ports?n.ports.length:0})()`);
  console.log(`  节点=${nodes} 连线=${conns} 首节点端口数=${ports0}`);
  if (ports0 < 4) throw new Error('端口未初始化');

  console.log('== 2. 抽屉分栏（正文+AI 并排）==');
  await js(`__dbg.openDrawer(__dbg.state.nodes[0].id)`);
  await sleep(600);
  const paneEdit = await js(`!!document.querySelector('#paneEdit')`);
  const paneAI = await js(`!!document.querySelector('#paneAI')`);
  const splitBar = await js(`!!document.querySelector('#splitBar')`);
  const editorVisible = await js(`document.querySelector('#editor').offsetParent !== null`);
  const aiVisible = await js(`document.querySelector('#aiWrap').offsetParent !== null`);
  console.log(`  编辑栏=${paneEdit} AI栏=${paneAI} 分隔条=${splitBar} 编辑器可见=${editorVisible} AI可见=${aiVisible}`);
  if (!(paneEdit && paneAI && splitBar && editorVisible && aiVisible)) throw new Error('分栏缺失');
  await shot('feature-1-split.png');

  console.log('== 3. 工具箱 ==');
  const tb = await js(`!!document.querySelector('#toolbox')`);
  const tbtools = await js(`document.querySelectorAll('#toolbox .ttool').length`);
  console.log(`  工具箱=${tb} 工具数=${tbtools}`);
  if (!tb || tbtools < 4) throw new Error('工具箱缺失');

  console.log('== 4. 连线模式：点选两个端口 ==');
  await js(`__dbg.closeDrawer()`);
  await sleep(300);
  // 进入连线模式
  await js(`document.querySelector('#toolbox .ttool[data-tool="connect"]').click()`);
  await sleep(200);
  const modeIsConnect = await js(`__dbg.mode === 'connect'`);
  console.log(`  连线模式=${modeIsConnect}`);
  if (!modeIsConnect) throw new Error('连线模式未生效');
  // 直接调用 connectClickPort 模拟两次点击（验证数据层）
  const connBefore = await js(`__dbg.state.connections.length`);
  await js(`__dbg.connectClickPort(__dbg.state.nodes[0], __dbg.state.nodes[0].ports[1].id)`); // n0 e端口
  await js(`__dbg.connectClickPort(__dbg.state.nodes[1], __dbg.state.nodes[1].ports[3].id)`); // n1 w端口
  await sleep(200);
  const connAfter = await js(`__dbg.state.connections.length`);
  console.log(`  连线数 ${connBefore} -> ${connAfter}`);
  if (connAfter !== connBefore + 1) throw new Error('连线未创建');
  // 验证新连线的端点锚定到 portId
  const lastConn = await js(`JSON.stringify(__dbg.state.connections[__dbg.state.connections.length-1])`);
  console.log('  新连线:', lastConn);
  await js(`__dbg.setMode(null)`);

  console.log('== 5. 连线跟随卡片拖动（几何稳定性）==');
  // 记录 n1 的连线端点屏幕坐标，拖动 n1 后再看端点是否跟着走
  await js(`window.__test = {}; window.__test.before = (()=>{const c=__dbg.state.connections[__dbg.state.connections.length-1]; const n=__dbg.nodeById(c.to.node); const pt=__dbg.portPoint(n, c.to.portId); return {x:pt.x,y:pt.y};})()`);
  const before = await js(`JSON.stringify(window.__test.before)`);
  // 拖动 n1 向右下
  await js(`(()=>{const n=__dbg.nodeById('n1'); const old={x:n.x,y:n.y}; n.x += 200; n.y += 150; __dbg.updateNodeEl(n); window.__test.n1after = {x:n.x,y:n.y};})()`);
  await sleep(200);
  const after = await js(`(()=>{const c=__dbg.state.connections[__dbg.state.connections.length-1]; const n=__dbg.nodeById(c.to.node); const pt=__dbg.portPoint(n, c.to.portId); return JSON.stringify({x:pt.x,y:pt.y});})()`);
  const bp = JSON.parse(before), ap = JSON.parse(after);
  console.log(`  端点 before=${before} after=${after}`);
  if (Math.abs(ap.x - bp.x - 200) > 2 || Math.abs(ap.y - bp.y - 150) > 2) throw new Error('连线端点未跟随卡片移动');
  console.log('  ✅ 连线端点精确跟随卡片拖动 (dx=200, dy=150)');

  console.log('== 6. 多端口：新增端口 ==');
  const pBefore = await js(`__dbg.state.nodes[0].ports.length`);
  await js(`__dbg.state.nodes[0].ports.push({id: __dbg.uid('p'), side:'e', t:0.25}); __dbg.renderNodes();`);
  const pAfter = await js(`__dbg.state.nodes[0].ports.length`);
  console.log(`  n0 端口 ${pBefore} -> ${pAfter}`);
  if (pAfter !== pBefore + 1) throw new Error('新增端口失败');
  // 检查端口 DOM 渲染
  const portDots = await js(`document.querySelectorAll('[data-id="n0"] .port').length`);
  console.log(`  n0 端口 DOM 数=${portDots}`);
  await shot('feature-2-ports.png');

  console.log('== 7. 删线模式 ==');
  await js(`__dbg.setMode('cut')`);
  const cutting = await js(`__dbg.mode === 'cut'`);
  console.log(`  断线模式=${cutting}`);

  console.log('== 8. 无 JS 报错检查 ==');
  await sleep(500);
  if (errors.length) { console.log('  ❌ 报错:', errors.slice(0,5)); throw new Error('有 JS 报错'); }
  console.log('  ✅ 无 JS 报错');

  await shot('feature-3-final.png');
  console.log('\n全部 PASS ✅');
}

main().then(() => { edge.kill(); process.exit(0); }).catch(e => {
  console.log('\n❌ FAIL:', e.message);
  console.log('errors:', errors.slice(0,10));
  edge.kill(); process.exit(1);
});
