// 生成 build/icon.ico（256×256，PNG 内嵌 ICO）——零依赖
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');
const S = 256;

/* ---------- 画布 ---------- */
const px = new Uint8Array(S * S * 4);            // RGBA
const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};
const blend = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const sa = a / 255;
  px[i] = Math.round(px[i] * (1 - sa) + r * sa);
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
  px[i + 3] = Math.min(255, Math.round(px[i + 3] * (1 - sa) + 255 * sa));
};

/* 圆角矩形（带 2×2 超采样抗锯齿） */
function roundRect(x0, y0, w, h, rad, r, g, b, alpha = 255) {
  for (let y = Math.floor(y0) - 1; y <= y0 + h + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= x0 + w + 1; x++) {
      let hits = 0;
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
        const cx = x + dx, cy = y + dy;
        const ix = Math.min(Math.max(cx, x0 + rad), x0 + w - rad);
        const iy = Math.min(Math.max(cy, y0 + rad), y0 + h - rad);
        if (Math.hypot(cx - ix, cy - iy) <= rad) hits++;
      }
      if (hits) blend(x, y, r, g, b, Math.round(alpha * hits / 4));
    }
  }
}
function line(x1, y1, x2, y2, thick, r, g, b, a = 255) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
    roundRect(cx - thick / 2, cy - thick / 2, thick, thick, thick / 2, r, g, b, a);
  }
}

/* ---------- 图案：深色圆角底 + 节点时间树 ---------- */
roundRect(8, 8, S - 16, S - 16, 52, 20, 20, 20, 255);       // 底：#141414
// 三个节点（左中右），用线连成时间树
const nodes = [[62, 128], [128, 92], [128, 164], [196, 128]];
line(84, 128, 108, 100, 7, 235, 235, 235, 255);
line(84, 128, 108, 156, 7, 235, 235, 235, 255);
line(148, 100, 172, 122, 7, 235, 235, 235, 255);
line(148, 156, 172, 134, 7, 235, 235, 235, 255);
for (const [cx, cy] of nodes) {
  roundRect(cx - 20, cy - 20, 40, 40, 12, 248, 248, 248, 255);   // 白方块
  roundRect(cx - 7, cy - 7, 14, 14, 4, 26, 26, 26, 255);         // 中心黑点
}

/* ---------- PNG 编码 ---------- */
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;                                     // filter: none
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

/* ---------- ICO 封装 ---------- */
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0);      // reserved
ico.writeUInt16LE(1, 2);      // type: icon
ico.writeUInt16LE(1, 4);      // count
ico[6] = 0; ico[7] = 0;       // 256 → 0
ico[8] = 0; ico[9] = 0;       // palette
ico.writeUInt16LE(1, 10);     // planes
ico.writeUInt16LE(32, 12);    // bpp
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([ico, png]));
fs.writeFileSync(OUT.replace(/\.ico$/, '.png'), png);
console.log('icon 已生成:', OUT, (png.length / 1024).toFixed(1) + 'KB');
