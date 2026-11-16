/**
 * Reverse-mapping renderer. For every output pixel, compute the undistorted
 * coordinate, forward-distort it to a source pixel, and sample there.
 *
 * Out-of-frame / outside-model pixels are filled with the configured colour
 * and recorded in an invalid mask, never smeared or clamped silently.
 */

import { undistortedToDistorted } from './model.js';

export const SAMPLING = Object.freeze({ NEAREST: 'nearest', BILINEAR: 'bilinear' });

/**
 * @param {Uint8ClampedArray} src RGBA source
 * @param {number} srcW
 * @param {number} srcH
 * @param {object} plan output plan from planOutput()
 * @param {object} distortion
 * @param {object} options { sampling, fillColor, coverage }
 * @returns {{ rgba: Uint8ClampedArray, invalidMask: Uint8Array, stats: object }}
 */
export function renderRectified(src, srcW, srcH, plan, distortion, options = {}) {
  const sampling = options.sampling === SAMPLING.NEAREST ? SAMPLING.NEAREST : SAMPLING.BILINEAR;
  const fill = normalizeFill(options.fillColor || [16, 20, 28, 255]);
  const w = plan.width;
  const h = plan.height;
  const out = new Uint8ClampedArray(w * h * 4);
  const invalidMask = new Uint8Array(w * h);
  const intr = plan.intrinsics;
  const vmax = distortion.validMaxNormalizedRadius;
  const coverage = options.coverage || null;
  const stats = {
    width: w, height: h, pixels: w * h,
    sampled: 0, outOfFrame: 0, outsideModel: 0, nonFinite: 0, invalid: 0,
    maxRadius: 0, meanRadius: 0, maxSourceX: -Infinity, maxSourceY: -Infinity,
    minSourceX: Infinity, minSourceY: Infinity,
  };
  let radiusSum = 0;

  for (let y = 0; y < h; y++) {
    const v = plan.offsetY + y * plan.stepY;
    for (let x = 0; x < w; x++) {
      const u = plan.offsetX + x * plan.stepX;
      const p = undistortedToDistorted(u, v, intr, distortion);
      const di = (y * w + x) * 4;
      let ok = true;
      if (!p.finite) { stats.nonFinite++; ok = false; }
      else if (p.radius > vmax) { stats.outsideModel++; ok = false; }
      else if (p.x < -0.5 || p.y < -0.5 || p.x > srcW - 0.5 || p.y > srcH - 0.5) { stats.outOfFrame++; ok = false; }
      if (ok && coverage && !coverage(u, v, p)) ok = false;
      if (!ok) {
        out[di] = fill[0]; out[di + 1] = fill[1]; out[di + 2] = fill[2]; out[di + 3] = fill[3];
        invalidMask[y * w + x] = 1;
        stats.invalid++;
        continue;
      }
      if (p.radius > stats.maxRadius) stats.maxRadius = p.radius;
      radiusSum += p.radius;
      if (p.x < stats.minSourceX) stats.minSourceX = p.x;
      if (p.y < stats.minSourceY) stats.minSourceY = p.y;
      if (p.x > stats.maxSourceX) stats.maxSourceX = p.x;
      if (p.y > stats.maxSourceY) stats.maxSourceY = p.y;
      if (sampling === SAMPLING.NEAREST) {
        const sx = clampInt(Math.round(p.x), 0, srcW - 1);
        const sy = clampInt(Math.round(p.y), 0, srcH - 1);
        const si = (sy * srcW + sx) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
      } else {
        sampleBilinear(src, srcW, srcH, p.x, p.y, out, di);
      }
      stats.sampled++;
    }
  }
  stats.valid = stats.sampled;
  stats.validFraction = stats.pixels ? stats.sampled / stats.pixels : 0;
  stats.meanRadius = stats.sampled ? radiusSum / stats.sampled : 0;
  if (!Number.isFinite(stats.minSourceX)) {
    stats.minSourceX = 0; stats.minSourceY = 0; stats.maxSourceX = 0; stats.maxSourceY = 0;
  }
  return { width: w, height: h, rgba: out, invalidMask, stats };
}

function sampleBilinear(src, w, h, x, y, out, di) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const wx = x - x0;
  const wy = y - y0;
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const cx0 = Math.max(0, Math.min(w - 1, x0));
  const cy0 = Math.max(0, Math.min(h - 1, y0));
  const i00 = (cy0 * w + cx0) * 4;
  const i10 = (cy0 * w + x1) * 4;
  const i01 = (y1 * w + cx0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = src[i00 + c] * (1 - wx) + src[i10 + c] * wx;
    const bot = src[i01 + c] * (1 - wx) + src[i11 + c] * wx;
    out[di + c] = Math.round(top * (1 - wy) + bot * wy);
  }
}

function normalizeFill(fill) {
  const f = Array.isArray(fill) && fill.length === 4 ? fill : [16, 20, 28, 255];
  return f.map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
}

function clampInt(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Thin overlay showing the invalid region boundary and a normalized-radius
 * contour, so the user can see which part of the output is real.
 */
export function overlayInvalidMask(rgba, invalidMask, width, height, color = [255, 70, 90]) {
  const out = new Uint8ClampedArray(rgba);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = invalidMask[i];
      if (v === invalidMask[i - 1] && v === invalidMask[i + 1] && v === invalidMask[i - width] && v === invalidMask[i + width]) continue;
      if (v === 0) continue;
      const di = i * 4;
      out[di] = color[0]; out[di + 1] = color[1]; out[di + 2] = color[2]; out[di + 3] = 255;
    }
  }
  return out;
}
