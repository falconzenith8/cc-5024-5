/**
 * Calibration parameter schema and resolution adaptation.
 *
 * Intrinsics are authored for `referenceWidth x referenceHeight`. Pixel-space
 * quantities (cx, cy, tangential profile) scale with the image. Normalized
 * radii and the radial polynomial are dimensionless and must NOT be rescaled.
 * If a caller changes the input size without adapting, the program refuses
 * rather than silently applying the same pixel parameters.
 */

export const MODEL = 'brown-conrady';
export const MODEL_ORDERS = Object.freeze([2, 4, 6]);
export const DISTORTION_MODEL = Object.freeze({
  id: 'brown-conrady',
  name: 'Brown-Conrady 径向+切向',
  radialOrders: [2, 4, 6],
  radialTermsByOrder: { 2: ['k1'], 4: ['k1', 'k2'], 6: ['k1', 'k2', 'k3'] },
  tangentialTerms: ['p1', 'p2'],
  formula: {
    normalized: 'x = (u - cx) / fx,  y = (v - cy) / fy',
    radial: 'r^2 = x^2 + y^2;  radial = 1 + k1 r^2 + k2 r^4 + k3 r^6（阶数可选 2/4/6）',
    tangential: 'dx = 2 p1 x y + p2 (r^2 + 2x^2);  dy = p1 (r^2 + 2y^2) + 2 p2 x y（可关闭）',
    distorted: 'xd = x * radial + dx,  yd = y * radial + dy',
    forward: 'ud = fx * xd + cx,  vd = fy * yd + cy',
    inverse: '对每个输出像素，用带步长/迭代预算的阻尼牛顿法反解正向映射',
  },
  notes: [
    'k1,k2,k3 无量纲；p1,p2 无量纲',
    'fx,fy,cx,cy 为 referenceWidth x referenceHeight 处的像素量',
    'validMaxNormalizedRadius 限定模型可信范围',
    'modelConfig 显式记录径向阶数（r^2/r^4/r^6 哪几项）与是否启用切向项',
  ],
});

export class ParameterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ParameterError';
    this.code = code;
    this.details = details;
  }
}

const POLYNOMIAL_KEYS = ['k1', 'k2', 'k3', 'p1', 'p2'];

export function finiteNumber(value, label) {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) {
    throw new ParameterError('NON_FINITE', `${label} 必须是有限数值，收到 ${JSON.stringify(value)}`);
  }
  return n;
}

function positiveInt(value, label) {
  const n = finiteNumber(value, label);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ParameterError('BAD_DIMENSION', `${label} 必须是正整数，收到 ${value}`);
  }
  return n;
}

export function createDefaultCalibration(width = 1600, height = 1200) {
  const w = positiveInt(width, 'width');
  const h = positiveInt(height, 'height');
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  return {
    formatVersion: 1,
    model: MODEL,
    source: { width: w, height: h, label: 'reference' },
    intrinsics: {
      referenceWidth: w,
      referenceHeight: h,
      fx: w * 0.78,
      fy: w * 0.78,
      cx,
      cy,
    },
    distortion: {
      k1: -0.22,
      k2: 0.085,
      k3: -0.012,
      p1: 0.0012,
      p2: -0.0008,
      validMaxNormalizedRadius: 1.08,
      edgeMode: 'transparent',
      modelConfig: { radialOrder: 6, tangential: true },
    },
    projection: { mode: 'preserve-field', fillColor: [16, 20, 28, 255] },
  };
}

/** Deep clone without relying on structuredClone being present. */
export function cloneCalibration(cal) {
  return JSON.parse(JSON.stringify(cal));
}

export function getIntrinsicsAtSize(cal, width, height) {
  const i = cal.intrinsics;
  const refW = positiveInt(i.referenceWidth, 'referenceWidth');
  const refH = positiveInt(i.referenceHeight, 'referenceHeight');
  const w = positiveInt(width, 'image width');
  const h = positiveInt(height, 'image height');
  const sx = w / refW;
  const sy = h / refH;
  return {
    width: w,
    height: h,
    referenceWidth: refW,
    referenceHeight: refH,
    sx,
    sy,
    aspectNumerator: refW * h,
    aspectDenominator: refH * w,
    fx: finiteNumber(i.fx, 'fx') * sx,
    fy: finiteNumber(i.fy, 'fy') * sy,
    cx: finiteNumber(i.cx, 'cx') * sx,
    cy: finiteNumber(i.cy, 'cy') * sy,
  };
}

/** True when calibration was authored at exactly this resolution. */
export function isNativeResolution(cal, width, height) {
  const i = cal.intrinsics;
  return i.referenceWidth === width && i.referenceHeight === height;
}

