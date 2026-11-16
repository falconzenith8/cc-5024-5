/**
 * Wide-angle rectification UI.
 *
 * Every number and image shown here comes from the same modules the CLI uses:
 * explicit Brown-Conrady model, budgeted inverse solver, measured output
 * framing, reverse-mapped resampling, and marker/line measurements on the
 * actual rasters. No decorative sharpening or pre-baked result images.
 */

import {
  MODEL, createDefaultCalibration, adaptCalibrationToSize, describeResolutionRelation,
  validateCalibration, formatCalibration, getIntrinsicsAtSize, clampValidRadius,
} from '../core/calibration.js';
import {
  forwardNormalized, distortedToUndistorted, undistortedToDistorted, inverseNormalized, buildReverseMap,
} from '../core/model.js';
import { planOutput } from '../core/projection.js';
import { renderRectified, overlayInvalidMask, SAMPLING } from '../core/render.js';
import {
  makeDefaultScene, generateDistortedImage, makeApproximateCalibration,
} from '../core/synthetic.js';
import {
  detectMarkers, matchPoints, fitCalibration, measureLineBending, sampleRgba,
} from '../core/analysis.js';
import { diagnoseRectification } from '../core/diagnosis.js';
import { encodePng } from '../core/png.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = {
  mode: 'preserve-field',
  view: 'distorted',
  source: null, // { rgba, width, height, name }
  sourceMeta: null,
  preview: null, // { rgba, width, height, scaleX, scaleY }
  calibration: null,
  points: [],
  initialPoints: [],
  grid: null, // { vertical, horizontal, markers, bounds }
  selected: -1,
  addMode: false,
  pointRadius: 6,
  showGrid: true,
  sampling: 'bilinear',
  solver: { maxIterations: 24, tolerance: 1e-7, maxStepNormalized: 0.6 },
  fit: null,
  radiusNotice: null,
  requestedValidRadius: null,
  planPreview: null,
  rectPreview: null,
  overlayPreview: null,
  errors: null,
  bend: null,
  diagnosis: null,
  probe: null,
  probeMode: null,
  verdict: 'idle',
  jobSeq: 0,
  busy: false,
  lastError: null,
  warnings: [],
  detection: null,
};

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function setError(messages, warnings = []) {
  const bar = $('errorBar');
  const seen = new Set();
  const all = [];
  for (const m of messages || []) {
    const text = String(m || '').trim();
    if (!text || seen.has(`e:${text}`)) continue;
    seen.add(`e:${text}`);
    all.push({ text, warn: false });
  }
  for (const w of warnings || []) {
    const text = String(w.message || w || '').trim();
    if (!text || seen.has(`w:${text}`)) continue;
    seen.add(`w:${text}`);
    all.push({ text, warn: true });
  }
  state.warnings = warnings || [];
  if (!all.length) {
    bar.hidden = true;
    bar.textContent = '';
    bar.classList.remove('warn');
    return;
  }
  bar.hidden = false;
  bar.classList.toggle('warn', all.every((a) => a.warn));
  bar.innerHTML = all.map((a) => `<div>${a.warn ? '提示' : '错误'}：${escapeHtml(a.text)}</div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(v, digits = 3) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(digits);
}

function kvRow(k, v, cls = '') {
  return `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(v)}</span></div>`;
}

function setProgress(on, text = '计算中…') {
  const el = $('progress');
  el.hidden = !on;
  el.querySelector('span').textContent = text;
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ */
/* Loading: built-in sample, user image, calibration JSON, points JSON */
/* ------------------------------------------------------------------ */

async function loadSample() {
  setProgress(true, '生成合成的真实畸变图…');
  setError([]);
  try {
    await yieldToUi();
    const W = 800;
    const H = 600;
    const scene = makeDefaultScene(W, H);
    const t0 = performance.now();
    const gen = generateDistortedImage(scene.calibration, scene.grid);
    if (gen.stats.invalid / gen.stats.pixels > 0.25) {
      throw new Error('合成图生成异常：无效像素过多，请检查场景设置');
    }
    const detected = detectMarkers(gen.rgba, gen.width, gen.height);
    const visible = scene.visibleMarkers;
    const pairs = matchPoints(detected, visible.map((p) => p.observed), 14);
    const usedD = new Set();
    const usedT = new Set();
    const points = [];
    for (const pr of pairs) {
      if (usedD.has(pr.detected) || usedT.has(pr.expected)) continue;
      usedD.add(pr.detected);
      usedT.add(pr.expected);
      const truth = visible[pr.expected];
      points.push({
        id: truth.id,
        ideal: { x: truth.ideal.x, y: truth.ideal.y },
        observed: { x: detected[pr.detected].x, y: detected[pr.detected].y },
        truthObserved: { ...truth.observed },
      });
    }
    if (points.length < 12) throw new Error(`内置图只检测到 ${points.length} 个标记，无法演示标定`);
    state.source = { rgba: gen.rgba, width: gen.width, height: gen.height, name: '内置合成广角标定图' };
    state.sourceMeta = {
      kind: 'synthetic',
      scene,
      generation: gen.stats,
      detectedCount: detected.length,
      elapsedMs: performance.now() - t0,
    };
    state.calibration = makeApproximateCalibration(scene);
    state.calibration.projection = { ...scene.calibration.projection, mode: state.mode };
    state.requestedValidRadius = state.calibration.distortion.validMaxNormalizedRadius;
    state.radiusNotice = null;
    state.points = points.map((p) => ({ ...p, ideal: { ...p.ideal }, observed: { ...p.observed } }));
    state.initialPoints = clonePoints(state.points);
    state.grid = {
      vertical: scene.grid.vertical,
      horizontal: scene.grid.horizontal,
      markers: scene.grid.markers,
      bounds: scene.chart,
      thresholds: scene.thresholds,
      truthCalibration: scene.calibration,
    };
    state.fit = null;
    state.errors = null;
    state.bend = null;
    state.diagnosis = null;
    state.planPreview = null;
    state.selected = -1;
    $('imageMeta').textContent = `${gen.width}×${gen.height} · 合成图`;
    $('distortedDims').textContent = `${gen.width}×${gen.height}`;
    $('renderNote').textContent = `内置图：${detected.length} 个标记，${points.length} 个已匹配，生成耗时 ${(state.sourceMeta.elapsedMs / 1000).toFixed(2)} s；参考分辨率 ${gen.width}×${gen.height}`;
    syncCalibrationInputs();
    syncPreview();
    await recompute({ fit: true, reason: 'sample-load' });
  } catch (err) {
    setError([err.message]);
  } finally {
    setProgress(false);
  }
}

async function loadImageFile(file) {
  setProgress(true, '载入图片…');
  try {
    const { rgba, width, height } = await decodeImage(file);
    state.source = { rgba, width, height, name: file.name };
    state.sourceMeta = { kind: 'file', name: file.name };
    state.grid = null;
    state.points = [];
    state.initialPoints = [];
    state.fit = null;
    state.selected = -1;
    if (!state.calibration) {
      state.calibration = createDefaultCalibration(width, height);
      state.calibration.projection = { ...state.calibration.projection, mode: state.mode };
    } else {
      const cal = state.calibration;
      if (cal.intrinsics.referenceWidth !== width || cal.intrinsics.referenceHeight !== height) {
        state.calibration = adaptCalibrationToSize(cal, width, height);
      }
    }
    state.requestedValidRadius = state.calibration.distortion.validMaxNormalizedRadius;
    state.radiusNotice = null;
    $('imageMeta').textContent = `${width}×${height} · ${file.name}`;
    $('distortedDims').textContent = `${width}×${height}`;
    syncCalibrationInputs();
    syncPreview();
    await recompute({ fit: false, reason: 'image-load' });
  } catch (err) {
    setError([`图片载入失败：${err.message}`]);
  } finally {
    setProgress(false);
  }
}

async function decodeImage(file) {
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    throw new Error('请选择 PNG/JPEG/WebP 图片');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('浏览器无法解码该图片（可能含不支持的色彩配置）'));
      img.src = url;
    });
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('图片超过 4000 万像素，请先缩小');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { rgba: data.data, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadCalibrationFile(file) {
  setProgress(true, '载入参数…');
  try {
    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`JSON 解析失败：${e.message}`);
    }
    const cal = normalizeCalibrationJson(raw);
    validateCalibration(cal);
    if (state.source) {
      if (cal.intrinsics.referenceWidth !== state.source.width || cal.intrinsics.referenceHeight !== state.source.height) {
        const rel = describeResolutionRelation(cal, state.source.width, state.source.height);
        state.calibration = adaptCalibrationToSize(cal, state.source.width, state.source.height);
        setError([], [{ code: 'ADAPTED', message: rel.message }]);
      } else {
        state.calibration = cal;
      }
    } else {
      state.calibration = cal;
    }
    state.fit = null;
    state.requestedValidRadius = state.calibration.distortion.validMaxNormalizedRadius;
    state.radiusNotice = null;
    syncCalibrationInputs();
    await recompute({ fit: false, reason: 'calibration-load' });
    if (!state.warnings.length) {
      $('renderNote').textContent = `参数已载入：${cal.model}，参考 ${cal.intrinsics.referenceWidth}×${cal.intrinsics.referenceHeight}`;
    }
  } catch (err) {
    const details = err.errors || err.details?.errors;
    setError([err.message, ...(details ? details.map((d) => d.message) : [])]);
  } finally {
    setProgress(false);
  }
}

function normalizeCalibrationJson(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('参数文件根节点必须是对象');
  if (raw.intrinsics && raw.distortion) return raw;
  const flat = raw;
  const ref = raw.referenceResolution || {};
  const width = ref.width || raw.referenceWidth || raw.width;
  const height = ref.height || raw.referenceHeight || raw.height;
  if (!width || !height || !raw.distortion) throw new Error('参数文件缺少 intrinsics/distortion 或 referenceResolution');
  const d = raw.distortion;
  return {
    formatVersion: 1,
    model: raw.model || MODEL,
    source: { width, height, label: 'imported' },
    intrinsics: {
      referenceWidth: width,
      referenceHeight: height,
      fx: raw.intrinsics?.fx ?? raw.fx,
      fy: raw.intrinsics?.fy ?? raw.fy,
      cx: raw.intrinsics?.cx ?? raw.cx,
      cy: raw.intrinsics?.cy ?? raw.cy,
    },
    distortion: {
      k1: d.k1, k2: d.k2, k3: d.k3, p1: d.p1, p2: d.p2,
      validMaxNormalizedRadius: d.validMaxNormalizedRadius,
      modelConfig: d.modelConfig || { radialOrder: 6, tangential: true },
      edgeMode: d.edgeMode || 'fill',
    },
    projection: raw.projection || { mode: state.mode, fillColor: [16, 20, 28, 255] },
  };
}

async function loadPointsFile(file) {
  try {
    const raw = JSON.parse(await file.text());
    const list = Array.isArray(raw) ? raw : raw.points;
    if (!Array.isArray(list)) throw new Error('对应点文件需为数组或含 points 数组');
    if (!state.source) throw new Error('请先载入图片');
    const sx = state.calibration.intrinsics.referenceWidth / (raw.referenceWidth || state.calibration.intrinsics.referenceWidth);
    const sy = state.calibration.intrinsics.referenceHeight / (raw.referenceHeight || state.calibration.intrinsics.referenceHeight);
    const points = list.map((p, i) => ({
      id: p.id || `M${i + 1}`,
      ideal: { x: Number(p.ideal.x), y: Number(p.ideal.y) },
      observed: { x: Number(p.observed.x) * sx, y: Number(p.observed.y) * sy },
    })).filter((p) => Number.isFinite(p.ideal.x) && Number.isFinite(p.ideal.y) && Number.isFinite(p.observed.x) && Number.isFinite(p.observed.y));
    if (!points.length) throw new Error('没有有效的对应点');
    state.points = points;
    state.initialPoints = clonePoints(points);
    state.grid = null;
    state.selected = -1;
    await recompute({ fit: true, reason: 'points-load' });
    setError([], [{ code: 'POINTS', message: `已载入 ${points.length} 个对应点，按当前模型重新拟合` }]);
  } catch (err) {
    setError([`对应点载入失败：${err.message}`]);
  }
}

/* ------------------------------------------------------------------ */
/* Preview sizing                                                     */
/* ------------------------------------------------------------------ */

function syncPreview() {
  if (!state.source) return;
  const MAX_W = 1100;
  const MAX_H = 900;
  const sw = state.source.width;
  const sh = state.source.height;
  const s = Math.min(1, MAX_W / sw, MAX_H / sh);
  if (s >= 1) {
    state.preview = { rgba: state.source.rgba, width: sw, height: sh, scaleX: 1, scaleY: 1 };
    return;
  }
  const pw = Math.max(2, Math.round(sw * s));
  const ph = Math.max(2, Math.round(sh * s));
  const rgba = new Uint8ClampedArray(pw * ph * 4);
  const sxr = sw / pw;
  const syr = sh / ph;
  for (let y = 0; y < ph; y++) {
    const y0 = Math.min(sh - 1, Math.floor((y + 0.5) * syr));
    for (let x = 0; x < pw; x++) {
      const x0 = Math.min(sw - 1, Math.floor((x + 0.5) * sxr));
      const si = (y0 * sw + x0) * 4;
      const di = (y * pw + x) * 4;
      rgba[di] = state.source.rgba[si];
      rgba[di + 1] = state.source.rgba[si + 1];
      rgba[di + 2] = state.source.rgba[si + 2];
      rgba[di + 3] = state.source.rgba[si + 3];
    }
  }
  state.preview = { rgba, width: pw, height: ph, scaleX: pw / sw, scaleY: ph / sh };
}

function previewCalibration() {
  if (!state.preview) return null;
  const cal = state.calibration;
  if (state.preview.scaleX === 1 && state.preview.scaleY === 1) return cal;
  return adaptCalibrationToSize(cal, state.preview.width, state.preview.height);
}

/* ------------------------------------------------------------------ */
/* Fit and recompute pipeline                                         */
/* ------------------------------------------------------------------ */

function doFit() {
  if (!state.calibration) return false;
  const cal = state.calibration;
  const modelConfig = cal.distortion.modelConfig || { radialOrder: 6, tangential: true };
  const start = JSON.parse(JSON.stringify(cal));
  start.distortion.modelConfig = modelConfig;
  // Fit against the radius the user asked for, not one clamped by a previous
  // weaker model. Otherwise switching to 2nd order and back would leave the
  // restored 6th-order model permanently stuck at the 2nd-order radius.
  if (state.requestedValidRadius > 0) {
    start.distortion.validMaxNormalizedRadius = state.requestedValidRadius;
  } else {
    state.requestedValidRadius = start.distortion.validMaxNormalizedRadius;
  }
  const fitPoints = state.points
    .filter((p) => Number.isFinite(p.observed.x) && Number.isFinite(p.observed.y))
    .map((p) => ({ ideal: p.ideal, observed: p.observed }));
  if (fitPoints.length < 6) {
    state.fit = null;
    return false;
  }
  const result = fitCalibration(fitPoints, start, { freeFocal: false, maxIterations: 80 });
  state.calibration = result.calibration;
  state.calibration.projection.mode = state.mode;
  state.radiusNotice = clampValidRadius(state.calibration);
  state.fit = {
    rmsPx: result.rmsPx,
    maxPx: result.maxPx,
    iterations: result.iterations,
    status: result.status,
    info: result.calibration.fit,
  };
  return true;
}

async function recompute({ fit = false, reason = '' } = {}) {
  if (!state.source || !state.calibration) return;
  const id = ++state.jobSeq;
  state.busy = true;
  setProgress(true, fit ? '拟合并重新采样…' : '重新采样…');
  let cal = state.calibration;
  try {
    if (fit) {
      try {
        doFit();
        cal = state.calibration;
      } catch (e) {
        state.fit = null;
        setError([`拟合失败：${e.message}`], state.warnings);
        state.busy = false;
        setProgress(false);
        return;
      }
    } else {
      state.radiusNotice = null;
    }
    const check = validateCalibration(cal);
    if (id !== state.jobSeq) return;
    state.lastError = null;
    const outlierWarnings = (state.fit?.info?.outlierCount ?? 0) > 0
      ? [{
        code: 'FIT_OUTLIERS',
        message: `拟合剔除了 ${state.fit.info.outlierCount} 个与整体模型不符的标定点（详见右下拟合信息），请检查这些点是否被误拖动`,
      }]
      : [];
    const radiusWarnings = state.radiusNotice?.message
      ? [{ code: 'VALID_RADIUS_CLAMPED', message: state.radiusNotice.message }]
      : [];
    setError([], [...check.warnings, ...outlierWarnings, ...radiusWarnings]);
    await yieldToUi();
    if (id !== state.jobSeq) return;

    const pcal = previewCalibration();
    // Field tracing needs a generous but bounded budget of its own; the two
    // limit sets are kept separate so the user's interactive setting cannot
    // starve the one-time trace (or silently change its geometry).
    const plan = planOutput(pcal, state.preview.width, state.preview.height, state.mode, {
      padding: 0,
      boundarySamples: 360,
      cropBoundarySamples: 96,
      maxOutputPixels: 6_000_000,
      inverse: { maxIterations: 90, tolerance: 1e-9, maxStepNormalized: 0.6 },
    });
    if (id !== state.jobSeq) return;
    const planWarnings = plan.warnings || [];
    if (planWarnings.length || check.warnings.length) setError([], [...check.warnings, ...outlierWarnings, ...radiusWarnings, ...planWarnings]);
    await yieldToUi();
    if (id !== state.jobSeq) return;

    const hold = state.preview;
    const rect = renderRectified(hold.rgba, hold.width, hold.height, plan, pcal.distortion, {
      sampling: state.sampling,
      fillColor: cal.projection.fillColor || [16, 20, 28, 255],
    });
    if (id !== state.jobSeq) return;
    state.planPreview = plan;
    state.previewCalibration = pcal;
    state.rectPreview = rect;
    state.overlayPreview = overlayInvalidMask(rect.rgba, rect.invalidMask, rect.width, rect.height);
    await yieldToUi();
    if (id !== state.jobSeq) return;

    state.errors = measureUiErrors(rect, plan, pcal);
    await yieldToUi();
    if (id !== state.jobSeq) return;

    try {
      state.bend = measureUiBending(rect, plan, pcal);
    } catch (e) {
      state.bend = { error: e.message };
    }
    if (id !== state.jobSeq) return;

    try {
      state.diagnosis = diagnoseRectification({
        calibration: pcal,
        sourceWidth: hold.width,
        sourceHeight: hold.height,
        mode: state.mode,
        plan,
        rect,
        evaluation: {
          coordinateResidual: state.errors?.independent ? {
            rmsPx: state.errors.rmsPx,
            maxPx: state.errors.maxPx,
            count: state.errors.count,
            excludedClipped: state.errors.excludedClipped,
            points: state.errors.points,
          } : null,
          thresholds: state.grid?.thresholds || null,
          units: 'source-pixel',
        },
        inverse: state.solver,
        limits: { reverseMapGrid: 96 },
      });
    } catch (e) {
      state.diagnosis = { error: e.message };
    }
    if (id !== state.jobSeq) return;

    state.verdict = computeVerdict();
    renderUi();
    if (fit) syncCalibrationInputs();
    state.busy = false;
    setProgress(false);
  } catch (err) {
    if (id !== state.jobSeq) return;
    state.busy = false;
    setProgress(false);
    state.lastError = err;
    const details = err.errors || err.details?.errors;
    setError([err.message, ...(details ? details.map((d) => d.message) : [])], state.warnings);
    state.verdict = 'invalid';
    renderVerdictOnly();
  }
}

function sourceScaleFromPreview() {
  return state.preview.scaleX || 1;
}

/**
 * Independent coordinate error: detect the calibration markers in the actual
 * rectified raster, match them to the known ideal intersections, and compare
 * in source-plane pixels. Preview-plane coordinates are converted explicitly.
 */
function measureUiErrors(rect, plan, pcal) {
  const invScaleX = 1 / (state.preview.scaleX || 1);
  const invScaleY = 1 / (state.preview.scaleY || 1);
  const out = {
    fitRms: state.fit?.rmsPx ?? null,
    fitMax: state.fit?.maxPx ?? null,
    fitCount: state.fit?.info?.pointCount ?? 0,
    count: 0,
    rmsPx: null,
    maxPx: null,
    excludedClipped: 0,
    matched: 0,
    points: [],
    independent: false,
  };
  if (!state.grid || !state.grid.markers?.length) return out;

  const detections = detectMarkers(rect.rgba, rect.width, rect.height);
  const areas = detections.map((d) => d.area).sort((a, b) => a - b);
  const medianArea = areas.length ? areas[areas.length >> 1] : 0;
  const complete = detections.filter((d) => (
    d.bbox.minX > 0 && d.bbox.minY > 0 && d.bbox.maxX < rect.width - 1 && d.bbox.maxY < rect.height - 1
    && d.area >= medianArea * 0.55
  ));
  out.excludedClipped = detections.length - complete.length;
  const expected = state.grid.markers
    .map((m) => {
      const px = m.x * state.preview.scaleX;
      const py = m.y * state.preview.scaleY;
      return {
        ideal: m,
        px,
        py,
        x: (px - plan.offsetX) / plan.stepX,
        y: (py - plan.offsetY) / plan.stepY,
      };
    })
    .filter((m) => m.x > 10 && m.y > 10 && m.x < rect.width - 11 && m.y < rect.height - 11);
  const pairs = matchPoints(complete, expected, 14);
  const usedD = new Set();
  const usedE = new Set();
  for (const pr of pairs) {
    if (usedD.has(pr.detected) || usedE.has(pr.expected)) continue;
    usedD.add(pr.detected);
    usedE.add(pr.expected);
    const det = complete[pr.detected];
    const exp = expected[pr.expected];
    const destX = plan.offsetX + det.x * plan.stepX;
    const destY = plan.offsetY + det.y * plan.stepY;
    const dxSource = (destX - exp.px) * invScaleX;
    const dySource = (destY - exp.py) * invScaleY;
    out.points.push({
      ideal: exp.ideal,
      detected: { x: destX * invScaleX, y: destY * invScaleY },
      dx: dxSource,
      dy: dySource,
      errorPx: Math.hypot(dxSource, dySource),
    });
  }
  out.count = out.points.length;
  out.matched = pairs.length;
  if (out.count) {
    out.rmsPx = Math.sqrt(out.points.reduce((s, p) => s + p.errorPx * p.errorPx, 0) / out.count);
    out.maxPx = Math.max(...out.points.map((p) => p.errorPx));
    out.independent = true;
  }
  return out;
}

function measureUiBending(rect, plan, pcal) {
  const sx = 1 / (state.preview.scaleX || 1);
  const sy = 1 / (state.preview.scaleY || 1);
  const out = { rectified: null, distorted: null, lines: [], improvementRatio: null };
  if (!state.grid) return out;
  const grid = state.grid;
  const pv = state.preview;
  const planeLeft = plan.offsetX * sx;
  const planeRight = (plan.offsetX + plan.width * plan.stepX) * sx;
  const planeTop = plan.offsetY * sy;
  const planeBottom = (plan.offsetY + plan.height * plan.stepY) * sy;

  const vertical = grid.vertical.filter((X) => X > planeLeft + 6 && X < planeRight - 6);
  const horizontal = grid.horizontal.filter((Y) => Y > planeTop + 6 && Y < planeBottom - 6);
  if (!vertical.length && !horizontal.length) return out;

  const lineCount = 12;
  const pick = (arr) => (arr.length <= lineCount ? arr : Array.from({ length: lineCount }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (lineCount - 1))]));
  const rectGuides = [];
  const markerDest = grid.markers.map((m) => ({
    x: (m.x * pv.scaleX - plan.offsetX) / plan.stepX,
    y: (m.y * pv.scaleY - plan.offsetY) / plan.stepY,
  }));
  for (const X of pick(vertical)) {
    const x = (X * pv.scaleX - plan.offsetX) / plan.stepX;
    const pts = [];
    for (let k = 0; k < 90; k++) {
      const y = 8 + ((rect.height - 17) * k) / 89;
      pts.push({ x, y });
    }
    rectGuides.push(pts);
  }
  for (const Y of pick(horizontal)) {
    const y = (Y * pv.scaleY - plan.offsetY) / plan.stepY;
    const pts = [];
    for (let k = 0; k < 90; k++) {
      const x = 8 + ((rect.width - 17) * k) / 89;
      pts.push({ x, y });
    }
    rectGuides.push(pts);
  }
  const rectBend = measureLineBending(rect.rgba, rect.width, rect.height, rectGuides, {
    searchRadius: Math.max(3, Math.round(6 / Math.min(plan.stepX, plan.stepY))),
    markers: markerDest,
    markerClearance: 8,
  });
  out.rectified = {
    rmsSourcePx: rectBend.summary.rmsPx != null ? rectBend.summary.rmsPx * (sx + sy) / 2 : null,
    maxSourcePx: rectBend.summary.maxPx != null ? rectBend.summary.maxPx * (sx + sy) / 2 : null,
    lines: rectBend.lines.length,
  };

  // Distorted reference measured through the current fitted forward model.
  const intr = getIntrinsicsAtSize(state.calibration, state.source.width, state.source.height);
  const mapper = (p) => {
    const f = undistortedToDistorted(p.x, p.y, intr, state.calibration.distortion);
    return { x: f.x * pv.scaleX, y: f.y * pv.scaleY, valid: f.finite };
  };
  const distGuides = [];
  for (const X of pick(vertical)) {
    const pts = [];
    for (let k = 0; k < 80; k++) {
      const y = grid.bounds.minY + 10 + ((grid.bounds.height - 20) * k) / 79;
      const m = mapper({ x: X, y });
      if (!m.valid || m.x < 2 || m.y < 2 || m.x > pv.width - 3 || m.y > pv.height - 3) continue;
      pts.push({ x: m.x, y: m.y });
    }
    if (pts.length > 8) distGuides.push(pts);
  }
  for (const Y of pick(horizontal)) {
    const pts = [];
    for (let k = 0; k < 80; k++) {
      const x = grid.bounds.minX + 10 + ((grid.bounds.width - 20) * k) / 79;
      const m = mapper({ x, y: Y });
      if (!m.valid || m.x < 2 || m.y < 2 || m.x > pv.width - 3 || m.y > pv.height - 3) continue;
      pts.push({ x: m.x, y: m.y });
    }
    if (pts.length > 8) distGuides.push(pts);
  }
  if (distGuides.length) {
    const distBend = measureLineBending(pv.rgba, pv.width, pv.height, distGuides, {
      searchRadius: 8,
      markers: state.points.map((p) => ({ x: p.observed.x * state.preview.scaleX, y: p.observed.y * state.preview.scaleY })),
      markerClearance: 8,
    });
    out.distorted = {
      rmsSourcePx: distBend.summary.rmsPx != null ? distBend.summary.rmsPx * (sx + sy) / 2 : null,
      maxSourcePx: distBend.summary.maxPx != null ? distBend.summary.maxPx * (sx + sy) / 2 : null,
      lines: distBend.summary.lineCount,
    };
    if (out.distorted.rmsSourcePx && out.rectified.rmsSourcePx) {
      out.improvementRatio = out.distorted.rmsSourcePx / Math.max(out.rectified.rmsSourcePx, 1e-9);
    }
  }
  out.lines = rectBend.lines.filter((l) => !l.skipped).slice(0, 16).map((l) => ({
    rms: l.rmsPx * (sx + sy) / 2,
    max: l.maxPx * (sx + sy) / 2,
  }));
  return out;
}

function computeVerdict() {
  const e = state.errors;
  if (state.lastError) return 'invalid';
  if (!e) return 'idle';
  const outliers = state.fit?.info?.outlierCount ?? 0;
  const thresholds = state.grid?.thresholds || { markerRmsPx: 0.8, markerMaxPx: 2.2 };
  // Only call the rejection "dropped points" when the rest of the fit is sound.
  // A large fit residual means the chosen model order simply cannot describe
  // the data, which is a different problem and must not be blamed on a point.
  if (outliers > 0 && (state.fit?.rmsPx ?? 0) <= thresholds.markerRmsPx * 2.5) return 'outlier';
  if (e.independent) {
    if (e.rmsPx <= thresholds.markerRmsPx && e.maxPx <= thresholds.markerMaxPx) return 'pass';
    if (e.rmsPx <= thresholds.markerRmsPx * 2.5) return 'warn';
    return 'fail';
  }
  if (e.fitRms != null) {
    if (e.fitRms <= thresholds.markerRmsPx) return 'pass';
    if (e.fitRms <= thresholds.markerRmsPx * 2.5) return 'warn';
    return 'fail';
  }
  return 'idle';
}

/* ------------------------------------------------------------------ */
/* Rendering the UI                                                   */
/* ------------------------------------------------------------------ */

function renderUi() {
  renderVerdictOnly();
  renderResolutionBox();
  renderPlanBox();
  renderSolverBox();
  renderPointInfo();
  renderErrors();
  renderBend();
  renderInvalid();
  renderDiagnosis();
  renderFitBox();
  drawCanvases();
  renderProbesTable();
}

function renderVerdictOnly() {
  const el = $('verdict');
  const map = {
    idle: ['未评估', ''],
    pass: ['通过 · 残差达标', 'pass'],
    warn: ['注意 · 残差偏大', 'warn'],
    outlier: ['注意 · 已剔除异常点', 'warn'],
    fail: ['不通过 · 残差过大', 'fail'],
    invalid: ['参数或运行异常', 'fail'],
  };
  const [text, cls] = map[state.verdict] || map.idle;
  el.textContent = text;
  el.className = `verdict ${cls}`;
}

function renderResolutionBox() {
  const el = $('resolutionBox');
  if (!state.source || !state.calibration) {
    el.textContent = '尚未载入图片。';
    return;
  }
  const i = state.calibration.intrinsics;
  const same = i.referenceWidth === state.source.width && i.referenceHeight === state.source.height;
  const rel = describeResolutionRelation(state.calibration, state.source.width, state.source.height);
  const pv = state.preview;
  el.innerHTML = [
    kvRow('内参参考分辨率', `${i.referenceWidth}×${i.referenceHeight}`),
    kvRow('输入图像', `${state.source.width}×${state.source.height}`),
    kvRow('交互预览', `${pv.width}×${pv.height}（缩放 ${fmt(pv.scaleX, 4)}）`),
    `<div class="row"><span class="k">关系</span><span class="v ${same ? 'ok' : 'warn'}">${same ? '一致' : '已按比例调整'}</span></div>`,
    `<div class="micro">${escapeHtml(rel.message)}</div>`,
    same ? '' : '<div class="micro">仅 fx/fy/cx/cy 随分辨率缩放；k/p 为无量纲系数，保持原值。预览缩放只影响交互显示，导出时按原始分辨率重新计算。</div>',
  ].join('');
}

function renderPlanBox() {
  const el = $('planBox');
  const plan = state.planPreview;
  if (!plan) {
    el.textContent = '尚未计算。';
    return;
  }
  const coverage = plan.coverage || {};
  const rows = [
    kvRow('模式', state.mode === 'crop' ? '裁剪输出（实测最大居中窗口）' : '保留视场（实测反演边界）'),
    kvRow('输出尺寸', `${plan.width}×${plan.height}`),
    kvRow('输出比例', fmt(plan.width / plan.height, 4)),
    kvRow('采样步长', `${fmt(plan.stepX, 4)}, ${fmt(plan.stepY, 4)}`),
    kvRow('输出原点', `${fmt(plan.offsetX, 2)}, ${fmt(plan.offsetY, 2)}`),
  ];
  if (coverage.fieldBounds) {
    rows.push(kvRow('无畸变范围', `${fmt(coverage.fieldBounds.width, 1)}×${fmt(coverage.fieldBounds.height, 1)} px`));
  }
  if (coverage.crop) {
    rows.push(kvRow('裁剪实测', `${coverage.crop.width}×${coverage.crop.height}（源画幅 ${fmt(coverage.crop.scale * 100, 1)}%）`));
  }
  rows.push(`<div class="micro">${escapeHtml(plan.notes)}</div>`);
  for (const w of plan.warnings) rows.push(`<div class="micro warn">提示：${escapeHtml(w.message)}</div>`);
  el.innerHTML = rows.join('');
}

function renderSolverBox() {
  const el = $('solverBox');
  if (!state.rectPreview || !state.planPreview) {
    el.textContent = '尚未计算。';
    return;
  }
  const s = state.rectPreview.stats;
  const plan = state.planPreview;
  el.innerHTML = [
    kvRow('正向映射（输出→源）', '目标像素逐个用显式模型算出源坐标'),
    kvRow('求逆预算', `≤${state.solver.maxIterations} 次迭代 / 容差 ${state.solver.tolerance} / 步长 ≤${state.solver.maxStepNormalized}`),
    kvRow('范围反演样本', plan.field ? `${plan.field.pointCount} 点，拒绝 ${plan.field.rejected}` : '裁剪模式使用正向边界检查'),
    kvRow('预览越界像素', String(s.outOfFrame)),
    kvRow('预览模型外像素', String(s.outsideModel)),
    kvRow('采样', state.sampling === 'nearest' ? '最近邻' : '双线性'),
  ].join('');
}

function renderFitBox() {
  const el = $('fitBox');
  if (!state.calibration) {
    el.textContent = '尚无拟合。';
    return;
  }
  const d = state.calibration.distortion;
  const cfg = d.modelConfig || { radialOrder: 6, tangential: true };
  const fit = state.fit;
  const rows = [
    kvRow('模型', `${MODEL} · 径向 ${cfg.radialOrder} 阶 · 切向 ${cfg.tangential ? '启用' : '关闭'}`),
    kvRow('有效半径上限', fmt(d.validMaxNormalizedRadius, 3)),
    kvRow('标定点数', String(state.points.length)),
    kvRow('自动检测标记', state.sourceMeta?.detectedCount != null ? String(state.sourceMeta.detectedCount) : (state.detection?.length ?? '—')),
  ];
  if (fit) {
    rows.push(kvRow('拟合残差 RMS', `${fmt(fit.rmsPx, 4)} px`));
    rows.push(kvRow('拟合残差最大', `${fmt(fit.maxPx, 4)} px`));
    rows.push(kvRow('拟合状态', `${fit.status} · ${fit.iterations} 次迭代`, fit.status === 'converged' ? 'ok' : 'warn'));
    rows.push(kvRow('自由参数', (fit.info?.freeParameters || []).join(', ')));
    if (fit.info?.outlierCount > 0) {
      const ids = (fit.info.outliers || []).map((o) => {
        const hit = state.points.find((p) => Math.hypot(p.ideal.x - o.ideal.x, p.ideal.y - o.ideal.y) < 1e-6);
        return hit ? (hit.id ?? '?') : '?';
      });
      const modelTooWeak = fit.rmsPx > (state.grid?.thresholds?.markerRmsPx ?? 0.8) * 2.5;
      if (modelTooWeak) {
        rows.push(kvRow('未能解释的点', `${fit.info.outlierCount} 个${ids.length ? `（${ids.join(', ')}）` : ''}`, 'warn'));
        rows.push('<div class="micro warn">当前径向阶数/切向开关不足以描述这些点附近的畸变，整体残差也偏大；这不是误拖，可提高径向阶数或启用切向项。</div>');
      } else {
        rows.push(kvRow('已剔除不一致点', `${fit.info.outlierCount} 个${ids.length ? `（${ids.join(', ')}）` : ''}`, 'warn'));
        rows.push('<div class="micro warn">这些标定点与其余点的整体模型明显不符，判断为误拖或误匹配，已排除出拟合；请检查其位置或删除。</div>');
      }
    } else {
      rows.push(kvRow('不一致点', '0', 'ok'));
    }
    rows.push(`<div class="micro">${escapeHtml(fit.info?.note || '')}</div>`);
  } else {
    rows.push('<div class="micro warn">尚未拟合：至少需要 6 个标定点。当前显示为手动参数下的映射结果。</div>');
  }
  if (state.grid?.truthCalibration) {
    const t = state.grid.truthCalibration;
    rows.push(`<div class="micro">真值参考（仅用于验证演示）：fx ${fmt(t.intrinsics.fx, 2)}, cx ${fmt(t.intrinsics.cx, 2)}, cy ${fmt(t.intrinsics.cy, 2)}, k1 ${fmt(t.distortion.k1, 4)}, k2 ${fmt(t.distortion.k2, 4)}, k3 ${fmt(t.distortion.k3, 5)}</div>`);
  }
  el.innerHTML = rows.join('');
}

function renderPointInfo() {
  const el = $('pointInfo');
  if (!state.points.length) {
    el.textContent = state.addMode ? '添加模式：在畸变图上点击以放置新标定点。' : '尚无标定点。';
    return;
  }
  const sel = state.points[state.selected];
  if (!sel) {
    el.innerHTML = `<div class="row"><span class="k">标定点</span><span class="v">${state.points.length} 个 · 点击画布选择</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="row"><span class="k">选中</span><span class="v">${escapeHtml(sel.id)}</span></div>
    <div class="grid2" style="margin-top:6px">
      <label class="field">理想 x<input data-pt="ix" type="number" step="0.1" value="${sel.ideal.x}"></label>
      <label class="field">理想 y<input data-pt="iy" type="number" step="0.1" value="${sel.ideal.y}"></label>
      <label class="field">观测 x<input data-pt="ox" type="number" step="0.1" value="${sel.observed.x}"></label>
      <label class="field">观测 y<input data-pt="oy" type="number" step="0.1" value="${sel.observed.y}"></label>
    </div>
    <div class="micro">修改数值后按回车或失焦生效，并用当前模型重新拟合。</div>
  `;
  el.querySelectorAll('input[data-pt]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const p = state.points[state.selected];
      if (!p) return;
      const v = Number(inp.value);
      if (!Number.isFinite(v)) { renderPointInfo(); return; }
      const key = inp.dataset.pt;
      if (key === 'ix') p.ideal.x = v;
      if (key === 'iy') p.ideal.y = v;
      if (key === 'ox') p.observed.x = v;
      if (key === 'oy') p.observed.y = v;
      recompute({ fit: true, reason: 'point-edit' });
    });
  });
}

function renderErrors() {
  const summary = $('errorSummary');
  const table = $('errorTable');
  const canvas = $('errorPlot');
  if (!state.errors) {
    summary.textContent = '尚无评估结果。';
    table.innerHTML = '';
    clearPlot(canvas);
    return;
  }
  const e = state.errors;
  const parts = [];
  if (e.fitRms != null) {
    parts.push(kvRow('拟合重投影 RMS', `${fmt(e.fitRms, 4)} px`));
    parts.push(kvRow('拟合重投影最大', `${fmt(e.fitMax, 4)} px`));
  }
  if (e.independent) {
    parts.push(kvRow('校正图坐标残差 RMS', `${fmt(e.rmsPx, 4)} px`, e.rmsPx <= 0.8 ? 'ok' : 'warn'));
    parts.push(kvRow('校正图坐标残差最大', `${fmt(e.maxPx, 4)} px`, e.maxPx <= 2.2 ? 'ok' : 'warn'));
    parts.push(kvRow('参与点数', `${e.count}（排除边缘截断 ${e.excludedClipped}）`));
    parts.push('<div class="micro">残差来自在校正图中重新检测标记，与理想交点比较，按源像素计；不是拟合残差的复述。</div>');
  } else {
    parts.push('<div class="micro warn">校正图中未检测到足够标记（当前图像无已知网格），因此只显示拟合重投影残差。</div>');
  }
  summary.innerHTML = parts.join('');

  const rows = (e.points || []).slice().sort((a, b) => b.errorPx - a.errorPx).slice(0, 60);
  if (!rows.length) {
    table.innerHTML = '';
  } else {
    table.innerHTML = `<table><thead><tr><th>理想 x</th><th>理想 y</th><th>dx</th><th>dy</th><th>误差 px</th></tr></thead><tbody>${rows.map((p) => `
      <tr class="${p.errorPx > 1 ? 'badrow' : ''}"><td>${fmt(p.ideal.x, 1)}</td><td>${fmt(p.ideal.y, 1)}</td><td>${fmt(p.dx, 3)}</td><td>${fmt(p.dy, 3)}</td><td>${fmt(p.errorPx, 3)}</td></tr>`).join('')}</tbody></table>`;
  }
  drawErrorPlot(canvas, e);
}

function renderBend() {
  const box = $('bendSummary');
  const canvas = $('bendPlot');
  const b = state.bend;
  if (!b || b.error) {
    box.textContent = b?.error ? `测量失败：${b.error}` : '尚无测量。';
    clearPlot(canvas);
    return;
  }
  if (!b.rectified) {
    box.textContent = '当前图像没有可用的网格引导线，无法测量线条弯曲。';
    clearPlot(canvas);
    return;
  }
  const rows = [
    kvRow('畸变图线条 RMS', b.distorted?.rmsSourcePx != null ? `${fmt(b.distorted.rmsSourcePx, 3)} px` : '—'),
    kvRow('校正图线条 RMS', b.rectified.rmsSourcePx != null ? `${fmt(b.rectified.rmsSourcePx, 3)} px` : '—', b.rectified.rmsSourcePx < 0.45 ? 'ok' : 'warn'),
    kvRow('校正图线条最大', b.rectified.maxSourcePx != null ? `${fmt(b.rectified.maxSourcePx, 3)} px` : '—'),
    kvRow('改善倍数', b.improvementRatio != null ? `${fmt(b.improvementRatio, 2)}×` : '—', b.improvementRatio > 3 ? 'ok' : 'warn'),
    `<div class="micro">沿法向扫描实际亮度重心后拟合直线，按源像素报告；引导线由当前模型映射，畸变图与校正图使用同一测量代码。</div>`,
  ];
  box.innerHTML = rows.join('');
  drawBendPlot(canvas, b);
}

function renderInvalid() {
  const box = $('invalidBox');
  const canvas = $('invalidPlot');
  const rect = state.rectPreview;
  if (!rect) {
    box.textContent = '尚无统计。';
    clearPlot(canvas);
    return;
  }
  const s = rect.stats;
  box.innerHTML = [
    kvRow('有效像素', `${s.valid.toLocaleString()} / ${s.pixels.toLocaleString()}（${(s.validFraction * 100).toFixed(2)}%）`),
    kvRow('越界（源画面外）', s.outOfFrame.toLocaleString(), s.outOfFrame ? 'warn' : ''),
    kvRow('模型外（|r|>r_max）', s.outsideModel.toLocaleString(), s.outsideModel ? 'warn' : ''),
    kvRow('非有限坐标', String(s.nonFinite)),
    kvRow('最大半径', fmt(s.maxRadius, 4)),
    '<div class="micro">红色边界=无效区域；填充色由参数 projection.fillColor 决定，不参与后续统计。</div>',
  ].join('');
  drawInvalidPlot(canvas, rect, state.planPreview);
}

function renderDiagnosis() {
  const el = $('diagnosisBox');
  const d = state.diagnosis;
  if (!d) {
    el.textContent = '尚无诊断。';
    return;
  }
  if (d.error) {
    el.textContent = `诊断失败：${d.error}`;
    return;
  }
  const stageOf = (name) => d.evidenceChain.find((s) => s.stage === name);
  const render = stageOf('render');
  const model = stageOf('model');
  const rmap = stageOf('reverse-map');
  const measure = stageOf('measure');
  const verdictText = { ok: '未发现异常原因', attention: '需注意', broken: '存在严重异常' }[d.verdict] || d.verdict;
  const verdictCls = { ok: 'ok', attention: 'warn', broken: 'bad' }[d.verdict] || '';
  const rows = [kvRow('诊断结论', `${verdictText}（${d.causes.length} 个原因）`, verdictCls)];
  for (const c of d.causes) {
    rows.push(`<div class="row"><span class="k">阶段 ${escapeHtml(c.stage)}</span><span class="v ${c.severity === 'info' ? '' : c.severity === 'warn' ? 'warn' : 'bad'}">${escapeHtml(c.summary)}</span></div>`);
  }
  if (render) {
    const m = render.measurements;
    rows.push(kvRow(
      '失败区域（render）',
      `${m.regionCount} 个 · 无效 ${m.invalid.toLocaleString()} px（越界 ${m.outOfFrame.toLocaleString()} / 模型外 ${m.outsideModel.toLocaleString()} / 非有限 ${m.nonFinite}）`,
      m.nonFinite ? 'bad' : m.invalid ? 'warn' : 'ok',
    ));
    const tracked = m.anomalies.slice(0, 4).map((a) => {
      const src = a.source.x == null ? '—' : `(${a.source.x}, ${a.source.y})`;
      return `输出(${a.destination.x},${a.destination.y})→源${src} r=${a.normalizedRadius} 拉伸=${a.localStretch} [${a.cause}]`;
    });
    for (const t of tracked) rows.push(`<div class="micro">${escapeHtml(t)}</div>`);
  }
  if (rmap) {
    const m = rmap.measurements;
    rows.push(kvRow(
      '求逆状态（reverse-map）',
      `收敛 ${m.converged} · 耗尽 ${m.iterationsExhausted} · 停滞 ${m.stalled} · 发散 ${m.diverged} · 最大迭代 ${m.maxIterations} · 最大残差 ${m.maxResidual}`,
      m.diverged || m.iterationsExhausted ? 'warn' : 'ok',
    ));
  }
  if (model) {
    const m = model.measurements;
    rows.push(kvRow(
      '径向探针（model）',
      `角半径 ${m.cornerRadius} / 有效 ${m.validMaxRadius} · 帧内覆盖 ${(m.frameInsideModelFraction * 100).toFixed(1)}% · 回环最大误差 ${m.roundTrip.maxError}`,
      m.frameInsideModelFraction < 0.5 ? 'bad' : 'ok',
    ));
  }
  if (measure && !measure.measurements.skipped && measure.measurements.rmsPx != null) {
    const m = measure.measurements;
    rows.push(kvRow('坐标残差（measure）', `RMS ${m.rmsPx} px · 最大 ${m.maxPx} px · n=${m.count}`, 'ok'));
  }
  const b = d.logBudget;
  rows.push(`<div class="micro">日志预算：异常记录 ${b.anomaliesRecorded}/${b.maxAnomalies} 条、区域 ${b.regionsRecorded}/${b.maxRegions} 个；预算外丢弃异常 ${b.anomaliesDropped}、区域 ${b.regionsDropped}（只计数不展开，控制日志成本）。诊断只读取光栅，不涂补失败像素。</div>`);
  el.innerHTML = rows.join('');
}

function renderProbesTable() {
  const box = $('probeBox');
  if (state.probe) {
    box.innerHTML = state.probe;
    return;
  }
  if (!state.planPreview || !state.rectPreview) {
    box.textContent = '将鼠标移到畸变图或校正图上查看正向/反向坐标。';
    return;
  }
  const plan = state.planPreview;
  const cal = state.calibration;
  const pv = state.preview;
  const rows = [];
  const fx = [0, 0.5, 1];
  const fy = [0, 0.5, 1];
  for (const v of fy) {
    for (const u of fx) {
      const dx = Math.round(u * (plan.width - 1));
      const dy = Math.round(v * (plan.height - 1));
      // plan is in preview pixels; plan.intrinsics matches that scale.
      const planeX = plan.offsetX + dx * plan.stepX;
      const planeY = plan.offsetY + dy * plan.stepY;
      const f = undistortedToDistorted(planeX, planeY, plan.intrinsics, state.previewCalibration.distortion);
      const valid = f.finite && f.radius <= cal.distortion.validMaxNormalizedRadius
        && f.x >= 0 && f.y >= 0 && f.x <= pv.width - 1 && f.y <= pv.height - 1;
      rows.push(`<div class="row"><span class="k">输出(${dx},${dy})</span><span class="v ${valid ? '' : 'bad'}">→ 源(${fmt(f.x / pv.scaleX, 1)}, ${fmt(f.y / pv.scaleY, 1)}) r=${fmt(f.radius, 3)}</span></div>`);
    }
  }
  box.innerHTML = `<div class="micro">角点/中心映射抽样（实际计算）：</div>${rows.join('')}<div class="micro">把鼠标移到画布上可查看任意点的双向映射与迭代状态。</div>`;
}

function clearPlot(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f141a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#6c7889';
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('暂无数据', canvas.width / 2, canvas.height / 2);
}

function drawErrorPlot(canvas, e) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#0f141a';
  ctx.fillRect(0, 0, W, H);
  const padL = 44;
  const padB = 28;
  const padT = 16;
  const padR = 14;
  const points = e.points || [];
  if (!points.length) {
    clearPlot(canvas);
    return;
  }
  const rmax = state.calibration.distortion.validMaxNormalizedRadius;
  const intr = getIntrinsicsAtSize(state.calibration, state.calibration.intrinsics.referenceWidth, state.calibration.intrinsics.referenceHeight);
  const radii = points.map((p) => Math.hypot((p.ideal.x - intr.cx) / intr.fx, (p.ideal.y - intr.cy) / intr.fy));
  const maxR = Math.max(rmax * 0.35, ...radii) * 1.05;
  const maxErr = Math.max(0.4, e.maxPx * 1.15);
  const x = (r) => padL + (r / maxR) * (W - padL - padR);
  const y = (v) => H - padB - (v / maxErr) * (H - padB - padT);

  ctx.strokeStyle = '#232c38';
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const gy = padT + ((H - padB - padT) * k) / 4;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
    ctx.fillStyle = '#667487';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText((maxErr * (1 - k / 4)).toFixed(2), padL - 6, gy + 3);
  }
  ctx.textAlign = 'center';
  ctx.fillText('归一化半径 r', (padL + W - padR) / 2, H - 8);
  ctx.save();
  ctx.translate(12, (padT + H - padB) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('误差 px', 0, 0);
  ctx.restore();

  ctx.fillStyle = 'rgba(74,168,255,0.85)';
  for (let i = 0; i < points.length; i++) {
    ctx.beginPath();
    ctx.arc(x(radii[i]), y(points[i].errorPx), 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (e.rmsPx != null) {
    ctx.strokeStyle = '#62e0a1';
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y(e.rmsPx)); ctx.lineTo(W - padR, y(e.rmsPx)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#62e0a1';
    ctx.textAlign = 'left';
    ctx.fillText(`RMS ${e.rmsPx.toFixed(3)} px`, padL + 6, y(e.rmsPx) - 5);
  }
  if (e.maxPx != null) {
    ctx.fillStyle = '#ff97a8';
    ctx.textAlign = 'right';
    ctx.fillText(`max ${e.maxPx.toFixed(3)} px`, W - padR, padT + 10);
  }
}

function drawBendPlot(canvas, b) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#0f141a';
  ctx.fillRect(0, 0, W, H);
  const lines = b.lines || [];
  if (!lines.length) {
    clearPlot(canvas);
    return;
  }
  const padL = 46;
  const padR = 14;
  const padT = 14;
  const padB = 22;
  const maxV = Math.max(0.5, ...lines.map((l) => l.max));
  const rowH = (H - padT - padB) / lines.length;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i < lines.length; i++) {
    const cy = padT + i * rowH + rowH / 2;
    const w = ((W - padL - padR) * lines[i].rms) / maxV;
    ctx.fillStyle = `rgba(98,224,161,${0.35 + 0.5 * (1 - i / lines.length)})`;
    ctx.fillRect(padL, cy - 2.5, Math.max(1, w), 5);
    ctx.fillStyle = '#667487';
    ctx.fillText(lines[i].rms.toFixed(3), padL - 6, cy + 3);
  }
  ctx.strokeStyle = '#2a3442';
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.stroke();
  ctx.fillStyle = '#667487';
  ctx.textAlign = 'left';
  ctx.fillText(`每条线校正后 RMS（px），最大 ${maxV.toFixed(2)}`, padL + 4, H - 6);
}

function drawInvalidPlot(canvas, rect, plan) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#0f141a';
  ctx.fillRect(0, 0, W, H);
  if (!rect) return;
  const cols = 96;
  const rows = Math.max(10, Math.round((cols * rect.height) / rect.width));
  const cw = W / cols;
  const ch = H / rows;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      let invalid = 0;
      let total = 0;
      const x0 = Math.floor((rx * rect.width) / cols);
      const x1 = Math.floor(((rx + 1) * rect.width) / cols);
      const y0 = Math.floor((ry * rect.height) / rows);
      const y1 = Math.floor(((ry + 1) * rect.height) / rows);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          if (rect.invalidMask[y * rect.width + x]) invalid++;
          total++;
        }
      }
      const frac = total ? invalid / total : 0;
      if (frac === 0) ctx.fillStyle = 'rgba(40,60,80,0.25)';
      else ctx.fillStyle = `rgba(255,92,116,${0.15 + 0.75 * frac})`;
      ctx.fillRect(rx * cw, ry * ch, cw + 0.5, ch + 0.5);
    }
  }
  ctx.strokeStyle = '#2a3442';
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.fillStyle = '#8d9aad';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`输出 ${rect.width}×${rect.height} · 无效 ${(100 - rect.stats.validFraction * 100).toFixed(2)}% · ${plan?.notes ? '' : ''}`, 6, H - 6);
}

/* ------------------------------------------------------------------ */
/* Canvas drawing + interaction                                       */
/* ------------------------------------------------------------------ */

function drawCanvases() {
  drawDistortedCanvas();
  drawRectifiedCanvas();
}

function prepareCanvas(canvas, w, h) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function drawDistortedCanvas() {
  const canvas = $('distortedCanvas');
  if (!state.preview) {
    prepareCanvas(canvas, 640, 400);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f141a'; ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = '#6c7889'; ctx.font = '13px ui-monospace'; ctx.textAlign = 'center';
    ctx.fillText('尚未载入图片', 320, 200);
    return;
  }
  const pv = state.preview;
  const ctx = prepareCanvas(canvas, pv.width, pv.height);
  const img = new ImageData(new Uint8ClampedArray(pv.rgba), pv.width, pv.height);
  ctx.putImageData(img, 0, 0);

  if (state.showGrid && state.grid && state.calibration) {
    drawProjectedGrid(ctx, pv);
  }
  drawPointMarkers(ctx, pv);
  if (state.probeMode === 'distorted' && state.probePos) {
    drawProbeCross(ctx, state.probePos.x, state.probePos.y);
  }
}

function drawProjectedGrid(ctx, pv) {
  const cal = state.calibration;
  const intr = getIntrinsicsAtSize(cal, state.source.width, state.source.height);
  const sx = pv.scaleX;
  const sy = pv.scaleY;
  const project = (x, y) => {
    const f = undistortedToDistorted(x, y, intr, cal.distortion);
    return {
      x: f.x * sx,
      y: f.y * sy,
      valid: f.finite && f.radius <= cal.distortion.validMaxNormalizedRadius
        && f.x >= 0 && f.y >= 0 && f.x <= state.source.width - 1 && f.y <= state.source.height - 1,
    };
  };
  ctx.save();
  ctx.strokeStyle = 'rgba(90,167,255,0.45)';
  ctx.lineWidth = 0.9;
  ctx.setLineDash([4, 3]);
  const samples = 90;
  const bounds = state.grid.bounds;
  for (const X of state.grid.vertical) {
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k < samples; k++) {
      const y = bounds.minY + (bounds.height * k) / (samples - 1);
      const p = project(X, y);
      if (!p.valid) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  for (const Y of state.grid.horizontal) {
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k < samples; k++) {
      const x = bounds.minX + (bounds.width * k) / (samples - 1);
      const p = project(x, Y);
      if (!p.valid) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function drawPointMarkers(ctx, pv) {
  if (!state.points.length) return;
  const r = state.pointRadius;
  const sx = pv.scaleX;
  const sy = pv.scaleY;
  ctx.save();
  for (let i = 0; i < state.points.length; i++) {
    const p = state.points[i];
    const x = p.observed.x * sx;
    const y = p.observed.y * sy;
    if (x < -20 || y < -20 || x > pv.width + 20 || y > pv.height + 20) continue;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(250,150,62,0.16)';
    ctx.fill();
    ctx.lineWidth = i === state.selected ? 2.2 : 1.2;
    ctx.strokeStyle = i === state.selected ? '#ffffff' : '#fa963e';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 2.5, y); ctx.lineTo(x + 2.5, y);
    ctx.moveTo(x, y - 2.5); ctx.lineTo(x, y + 2.5);
    ctx.strokeStyle = '#ffd7a8';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function drawRectifiedCanvas() {
  const canvas = $('rectifiedCanvas');
  if (!state.rectPreview) {
    prepareCanvas(canvas, 640, 400);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f141a'; ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = '#6c7889'; ctx.font = '13px ui-monospace'; ctx.textAlign = 'center';
    ctx.fillText('校正结果尚未生成', 320, 200);
    return;
  }
  const rect = state.rectPreview;
  const ctx = prepareCanvas(canvas, rect.width, rect.height);
  const img = new ImageData(new Uint8ClampedArray(state.overlayPreview || rect.rgba), rect.width, rect.height);
  ctx.putImageData(img, 0, 0);
  $('rectifiedDims').textContent = `${rect.width}×${rect.height}`;

  if (state.showGrid && state.grid && state.planPreview && state.preview) {
    const plan = state.planPreview;
    const pv = state.preview;
    ctx.save();
    ctx.strokeStyle = 'rgba(98,224,161,0.5)';
    ctx.lineWidth = 0.9;
    ctx.setLineDash([4, 3]);
    for (const X of state.grid.vertical) {
      const x = (X * pv.scaleX - plan.offsetX) / plan.stepX;
      if (x < 0 || x > rect.width - 1) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
    }
    for (const Y of state.grid.horizontal) {
      const y = (Y * pv.scaleY - plan.offsetY) / plan.stepY;
      if (y < 0 || y > rect.height - 1) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }
  // Expected point positions in the output.
  if (state.planPreview && state.preview) {
    const plan = state.planPreview;
    const pv = state.preview;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,215,168,0.8)';
    ctx.lineWidth = 1;
    for (const p of state.points) {
      const x = (p.ideal.x * pv.scaleX - plan.offsetX) / plan.stepX;
      const y = (p.ideal.y * pv.scaleY - plan.offsetY) / plan.stepY;
      if (x < 0 || y < 0 || x > rect.width - 1 || y > rect.height - 1) continue;
      ctx.beginPath();
      ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (state.probeMode === 'rectified' && state.probePos) {
    drawProbeCross(ctx, state.probePos.x, state.probePos.y);
  }
}

function drawProbeCross(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y);
  ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function canvasPoint(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y, inside: x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height };
}

function pickPoint(pvX, pvY) {
  const pv = state.preview;
  const tol = Math.max(7, state.pointRadius + 3);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < state.points.length; i++) {
    const p = state.points[i];
    const d = Math.hypot(p.observed.x * pv.scaleX - pvX, p.observed.y * pv.scaleY - pvY);
    if (d < tol && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

let dragState = null;
let lastLive = 0;

function setupInteractions() {
  const canvas = $('distortedCanvas');
  canvas.addEventListener('pointerdown', (ev) => {
    if (!state.preview) return;
    const pt = canvasPoint(canvas, ev);
    if (!pt.inside) return;
    const pv = state.preview;
    if (state.addMode && state.calibration) {
      addPointAt(pt.x / pv.scaleX, pt.y / pv.scaleY);
      return;
    }
    const idx = pickPoint(pt.x, pt.y);
    if (idx >= 0) {
      state.selected = idx;
      dragState = { idx, pointerId: ev.pointerId };
      canvas.setPointerCapture(ev.pointerId);
      renderPointInfo();
      drawDistortedCanvas();
    } else {
      state.selected = -1;
      renderPointInfo();
      drawDistortedCanvas();
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!state.preview) return;
    const pt = canvasPoint(canvas, ev);
    const pv = state.preview;
    if (dragState && dragState.pointerId === ev.pointerId) {
      const p = state.points[dragState.idx];
      if (p) {
        p.observed.x = clamp(pt.x / pv.scaleX, 0, state.source.width - 1);
        p.observed.y = clamp(pt.y / pv.scaleY, 0, state.source.height - 1);
        drawDistortedCanvas();
        const now = performance.now();
        if (now - lastLive > 180 && !state.busy) {
          lastLive = now;
          recompute({ fit: true, reason: 'drag' });
        }
      }
      return;
    }
    updateDistortedProbe(pt);
  });
  const endDrag = (ev) => {
    if (dragState && dragState.pointerId === ev.pointerId) {
      dragState = null;
      recompute({ fit: true, reason: 'drag-end' });
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!dragState && state.probeMode === 'distorted') {
      state.probeMode = null;
      state.probePos = null;
      state.probe = null;
      renderProbesTable();
      drawDistortedCanvas();
    }
  });

  const rCanvas = $('rectifiedCanvas');
  rCanvas.addEventListener('pointermove', (ev) => {
    if (!state.rectPreview) return;
    const pt = canvasPoint(rCanvas, ev);
    if (!pt.inside) return;
    updateRectifiedProbe(pt);
  });
  rCanvas.addEventListener('pointerleave', () => {
    if (state.probeMode === 'rectified') {
      state.probeMode = null;
      state.probePos = null;
      state.probe = null;
      renderProbesTable();
      drawRectifiedCanvas();
    }
  });
}

function updateDistortedProbe(pt) {
  if (!state.calibration || !state.source) return;
  const pv = state.preview;
  const u = pt.x / pv.scaleX;
  const v = pt.y / pv.scaleY;
  if (u < 0 || v < 0 || u > state.source.width - 1 || v > state.source.height - 1) return;
  const cal = state.calibration;
  try {
    const intr = getIntrinsicsAtSize(cal, state.source.width, state.source.height);
    const inv = distortedToUndistorted(u, v, intr, cal.distortion, state.solver);
    const recon = undistortedToDistorted(inv.x, inv.y, intr, cal.distortion);
    const reproj = Math.hypot(recon.x - u, recon.y - v);
    const insideModel = inv.radius <= cal.distortion.validMaxNormalizedRadius;
    const statusClass = inv.status === 'converged' ? 'ok' : 'warn';
    state.probeMode = 'distorted';
    state.probePos = { x: pt.x, y: pt.y };
    state.probe = [
      kvRow('画布', '畸变原图'),
      kvRow('观测像素', `(${fmt(u, 2)}, ${fmt(v, 2)})`),
      kvRow('归一化', `(${fmt((u - intr.cx) / intr.fx, 4)}, ${fmt((v - intr.cy) / intr.fy, 4)})`),
      kvRow('反解无畸变', `(${fmt(inv.x, 2)}, ${fmt(inv.y, 2)})`),
      kvRow('半径 / 上限', `${fmt(inv.radius, 4)} / ${fmt(cal.distortion.validMaxNormalizedRadius, 3)}`, insideModel ? 'ok' : 'bad'),
      kvRow('反解状态', `${inv.status}${inv.reason ? ` (${inv.reason})` : ''}`, statusClass),
      kvRow('迭代 / 残差', `${inv.iterations} 次 / ${inv.residual.toExponential(2)}`),
      kvRow('回代重投影', `${fmt(reproj, 6)} px`),
      kvRow('有效性', insideModel ? '在模型范围内' : '超出模型有效范围（映射不可信）', insideModel ? 'ok' : 'bad'),
    ].join('');
  } catch (e) {
    state.probe = kvRow('反解错误', e.message, 'bad');
  }
  renderProbesTable();
  drawDistortedCanvas();
}

function updateRectifiedProbe(pt) {
  const plan = state.planPreview;
  if (!plan || !state.calibration) return;
  const cal = state.calibration;
  const intr = getIntrinsicsAtSize(cal, state.source.width, state.source.height);
  const pv = state.preview;
  // Plan is expressed in preview pixels; undo the preview scale to reach the
  // source plane the intrinsics are defined on.
  const planeX = (plan.offsetX + pt.x * plan.stepX) / pv.scaleX;
  const planeY = (plan.offsetY + pt.y * plan.stepY) / pv.scaleY;
  const f = undistortedToDistorted(planeX, planeY, intr, cal.distortion);
  const insideModel = f.finite && f.radius <= cal.distortion.validMaxNormalizedRadius;
  const inFrame = f.finite && f.x >= 0 && f.y >= 0 && f.x <= state.source.width - 1 && f.y <= state.source.height - 1;
  const valid = insideModel && inFrame;
  const idx = Math.round(pt.y) * state.rectPreview.width + Math.round(pt.x);
  const maskInvalid = state.rectPreview.invalidMask[idx] === 1;
  state.probeMode = 'rectified';
  state.probePos = { x: pt.x, y: pt.y };
  state.probe = [
    kvRow('画布', '校正输出'),
    kvRow('输出像素（预览）', `(${fmt(pt.x, 1)}, ${fmt(pt.y, 1)})`),
    kvRow('无畸变坐标（源像素）', `(${fmt(planeX, 2)}, ${fmt(planeY, 2)})`),
    kvRow('源像素（反向映射）', `(${fmt(f.x, 2)}, ${fmt(f.y, 2)})`, valid ? 'ok' : 'bad'),
    kvRow('归一化半径', `${fmt(f.radius, 4)} / ${fmt(cal.distortion.validMaxNormalizedRadius, 3)}`, insideModel ? 'ok' : 'bad'),
    kvRow('径向缩放', fmt(f.radialScale, 4)),
    kvRow('局部放大率', fmt(1 / Math.max(f.radialScale, 1e-6), 3)),
    kvRow('无效原因', !insideModel ? '超出模型有效半径' : !inFrame ? '源画面之外（越界）' : maskInvalid ? '渲染标记为无效' : '有效', valid && !maskInvalid ? 'ok' : 'bad'),
    kvRow('取样', state.sampling === 'nearest' ? '最近邻' : '双线性'),
  ].join('');
  renderProbesTable();
  drawRectifiedCanvas();
}

function addPointAt(srcX, srcY) {
  let ideal;
  if (state.grid) {
    let best = null;
    let bestD = Infinity;
    for (const m of state.grid.markers) {
      if (state.points.some((p) => Math.hypot(p.ideal.x - m.x, p.ideal.y - m.y) < 0.5)) continue;
      const intr = getIntrinsicsAtSize(state.calibration, state.source.width, state.source.height);
      const f = undistortedToDistorted(m.x, m.y, intr, state.calibration.distortion);
      const d = Math.hypot(f.x - srcX, f.y - srcY);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best && bestD < 40) {
      ideal = { x: best.x, y: best.y };
    } else {
      const intr = getIntrinsicsAtSize(state.calibration, state.source.width, state.source.height);
      const inv = distortedToUndistorted(srcX, srcY, intr, state.calibration.distortion, state.solver);
      ideal = { x: inv.x, y: inv.y };
    }
  } else {
    const intr = getIntrinsicsAtSize(state.calibration, state.source.width, state.source.height);
    const inv = distortedToUndistorted(srcX, srcY, intr, state.calibration.distortion, state.solver);
    ideal = { x: inv.x, y: inv.y };
    setError([], [{ code: 'MANUAL_IDEAL', message: '当前图片无已知网格，新点的理想坐标初值取自当前模型的反解；请在右侧面板手动改为真实无畸变坐标。' }]);
  }
  state.points.push({
    id: `M${state.points.length + 1}`,
    ideal,
    observed: { x: srcX, y: srcY },
  });
  state.selected = state.points.length - 1;
  state.addMode = false;
  $('btnAddPoint').classList.remove('danger');
  $('btnAddPoint').textContent = '添加标定点';
  recompute({ fit: true, reason: 'point-add' });
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                          */
/* ------------------------------------------------------------------ */

function syncCalibrationInputs() {
  if (!state.calibration) return;
  const i = state.calibration.intrinsics;
  const d = state.calibration.distortion;
  $('in_fx').value = i.fx;
  $('in_fy').value = i.fy;
  $('in_cx').value = i.cx;
  $('in_cy').value = i.cy;
  $('in_k1').value = d.k1;
  $('in_k2').value = d.k2;
  $('in_k3').value = d.k3;
  $('in_p1').value = d.p1;
  $('in_p2').value = d.p2;
  $('in_validR').value = d.validMaxNormalizedRadius;
  const cfg = d.modelConfig || { radialOrder: 6, tangential: true };
  $('radialOrder').value = String(cfg.radialOrder);
  $('tangentialOn').checked = cfg.tangential !== false;
  updateFormula();
}

function updateFormula() {
  const order = Number($('radialOrder').value);
  const tang = $('tangentialOn').checked;
  const radial = order === 2 ? '1 + k1·r²' : order === 4 ? '1 + k1·r² + k2·r⁴' : '1 + k1·r² + k2·r⁴ + k3·r⁶';
  const t = tang ? 'dx = 2p1xy + p2(r²+2x²)，dy = p1(r²+2y²) + 2p2xy' : '切向项关闭：dx = dy = 0';
  $('modelFormula').textContent = `归一化: x=(u−cx)/fx, y=(v−cy)/fy\n径向: R(r²) = ${radial}\n切向: ${t}\n映射: xd = x·R + dx, yd = y·R + dy\n反解: 阻尼牛顿，带迭代/步长/线搜索预算`;
}

function applyModelConfig() {
  if (!state.calibration) return;
  const order = Number($('radialOrder').value);
  const tang = $('tangentialOn').checked;
  state.calibration.distortion.modelConfig = { radialOrder: order, tangential: tang };
  updateFormula();
  // Changing which terms exist changes the model itself, so re-fit the
  // correspondence set rather than reusing coefficients from the old order.
  recompute({ fit: state.points.length >= 6, reason: 'model-config' });
}

function applyIntrinsics() {
  if (!state.calibration) return;
  const cal = state.calibration;
  const next = {
    fx: Number($('in_fx').value), fy: Number($('in_fy').value),
    cx: Number($('in_cx').value), cy: Number($('in_cy').value),
  };
  for (const [k, v] of Object.entries(next)) {
    if (!Number.isFinite(v)) { setError([`内参 ${k} 不是有限数值`]); return; }
  }
  cal.intrinsics.fx = next.fx;
  cal.intrinsics.fy = next.fy;
  cal.intrinsics.cx = next.cx;
  cal.intrinsics.cy = next.cy;
  recompute({ fit: false, reason: 'intrinsics' });
}

function applyCoeffs() {
  if (!state.calibration) return;
  const cal = state.calibration;
  const vals = {
    k1: Number($('in_k1').value), k2: Number($('in_k2').value), k3: Number($('in_k3').value),
    p1: Number($('in_p1').value), p2: Number($('in_p2').value),
    validMaxNormalizedRadius: Number($('in_validR').value),
  };
  for (const [k, v] of Object.entries(vals)) {
    if (!Number.isFinite(v)) { setError([`畸变参数 ${k} 不是有限数值`]); return; }
  }
  Object.assign(cal.distortion, vals);
  state.requestedValidRadius = vals.validMaxNormalizedRadius;
  recompute({ fit: false, reason: 'coefficients' });
}

function setupButtons() {
  $('btnLoadSample').addEventListener('click', () => loadSample());
  $('fileImage').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadImageFile(f);
    e.target.value = '';
  });
  $('fileCal').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadCalibrationFile(f);
    e.target.value = '';
  });
  const pointsInput = $('filePoints');
  if (pointsInput) {
    pointsInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) loadPointsFile(f);
      e.target.value = '';
    });
  }
  $('btnApplyIntrinsics').addEventListener('click', applyIntrinsics);
  $('btnApplyCoeffs').addEventListener('click', applyCoeffs);
  $('radialOrder').addEventListener('change', applyModelConfig);
  $('tangentialOn').addEventListener('change', applyModelConfig);
  for (const btn of document.querySelectorAll('.segbtn')) {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('.segbtn')) b.classList.toggle('active', b === btn);
      if (state.calibration) state.calibration.projection.mode = state.mode;
      recompute({ fit: false, reason: 'mode' });
    });
  }
  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b === btn);
      const d = $('distortedCard');
      const r = $('rectifiedCard');
      d.classList.toggle('hidden', state.view === 'rectified');
      r.classList.toggle('hidden', state.view === 'distorted');
    });
  }
  $('ptRadius').addEventListener('input', (e) => {
    state.pointRadius = Number(e.target.value);
    drawDistortedCanvas();
  });
  $('showIdealGrid').addEventListener('change', (e) => {
    state.showGrid = e.target.value === 'on';
    drawCanvases();
  });
  $('sampling').addEventListener('change', (e) => {
    state.sampling = e.target.value;
    recompute({ fit: false, reason: 'sampling' });
  });
  const solverInputs = ['invMaxIter', 'invTol', 'invStep'];
  for (const id of solverInputs) {
    $(id).addEventListener('change', () => {
      const maxIterations = clamp(Math.round(Number($('invMaxIter').value)), 2, 200);
      const tolerance = clamp(Number($('invTol').value), 1e-12, 1e-2);
      const maxStepNormalized = clamp(Number($('invStep').value), 0.01, 2);
      if (![maxIterations, tolerance, maxStepNormalized].every(Number.isFinite)) {
        setError(['求解预算必须为有限数值']);
        return;
      }
      state.solver = { maxIterations, tolerance, maxStepNormalized };
      recompute({ fit: false, reason: 'solver' });
    });
  }
  $('btnRefit').addEventListener('click', () => {
    if (!state.points.length) { setError([], [{ code: 'NO_POINTS', message: '没有标定点，无法拟合' }]); return; }
    recompute({ fit: true, reason: 'refit' });
  });
  $('btnResetPoints').addEventListener('click', () => {
    if (!state.initialPoints.length) { setError([], [{ code: 'NO_POINTS', message: '没有可恢复的初始标定点' }]); return; }
    state.points = clonePoints(state.initialPoints);
    state.selected = -1;
    recompute({ fit: true, reason: 'reset-points' });
  });
  $('btnAddPoint').addEventListener('click', () => {
    state.addMode = !state.addMode;
    const btn = $('btnAddPoint');
    btn.textContent = state.addMode ? '点击画布放置…' : '添加标定点';
    btn.classList.toggle('danger', state.addMode);
    renderPointInfo();
  });
  $('btnDeletePoint').addEventListener('click', () => {
    if (state.selected < 0 || !state.points[state.selected]) {
      setError([], [{ code: 'NO_SELECTION', message: '请先在畸变图上选中一个标定点' }]);
      return;
    }
    state.points.splice(state.selected, 1);
    state.selected = -1;
    recompute({ fit: true, reason: 'point-delete' });
  });
  $('btnExportPng').addEventListener('click', exportPng);
  $('btnExportCal').addEventListener('click', exportCalibration);
  $('btnExportEval').addEventListener('click', exportEvaluation);
  $('btnExportDiag').addEventListener('click', exportDiagnosis);
  const btnPoints = $('btnExportPoints');
  if (btnPoints) btnPoints.addEventListener('click', exportPoints);
}

function clonePoints(points) {
  return points.map((p) => ({ ...p, ideal: { ...p.ideal }, observed: { ...p.observed }, truthObserved: p.truthObserved ? { ...p.truthObserved } : undefined }));
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

function download(name, blobOrText, type = 'application/json') {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function deflateBytes(raw) {
  if (typeof CompressionStream === 'undefined') throw new Error('当前浏览器不支持 CompressionStream，无法编码 PNG');
  const cs = new CompressionStream('deflate');
  const stream = new Blob([raw]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function renderFullRes(reason) {
  if (!state.source || !state.calibration) throw new Error('尚未载入图片或参数');
  const check = validateCalibration(state.calibration);
  if (check.errors) throw new Error(check.errors[0].message);
  if (reason) setProgress(true, reason);
  await yieldToUi();
  const plan = planOutput(state.calibration, state.source.width, state.source.height, state.mode, {
    padding: 0,
    inverse: { ...state.solver },
  });
  await yieldToUi();
  const rect = renderRectified(state.source.rgba, state.source.width, state.source.height, plan, state.calibration.distortion, {
    sampling: state.sampling,
    fillColor: state.calibration.projection.fillColor || [16, 20, 28, 255],
  });
  return { plan, rect };
}

/** Coordinate residuals re-measured on a full-resolution rectified raster. */
function measureFullResCoordResidual(plan, rect) {
  if (!state.grid) return null;
  const detections = detectMarkers(rect.rgba, rect.width, rect.height);
  const areas = detections.map((d) => d.area).sort((a, b) => a - b);
  const medianArea = areas.length ? areas[areas.length >> 1] : 0;
  const complete = detections.filter((d) => d.bbox.minX > 0 && d.bbox.minY > 0 && d.bbox.maxX < rect.width - 1 && d.bbox.maxY < rect.height - 1 && d.area >= medianArea * 0.55);
  const expected = state.grid.markers.map((m) => ({ ideal: m, x: (m.x - plan.offsetX) / plan.stepX, y: (m.y - plan.offsetY) / plan.stepY }))
    .filter((m) => m.x > 10 && m.y > 10 && m.x < rect.width - 11 && m.y < rect.height - 11);
  const pairs = matchPoints(complete, expected, 14);
  const usedD = new Set();
  const usedE = new Set();
  const points = [];
  for (const pr of pairs) {
    if (usedD.has(pr.detected) || usedE.has(pr.expected)) continue;
    usedD.add(pr.detected); usedE.add(pr.expected);
    const det = complete[pr.detected];
    const exp = expected[pr.expected];
    const dx = plan.offsetX + det.x * plan.stepX - exp.ideal.x;
    const dy = plan.offsetY + det.y * plan.stepY - exp.ideal.y;
    points.push({ ideal: exp.ideal, errorPx: Math.hypot(dx, dy), dx, dy });
  }
  if (!points.length) return null;
  return {
    count: points.length,
    excludedClipped: detections.length - complete.length,
    rmsPx: Math.sqrt(points.reduce((s, p) => s + p.errorPx * p.errorPx, 0) / points.length),
    maxPx: Math.max(...points.map((p) => p.errorPx)),
    points,
  };
}

async function exportPng() {
  try {
    const { plan, rect } = await renderFullRes('按原始分辨率重采样…');
    setProgress(true, '编码 PNG…');
    await yieldToUi();
    const bytes = await encodePng(rect.rgba, rect.width, rect.height, deflateBytes);
    const base = (state.source.name || 'image').replace(/\.[^.]+$/, '');
    download(`${base}-rectified-${rect.width}x${rect.height}.png`, new Blob([bytes], { type: 'image/png' }));
    $('renderNote').textContent = `已导出全分辨率校正图 ${rect.width}×${rect.height}（${state.mode === 'crop' ? '裁剪' : '保留视场'}），PNG ${(bytes.length / 1024 / 1024).toFixed(2)} MB`;
    setProgress(false);
  } catch (err) {
    setProgress(false);
    setError([`导出失败：${err.message}`]);
  }
}

function calibrationPayload(extra = {}) {
  const cal = JSON.parse(JSON.stringify(state.calibration));
  cal.projection = { ...cal.projection, mode: state.mode };
  const payload = {
    formatVersion: 1,
    model: cal.model,
    modelConfig: cal.distortion.modelConfig,
    source: { width: state.source.width, height: state.source.height, name: state.source.name },
    referenceResolution: { width: cal.intrinsics.referenceWidth, height: cal.intrinsics.referenceHeight },
    intrinsics: cal.intrinsics,
    distortion: cal.distortion,
    projection: { mode: state.mode, fillColor: cal.projection.fillColor || [16, 20, 28, 255] },
    solver: state.solver,
    fit: state.fit ? { rmsPx: state.fit.rmsPx, maxPx: state.fit.maxPx, iterations: state.fit.iterations, status: state.fit.status, ...state.fit.info } : null,
    points: state.points.map((p) => ({ id: p.id, ideal: p.ideal, observed: p.observed })),
    resolutionRelationship: describeResolutionRelation(cal, state.source.width, state.source.height),
    notes: [
      'intrinsics 定义于 referenceResolution；换分辨率时必须按比例缩放 fx/fy/cx/cy。',
      '畸变系数 k/p 为无量纲量，分辨率改变时保持原值。',
      '正向：无畸变归一化坐标经径向+切向模型得到畸变坐标；反解使用带预算的阻尼牛顿迭代。',
    ],
    ...extra,
  };
  return payload;
}

function exportCalibration() {
  if (!state.calibration) { setError(['尚未载入参数']); return; }
  try {
    validateCalibration(state.calibration);
    const payload = calibrationPayload();
    const base = (state.source?.name || 'calibration').replace(/\.[^.]+$/, '');
    download(`${base}-calibration.json`, JSON.stringify(payload, null, 2));
    $('renderNote').textContent = '已导出参数 JSON（含模型选择、分辨率关系、拟合统计与标定点）。';
  } catch (err) {
    setError([err.message, ...(err.errors || []).map((e) => e.message)]);
  }
}

function exportPoints() {
  if (!state.points.length) { setError([], [{ code: 'NO_POINTS', message: '没有标定点可导出' }]); return; }
  const payload = {
    referenceResolution: { width: state.source.width, height: state.source.height },
    model: MODEL,
    points: state.points.map((p) => ({ id: p.id, ideal: p.ideal, observed: p.observed })),
  };
  download(`correspondences-${state.points.length}.json`, JSON.stringify(payload, null, 2));
}

async function exportEvaluation() {
  try {
    setProgress(true, '按原始分辨率评估…');
    await yieldToUi();
    const { plan, rect } = await renderFullRes();
    const fullCal = state.calibration;
    const intr = getIntrinsicsAtSize(fullCal, state.source.width, state.source.height);
    const coord = measureFullResCoordResidual(plan, rect);
    // Fit residual recomputed on current correspondence set at full resolution.
    const fitPoints = state.points.map((p) => ({ ideal: p.ideal, observed: p.observed }));
    const fitResiduals = fitPoints.map((p) => {
      const f = undistortedToDistorted(p.ideal.x, p.ideal.y, intr, fullCal.distortion);
      return { ideal: p.ideal, predicted: { x: f.x, y: f.y }, errorPx: Math.hypot(f.x - p.observed.x, f.y - p.observed.y) };
    });
    const fitRms = fitResiduals.length ? Math.sqrt(fitResiduals.reduce((s, p) => s + p.errorPx * p.errorPx, 0) / fitResiduals.length) : null;

    // Mapping probes at a 5x3 grid, using the full-resolution plan.
    const probes = [];
    for (const fy of [0, 0.5, 1]) {
      for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
        const dx = Math.round(fx * (plan.width - 1));
        const dy = Math.round(fy * (plan.height - 1));
        const u = plan.offsetX + dx * plan.stepX;
        const v = plan.offsetY + dy * plan.stepY;
        const f = undistortedToDistorted(u, v, intr, fullCal.distortion);
        const insideModel = f.finite && f.radius <= fullCal.distortion.validMaxNormalizedRadius;
        const inFrame = f.finite && f.x >= 0 && f.y >= 0 && f.x <= state.source.width - 1 && f.y <= state.source.height - 1;
        const pix = dx * 0 + dy;
        const invalid = rect.invalidMask[Math.round(dy) * rect.width + Math.round(dx)] === 1;
        probes.push({
          destination: { x: dx, y: dy },
          undistorted: { x: u, y: v },
          source: { x: f.x, y: f.y },
          normalizedRadius: f.radius,
          insideModel,
          inFrame,
          renderedInvalid: invalid,
        });
      }
    }

    const reverse = buildReverseMap(Math.min(240, state.source.width), Math.min(180, state.source.height), fullCal, { inverse: state.solver });

    const payload = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      modelConfig: fullCal.distortion.modelConfig,
      view: state.mode,
      source: { name: state.source.name, width: state.source.width, height: state.source.height },
      calibration: formatCalibration(fullCal),
      intrinsics: fullCal.intrinsics,
      distortion: fullCal.distortion,
      solver: state.solver,
      resolutionRelationship: describeResolutionRelation(fullCal, state.source.width, state.source.height),
      fit: state.fit ? { ...state.fit } : null,
      fitResidual: {
        rmsPx: fitRms,
        maxPx: fitResiduals.length ? Math.max(...fitResiduals.map((p) => p.errorPx)) : null,
        count: fitResiduals.length,
        points: fitResiduals,
      },
      coordinateResidual: coord,
      rectifiedStats: rect.stats,
      plan: {
        width: plan.width, height: plan.height, offsetX: plan.offsetX, offsetY: plan.offsetY,
        stepX: plan.stepX, stepY: plan.stepY, notes: plan.notes, warnings: plan.warnings,
        coverage: plan.coverage,
      },
      mappingProbes: probes,
      reverseMapSample: { width: reverse.width, height: reverse.height, stats: reverse.stats },
      thresholds: state.grid?.thresholds || null,
      notes: [
        '坐标残差来自校正后光栅中重新检测的标记，与理想网格交点比较，单位为源像素。',
        '映射探针与反向映射样本使用当前模型与求逆预算实际计算。',
      ],
    };
    if (state.bend) payload.lineBending = state.bend;
    download(`wideangle-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(payload, null, 2));
    $('renderNote').textContent = `已导出全分辨率评估 JSON：输出 ${plan.width}×${plan.height}，坐标残差 ${coord ? `${coord.rmsPx.toFixed(3)} px RMS` : '无网格不可测'}，越界 ${rect.stats.outOfFrame} px。`;
    setProgress(false);
  } catch (err) {
    setProgress(false);
    setError([`评估导出失败：${err.message}`]);
  }
}

