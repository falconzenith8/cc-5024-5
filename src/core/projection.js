/**
 * Output framing for rectification.
 *
 * "preserve-field": destination canvas is the bounding rectangle of the
 * undistorted image of the *whole valid source frame*. Its aspect ratio and
 * size are derived from the actual mapping, never stretched to a preset size.
 *
 * "crop": largest centered rectangle (source aspect) whose boundary maps to
 * valid source pixels. Its actual width/height are measured from the mapping.
 *
 * Both modes report their geometry so the UI and CLI can show what was chosen.
 */

import { getIntrinsicsAtSize, ParameterError } from './calibration.js';
import { distortedToUndistorted, undistortedToDistorted } from './model.js';

export const MODES = Object.freeze({ PRESERVE_FIELD: 'preserve-field', CROP: 'crop' });

const DEFAULT_LIMITS = Object.freeze({
  maxDimension: 8192,
  maxOutputPixels: 24_000_000,
  boundarySamples: 720,
  cropBoundarySamples: 96,
  // Bounded but deliberately generous: the field trace runs a few thousand
  // fixed inversions, not per-pixel work, and strong barrels need more steps
  // near the corners. Stopping conditions still cap every call.
  inverse: { maxIterations: 90, tolerance: 1e-9, maxStepNormalized: 0.6 },
});

function readLimits(overrides = {}) {
  return {
    ...DEFAULT_LIMITS,
    ...overrides,
    inverse: { ...DEFAULT_LIMITS.inverse, ...(overrides.inverse || {}) },
  };
}

/**
 * Undistorted-space image of the source frame: sample the border and a few
 * interior rings, invert each point, keep finite and model-valid samples.
 */
export function measureFieldBounds(calibration, srcWidth, srcHeight, options = {}) {
  const limits = readLimits(options);
  const intr = getIntrinsicsAtSize(calibration, srcWidth, srcHeight);
  const vmax = calibration.distortion.validMaxNormalizedRadius;
  const n = Math.max(64, Math.floor(limits.boundarySamples));
  const points = [];
  let rejected = 0;
  let nonConverged = 0;

  const push = (u, v) => {
    const inv = distortedToUndistorted(u, v, intr, calibration.distortion, limits.inverse);
    if (!Number.isFinite(inv.x) || !Number.isFinite(inv.y) || inv.radius > vmax || inv.status === 'diverged') {
      rejected++;
      return;
    }
    if (inv.status !== 'converged' && inv.reason !== 'plateau') nonConverged++;
    points.push({ u: inv.x, v: inv.y, sourceU: u, sourceV: v, radius: inv.radius, status: inv.status });
  };

  for (let k = 0; k < n; k++) {
    const t = k / n;
    const x = t * (srcWidth - 1);
    const y = t * (srcHeight - 1);
    push(x, 0);
    push(x, srcHeight - 1);
    push(0, y);
    push(srcWidth - 1, y);
  }
  // Interior rings detect folds or holes that a pure border trace would miss.
  for (let gy = 1; gy <= 6; gy++) {
    for (let gx = 1; gx <= 6; gx++) {
      push((srcWidth - 1) * gx / 7, (srcHeight - 1) * gy / 7);
    }
  }
  if (!points.length) {
    throw new ParameterError('EMPTY_FIELD', '源画面边界在该畸变模型下全部无效，无法确定校正输出范围');
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.u < minX) minX = p.u;
    if (p.v < minY) minY = p.v;
    if (p.u > maxX) maxX = p.u;
    if (p.v > maxY) maxY = p.v;
  }
  const warnings = [];
  if (rejected) {
    warnings.push({
      code: 'FIELD_SAMPLES_REJECTED',
      message: `${rejected} 个源边界/内点样本超出模型有效范围或无法反演，输出范围由剩余有效样本确定`,
    });
  }
  if (nonConverged) {
    warnings.push({
      code: 'FIELD_INVERSE_NOT_CONVERGED',
      message: `${nonConverged} 个范围测量点迭代未达容差（已按预算停止），范围可能略有偏差`,
    });
  }
  return {
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    pointCount: points.length,
    rejected,
    nonConverged,
    warnings,
    intr,
  };
}

