// 调试：加连接点点击落点
import { spawn } from 'node:child_process';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--remote-debugging-port=9335', '--headless=new', '--disable-gpu', '--window-size=1440,900', 'http://127.0.0.1:4317/'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
await fetch('http://127.0.0.1:9335/json').then(r => r.json()).then(pages => new Promise(res => { ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl); ws.onopen = res; }));
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const js = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.value;
const mouse = async (t, x, y) => send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
for (let i = 0; i < 60; i++){ if (await js('window.__ready===true')) break; await sleep(250); }
await sleep(1000);
await js(`stage.addEventListener('pointerdown',e=>{window.__tgt=(e.target.className||'')+'';window.__tag=e.target.tagName;window.__inNode=!!e.target.closest('.node');window.__mode=mode;},{capture:true})`);
console.log('n1:', JSON.stringify(await js(`(()=>{const n=__dbg.nodeById('n1'); return {x:n.x,y:n.y,w:n.w,h:n.h,ports:n.ports.length,portsDetail:JSON.stringify(n.ports)}})()`)));
await js(`document.querySelector('#toolbox .ttool[data-tool="port"]').click()`); await sleep(200);
const pe = await js(`(()=>{const n=__dbg.nodeById('n1'); return {x:(n.x+n.w)*__dbg.vS()+__dbg.vX(), y:(n.y+n.h*0.3)*__dbg.vS()+__dbg.vY()}})()`);
console.log('点击屏幕坐标:', JSON.stringify(pe), 'mode=', await js('__dbg.mode'), 'view=', JSON.stringify(await js(`(()=>{const d=__dbg;return {s:d.vS(),x:d.vX(),y:d.vY()}})()`)));
await mouse('mousePressed', pe.x, pe.y); await sleep(60); await mouse('mouseReleased', pe.x, pe.y);
await sleep(300);
console.log('target=', await js('window.__tgt'), 'tag=', await js('window.__tag'), 'inNode=', await js('window.__inNode'), 'modeAtDown=', await js('window.__mode'));
console.log('ports=', await js(`__dbg.nodeById('n1').ports.length`));
edge.kill(); process.exit(0);
