/**
 * Measurement and fitting.
 *
 * Everything here operates on actual pixels/coordinates:
 *  - marker centroids are found by colour segmentation + connected components,
 *  - parameters are fitted by damped Gauss-Newton (Levenberg-Marquardt) over
 *    detected point correspondences,
 *  - line bending is measured by scanning intensity profiles along a guide
 *    and fitting a straight line to the actual line centres.
 */

import { getIntrinsicsAtSize, ParameterError } from './calibration.js';
import { distortNormalized, inverseNormalized } from './model.js';

export const MARKER_COLOR = Object.freeze({ r: 250, g: 150, b: 62 });

/** Subpixel marker centroid detection from an RGBA raster. */
export function detectMarkers(rgba, width, height, options = {}) {
  const minArea = options.minArea ?? 3;
  const maxArea = options.maxArea ?? 900;
  const maxExtent = options.maxExtent ?? 40;
  const visited = new Uint8Array(width * height);
  const out = [];
  const stack = new Int32Array(width * height);
  const isMarker = (i) => {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    return r > 150 && g > 70 && g < 215 && b < 130 && r - g > 35 && g - b > 25;
  };
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const start = y * width + x;
      if (visited[start] || !isMarker(start)) continue;
      let top = 0;
      stack[top++] = start;
      visited[start] = 1;
      let area = 0;
      let wx = 0;
      let wy = 0;
      let wsum = 0;
      let minX = x; let maxX = x; let minY = y; let maxY = y;
      while (top > 0) {
        const idx = stack[--top];
        const px = idx % width;
        const py = (idx / width) | 0;
        const r = rgba[idx * 4];
        const g = rgba[idx * 4 + 1];
        const b = rgba[idx * 4 + 2];
        const w = Math.max(1, r - b);
        area++;
        wx += px * w;
        wy += py * w;
        wsum += w;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (visited[ni]) continue;
            if (!isMarker(ni)) { visited[ni] = 1; continue; }
            visited[ni] = 1;
            stack[top++] = ni;
          }
        }
      }
      if (area < minArea || area > maxArea) continue;
      if (maxX - minX > maxExtent || maxY - minY > maxExtent) continue;
      out.push({
        x: wx / wsum,
        y: wy / wsum,
        area,
        bbox: { minX, minY, maxX, maxY },
        score: wsum / area,
      });
    }
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

/** Greedy one-to-one nearest matching. */
export function matchPoints(detected, expected, maxDistance = 60) {
  const pairs = [];
  const used = new Set();
  for (let i = 0; i < detected.length; i++) {
    let best = -1;
    let bestD = maxDistance;
    for (let j = 0; j < expected.length; j++) {
      if (used.has(j)) continue;
      const d = Math.hypot(detected[i].x - expected[j].x, detected[i].y - expected[j].y);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best >= 0) {
      used.add(best);
      pairs.push({ detected: i, expected: best, distance: bestD });
    }
  }
  return pairs;
}

const FIT_KEYS = ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2'];

/**
 * Fit Brown-Conrady parameters to point correspondences.
 * ideal: undistorted pixel coords at reference resolution.
 * observed: distorted pixel coords at reference resolution.
 *
 * fx/fy are fixed by default: with the radial polynomial written on
 * (X-cx)/fx, focal and coefficients share an exact gauge for radial terms
 * (only k/f², k2/f⁴, ... change the pixel map). The file's intrinsics decide
 * the normalized scale; the fitter therefore solves k/p/cx/cy at that scale.
 */
