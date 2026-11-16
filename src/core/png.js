/**
 * Minimal PNG codec (RGBA8, non-interlaced) shared by Node and browser.
 * Uses an injected inflate/deflate so the same code runs in both runtimes.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function parsePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('不是 PNG 文件（签名不符）');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (off < bytes.length) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error('PNG 数据块被截断');
    if (type === 'IHDR') {
      width = readU32(bytes, dataStart);
      height = readU32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'PLTE') {
      palette = bytes.slice(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      transparency = bytes.slice(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idat.push(bytes.slice(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4;
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR');
  if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG，收到 ${bitDepth} 位`);
  if (interlace !== 0) throw new Error('暂不支持隔行扫描 PNG，请另存为非隔行');
  if (![0, 2, 4, 6, 3].includes(colorType)) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const total = idat.reduce((n, c) => n + c.length, 0);
  const compressed = new Uint8Array(total);
  let p = 0;
  for (const c of idat) { compressed.set(c, p); p += c.length; }
  return { width, height, colorType, channels, bitDepth, compressed, palette, transparency };
}

/** Unfilter raw scanlines into RGBA8. */
export function unfilterToRgba(parsed, raw) {
  const { width, height, channels, colorType, palette, transparency } = parsed;
  const stride = width * channels;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    if (off >= raw.length) throw new Error('PNG 扫描线数据不足');
    const filter = raw[off++];
    if (off + stride > raw.length) throw new Error('PNG 扫描线数据不足');
    cur.set(raw.subarray(off, off + stride));
    off += stride;
    switch (filter) {
      case 0: break;
      case 1:
        for (let i = channels; i < stride; i++) cur[i] = (cur[i] + cur[i - channels]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? cur[i - channels] : 0;
          cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? cur[i - channels] : 0;
          const b = prev[i];
          const c = i >= channels ? prev[i - channels] : 0;
          cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`未知 PNG 行滤波类型 ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const si = x * channels;
      let r; let g; let b; let a = 255;
      if (colorType === 0) { r = g = b = cur[si]; }
      else if (colorType === 2) { r = cur[si]; g = cur[si + 1]; b = cur[si + 2]; }
      else if (colorType === 3) {
        const pi = cur[si] * 3;
        if (!palette || pi + 2 >= palette.length) throw new Error('PNG 调色板索引越界');
        r = palette[pi]; g = palette[pi + 1]; b = palette[pi + 2];
        if (transparency && cur[si] < transparency.length) a = transparency[cur[si]];
      } else if (colorType === 4) { r = g = b = cur[si]; a = cur[si + 1]; }
      else { r = cur[si]; g = cur[si + 1]; b = cur[si + 2]; a = cur[si + 3]; }
      rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = a;
    }
    prev.set(cur);
  }
  return rgba;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Encode RGBA8 into PNG bytes. `deflate` must return zlib-wrapped deflate data. */
export async function encodePng(rgba, width, height, deflate) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = await deflate(raw);
  const chunks = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', compressed));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + len);
  crcInput.set(out.subarray(4, 8), 0);
  crcInput.set(data, 4);
  dv.setUint32(8 + len, crc32(crcInput));
  return out;
}

/** Resize RGBA with bilinear sampling. */
export function resizeRgba(src, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const di = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i10 + c] * wx;
        const bot = src[i01 + c] * (1 - wx) + src[i11 + c] * wx;
        out[di + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}
