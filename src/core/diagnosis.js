/**
 * Edge-anomaly diagnosis for the rectification pipeline.
 *
 * Given the actual plan + render (+ optional coordinate-residual measurement)
 * this module builds a stage-located execution evidence chain:
 *
 *   validate -> model -> plan -> reverse-map -> render -> measure
 *
 *  - Edge black blocks / local stretching are tracked with coordinates and
 *    validity: destination pixel, undistorted plane coordinate, mapped source
 *    pixel, normalized radius vs the model's valid radius, radial scale and
 *    local stretch from the forward Jacobian.
 *  - A known radial transform (closed-form forward curve plus a budgeted
 *    inverse round-trip) separates three root causes: parameter scale/units
 *    mismatch, inversion non-convergence, and insufficient input coverage.
 *  - Diagnostics never paint over failed pixels: render buffers are read,
 *    never written. Callers can verify the raster is byte-identical after.
 *  - Log cost is bounded: anomalies, regions and per-region samples are
 *    capped; dropped entries are counted in `logBudget`, never silently lost.
 */

import { getIntrinsicsAtSize, validateCalibration } from './calibration.js';
import {
  buildReverseMap,
  distortNormalized,
  inverseNormalized,
  radialDerivative,
  radialScale,
  undistortedToDistorted,
} from './model.js';

export const DIAGNOSIS_LIMITS = Object.freeze({
  maxAnomalies: 48,
  maxRegions: 8,
  samplesPerRegion: 3,
  reverseMapGrid: 160,
  radialProbeCount: 24,
  roundTripRadii: 12,
  roundTripAngles: 8,
  measurePoints: 8,
});

export const CAUSE = Object.freeze({
  PARAM_SCALE: 'parameter-scale',
  NON_CONVERGENCE: 'inversion-non-convergence',
  COVERAGE: 'insufficient-coverage',
  EXTREME_DISTORTION: 'extreme-distortion-domain',
  NON_FINITE: 'non-finite-coordinates',
  RESIDUAL: 'coordinate-residual-excess',
});

export const STAGES = Object.freeze(['validate', 'model', 'plan', 'reverse-map', 'render', 'measure']);

const PIXEL_CAUSE = Object.freeze({
  NON_FINITE: 'non-finite',
  EXTREME: 'extreme-distortion',
  EDGE: 'edge-out-of-frame',
  UNCLASSIFIED: 'unclassified',
});

function round(v, p = 6) {
  if (!Number.isFinite(v)) return v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : null;
  const f = 10 ** p;
  return Math.round(v * f) / f;
}

/**
 * Known radial transform probe. The forward curve is closed form, so its
 * values are exact expectations; the inverse round-trip is measured with the
 * caller's budget. Deviations classify parameter-scale vs solver issues.
 */