/** Check all boundary sample points of a centered rectangle are valid. */
function rectBoundaryValid(calibration, intr, cx, cy, halfW, halfH, samples) {
  const vmax = calibration.distortion.validMaxNormalizedRadius;
  const points = [];
  for (let k = 0; k < samples; k++) {
    const t = k / samples;
    points.push([cx - halfW + 2 * halfW * t, cy - halfH]);
    points.push([cx - halfW + 2 * halfW * t, cy + halfH]);
    points.push([cx - halfW, cy - halfH + 2 * halfH * t]);
    points.push([cx + halfW, cy - halfH + 2 * halfH * t]);
  }
  points.push([cx, cy]);
  for (const [u, v] of points) {
    const p = undistortedToDistorted(u, v, intr, calibration.distortion);
    if (!p.finite) return false;
    if (p.radius > vmax) return false;
    if (p.x < -0.5 || p.y < -0.5 || p.x > intr.width - 0.5 || p.y > intr.height - 0.5) return false;
  }
  return true;
}

/**
 * Largest centered crop rectangle with the requested aspect ratio whose whole
 * boundary is valid. Found by bisection on a scale factor (fixed 40 steps).
 */
export function measureCropRect(calibration, srcWidth, srcHeight, options = {}) {
  const limits = readLimits(options);
  const intr = getIntrinsicsAtSize(calibration, srcWidth, srcHeight);
  const samples = Math.max(16, Math.floor(limits.cropBoundarySamples / 4));
  const aspect = srcWidth / srcHeight;
  let aspectW = aspect;
  let aspectH = 1;
  if (aspect < 1) { aspectW = 1; aspectH = 1 / aspect; }

  const testScale = (s) => rectBoundaryValid(calibration, intr, intr.cx, intr.cy, (srcWidth * s) / 2, (srcHeight * s) / 2, samples);

  if (!testScale(0.02)) {
    throw new ParameterError('CROP_TOO_SMALL', '即使很小的中心裁剪窗口也无法完全落在有效源像素内；请缩小模型有效半径或改用保留视场模式');
  }
  let lo = 0.02;
  let hi = 1.0;
  let attempts = 0;
  if (testScale(1.0)) {
    lo = 1.0;
  } else {
    for (let i = 0; i < 40; i++) {
      attempts++;
      const mid = (lo + hi) / 2;
      if (testScale(mid)) lo = mid; else hi = mid;
    }
  }
  const halfW = (srcWidth * lo) / 2;
  const halfH = (srcHeight * lo) / 2;
  const width = Math.max(2, Math.floor(2 * halfW));
  const height = Math.max(2, Math.floor(2 * halfH));
  return {
    offsetX: intr.cx - width / 2,
    offsetY: intr.cy - height / 2,
    width,
    height,
    scale: lo,
    aspect: width / height,
    requestedAspect: aspectW / aspectH,
    bisectionSteps: attempts,
    samplesPerEdge: samples,
  };
}

/**
 * Production entry point: build a destination grid and the exact geometry
 * used by the renderer. No fixed output rectangle is assumed.
 */