export function fitCalibration(points, initialCalibration, options = {}) {
  if (!Array.isArray(points) || points.length < 6) {
    throw new ParameterError('FIT_POINTS', `至少需要 6 个对应点才能拟合，收到 ${points ? points.length : 0} 个`);
  }
  const free = {
    fx: options.freeFocal === true,
    fy: options.freeFocal === true,
    cx: options.fixPrincipalPoint !== true,
    cy: options.fixPrincipalPoint !== true,
    k1: true, k2: true, k3: true, p1: true, p2: true,
  };
  const init = initialCalibration.intrinsics;
  const dist = initialCalibration.distortion;
  const modelConfig = dist.modelConfig || { radialOrder: 6, tangential: true };
  const radialOrder = [2, 4, 6].includes(modelConfig.radialOrder) ? modelConfig.radialOrder : 6;
  const tangentialOn = modelConfig.tangential !== false;
  if (['k1', 'k2', 'k3'].some((k) => free[k])) {
    for (const key of ['k2', 'k3']) {
      const needed = key === 'k2' ? radialOrder >= 4 : radialOrder >= 6;
      if (!needed) free[key] = false;
    }
  }
  if (['p1', 'p2'].some((k) => free[k]) && !tangentialOn) {
    free.p1 = false;
    free.p2 = false;
  }
  const p = [
    init.fx, init.fy, init.cx, init.cy,
    dist.k1, dist.k2, dist.k3, dist.p1, dist.p2,
  ];
  const active = FIT_KEYS.map((k, i) => (free[k] ? i : -1)).filter((i) => i >= 0);
  if (!active.length) throw new ParameterError('FIT_FREE', '没有可拟合的自由参数');
  const refW = init.referenceWidth;
  const refH = init.referenceHeight;

  const deltaFor = (idx, params) => {
    switch (idx) {
      case 0: return Math.max(1e-4, Math.abs(params[0]) * 2e-6);
      case 1: return Math.max(1e-4, Math.abs(params[1]) * 2e-6);
      case 2: case 3: return 1e-4;
      case 4: case 5: case 6: return 1e-7;
      default: return 1e-8;
    }
  };
  const clampParam = (idx, v) => {
    if (idx === 0 || idx === 1) return Math.min(refW * 6, Math.max(refW * 0.15, v));
    if (idx === 2) return Math.min(refW - 0.001, Math.max(0, v));
    if (idx === 3) return Math.min(refH - 0.001, Math.max(0, v));
    return Math.max(-4, Math.min(4, v));
  };
  const stepLimit = (idx, v) => {
    if (idx === 0 || idx === 1) return Math.abs(v) * 0.05;
    if (idx === 2 || idx === 3) return Math.max(0.5, refW * 0.005);
    return 0.05;
  };

  const maxIterations = Math.max(5, Math.min(200, options.maxIterations ?? 60));
  const tolerance = options.tolerance ?? 1e-10;
  const huberPx = options.huberPx ?? 4;

  const residualFor = (pts, params) => {
    const [fx, fy, cx, cy, k1, k2, k3, p1, p2] = params;
    const d = { k1, k2, k3, p1, p2, modelConfig };
    const r = new Float64Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const x = (pt.ideal.x - cx) / fx;
      const y = (pt.ideal.y - cy) / fy;
      const f = distortNormalized(x, y, d);
      const w = Math.sqrt(pt.weight ?? 1);
      r[i * 2] = (f.xd * fx + cx - pt.observed.x) * w;
      r[i * 2 + 1] = (f.yd * fy + cy - pt.observed.y) * w;
    }
    return r;
  };

  const cost = (r) => {
    let s = 0;
    for (let i = 0; i < r.length; i += 2) {
      const n = Math.hypot(r[i], r[i + 1]);
      s += n <= huberPx ? n * n : huberPx * (2 * n - huberPx);
    }
    return s;
  };

  const solve = (pts, startParams, budget) => {
    let current = startParams.slice();
    let r = residualFor(pts, current);
    let currentCost = cost(r);
    let lambda = options.initialLambda ?? 1e-3;
    let iterations = 0;
    let status = 'budget';
    let converged = false;

    for (; iterations < budget; iterations++) {
      const n = active.length;
      const J = new Float64Array(r.length * n);
      for (let c = 0; c < n; c++) {
        const idx = active[c];
        const delta = deltaFor(idx, current);
        const trial = current.slice();
        trial[idx] = clampParam(idx, trial[idx] + delta);
        const rt = residualFor(pts, trial);
        for (let i = 0; i < r.length; i++) J[i * n + c] = (rt[i] - r[i]) / delta;
      }
      const A = new Float64Array(n * n);
      const b = new Float64Array(n);
      for (let i = 0; i < r.length; i += 2) {
        for (let c = 0; c < n; c++) {
          const j0 = J[i * n + c];
          const j1 = J[(i + 1) * n + c];
          b[c] += j0 * r[i] + j1 * r[i + 1];
          for (let e = 0; e < n; e++) A[c * n + e] += j0 * J[i * n + e] + j1 * J[(i + 1) * n + e];
        }
      }
      let maxDiag = 0;
      for (let c = 0; c < n; c++) maxDiag = Math.max(maxDiag, A[c * n + c]);
      for (let c = 0; c < n; c++) A[c * n + c] += lambda * (A[c * n + c] + maxDiag * 1e-9 + 1e-12);
      const step = solveLinear(A, b, n);
      if (!step) { status = 'singular'; break; }
      const trial = current.slice();
      let moved = 0;
      for (let c = 0; c < n; c++) {
        const idx = active[c];
        let s = -step[c];
        const lim = stepLimit(idx, current[idx]);
        if (Math.abs(s) > lim) s = Math.sign(s) * lim;
        trial[idx] = clampParam(idx, trial[idx] + s);
        moved = Math.max(moved, Math.abs(s));
      }
      const rt = residualFor(pts, trial);
      const trialCost = cost(rt);
      if (trialCost < currentCost) {
        const improvement = currentCost - trialCost;
        current = trial;
        r = rt;
        currentCost = trialCost;
        lambda = Math.max(1e-12, lambda * 0.4);
        if (improvement < tolerance * (1 + currentCost) || moved < 1e-9) { converged = true; status = 'converged'; break; }
      } else {
        lambda *= 8;
        if (lambda > 1e12) { status = 'stalled'; break; }
      }
    }

    const perPoint = [];
    for (let i = 0; i < r.length; i += 2) perPoint.push(Math.hypot(r[i], r[i + 1]));
    return { params: current, r, cost: currentCost, iterations: iterations + 1, status, converged, perPoint };
  };

  // Two-stage robust fit. Rejection must happen *after* a fit, never before:
  // under a zero-distortion start the true strong-barrel points are tens of
  // pixels away from their prediction, so a pre-fit threshold would discard
  // the very points that determine the distortion. Stage one solves all
  // correspondences; later stages alternately re-score every point against the
  // current model and refit. Iterating the trim matters: one dragged marker
  // pulls the stage-one fit, which then makes several good points look bad;
  // after re-scoring, only the dragged point stays out.
  const outlierPx = options.outlierPx ?? 8;
  let usedPoints = points;
  let result = solve(points, p, maxIterations);
  let outliers = [];
  for (let round = 0; round < 3; round++) {
    const residuals = residualFor(points, result.params);
    const perPoint = [];
    for (let i = 0; i < residuals.length; i += 2) perPoint.push(Math.hypot(residuals[i], residuals[i + 1]));
    const sorted = perPoint.slice().sort((a, b) => a - b);
    const threshold = Math.max(outlierPx, sorted[sorted.length >> 1] * 6);
    const nextInliers = [];
    const nextOutliers = [];
    for (let i = 0; i < points.length; i++) {
      if (perPoint[i] > threshold) nextOutliers.push({ point: points[i], residualPx: perPoint[i] });
      else nextInliers.push(points[i]);
    }
    if (nextInliers.length < 6 || nextOutliers.length === outliers.length) {
      outliers = nextOutliers.length < points.length && nextInliers.length >= 6 ? nextOutliers : outliers;
      break;
    }
    outliers = nextOutliers;
    usedPoints = nextInliers;
    result = solve(usedPoints, result.params, Math.max(20, Math.round(maxIterations / 2)));
  }
  if (!outliers.length) usedPoints = points;
  // Final residuals are always measured on the points that produced them.
  const fitResiduals = residualFor(usedPoints, result.params);
  const perPointFinal = [];
  for (let i = 0; i < fitResiduals.length; i += 2) perPointFinal.push(Math.hypot(fitResiduals[i], fitResiduals[i + 1]));

  let sumSq = 0;
  let maxResidual = 0;
  for (const n of perPointFinal) {
    sumSq += n * n;
    if (n > maxResidual) maxResidual = n;
  }
  const rms = Math.sqrt(sumSq / perPointFinal.length);
  const [fx, fy, cx, cy, k1, k2, k3, p1, p2] = result.params;
  const calibration = JSON.parse(JSON.stringify(initialCalibration));
  calibration.intrinsics = {
    referenceWidth: init.referenceWidth,
    referenceHeight: init.referenceHeight,
    fx, fy, cx, cy,
  };
  calibration.distortion = { ...dist, k1, k2, k3, p1, p2 };
  calibration.fit = {
    method: 'levenberg-marquardt',
    pointCount: usedPoints.length,
    inputPointCount: points.length,
    freeParameters: active.map((i) => FIT_KEYS[i]),
    focalFixed: options.freeFocal !== true,
    iterations: result.iterations,
    status: result.converged ? 'converged' : result.status,
    rmsPx: rms,
    maxPx: maxResidual,
    cost: result.cost,
    outliers: outliers.map((o) => ({
      ideal: o.point.ideal,
      observed: o.point.observed,
      residualPx: o.residualPx,
    })),
    outlierCount: outliers.length,
    note: options.freeFocal === true
      ? '焦距与径向系数存在尺度规范简并，仅当有外部尺度约束时才应释放焦距'
      : '焦距由标定文件固定；仅拟合主点、径向与切向系数（径向项只以 k/f² 等组合影响像素映射）',
  };
  return {
    calibration, rmsPx: rms, maxPx: maxResidual, iterations: result.iterations,
    status: result.converged ? 'converged' : result.status,
    outliers, inlierCount: usedPoints.length,
  };
}