function probeRadialTransform(calibration, intr, vmax, inverseOpts, limits) {
  const corners = [
    [0, 0], [intr.width - 1, 0], [0, intr.height - 1], [intr.width - 1, intr.height - 1],
  ];
  let cornerRadius = 0;
  for (const [u, v] of corners) {
    cornerRadius = Math.max(cornerRadius, Math.hypot((u - intr.cx) / intr.fx, (v - intr.cy) / intr.fy));
  }
  const probeMax = Math.max(vmax, cornerRadius);
  const curve = [];
  let scaleMin = Infinity;
  let scaleMax = -Infinity;
  let monotonicInFrame = true;
  for (let k = 0; k < limits.radialProbeCount; k++) {
    const r = (probeMax * k) / (limits.radialProbeCount - 1);
    const r2 = r * r;
    const scale = radialScale(r2, calibration.distortion);
    const deriv = radialDerivative(r2, calibration.distortion);
    curve.push({ r: round(r), radialScale: round(scale), radialDerivative: round(deriv) });
    if (r <= cornerRadius + 1e-12) {
      if (scale < scaleMin) scaleMin = scale;
      if (scale > scaleMax) scaleMax = scale;
      if (!(deriv > 0)) monotonicInFrame = false;
    }
  }

  // Fraction of the source frame that lies inside the model's valid radius.
  let inside = 0;
  let total = 0;
  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      const u = ((intr.width - 1) * gx) / 8;
      const v = ((intr.height - 1) * gy) / 8;
      const r = Math.hypot((u - intr.cx) / intr.fx, (v - intr.cy) / intr.fy);
      if (r <= vmax) inside++;
      total++;
    }
  }

  // Round-trip against the known forward transform.
  const rt = { samples: 0, maxError: 0, nonConverged: 0, statuses: {} };
  const rtMax = Math.min(probeMax, vmax * 1.2 || probeMax);
  for (let i = 0; i < limits.roundTripRadii; i++) {
    const r = (rtMax * (i + 0.5)) / limits.roundTripRadii;
    for (let j = 0; j < limits.roundTripAngles; j++) {
      const th = (2 * Math.PI * j) / limits.roundTripAngles;
      const x = r * Math.cos(th);
      const y = r * Math.sin(th);
      const f = distortNormalized(x, y, calibration.distortion);
      const inv = inverseNormalized(f.xd, f.yd, calibration.distortion, inverseOpts);
      const err = Math.hypot(inv.x - x, inv.y - y);
      rt.samples++;
      if (err > rt.maxError) rt.maxError = err;
      if (inv.status !== 'converged') rt.nonConverged++;
      rt.statuses[inv.status] = (rt.statuses[inv.status] || 0) + 1;
    }
  }

  return {
    cornerRadius: round(cornerRadius),
    validMaxRadius: vmax,
    probeMaxRadius: round(probeMax),
    curve,
    scaleRangeInFrame: { min: round(scaleMin), max: round(scaleMax) },
    monotonicInFrame,
    frameInsideModelFraction: round(total ? inside / total : 0, 4),
    roundTrip: {
      samples: rt.samples,
      maxError: round(rt.maxError, 9),
      nonConverged: rt.nonConverged,
      statuses: rt.statuses,
    },
  };
}

/** 4-connected labelling of the invalid mask. O(N), transient buffers only. */
function labelInvalidRegions(invalidMask, width, height) {
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const regions = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!invalidMask[start] || labels[start]) continue;
      const id = regions.length + 1;
      let top = 0;
      stack[top++] = start;
      labels[start] = id;
      let count = 0;
      let minX = x; let maxX = x; let minY = y; let maxY = y;
      let sumX = 0; let sumY = 0;
      while (top > 0) {
        const idx = stack[--top];
        const px = idx % width;
        const py = (idx / width) | 0;
        count++;
        sumX += px;
        sumY += py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (px > 0 && invalidMask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = id; stack[top++] = idx - 1; }
        if (px < width - 1 && invalidMask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = id; stack[top++] = idx + 1; }
        if (py > 0 && invalidMask[idx - width] && !labels[idx - width]) { labels[idx - width] = id; stack[top++] = idx - width; }
        if (py < height - 1 && invalidMask[idx + width] && !labels[idx + width]) { labels[idx + width] = id; stack[top++] = idx + width; }
      }
      regions.push({
        id,
        pixelCount: count,
        bbox: { minX, minY, maxX, maxY },
        centroid: { x: sumX / count, y: sumY / count },
        first: { x, y },
      });
    }
  }
  return { regions, labels };
}

/**
 * Deterministic in-region samples: the centroid when it lies inside, plus
 * row scans at fixed bbox heights. Every returned point carries the region's
 * label, so samples can never drift into a neighbouring region.
 */
function regionSamples(labels, width, height, region, count) {
  const samples = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (labels[y * width + x] !== region.id) return;
    if (samples.some((s) => s.x === x && s.y === y)) return;
    samples.push({ x, y });
  };
  push(Math.round(region.centroid.x), Math.round(region.centroid.y));
  const fracs = count === 1 ? [0.5] : count === 2 ? [0.33, 0.66] : [0.25, 0.5, 0.75];
  for (const f of fracs) {
    if (samples.length >= count) break;
    const y = Math.min(height - 1, Math.max(0, Math.round(region.bbox.minY + (region.bbox.maxY - region.bbox.minY) * f)));
    for (let x = region.bbox.minX; x <= region.bbox.maxX && samples.length < count; x++) {
      if (labels[y * width + x] === region.id) { push(x, y); break; }
    }
  }
  if (!samples.length) push(region.first.x, region.first.y);
  return samples.slice(0, count);
}