/**
 * Adapt intrinsics to a different input size. fx/fy/cx/cy are scaled;
 * the dimensionless distortion coefficients are carried unchanged.
 * The reference resolution is updated so the recorded fit stays honest.
 */
export function adaptCalibrationToSize(cal, width, height) {
  const a = getIntrinsicsAtSize(cal, width, height);
  const next = cloneCalibration(cal);
  next.intrinsics = {
    referenceWidth: a.width,
    referenceHeight: a.height,
    fx: round(a.fx),
    fy: round(a.fy),
    cx: round(a.cx),
    cy: round(a.cy),
  };
  next.source = {
    ...(next.source || {}),
    width: a.width,
    height: a.height,
  };
  next.adaptation = {
    from: { width: a.referenceWidth, height: a.referenceHeight },
    to: { width: a.width, height: a.height },
    scale: { x: a.sx, y: a.sy },
    coefficientsRescaled: false,
  };
  return next;
}

/** Rescale normalized-coordinate coefficients when the aspect ratio changes. */
export function adaptCoefficientsForAspect(cal, width, height) {
  const a = getIntrinsicsAtSize(cal, width, height);
  if (Math.abs(a.aspectNumerator - a.aspectDenominator) === 0) return cloneCalibration(cal);
  const out = adaptCalibrationToSize(cal, width, height);
  const rx = a.fx / a.fy;
  const ry = 1 / rx;
  const d = out.distortion;
  d.k1 *= rx * rx;
  d.k2 *= rx ** 4;
  d.k3 *= rx ** 6;
  d.p1 *= rx * rx;
  d.p2 *= rx * ry;
  out.adaptation.coefficientsRescaled = true;
  out.adaptation.aspectScale = { x: rx, y: ry };
  return out;
}

/**
 * Validate every field the solver will consume. Throws ParameterError with a
 * user-facing message and code; the UI surfaces these and the CLI exits non-zero.
 */