function solveLinear(A, b, n) {
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col * (n + 1) + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row * (n + 1) + col]);
      if (v > best) { best = v; pivot = row; }
    }
    if (best < 1e-14) return null;
    if (pivot !== col) {
      for (let k = col; k <= n; k++) {
        const t = M[col * (n + 1) + k];
        M[col * (n + 1) + k] = M[pivot * (n + 1) + k];
        M[pivot * (n + 1) + k] = t;
      }
    }
    const d = M[col * (n + 1) + col];
    for (let k = col; k <= n; k++) M[col * (n + 1) + k] /= d;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = M[row * (n + 1) + col];
      if (!f) continue;
      for (let k = col; k <= n; k++) M[row * (n + 1) + k] -= f * M[col * (n + 1) + k];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i * (n + 1) + n];
  return x;
}

/** Bilinear luminance/colour probe. Returns null outside. */
export function sampleRgba(rgba, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const wx = x - x0;
  const wy = y - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = rgba[i00 + c] * (1 - wx) + rgba[i10 + c] * wx;
    const bot = rgba[i01 + c] * (1 - wx) + rgba[i11 + c] * wx;
    out[c] = top * (1 - wy) + bot * wy;
  }
  return out;
}

/**
 * Measure line straightness from actual raster intensity.
 * guides: array of arrays of {x,y} sample points (at least 3) along where the
 * line is expected. Each point is refined by scanning +/-searchRadius along the
 * local normal for the intensity centroid, then a straight line is fitted (PCA)
 * and perpendicular residuals are reported.
 */