/** Classify one invalid output pixel and record its full coordinate chain. */
function classifyInvalidPixel(plan, distortion, vmax, dx, dy) {
  const u = plan.offsetX + dx * plan.stepX;
  const v = plan.offsetY + dy * plan.stepY;
  const intr = plan.intrinsics;
  const f = undistortedToDistorted(u, v, intr, distortion);
  const nx = (u - intr.cx) / intr.fx;
  const ny = (v - intr.cy) / intr.fy;
  const g = distortNormalized(nx, ny, distortion);
  const det = g.jxx * g.jyy - g.jxy * g.jyx;
  const localStretch = Number.isFinite(det) && Math.abs(det) > 1e-12 ? 1 / Math.abs(det) : Infinity;
  let cause = PIXEL_CAUSE.UNCLASSIFIED;
  if (!f.finite) cause = PIXEL_CAUSE.NON_FINITE;
  else if (f.radius > vmax) cause = PIXEL_CAUSE.EXTREME;
  else if (f.x < -0.5 || f.y < -0.5 || f.x > intr.width - 0.5 || f.y > intr.height - 0.5) cause = PIXEL_CAUSE.EDGE;
  return {
    destination: { x: dx, y: dy },
    plane: { u: round(u, 3), v: round(v, 3) },
    source: { x: round(f.x, 3), y: round(f.y, 3) },
    normalizedRadius: round(f.radius),
    validMaxRadius: vmax,
    radialScale: round(f.radialScale),
    localStretch: round(Math.min(localStretch, 1e6)),
    cause,
  };
}

/**
 * Build the stage-located diagnosis for one rectification run.
 *
 * @param {object} input
 * @param {object} input.calibration validated calibration at source resolution
 * @param {number} input.sourceWidth
 * @param {number} input.sourceHeight
 * @param {string} input.mode 'preserve-field' | 'crop'
 * @param {object} input.plan result of planOutput for the same calibration/size
 * @param {object} input.rect result of renderRectified (rgba/invalidMask/stats)
 * @param {object} [input.evaluation] optional { coordinateResidual, thresholds }
 * @param {object} [input.inverse] solver budget for the reverse-map stage
 * @param {object} [input.limits] overrides for DIAGNOSIS_LIMITS
 */