export function validateCalibration(cal, opts = {}) {
  const errors = [];
  const warnings = [];
  const add = (code, message, field) => errors.push({ code, message, field });

  if (!cal || typeof cal !== 'object') {
    throw new ParameterError('MALFORMED', '标定参数根节点必须是对象');
  }
  if (cal.model !== MODEL) {
    add('MODEL', `模型必须显式声明为 "${MODEL}"，收到 ${JSON.stringify(cal.model)}`, 'model');
  }
  const i = cal.intrinsics || {};
  let refW = 0;
  let refH = 0;
  try { refW = positiveInt(i.referenceWidth, 'intrinsics.referenceWidth'); } catch (e) { add(e.code, e.message, 'intrinsics.referenceWidth'); }
  try { refH = positiveInt(i.referenceHeight, 'intrinsics.referenceHeight'); } catch (e) { add(e.code, e.message, 'intrinsics.referenceHeight'); }
  const nums = {};
  for (const key of ['fx', 'fy', 'cx', 'cy']) {
    try {
      nums[key] = finiteNumber(i[key], `intrinsics.${key}`);
    } catch (e) {
      add(e.code, e.message, `intrinsics.${key}`);
    }
  }
  if (Number.isFinite(nums.fx) && nums.fx <= 0) add('FOCAL', 'fx 必须为正数（像素）', 'intrinsics.fx');
  if (Number.isFinite(nums.fy) && nums.fy <= 0) add('FOCAL', 'fy 必须为正数（像素）', 'intrinsics.fy');
  if (Number.isFinite(nums.fx) && Number.isFinite(nums.fy) && refW && refH) {
    const ratio = (nums.fx / refW) / (nums.fy / refH);
    if (ratio < 0.5 || ratio > 2) {
      warnings.push({
        code: 'ASPECT_FOCAL',
        message: `fx/fy 归一化比例差异常（${ratio.toFixed(3)}）。若输入不是方形像素，分离的 fx/fy 仍会按各自方向工作。`,
        field: 'intrinsics',
      });
    }
  }

  const d = cal.distortion || {};
  const dist = {};
  for (const key of POLYNOMIAL_KEYS) {
    try { dist[key] = finiteNumber(d[key], `distortion.${key}`); } catch (e) { add(e.code, e.message, `distortion.${key}`); }
  }
  const maxR = d.validMaxNormalizedRadius;
  let vmax = NaN;
  try { vmax = finiteNumber(maxR, 'distortion.validMaxNormalizedRadius'); } catch (e) { add(e.code, e.message, 'distortion.validMaxNormalizedRadius'); }
  const cfg = d.modelConfig || { radialOrder: 6, tangential: true };
  if (![2, 4, 6].includes(cfg.radialOrder)) {
    add('RADIAL_ORDER', 'distortion.modelConfig.radialOrder 必须为 2、4 或 6', 'distortion.modelConfig.radialOrder');
  }
  if (typeof cfg.tangential !== 'boolean') {
    add('TANGENTIAL_FLAG', 'distortion.modelConfig.tangential 必须显式为 true 或 false', 'distortion.modelConfig.tangential');
  }
  if (Number.isFinite(vmax)) {
    if (vmax <= 0) add('VALID_RADIUS', 'validMaxNormalizedRadius 必须为正数', 'distortion.validMaxNormalizedRadius');
    else if (vmax > 1.8) warnings.push({ code: 'VALID_RADIUS_WIDE', message: '模型有效半径 > 1.8，远离拟合区域外推风险很大', field: 'distortion.validMaxNormalizedRadius' });
    else if (vmax < 0.35) warnings.push({ code: 'VALID_RADIUS_NARROW', message: '模型有效半径 < 0.35，大部分画面会被判为无效', field: 'distortion.validMaxNormalizedRadius' });
  }
  const mode = cal.projection?.mode;
  if (mode !== 'preserve-field' && mode !== 'crop') {
    add('PROJECTION_MODE', 'projection.mode 必须为 "preserve-field" 或 "crop"', 'projection.mode');
  }
  if (mode === 'preserve-field' && cal.projection?.fillColor) {
    const fc = cal.projection.fillColor;
    if (!Array.isArray(fc) || fc.length !== 4 || fc.some((v) => !Number.isFinite(Number(v)) || v < 0 || v > 255)) {
      add('FILL_COLOR', 'projection.fillColor 必须是 [r,g,b,a] 0..255', 'projection.fillColor');
    }
  }

  // Numerical sanity: must be invertible over the valid disk.
  let k1 = dist.k1;
  let k2 = dist.k2;
  let k3 = dist.k3;
  if (Number.isFinite(k1) || Number.isFinite(k2) || Number.isFinite(k3)) {
    const vmaxSolve = Number.isFinite(vmax) && vmax > 0 ? vmax : 1;
    const order = [2, 4, 6].includes(cfg.radialOrder) ? cfg.radialOrder : 6;
    const k2eff = order >= 4 ? k2 : 0;
    const k3eff = order >= 6 ? k3 : 0;
    let monotonic = true;
    for (let step = 0; step <= 100; step++) {
      const r = (vmaxSolve * step) / 100;
      const r2 = r * r;
      const dR = 1 + 3 * k1 * r2 + 5 * k2eff * r2 * r2 + 7 * k3eff * r2 * r2 * r2;
      if (dR <= 0) { monotonic = false; break; }
    }
    if (!monotonic) errors.push({
      code: 'NON_MONOTONIC',
      message: '径向多项式在有效半径内非单调（1 + 3k1r² + 5k2r⁴ + 7k3r⁶ ≤ 0），正向映射不可逆，请缩小 validMaxNormalizedRadius 或修改系数',
      field: 'distortion',
    });
  }
  if (Number.isFinite(k1) && Number.isFinite(vmax) && vmax > 0) {
    const rr = vmax * vmax;
    const order = [2, 4, 6].includes(cfg.radialOrder) ? cfg.radialOrder : 6;
    const scale = 1 + k1 * rr
      + (order >= 4 ? k2 * rr * rr : 0)
      + (order >= 6 ? k3 * rr ** 3 : 0);
    const rmax = rr > 0 ? scale : 1;
    if (rmax <= 0) errors.push({
      code: 'NON_POSITIVE_SCALE', message: '在有效半径边缘径向缩放 ≤ 0，模型没有可用图像域', field: 'distortion',
    });
    else if (Math.abs(rmax) > 6) errors.push({
      code: 'EXTREME_SCALE', message: `有效半径边缘径向缩放过大（${rmax.toFixed(2)}），正向映射会塌缩或爆炸`, field: 'distortion',
    });
  }
  if (Number.isFinite(dist.p1) && Number.isFinite(dist.p2) && Number.isFinite(vmax) && vmax > 0 && cfg.tangential !== false) {
    const maxTangential = 2 * Math.max(Math.abs(dist.p1), Math.abs(dist.p2)) * vmax * vmax;
    if (maxTangential > 0.08) {
      warnings.push({ code: 'LARGE_TANGENTIAL', message: `切向项在有效半径处可达 ${maxTangential.toFixed(3)}（归一化），可能不可逆`, field: 'distortion' });
    }
  }
  if (Number.isFinite(nums.cx) && Number.isFinite(nums.cy) && refW && refH) {
    if (nums.cx < 0 || nums.cx >= refW || nums.cy < 0 || nums.cy >= refH) {
      errors.push({ code: 'CENTER_OUTSIDE', message: `主点 (${nums.cx.toFixed(1)}, ${nums.cy.toFixed(1)}) 超出参考图像 ${refW}×${refH}`, field: 'intrinsics' });
    }
  }

  if (errors.length) {
    const err = new ParameterError('INVALID_CALIBRATION', errors[0].message, { errors, warnings });
    err.errors = errors;
    err.warnings = warnings;
    throw err;
  }
  return { calibration: cal, warnings };
}