export function measureLineBending(rgba, width, height, guides, options = {}) {
  const searchRadius = options.searchRadius ?? 7;
  const minPeak = options.minPeak ?? 80;
  const step = options.step ?? 0.5;
  const excludeNearMarkers = options.markers || null;
  const lines = [];
  const allResiduals = [];

  for (let gi = 0; gi < guides.length; gi++) {
    const guide = guides[gi];
    const points = [];
    for (let i = 1; i < guide.length - 1; i++) {
      const prev = guide[i - 1];
      const next = guide[i + 1];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-9) continue;
      tx /= tl; ty /= tl;
      const nx = -ty;
      const ny = tx;
      if (excludeNearMarkers) {
        let skip = false;
        for (const m of excludeNearMarkers) {
          if (Math.hypot(guide[i].x - m.x, guide[i].y - m.y) < (options.markerClearance ?? 9)) { skip = true; break; }
        }
        if (skip) continue;
      }
      let sumW = 0;
      let sumT = 0;
      let peak = 0;
      for (let t = -searchRadius; t <= searchRadius + 1e-9; t += step) {
        const sx = guide[i].x + nx * t;
        const sy = guide[i].y + ny * t;
        const c = sampleRgba(rgba, width, height, sx, sy);
        if (!c) continue;
        const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        if (lum > peak) peak = lum;
        // Exclude orange marker pixels so they cannot pull the line centre.
        const wgt = c[2] > 85 && lum > 70 ? lum - 70 : 0;
        sumW += wgt;
        sumT += wgt * t;
      }
      if (peak < minPeak || sumW < 30) continue;
      const off = sumT / sumW;
      points.push({ x: guide[i].x + nx * off, y: guide[i].y + ny * off });
    }
    if (points.length < 8) {
      lines.push({ index: gi, samples: points.length, rmsPx: null, maxPx: null, skipped: true });
      continue;
    }
    // Robust straight-line fit via PCA, with one outlier-clipping pass.
    let fit = pcaLine(points);
    let residuals = perpendicularResiduals(points, fit);
    const sigma = median(residuals.map(Math.abs)) * 1.4826;
    const clip = Math.max(0.75, 2.5 * sigma);
    const kept = [];
    const keptRes = [];
    for (let i = 0; i < points.length; i++) {
      if (residuals[i] <= clip) { kept.push(points[i]); keptRes.push(residuals[i]); }
    }
    if (kept.length >= 8) {
      fit = pcaLine(kept);
      residuals = perpendicularResiduals(kept, fit);
    } else {
      fit = pcaLine(points);
      residuals = perpendicularResiduals(points, fit);
    }
    const rms = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / residuals.length);
    const max = Math.max(...residuals);
    allResiduals.push(...residuals);
    lines.push({
      index: gi,
      samples: residuals.length,
      rmsPx: rms,
      maxPx: max,
      direction: { x: fit.dx, y: fit.dy },
      center: { x: fit.cx, y: fit.cy },
      skipped: false,
    });
  }
  const valid = lines.filter((l) => !l.skipped);
  const summary = {
    lineCount: valid.length,
    skipped: lines.length - valid.length,
    rmsPx: valid.length ? Math.sqrt(valid.reduce((s, l) => s + l.rmsPx * l.rmsPx, 0) / valid.length) : null,
    maxPx: valid.length ? Math.max(...valid.map((l) => l.maxPx)) : null,
    sampleCount: allResiduals.length,
  };
  return { lines, summary };
}

