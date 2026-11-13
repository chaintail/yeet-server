// QR codes for the fund page, made in the browser (no image service, no request). Byte mode, error correction level M,
// versions 1 to 10 (up to 213 bytes, more than any wallet address or payment link here). Follows ISO/IEC 18004: Reed-
// Solomon over GF(256) with 0x11D, the eight data masks and the four penalty rules for picking one. No React here, so
// node --test loads it (qr.test.mjs checks it against reference matrices).

// Per version at level M: [error correction codewords per block, [blocks, data codewords per block]...].
const LEVEL_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMAT_M = 0; // error correction level M in the format bits
export const QR_MAX_VERSION = 10;

const dataCapacity = (v) => LEVEL_M[v].slice(1).reduce((n, [blocks, size]) => n + blocks * size, 0);

// GF(256) tables.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Reed-Solomon error correction codewords for `data` (degree = count). */
export function reedSolomon(data, count) {
  // Generator: product of (x - a^i) for i in 0..count-1, highest power first (leading 1 dropped).
  let gen = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < count; j++) rem[j] ^= mul(gen[j + 1], factor);
  }
  return rem;
}

/** Data codewords for `bytes` in byte mode at version v: mode, count, data, terminator, pad bytes. */
function codewords(bytes, v) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCapacity(v) * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCapacity(v); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits into blocks, adds error correction, interleaves. */
function interleave(data, v) {
  const [ec, ...groups] = LEVEL_M[v];
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups)
    for (let b = 0; b < count; b++) {
      const d = data.slice(at, (at += size));
      blocks.push({ d, e: reedSolomon(d, ec) });
    }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function bch(value, poly, degree) {
  let rem = value << degree;
  const top = 31 - Math.clz32(poly);
  for (let i = 31 - Math.clz32(rem); i >= top; i--) if ((rem >>> i) & 1) rem ^= poly << (i - top);
  return (value << degree) | rem;
}

class Grid {
  constructor(size) {
    this.size = size;
    this.dark = new Uint8Array(size * size);
    this.fixed = new Uint8Array(size * size);
  }
  get(x, y) {
    return this.dark[y * this.size + x];
  }
  set(x, y, on, fixed = true) {
    this.dark[y * this.size + x] = on ? 1 : 0;
    if (fixed) this.fixed[y * this.size + x] = 1;
  }
}

function functionPatterns(g, v) {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx,
          y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
  const pos = ALIGN[v],
    last = pos.length - 1;
  for (let i = 0; i <= last; i++)
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) g.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  formatBits(g, 0);
  if (v >= 7) {
    const bits = bch(v, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const on = (bits >>> i) & 1,
        a = n - 11 + (i % 3),
        b = Math.floor(i / 3);
      g.set(a, b, on);
      g.set(b, a, on);
    }
  }
}

function formatBits(g, mask) {
  const n = g.size;
  const bits = bch((FORMAT_M << 3) | mask, 0x537, 10) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, 1);
}

function placeData(g, data) {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (g.fixed[y * n + x]) continue;
        g.set(x, y, i < data.length * 8 ? (data[i >>> 3] >>> (7 - (i & 7))) & 1 : 0, false);
        i++;
      }
  }
}

function applyMask(g, mask) {
  const n = g.size,
    f = MASKS[mask];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!g.fixed[y * n + x] && f(x, y)) g.dark[y * n + x] ^= 1;
}

/** The four penalty rules (runs of five or more, 2x2 blocks, finder-like 1:1:3:1:1 runs with four light, dark share). */
export function penalty(g) {
  const n = g.size;
  let points = 0;
  for (let a = 0; a < n; a++) {
    let runRow = 0,
      runCol = 0,
      lastRow = -1,
      lastCol = -1,
      bitsRow = 0,
      bitsCol = 0;
    for (let b = 0; b < n; b++) {
      const r = g.get(b, a),
        c = g.get(a, b);
      if (r === lastRow) runRow++;
      else {
        if (runRow >= 5) points += 3 + runRow - 5;
        lastRow = r;
        runRow = 1;
      }
      if (c === lastCol) runCol++;
      else {
        if (runCol >= 5) points += 3 + runCol - 5;
        lastCol = c;
        runCol = 1;
      }
      bitsRow = ((bitsRow << 1) & 0x7ff) | r;
      bitsCol = ((bitsCol << 1) & 0x7ff) | c;
      if (b >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 40;
      if (b >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 40;
    }
    if (runRow >= 5) points += 3 + runRow - 5;
    if (runCol >= 5) points += 3 + runCol - 5;
  }
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const s = g.get(x, y) + g.get(x + 1, y) + g.get(x, y + 1) + g.get(x + 1, y + 1);
      if (s === 0 || s === 4) points += 3;
    }
  const dark = g.dark.reduce((a, b) => a + b, 0);
  points += Math.abs(Math.ceil((dark * 100) / (n * n) / 5) - 10) * 10;
  return points;
}

/**
 * QR code for `text` (UTF-8, byte mode, level M), smallest version that fits. Returns {version, mask, size, rows}
 * where rows[y][x] is 1 for a dark module. Throws "qr-too-long" above version 10. `mask` forces a mask (tests only).
 */
export function qrCode(text, { mask: forced } = {}) {
  if (typeof text !== "string" || !text) throw Error("qr-empty");
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  while (v <= QR_MAX_VERSION && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(v) * 8) v++;
  if (v > QR_MAX_VERSION) throw Error("qr-too-long");
  const g = new Grid(17 + 4 * v);
  functionPatterns(g, v);
  placeData(g, interleave(codewords(bytes, v), v));
  let best = forced,
    lowest = Infinity;
  if (best === undefined)
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      formatBits(g, m);
      const p = penalty(g);
      applyMask(g, m);
      if (p < lowest) {
        lowest = p;
        best = m;
      }
    }
  applyMask(g, best);
  formatBits(g, best);
  const rows = [];
  for (let y = 0; y < g.size; y++) rows.push(Array.from(g.dark.subarray(y * g.size, (y + 1) * g.size)));
  return { version: v, mask: best, size: g.size, rows };
}

/** SVG path data for the dark modules (one subpath per horizontal run), offset by a quiet zone of `quiet` modules. */
export function qrPath(code, quiet = 4) {
  let d = "";
  code.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return d;
}