/**
 * Largest normalized radius at which the radial map is still monotone
 * (dR/dr > 0), searched on a fine grid up to `ceiling`. Returns `ceiling` when
 * the polynomial stays invertible there. Used to keep an honest valid range
 * when a chosen model order cannot cover the requested radius.
 */
export function monotonicRadiusLimit(distortion, ceiling = 1.6) {
  const d = distortion || {};
  const cfg = d.modelConfig || { radialOrder: 6, tangential: true };
  const order = [2, 4, 6].includes(cfg.radialOrder) ? cfg.radialOrder : 6;
  const k1 = Number(d.k1) || 0;
  const k2 = order >= 4 ? Number(d.k2) || 0 : 0;
  const k3 = order >= 6 ? Number(d.k3) || 0 : 0;
  const steps = 2000;
  for (let s = 0; s <= steps; s++) {
    const r = (ceiling * s) / steps;
    const r2 = r * r;
    const dR = 1 + 3 * k1 * r2 + 5 * k2 * r2 * r2 + 7 * k3 * r2 * r2 * r2;
    if (dR <= 0) return r;
  }
  return ceiling;
}

/**
 * Clamp a fitted calibration's valid radius to the invertible range of its
 * actual coefficients. This is a *measured* range, reported to the caller;
 * it is never silently applied.
 */
export function clampValidRadius(cal, ceiling = 1.6) {
  const limit = monotonicRadiusLimit(cal.distortion, ceiling);
  // The scan returns the first radius where dR <= 0; keep a small margin so the
  // validation scan (which samples the upper bound inclusively) stays valid.
  const safeLimit = limit >= ceiling ? limit : Math.max(1e-3, limit * 0.995);
  const current = Number(cal.distortion.validMaxNormalizedRadius);
  const target = Number.isFinite(current) ? Math.min(current, safeLimit) : safeLimit;
  const changed = Number.isFinite(current) && target < current - 1e-6;
  if (changed) cal.distortion.validMaxNormalizedRadius = Math.max(1e-3, target);
  return {
    changed,
    previous: current,
    applied: cal.distortion.validMaxNormalizedRadius,
    monotonicLimit: limit,
    message: changed
      ? `所选模型在当前系数下仅在 r ≤ ${limit.toFixed(3)} 内保持单调可逆；有效半径已由 ${current.toFixed(3)} 收缩到 ${cal.distortion.validMaxNormalizedRadius.toFixed(3)}，画面外围将按无效区域处理`
      : null,
  };
}

/** Validate expected image dimensions against a calibration. Returns adaptation notice. */export function describeResolutionRelation(cal, width, height) {
  const i = cal.intrinsics;
  const native = isNativeResolution(cal, width, height);
  const a = getIntrinsicsAtSize(cal, width, height);
  return {
    native,
    reference: { width: i.referenceWidth, height: i.referenceHeight },
    input: { width, height },
    scale: { x: a.sx, y: a.sy },
    message: native
      ? '输入分辨率与标定参考分辨率一致'
      : `输入 ${width}×${height} 与标定参考 ${i.referenceWidth}×${i.referenceHeight} 不同；已按 sx=${a.sx.toFixed(4)}, sy=${a.sy.toFixed(4)} 调整 fx/fy/cx/cy（畸变系数为无量纲，保持不变）`,
  };
}

export function formatCalibration(cal) {
  const i = cal.intrinsics;
  const d = cal.distortion;
  return {
    model: cal.model,
    reference: `${i.referenceWidth}×${i.referenceHeight}`,
    intrinsics: {
      referenceWidth: i.referenceWidth,
      referenceHeight: i.referenceHeight,
      fx: round(i.fx), fy: round(i.fy), cx: round(i.cx), cy: round(i.cy),
    },
    distortion: {
      k1: d.k1, k2: d.k2, k3: d.k3, p1: d.p1, p2: d.p2,
      validMaxNormalizedRadius: d.validMaxNormalizedRadius,
      modelConfig: d.modelConfig || { radialOrder: 6, tangential: true },
    },
    projection: cal.projection,
  };
}

function round(v) {
  return Math.round(v * 1e6) / 1e6;
}