async function exportDiagnosis() {
  try {
    setProgress(true, '按原始分辨率诊断…');
    await yieldToUi();
    const { plan, rect } = await renderFullRes();
    const coord = measureFullResCoordResidual(plan, rect);
    const diagnosis = diagnoseRectification({
      calibration: state.calibration,
      sourceWidth: state.source.width,
      sourceHeight: state.source.height,
      mode: state.mode,
      plan,
      rect,
      evaluation: {
        coordinateResidual: coord,
        thresholds: state.grid?.thresholds || null,
        units: 'source-pixel',
      },
      inverse: state.solver,
    });
    const payload = {
      generatedAt: new Date().toISOString(),
      source: { name: state.source.name, width: state.source.width, height: state.source.height },
      mode: state.mode,
      calibration: formatCalibration(state.calibration),
      ...diagnosis,
    };
    download(`wideangle-diagnosis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(payload, null, 2));
    $('renderNote').textContent = `已导出全分辨率诊断 JSON：${diagnosis.summary}`;
    setProgress(false);
  } catch (err) {
    setProgress(false);
    setError([`诊断导出失败：${err.message}`]);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function boot() {
  setupButtons();
  setupInteractions();
  updateFormula();
  clearPlot($('errorPlot'));
  clearPlot($('bendPlot'));
  clearPlot($('invalidPlot'));
  setError([]);
  drawDistortedCanvas();
  drawRectifiedCanvas();
  // Auto-load the built-in calibration scene so the page is useful on open.
  setTimeout(() => { loadSample(); }, 60);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