export function planOutput(calibration, srcWidth, srcHeight, mode, options = {}) {
  const limits = readLimits(options);
  if (mode !== MODES.PRESERVE_FIELD && mode !== MODES.CROP) {
    throw new ParameterError('PROJECTION_MODE', `未知输出模式 ${JSON.stringify(mode)}`);
  }
  const intr = getIntrinsicsAtSize(calibration, srcWidth, srcHeight);
  const warnings = [];
  let width; let height; let offsetX; let offsetY; let stepX = 1; let stepY = 1;
  let field = null; let crop = null;
  let modeNote;

  if (mode === MODES.PRESERVE_FIELD) {
    field = measureFieldBounds(calibration, srcWidth, srcHeight, options);
    warnings.push(...field.warnings);
    const b = field.bounds;
    const pad = Math.max(0, Number(options.padding) || 0);
    let spanX = Math.max(b.width, 0) + 2 * pad;
    let spanY = Math.max(b.height, 0) + 2 * pad;
    let outW = Math.ceil(spanX) + 1;
    let outH = Math.ceil(spanY) + 1;
    let budgetScale = 1;
    if (outW * outH > limits.maxOutputPixels) {
      budgetScale = Math.sqrt(limits.maxOutputPixels / (outW * outH));
      warnings.push({
        code: 'OUTPUT_BUDGET',
        message: `保留视场输出 ${outW}×${outH} 超过 ${limits.maxOutputPixels} 像素预算，采样步长设为 ${(1 / budgetScale).toFixed(4)}（按比例缩小，不改变画幅比例）`,
      });
    }
    if (outW * budgetScale > limits.maxDimension) {
      budgetScale = Math.min(budgetScale, limits.maxDimension / outW);
      warnings.push({ code: 'OUTPUT_DIMENSION', message: `输出宽度受 ${limits.maxDimension} 上限约束，采样步长 ${(1 / budgetScale).toFixed(4)}` });
    }
    if (outH * budgetScale > limits.maxDimension) {
      budgetScale = Math.min(budgetScale, limits.maxDimension / outH);
      warnings.push({ code: 'OUTPUT_DIMENSION', message: `输出高度受 ${limits.maxDimension} 上限约束，采样步长 ${(1 / budgetScale).toFixed(4)}` });
    }
    stepX = 1 / budgetScale;
    stepY = 1 / budgetScale;
    width = Math.max(2, Math.ceil(spanX / stepX) + 1);
    height = Math.max(2, Math.ceil(spanY / stepY) + 1);
    offsetX = b.minX - pad + (spanX - (width - 1) * stepX) / 2;
    offsetY = b.minY - pad + (spanY - (height - 1) * stepY) / 2;
    modeNote = `保留视场：由有效源画面反演得到 ${b.width.toFixed(1)}×${b.height.toFixed(1)} 的无畸变范围，输出 ${width}×${height}（比例 ${(width / height).toFixed(4)}）`;
  } else {
    crop = measureCropRect(calibration, srcWidth, srcHeight, options);
    width = crop.width;
    height = crop.height;
    offsetX = crop.offsetX;
    offsetY = crop.offsetY;
    if (width * height > limits.maxOutputPixels) {
      const s = Math.sqrt(limits.maxOutputPixels / (width * height));
      width = Math.max(2, Math.floor(width * s));
      height = Math.max(2, Math.floor(height * s));
      stepX = crop.width / width;
      stepY = crop.height / height;
      offsetX = crop.offsetX + stepX / 2;
      offsetY = crop.offsetY + stepY / 2;
      warnings.push({ code: 'OUTPUT_BUDGET', message: '裁剪输出超过像素预算，已按比例降低采样密度' });
    }
    modeNote = `裁剪输出：实测最大居中裁剪为 ${width}×${height}（源画幅 ${(crop.scale * 100).toFixed(1)}%，比例 ${(width / height).toFixed(4)}）`;
  }

  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new ParameterError('OUTPUT_TOO_LARGE', `输出 ${width}×${height} 超过单边 ${limits.maxDimension} 像素上限，请降低预算或改用裁剪模式`);
  }

  return {
    mode,
    source: { width: srcWidth, height: srcHeight },
    intrinsics: intr,
    width,
    height,
    offsetX,
    offsetY,
    stepX,
    stepY,
    coverage: {
      preserveField: mode === MODES.PRESERVE_FIELD,
      fieldBounds: field ? field.bounds : null,
      fieldPointCount: field ? field.pointCount : null,
      crop,
    },
    field,
    crop,
    notes: modeNote,
    warnings,
    limits,
  };
}

/**
 * For a destination pixel, return its undistorted coordinate (u,v) and the
 * source pixel it must sample. Pure function; both UI probe and renderer use it.
 */
export function destinationToSource(plan, distortion, dx, dy) {
  const u = plan.offsetX + dx * plan.stepX;
  const v = plan.offsetY + dy * plan.stepY;
  const p = undistortedToDistorted(u, v, plan.intrinsics, distortion);
  const inFrame = p.finite && p.x >= -0.5 && p.y >= -0.5 && p.x <= plan.intrinsics.width - 0.5 && p.y <= plan.intrinsics.height - 0.5;
  return {
    u, v,
    sourceX: p.x,
    sourceY: p.y,
    radius: p.radius,
    radialScale: p.radialScale,
    insideModel: p.finite && p.radius <= distortion.validMaxNormalizedRadius,
    inFrame,
    valid: inFrame && p.finite && p.radius <= distortion.validMaxNormalizedRadius,
  };
}