export function diagnoseRectification(input) {
  const limits = { ...DIAGNOSIS_LIMITS, ...(input.limits || {}) };
  const calibration = input.calibration;
  const distortion = calibration.distortion;
  const vmax = distortion.validMaxNormalizedRadius;
  const plan = input.plan;
  const rect = input.rect;
  const inverseOpts = input.inverse || {};
  if (!plan || !plan.intrinsics) throw new Error('诊断需要 planOutput 的输出计划');
  if (!rect || !rect.invalidMask || !rect.stats) throw new Error('诊断需要 renderRectified 的输出（含 invalidMask 与 stats）');

  const chain = [];
  const causes = [];
  const pushCause = (id, stage, severity, summary, evidence) => {
    causes.push({ id, stage, severity, summary, evidence });
  };

  /* ---- stage: validate ------------------------------------------------ */
  const validation = validateCalibration(calibration);
  chain.push({
    stage: 'validate',
    ok: true,
    measurements: {
      model: calibration.model,
      radialOrder: distortion.modelConfig?.radialOrder ?? 6,
      tangential: distortion.modelConfig?.tangential !== false,
      warnings: (validation.warnings || []).map((w) => ({ code: w.code, message: w.message })),
    },
  });

  /* ---- stage: model (known radial transform) -------------------------- */
  const intr = getIntrinsicsAtSize(calibration, input.sourceWidth, input.sourceHeight);
  const probe = probeRadialTransform(calibration, intr, vmax, inverseOpts, limits);
  const scaleRange = probe.scaleRangeInFrame;
  const scaleExtreme = (scaleRange.min != null && scaleRange.min <= 0) || (scaleRange.max != null && scaleRange.max > 6);
  const coverageFraction = probe.frameInsideModelFraction;
  let paramSeverity = null;
  if (coverageFraction < 0.2 || (scaleRange.min != null && scaleRange.min <= 0)) paramSeverity = 'fail';
  else if (coverageFraction < 0.5 || scaleExtreme || !probe.monotonicInFrame) paramSeverity = 'warn';
  if (paramSeverity) {
    pushCause(
      CAUSE.PARAM_SCALE,
      'model',
      paramSeverity,
      `参数单位/尺度异常：源画面仅 ${(coverageFraction * 100).toFixed(1)}% 落在模型有效半径内（角半径 ${probe.cornerRadius} vs 有效 ${vmax}），帧内径向缩放范围 [${scaleRange.min}, ${scaleRange.max}]；内参单位或畸变系数量纲很可能不一致`,
      {
        cornerRadius: probe.cornerRadius,
        validMaxRadius: vmax,
        frameInsideModelFraction: coverageFraction,
        scaleRangeInFrame: scaleRange,
        monotonicInFrame: probe.monotonicInFrame,
      },
    );
  }
  chain.push({
    stage: 'model',
    ok: paramSeverity !== 'fail',
    measurements: {
      cornerRadius: probe.cornerRadius,
      validMaxRadius: probe.validMaxRadius,
      frameInsideModelFraction: coverageFraction,
      scaleRangeInFrame: scaleRange,
      monotonicInFrame: probe.monotonicInFrame,
      roundTrip: probe.roundTrip,
      radialCurve: probe.curve,
    },
  });

  /* ---- stage: plan ---------------------------------------------------- */
  const field = plan.field || null;
  chain.push({
    stage: 'plan',
    ok: true,
    measurements: {
      mode: plan.mode,
      output: { width: plan.width, height: plan.height },
      step: { x: round(plan.stepX), y: round(plan.stepY) },
      offset: { x: round(plan.offsetX, 3), y: round(plan.offsetY, 3) },
      fieldSamples: field ? field.pointCount : null,
      fieldRejected: field ? field.rejected : null,
      fieldNonConverged: field ? field.nonConverged : null,
      cropScale: plan.crop ? round(plan.crop.scale, 4) : null,
      warnings: (plan.warnings || []).map((w) => ({ code: w.code, message: w.message })),
    },
  });
  if (field && field.nonConverged > 0) {
    pushCause(
      CAUSE.NON_CONVERGENCE,
      'plan',
      'info',
      `取景边界测量有 ${field.nonConverged} 个样本迭代未达容差（按预算停止），输出范围可能略有偏差`,
      { fieldNonConverged: field.nonConverged, fieldSamples: field.pointCount },
    );
  }

  /* ---- stage: reverse-map (solver health over the destination grid) --- */
  const gridW = Math.max(8, Math.min(limits.reverseMapGrid, plan.width));
  const gridH = Math.max(8, Math.min(limits.reverseMapGrid, plan.height));
  const rev = buildReverseMap(gridW, gridH, calibration, { inverse: inverseOpts });
  const rs = rev.stats;
  const nonConvergedCount = rs.iterationsExhausted + rs.stalled + rs.diverged;
  const nonConvergedFraction = rs.pixels ? nonConvergedCount / rs.pixels : 0;
  chain.push({
    stage: 'reverse-map',
    ok: rs.diverged === 0,
    measurements: {
      grid: { width: rev.width, height: rev.height },
      converged: rs.converged,
      iterationsExhausted: rs.iterationsExhausted,
      stalled: rs.stalled,
      diverged: rs.diverged,
      maxIterations: rs.maxIterations,
      maxResidual: round(rs.maxResidual, 9),
      meanResidual: round(rs.meanResidual, 9),
      outsideModel: rs.outsideModel,
      outOfFrame: rs.outOfFrame,
      validFraction: round(rs.validFraction, 4),
      inverseBudget: {
        maxIterations: inverseOpts.maxIterations ?? null,
        tolerance: inverseOpts.tolerance ?? null,
        maxStepNormalized: inverseOpts.maxStepNormalized ?? null,
      },
    },
  });
  if (rs.diverged > 0 || nonConvergedFraction > 0.005 || probe.roundTrip.nonConverged > 0) {
    const severity = rs.diverged > 0 ? 'fail' : 'warn';
    pushCause(
      CAUSE.NON_CONVERGENCE,
      'reverse-map',
      severity,
      `迭代不收敛：反向映射抽样 ${rs.pixels} 点中 ${nonConvergedCount} 点未收敛（耗尽 ${rs.iterationsExhausted}、停滞 ${rs.stalled}、发散 ${rs.diverged}），最大残差 ${round(rs.maxResidual, 9)}；已知径向变换回环未收敛 ${probe.roundTrip.nonConverged}/${probe.roundTrip.samples}`,
      {
        sampled: rs.pixels,
        iterationsExhausted: rs.iterationsExhausted,
        stalled: rs.stalled,
        diverged: rs.diverged,
        maxResidual: round(rs.maxResidual, 9),
        maxIterations: rs.maxIterations,
        roundTripNonConverged: probe.roundTrip.nonConverged,
        roundTripMaxError: probe.roundTrip.maxError,
      },
    );
  }

  /* ---- stage: render (failure regions + edge anomaly tracking) -------- */
  const stats = rect.stats;
  const { regions, labels } = labelInvalidRegions(rect.invalidMask, rect.width, rect.height);
  regions.sort((a, b) => b.pixelCount - a.pixelCount);
  const keptRegions = regions.slice(0, limits.maxRegions);
  const anomalies = [];
  const regionViews = [];
  for (const region of keptRegions) {
    const samples = regionSamples(labels, rect.width, rect.height, region, limits.samplesPerRegion);
    const regionAnomalies = [];
    for (const s of samples) {
      if (anomalies.length >= limits.maxAnomalies) break;
      const record = classifyInvalidPixel(plan, distortion, vmax, s.x, s.y);
      record.stage = 'render';
      record.regionId = region.id;
      anomalies.push(record);
      regionAnomalies.push(record);
    }
    const dominant = {};
    for (const a of regionAnomalies) dominant[a.cause] = (dominant[a.cause] || 0) + 1;
    regionViews.push({
      id: region.id,
      pixelCount: region.pixelCount,
      bbox: region.bbox,
      centroid: { x: round(region.centroid.x, 2), y: round(region.centroid.y, 2) },
      dominantCause: Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      samples: regionAnomalies,
    });
  }
  const byCause = {};
  for (const a of anomalies) byCause[a.cause] = (byCause[a.cause] || 0) + 1;
  const anomaliesDropped = Math.max(0, stats.invalid - anomalies.length);
  const regionsDropped = Math.max(0, regions.length - keptRegions.length);

  chain.push({
    stage: 'render',
    ok: stats.nonFinite === 0,
    measurements: {
      output: { width: rect.width, height: rect.height },
      valid: stats.valid,
      invalid: stats.invalid,
      validFraction: round(stats.validFraction, 4),
      outOfFrame: stats.outOfFrame,
      outsideModel: stats.outsideModel,
      nonFinite: stats.nonFinite,
      maxRadius: round(stats.maxRadius),
      validMaxRadius: vmax,
      regionCount: regions.length,
      regions: regionViews,
      anomalies,
      anomalyTotals: { recorded: anomalies.length, dropped: anomaliesDropped, byCause },
    },
  });

  if (stats.nonFinite > 0) {
    pushCause(
      CAUSE.NON_FINITE,
      'render',
      'fail',
      `出现 ${stats.nonFinite} 个非有限映射坐标，模型或内参已产生非法数值`,
      { nonFinite: stats.nonFinite },
    );
  }
  if (stats.outsideModel > 0) {
    const fraction = stats.pixels ? stats.outsideModel / stats.pixels : 0;
    pushCause(
      CAUSE.EXTREME_DISTORTION,
      'render',
      fraction > 0.005 ? 'warn' : 'info',
      `大畸变超出模型有效域：${stats.outsideModel} 个输出像素（${(fraction * 100).toFixed(2)}%）归一化半径超过 r_max=${vmax}（实测最大半径 ${round(stats.maxRadius)}）`,
      {
        outsideModel: stats.outsideModel,
        fraction: round(fraction, 6),
        maxRadius: round(stats.maxRadius),
        validMaxRadius: vmax,
        examples: anomalies.filter((a) => a.cause === PIXEL_CAUSE.EXTREME).slice(0, 3),
      },
    );
  }
  if (stats.outOfFrame > 0) {
    const fraction = stats.pixels ? stats.outOfFrame / stats.pixels : 0;
    pushCause(
      CAUSE.COVERAGE,
      'render',
      fraction > 0.25 ? 'warn' : 'info',
      `输入覆盖不足：${stats.outOfFrame} 个输出像素（${(fraction * 100).toFixed(2)}%）的取样点落在源画面之外（边缘越界），校正图边缘黑块由此产生，只能用填充色标示，不能涂补`,
      {
        outOfFrame: stats.outOfFrame,
        fraction: round(fraction, 6),
        outputPixels: stats.pixels,
        examples: anomalies.filter((a) => a.cause === PIXEL_CAUSE.EDGE).slice(0, 3),
      },
    );
  }

  /* ---- stage: measure (coordinate residuals, if provided) ------------- */
  const residual = input.evaluation?.coordinateResidual || null;
  const thresholds = input.evaluation?.thresholds || null;
  const topPoints = residual?.points
    ? residual.points.slice().sort((a, b) => b.errorPx - a.errorPx).slice(0, limits.measurePoints)
    : [];
  chain.push({
    stage: 'measure',
    ok: true,
    measurements: residual
      ? {
        rmsPx: round(residual.rmsPx, 4),
        maxPx: round(residual.maxPx, 4),
        count: residual.count,
        excludedClipped: residual.excludedClipped ?? null,
        thresholds: thresholds
          ? { markerRmsPx: thresholds.markerRmsPx ?? null, markerMaxPx: thresholds.markerMaxPx ?? null }
          : null,
        topPoints: topPoints.map((p) => ({
          ideal: p.ideal ? { x: round(p.ideal.x, 2), y: round(p.ideal.y, 2) } : null,
          errorPx: round(p.errorPx, 4),
        })),
        units: input.evaluation?.units || 'source-pixel',
      }
      : { note: '未提供坐标残差测量，本阶段仅记录为跳过', skipped: true },
  });
  if (residual && thresholds && residual.rmsPx != null && residual.maxPx != null) {
    const rmsLimit = thresholds.markerRmsPx;
    const maxLimit = thresholds.markerMaxPx;
    if ((rmsLimit != null && residual.rmsPx > rmsLimit) || (maxLimit != null && residual.maxPx > maxLimit)) {
      pushCause(
        CAUSE.RESIDUAL,
        'measure',
        'warn',
        `坐标残差超阈：RMS ${round(residual.rmsPx, 4)} px（阈 ${rmsLimit}）、最大 ${round(residual.maxPx, 4)} px（阈 ${maxLimit}），最差点见 measure 阶段 topPoints`,
        {
          rmsPx: round(residual.rmsPx, 4),
          maxPx: round(residual.maxPx, 4),
          thresholds: { markerRmsPx: rmsLimit, markerMaxPx: maxLimit },
          topPoints: topPoints.slice(0, 3).map((p) => ({
            ideal: p.ideal ? { x: round(p.ideal.x, 2), y: round(p.ideal.y, 2) } : null,
            errorPx: round(p.errorPx, 4),
          })),
        },
      );
    }
  }

  /* ---- verdict + bounded log budget ----------------------------------- */
  const worst = causes.reduce((acc, c) => {
    if (c.severity === 'fail') return 'fail';
    if (c.severity === 'warn' && acc !== 'fail') return 'warn';
    return acc;
  }, 'info');
  const verdict = worst === 'fail' ? 'broken' : worst === 'warn' ? 'attention' : 'ok';
  const logBudget = {
    maxAnomalies: limits.maxAnomalies,
    maxRegions: limits.maxRegions,
    samplesPerRegion: limits.samplesPerRegion,
    anomaliesRecorded: anomalies.length,
    anomaliesDropped,
    regionsRecorded: keptRegions.length,
    regionsDropped,
    truncated: anomaliesDropped > 0 || regionsDropped > 0,
  };
  const severityCount = { fail: 0, warn: 0, info: 0 };
  for (const c of causes) severityCount[c.severity]++;
  const summary = `诊断 ${verdict}：${causes.length} 个原因（fail ${severityCount.fail} / warn ${severityCount.warn} / info ${severityCount.info}）；`
    + `失败区域 ${regions.length} 个（记录 ${keptRegions.length}），无效像素 ${stats.invalid}（异常记录 ${anomalies.length} 条，预算外丢弃 ${anomaliesDropped}）`;

  return {
    verdict,
    summary,
    causes,
    evidenceChain: chain,
    logBudget,
  };
}