function pcaLine(points) {
  let mx = 0; let my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= points.length; my /= points.length;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx: mx, cy: my, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function perpendicularResiduals(points, fit) {
  return points.map((p) => Math.abs(-fit.dy * (p.x - fit.cx) + fit.dx * (p.y - fit.cy)));
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Build guide polylines for vertical/horizontal lines in an ideal grid. */
export function buildGuidesForGrid(grid, mapper, options = {}) {
  const margin = options.margin ?? 24;
  const samples = options.samples ?? 120;
  const chart = grid.chart;
  const verticalLines = options.verticalLines ?? grid.vertical;
  const horizontalLines = options.horizontalLines ?? grid.horizontal;
  const guides = [];
  for (const X of verticalLines) {
    const pts = [];
    for (let k = 0; k < samples; k++) {
      const t = chart.minY + margin + ((chart.height - 2 * margin) * k) / (samples - 1);
      pts.push(mapper({ x: X, y: t }));
    }
    guides.push(pts);
  }
  for (const Y of horizontalLines) {
    const pts = [];
    for (let k = 0; k < samples; k++) {
      const t = chart.minX + margin + ((chart.width - 2 * margin) * k) / (samples - 1);
      pts.push(mapper({ x: t, y: Y }));
    }
    guides.push(pts);
  }
  return guides;
}

/** Ground-truth mapper for the synthetic scene, used only to steer guides. */
export function makeGroundTruthMapper(calibration) {
  const intr = getIntrinsicsAtSize(calibration, calibration.source.width, calibration.source.height);
  return (p) => {
    const x = (p.x - intr.cx) / intr.fx;
    const y = (p.y - intr.cy) / intr.fy;
    const f = distortNormalized(x, y, calibration.distortion);
    return { x: f.xd * intr.fx + intr.cx, y: f.yd * intr.fy + intr.cy };
  };
}

/** Solver round-trip over a normalized disk: distort then invert. */
export function measureRoundTrip(calibration, samples = 400, opts = {}) {
  const d = calibration.distortion;
  let maxErr = 0;
  let sumSq = 0;
  let count = 0;
  let failures = 0;
  const vmax = d.validMaxNormalizedRadius;
  for (let i = 0; i < samples; i++) {
    const r = vmax * Math.sqrt((i + 0.5) / samples);
    for (let j = 0; j < 36; j++) {
      const theta = (2 * Math.PI * j) / 36;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      const f = distortNormalized(x, y, d);
      const inv = inverseNormalized(f.xd, f.yd, d, opts);
      const err = Math.hypot(inv.x - x, inv.y - y);
      if (inv.status !== 'converged') failures++;
      maxErr = Math.max(maxErr, err);
      sumSq += err * err;
      count++;
    }
  }
  return { samples: count, rmsNormalized: Math.sqrt(sumSq / count), maxNormalized: maxErr, nonConverged: failures };
}

/**
 * Complete evaluation of a synthetic scene:
 * detect -> match -> fit -> render -> detect again -> residual + bending.
 */
export function evaluateRectification({ scene, distorted, rectified, plan, calibration, detection, fit }) {
  const grid = scene.grid;
  const sourceW = scene.width;
  const sourceH = scene.height;
  const truth = scene.calibration;

  const detectedObserved = detection.markers;
  const fitPoints = detection.fitPoints;
  const fitResiduals = fitPoints.map((p, i) => ({
    id: detection.matchedVisible?.[i]?.id || `P${i + 1}`,
    observed: p.observed,
    expected: p.truthObserved,
    detectedErrorPx: p.truthObserved ? Math.hypot(p.observed.x - p.truthObserved.x, p.observed.y - p.truthObserved.y) : null,
  }));

  // Coordinate residual after rectification: detected centroids in output
  // converted back to undistorted coordinates, compared with ideal positions.
  const rectDetections = detectMarkers(rectified.rgba, rectified.width, rectified.height);
  const areaMedian = median(rectDetections.map((d) => d.area));
  const completeDetections = rectDetections.filter((d) => {
    if (d.bbox.minX <= 0 || d.bbox.minY <= 0 || d.bbox.maxX >= rectified.width - 1 || d.bbox.maxY >= rectified.height - 1) return false;
    return d.area >= areaMedian * 0.55;
  });
  const excludedClipped = rectDetections.length - completeDetections.length;
  const expectedOut = grid.markers
    .map((p) => ({
      x: (p.x - plan.offsetX) / plan.stepX,
      y: (p.y - plan.offsetY) / plan.stepY,
      ideal: p,
    }))
    .filter((p) => p.x > 10 && p.y > 10 && p.x < rectified.width - 11 && p.y < rectified.height - 11);
  const rectPairs = matchPoints(completeDetections, expectedOut, 14);
  const coordErrors = [];
  const usedRectDet = new Set();
  const usedRectExp = new Set();
  for (const pair of rectPairs) {
    if (usedRectDet.has(pair.detected) || usedRectExp.has(pair.expected)) continue;
    usedRectDet.add(pair.detected);
    usedRectExp.add(pair.expected);
    const det = completeDetections[pair.detected];
    const exp = expectedOut[pair.expected];
    const dx = det.x * plan.stepX + plan.offsetX - exp.ideal.x;
    const dy = det.y * plan.stepY + plan.offsetY - exp.ideal.y;
    coordErrors.push({ ideal: exp.ideal, detected: det, errorPx: Math.hypot(dx, dy), dx, dy });
  }
  const rectRms = coordErrors.length ? Math.sqrt(coordErrors.reduce((s, p) => s + p.errorPx * p.errorPx, 0) / coordErrors.length) : null;
  const rectMax = coordErrors.length ? Math.max(...coordErrors.map((p) => p.errorPx)) : null;

  // Forward reprojection residual of the fitted model over all grid markers.
  const fitIntr = getIntrinsicsAtSize(calibration, sourceW, sourceH);
  const fwdResiduals = [];
  const truthIntr = getIntrinsicsAtSize(truth, sourceW, sourceH);
  for (const marker of grid.markers) {
    const x = (marker.x - fitIntr.cx) / fitIntr.fx;
    const y = (marker.y - fitIntr.cy) / fitIntr.fy;
    const f = distortNormalized(x, y, calibration.distortion);
    const tx = (marker.x - truthIntr.cx) / truthIntr.fx;
    const ty = (marker.y - truthIntr.cy) / truthIntr.fy;
    const tf = distortNormalized(tx, ty, truth.distortion);
    const pred = { x: f.xd * fitIntr.fx + fitIntr.cx, y: f.yd * fitIntr.fy + fitIntr.cy };
    const tr = { x: tf.xd * truthIntr.fx + truthIntr.cx, y: tf.yd * truthIntr.fy + truthIntr.cy };
    fwdResiduals.push({ ideal: marker, predicted: pred, truth: tr, errorPx: Math.hypot(pred.x - tr.x, pred.y - tr.y) });
  }
  const fwdRms = Math.sqrt(fwdResiduals.reduce((s, p) => s + p.errorPx * p.errorPx, 0) / fwdResiduals.length);
  const fwdMax = Math.max(...fwdResiduals.map((p) => p.errorPx));

  // Line bending: rectified raster vs distorted raster.
  const rectGuides = [];
  for (const X of grid.vertical) {
    const pts = [];
    for (let k = 0; k < 100; k++) {
      const y = 12 + ((rectified.height - 25) * k) / 99;
      pts.push({ x: (X - plan.offsetX) / plan.stepX, y });
    }
    rectGuides.push(pts);
  }
  for (const Y of grid.horizontal) {
    const pts = [];
    for (let k = 0; k < 100; k++) {
      const x = 12 + ((rectified.width - 25) * k) / 99;
      pts.push({ x, y: (Y - plan.offsetY) / plan.stepY });
    }
    rectGuides.push(pts);
  }
  const rectBending = measureLineBending(rectified.rgba, rectified.width, rectified.height, rectGuides, {
    searchRadius: Math.max(3, 6 / Math.min(plan.stepX, plan.stepY)),
    markers: grid.markers.map((m) => ({ x: (m.x - plan.offsetX) / plan.stepX, y: (m.y - plan.offsetY) / plan.stepY })),
    markerClearance: 8,
  });
  // Convert rectified bending from output pixels to source pixels.
  for (const line of rectBending.lines) {
    if (line.rmsPx != null) line.rmsSourcePx = line.rmsPx * (plan.stepX + plan.stepY) / 2;
    if (line.maxPx != null) line.maxSourcePx = line.maxPx * (plan.stepX + plan.stepY) / 2;
  }
  const rectBendSourceRms = rectBending.summary.rmsPx != null
    ? rectBending.summary.rmsPx * (plan.stepX + plan.stepY) / 2 : null;
  const rectBendSourceMax = rectBending.summary.maxPx != null
    ? rectBending.summary.maxPx * (plan.stepX + plan.stepY) / 2 : null;

  const truthMapper = makeGroundTruthMapper(truth);
  const distGuides = buildGuidesForGrid(grid, truthMapper, { margin: 20, samples: 100 });
  const distBending = measureLineBending(distorted.rgba, sourceW, sourceH, distGuides, {
    searchRadius: 10,
    markers: grid.markers,
    markerClearance: 9,
  });

  const thresholds = scene.thresholds;
  const checks = {
    markerRms: rectRms != null && rectRms <= thresholds.markerRmsPx,
    markerMax: rectMax != null && rectMax <= thresholds.markerMaxPx,
    bendingRms: rectBendSourceRms != null && rectBendSourceRms <= thresholds.lineBendingRmsPx,
    bendingMax: rectBendSourceMax != null && rectBendSourceMax <= thresholds.lineBendingMaxPx,
    improvement: distBending.summary.rmsPx != null && rectBendSourceRms != null
      ? distBending.summary.rmsPx / Math.max(rectBendSourceRms, 1e-9) >= thresholds.minimumImprovement
      : false,
  };
  const pass = checks.markerRms && checks.markerMax && checks.bendingRms && checks.bendingMax;

  return {
    pass,
    checks,
    thresholds,
    detectedMarkers: detectedObserved.length,
    matchedMarkers: fitPoints.length,
    coordinateResidual: {
      rmsPx: rectRms,
      maxPx: rectMax,
      count: coordErrors.length,
      excludedClipped,
      points: coordErrors.map((p) => ({ ideal: p.ideal, detectedPx: p.detected.x * plan.stepX + plan.offsetX, detectedPy: p.detected.y * plan.stepY + plan.offsetY, errorPx: p.errorPx })),
    },
    fitResidual: {
      rmsPx: fit.rmsPx,
      maxPx: fit.maxPx,
      pointCount: fit.calibration.fit?.pointCount,
      iterations: fit.iterations,
      status: fit.status,
      detectionVsTruthPx: fitResiduals.map((p) => p.detectedErrorPx).filter((v) => v != null),
    },    forwardResidual: { rmsPx: fwdRms, maxPx: fwdMax, points: fwdResiduals },
    lineBending: {
      distorted: distBending.summary,
      rectified: {
        ...rectBending.summary,
        rmsSourcePx: rectBendSourceRms,
        maxSourcePx: rectBendSourceMax,
      },
      improvementRatio: distBending.summary.rmsPx != null && rectBendSourceRms != null
        ? distBending.summary.rmsPx / Math.max(rectBendSourceRms, 1e-9) : null,
      rectifiedLines: rectBending.lines,
      distortedLines: distBending.lines,
    },
    mapping: {
      width: plan.width,
      height: plan.height,
      offsetX: plan.offsetX,
      offsetY: plan.offsetY,
      stepX: plan.stepX,
      stepY: plan.stepY,
      mode: plan.mode,
      validFraction: rectified.stats.validFraction,
      invalidPixels: rectified.stats.invalid,
      outOfFrame: rectified.stats.outOfFrame,
      outsideModel: rectified.stats.outsideModel,
      note: plan.notes,
      warnings: plan.warnings,
    },
    rectifiedStats: rectified.stats,
    distortedStats: distorted.stats,
    roundTrip: measureRoundTrip(calibration),
  };
}
