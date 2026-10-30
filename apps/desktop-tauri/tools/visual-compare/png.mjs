// Tiny pure-JS PNG decode/encode + pixel diff (zlib only). No dependencies.
import { inflateSync, deflateSync } from 'node:zlib';

export function decode(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8) throw new Error('only 8-bit PNG'); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ct]; if (!bpp) throw new Error(`unsupported color type ${ct}`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * bpp]; out[(y * w + x) * 4 + 1] = line[x * bpp + 1]; out[(y * w + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };

export function encode({ w, h, data }) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A pixel counts as different when any channel moves more than `tolerance`. */
export function diff(a, b, tolerance = 24) {
  const w = Math.max(a.w, b.w), h = Math.max(a.h, b.h), out = Buffer.alloc(w * h * 4);
  let bad = 0;
  const px = (img, x, y) => (x < img.w && y < img.h ? img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4) : null);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const pa = px(a, x, y), pb = px(b, x, y), o = (y * w + x) * 4;
    const d = !pa || !pb || Math.max(Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1]), Math.abs(pa[2] - pb[2])) > tolerance;
    if (d) { bad++; out[o] = 255; out[o + 1] = 0; out[o + 2] = 60; out[o + 3] = 255; }
    else { const g = pa ? Math.round((pa[0] + pa[1] + pa[2]) / 3 * 0.35 + 150) : 255; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
  }
  return { img: { w, h, data: out }, mismatch: bad / (w * h), pixels: bad, total: w * h };
}

/** Bounding box of pixels that differ from the page background colour. */
export function contentBox(img, bg) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * 4;
    if (Math.abs(img.data[o] - bg[0]) + Math.abs(img.data[o + 1] - bg[1]) + Math.abs(img.data[o + 2] - bg[2]) > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function sideBySide(a, b, gap = 12) {
  const h = Math.max(a.h, b.h), w = a.w + gap + b.w, out = Buffer.alloc(w * h * 4, 255);
  const blit = (img, ox) => { for (let y = 0; y < img.h; y++) img.data.copy(out, (y * w + ox) * 4, y * img.w * 4, (y + 1) * img.w * 4); };
  blit(a, 0); blit(b, a.w + gap);
  return { w, h, data: out };
}

export function crop(img, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) img.data.copy(out, y * box.w * 4, ((box.y + y) * img.w + box.x) * 4, ((box.y + y) * img.w + box.x + box.w) * 4);
  return { w: box.w, h: box.h, data: out };
}
