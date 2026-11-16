#!/usr/bin/env node
/**
 * Terminal helper for the wide-angle rectifier. Produces real artefacts:
 *   - distorted test photo from a known straight-line grid,
 *   - fitted calibration file measured from that photo,
 *   - rectified image from the fitted calibration,
 *   - evaluation JSON with coordinate residuals and line bending,
 *   - mapping probe JSON plus a contact sheet for visual review.
 *
 * This CLI is an auxiliary to the GUI (npm start); it does not replace it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeDefaultScene, generateDistortedImage, makeApproximateCalibration,
} from '../src/core/synthetic.js';
import {
  detectMarkers, matchPoints, fitCalibration, evaluateRectification,
} from '../src/core/analysis.js';
import { planOutput } from '../src/core/projection.js';
import { renderRectified, overlayInvalidMask } from '../src/core/render.js';
import { adaptCalibrationToSize, describeResolutionRelation, validateCalibration, formatCalibration } from '../src/core/calibration.js';
import { distortedToUndistorted, buildReverseMap, undistortedToDistorted } from '../src/core/model.js';
import { resizeRgba } from '../src/core/png.js';
import { readPng, writePng, readJson, writeJson } from '../src/node/png-node.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = resolve(root, 'deliverables');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

function makeContactSheet(items, width, height, cols = 3) {
  const rows = Math.ceil(items.length / cols);
  const pad = 10;
  const label = 22;
  const sheetW = cols * width + (cols + 1) * pad;
  const sheetH = rows * (height + label) + (rows + 1) * pad;
  const rgba = new Uint8ClampedArray(sheetW * sheetH * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 18; rgba[i + 1] = 21; rgba[i + 2] = 28; rgba[i + 3] = 255; }
  items.forEach((item, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const ox = pad + col * (width + pad);
    const oy = pad + row * (height + label + pad) + label;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * 4;
        const di = ((oy + y) * sheetW + ox + x) * 4;
        rgba[di] = item.rgba[si];
        rgba[di + 1] = item.rgba[si + 1];
        rgba[di + 2] = item.rgba[si + 2];
        rgba[di + 3] = 255;
      }
    }
    drawRect(rgba, sheetW, sheetH, ox - 1, oy - 1, width + 2, height + 2, [70, 80, 100, 255]);
  });
  return { rgba, width: sheetW, height: sheetH, labels: items.map((i) => i.label), cols, cell: { width, height, pad, label } };
}

function drawRect(rgba, w, h, x0, y0, rw, rh, color) {
  for (let x = x0; x < x0 + rw; x++) {
    for (const y of [y0, y0 + rh - 1]) {
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = (y * w + x) * 4;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
    }
  }
  for (let y = y0; y < y0 + rh; y++) {
    for (const x of [x0, x0 + rw - 1]) {
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = (y * w + x) * 4;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
    }
  }
}

function drawCross(rgba, w, h, x, y, color, size = 4) {
  for (let t = -size; t <= size; t++) {
    for (const [px, py] of [[x + t, y], [x, y + t]]) {
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const i = (iy * w + ix) * 4;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
    }
  }
}

function drawPolyline(rgba, w, h, pts, color) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      drawCross(rgba, w, h, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, color, 0);
    }
  }
}

function buildGridPolylines(grid) {
  const vertical = grid.vertical.map((X) => [{ x: X, y: grid.spacing * 0.15 }, { x: X, y: grid.height - grid.spacing * 0.15 }]);
  const horizontal = grid.horizontal.map((Y) => [{ x: grid.spacing * 0.15, y: Y }, { x: grid.width - grid.spacing * 0.15, y: Y }]);
  return [...vertical, ...horizontal];
}

function overlayGrid(rgba, w, h, polylines, color) {
  const out = new Uint8ClampedArray(rgba);
  for (const line of polylines) drawPolyline(out, w, h, line, color);
  return out;
}

function overlayMarkers(rgba, w, h, markers, color, size = 5) {
  const out = new Uint8ClampedArray(rgba);
  for (const m of markers) drawCross(out, w, h, m.x, m.y, color, size);
  return out;
}

function overlayErrorVectors(rgba, w, h, errors, color) {
  const out = new Uint8ClampedArray(rgba);
  for (const e of errors) {
    drawPolyline(out, w, h, [{ x: e.ideal.x, y: e.ideal.y }, { x: e.ideal.x + e.dx, y: e.ideal.y + e.dy }], color);
    drawCross(out, w, h, e.ideal.x, e.ideal.y, color, 2);
  }
  return out;
}

function mappingProbes(calibration, plan, distortion) {
  const probes = [];
  const xs = [0, 0.25, 0.5, 0.75, 1];
  const ys = [0, 0.5, 1];
  for (const fy of ys) {
    for (const fx of xs) {
      const dx = Math.round(fx * (plan.width - 1));
      const dy = Math.round(fy * (plan.height - 1));
      const u = plan.offsetX + dx * plan.stepX;
      const v = plan.offsetY + dy * plan.stepY;
      const f = undistortedToDistorted(u, v, plan.intrinsics, distortion);
      const inFrame = f.finite && f.x >= 0 && f.y >= 0 && f.x <= plan.intrinsics.width - 1 && f.y <= plan.intrinsics.height - 1;
      const insideModel = f.finite && f.radius <= distortion.validMaxNormalizedRadius;
      // Inverse check at the destination pixel itself.
      const inv = distortedToUndistorted(dx, dy, plan.intrinsics, distortion);
      probes.push({
        destination: { x: dx, y: dy },
        undistorted: { x: u, y: v },
        source: { x: f.x, y: f.y },
        normalizedRadius: f.radius,
        valid: inFrame && insideModel,
        invalidReason: !insideModel ? 'outside-model' : !inFrame ? 'out-of-frame' : null,
        inverseAtDestination: {
          x: inv.x, y: inv.y, iterations: inv.iterations, residual: inv.residual, status: inv.status, reason: inv.reason,
        },
      });
    }
  }
  return probes;
}

async function cmdGenerate(args) {
  const outDir = resolve(args.out || DEFAULT_DIR);
  await ensureDir(outDir);
  const width = Math.round(num(args.width, 1200));
  const height = Math.round(num(args.height, 900));
  const scale = num(args.scale, 1);
  const scene = makeDefaultScene(Math.round(width * scale), Math.round(height * scale));
  const t0 = performance.now();
  const dist = generateDistortedImage(scene.calibration, scene.grid);
  const elapsed = performance.now() - t0;
  const distortedPath = resolve(outDir, 'distorted-grid.png');
  await writePng(distortedPath, dist.rgba, dist.width, dist.height);
  const truthPath = resolve(outDir, 'distorted-ground-truth.json');
  await writeJson(truthPath, formatCalibration(scene.calibration));
  const pointsPath = resolve(outDir, 'correspondences.json');
  await writeJson(pointsPath, scene.calibrationPoints);
  console.log(`[generate] ${distortedPath}`);
  console.log(`[generate] ${dist.width}×${dist.height}, valid ${dist.stats.valid}/${dist.stats.pixels}, solver maxIter ${dist.stats.maxIterations}, ${elapsed.toFixed(0)} ms`);
  console.log(`[generate] 真值参数 ${truthPath}`);
  console.log(`[generate] ${scene.calibrationPoints.length} 个标定对应点 ${pointsPath}`);
}

async function cmdEvaluate(args) {
  const outDir = resolve(args.out || DEFAULT_DIR);
  await ensureDir(outDir);
  const mode = args.mode === 'crop' ? 'crop' : 'preserve-field';
  const scene = makeDefaultScene();
  const generated = generateDistortedImage(scene.calibration, scene.grid);
  await writePng(resolve(outDir, 'distorted-grid.png'), generated.rgba, generated.width, generated.height);

  const detected = detectMarkers(generated.rgba, generated.width, generated.height);
  const visible = scene.visibleMarkers;
  const pairs = matchPoints(detected, visible.map((p) => p.observed), 16);
  if (pairs.length < 8) throw new Error(`检测到的对应点不足（${pairs.length}），无法评估`);
  const usedDetected = new Set();
  const usedTruth = new Set();
  const matchedVisible = [];
  const fitPoints = [];
  for (const p of pairs) {
    if (usedDetected.has(p.detected) || usedTruth.has(p.expected)) continue;
    usedDetected.add(p.detected);
    usedTruth.add(p.expected);
    const truthPoint = visible[p.expected];
    matchedVisible.push(truthPoint);
    fitPoints.push({
      ideal: truthPoint.ideal,
      observed: { x: detected[p.detected].x, y: detected[p.detected].y },
      truthObserved: truthPoint.observed,
    });
  }
  const start = makeApproximateCalibration(scene);
  const fit = fitCalibration(fitPoints, start, { freeFocal: false });
  validateCalibration(fit.calibration);

  const plan = planOutput(fit.calibration, scene.width, scene.height, mode, { padding: 0 });
  const rectified = renderRectified(generated.rgba, generated.width, generated.height, plan, fit.calibration.distortion, {
    sampling: 'bilinear',
    fillColor: fit.calibration.projection.fillColor,
  });
  const truthPlan = planOutput(scene.calibration, scene.width, scene.height, mode, { padding: 0 });

  const evaluation = evaluateRectification({
    scene, distorted: generated, rectified, plan, calibration: fit.calibration,
    detection: {
      markers: detected,
      fitPoints,
      matchedVisible,
      visible,
    },
    fit,
  });

  const fittedPath = resolve(outDir, 'calibration-fitted.json');
  await writeJson(fittedPath, {
    ...formatCalibration(fit.calibration),
    fit: fit.calibration.fit,
    referenceResolution: { width: scene.width, height: scene.height },
  });
  await writeJson(resolve(outDir, 'calibration-ground-truth.json'), formatCalibration(scene.calibration));
  await writePng(resolve(outDir, 'rectified.png'), rectified.rgba, rectified.width, rectified.height);
  const invalidView = overlayInvalidMask(rectified.rgba, rectified.invalidMask, rectified.width, rectified.height);
  await writePng(resolve(outDir, 'rectified-invalid-overlay.png'), invalidView, rectified.width, rectified.height);

  // Review plots, all rendered from the actual integer image buffers.
  const gridLines = buildGridPolylines(scene.grid);
  const distortedOverlay = overlayGrid(generated.rgba, generated.width, generated.height, gridLines, [90, 220, 255, 255]);
  await writePng(resolve(outDir, 'distorted-with-ideal-grid.png'), distortedOverlay, generated.width, generated.height);
  const rectGridLines = gridLines.map((line) => line.map((p) => ({
    x: (p.x - plan.offsetX) / plan.stepX,
    y: (p.y - plan.offsetY) / plan.stepY,
  })));
  const rectOverlay = overlayGrid(rectified.rgba, rectified.width, rectified.height, rectGridLines, [90, 255, 150, 255]);
  await writePng(resolve(outDir, 'rectified-with-ideal-grid.png'), rectOverlay, rectified.width, rectified.height);
  const detectedView = overlayMarkers(generated.rgba, generated.width, generated.height,
    detected.map((m) => ({ x: m.x, y: m.y })), [255, 80, 90, 255]);
  await writePng(resolve(outDir, 'distorted-detected-markers.png'), detectedView, generated.width, generated.height);
  const errVecView = overlayErrorVectors(rectified.rgba, rectified.width, rectified.height,
    evaluation.coordinateResidual.points.map((p) => ({ ideal: { x: (p.ideal.x - plan.offsetX) / plan.stepX, y: (p.ideal.y - plan.offsetY) / plan.stepY }, dx: 0, dy: 0 })), [255, 220, 90, 255]);
  await writePng(resolve(outDir, 'rectified-markers.png'), errVecView, rectified.width, rectified.height);

  const report = {
    generatedAt: new Date().toISOString(),
    model: scene.calibration.model,
    mode,
    referenceResolution: { width: scene.width, height: scene.height },
    fit: { ...fit.calibration.fit, fittedIntrinsics: fit.calibration.intrinsics, fittedDistortion: fit.calibration.distortion },
    plan: {
      width: plan.width, height: plan.height, offsetX: plan.offsetX, offsetY: plan.offsetY,
      stepX: plan.stepX, stepY: plan.stepY, notes: plan.notes, warnings: plan.warnings,
      field: plan.field ? { bounds: plan.field.bounds, rejected: plan.field.rejected, samples: plan.field.pointCount } : null,
      crop: plan.crop,
      truthPlan: {
        width: truthPlan.width, height: truthPlan.height, offsetX: truthPlan.offsetX, offsetY: truthPlan.offsetY,
        stepX: truthPlan.stepX, stepY: truthPlan.stepY, notes: truthPlan.notes,
        field: truthPlan.field ? { bounds: truthPlan.field.bounds } : null, crop: truthPlan.crop,
      },
    },
    evaluation,
    rectifiedStats: rectified.stats,
    mappingProbes: mappingProbes(fit.calibration, plan, fit.calibration.distortion),
    thresholds: scene.thresholds,
    files: {
      distorted: 'distorted-grid.png',
      calibrationFitted: 'calibration-fitted.json',
      calibrationGroundTruth: 'calibration-ground-truth.json',
      rectified: 'rectified.png',
      invalidOverlay: 'rectified-invalid-overlay.png',
    },
  };
  await writeJson(resolve(outDir, 'evaluation.json'), report);
  await writeJson(resolve(outDir, 'mapping-probes.json'), report.mappingProbes);
  await writeJson(resolve(outDir, 'resolution-adaptation.json'), {
    native: describeResolutionRelation(fit.calibration, scene.width, scene.height),
    halved: describeResolutionRelation(adaptCalibrationToSize(fit.calibration, scene.width / 2, scene.height / 2), scene.width / 2, scene.height / 2),
    adapted: adaptCalibrationToSize(fit.calibration, scene.width / 2, scene.height / 2),
    note: '图像减半时 fx/fy/cx/cy 乘以 0.5；k1/k2/k3/p1/p2 为无量纲，保持不变。',
  });

  // Contact sheet of key views at a reduced size for quick visual review.
  const thumbW = 480;
  const thumbH = Math.round((thumbW / generated.width) * generated.height);
  const items = [
    { label: 'distorted', rgba: resizeRgba(generated.rgba, generated.width, generated.height, thumbW, thumbH) },
    { label: 'detected markers', rgba: resizeRgba(detectedView, generated.width, generated.height, thumbW, thumbH) },
    { label: 'distorted + ideal grid', rgba: resizeRgba(distortedOverlay, generated.width, generated.height, thumbW, thumbH) },
    { label: 'rectified', rgba: resizeRgba(rectified.rgba, rectified.width, rectified.height, thumbW, Math.round((thumbW / rectified.width) * rectified.height)) },
    { label: 'rectified + ideal grid', rgba: resizeRgba(rectOverlay, rectified.width, rectified.height, thumbW, Math.round((thumbW / rectified.width) * rectified.height)) },
    { label: 'invalid mask overlay', rgba: resizeRgba(invalidView, rectified.width, rectified.height, thumbW, Math.round((thumbW / rectified.width) * rectified.height)) },
  ];
  const sheet = makeContactSheet(items, thumbW, thumbH, 3);
  await writePng(resolve(outDir, 'contact-sheet.png'), sheet.rgba, sheet.width, sheet.height);
  const sheetMeta = {
    width: sheet.width, height: sheet.height, cols: sheet.cols, cell: sheet.cell, labels: sheet.labels,
    note: '按行排列；每个单元格左上角为对应标签。',
  };
  await writeJson(resolve(outDir, 'contact-sheet.json'), sheetMeta);

  // Console summary.
  const e = evaluation;
  console.log('=== 广角校正评估 (真实像素运算) ===');
  console.log(`模式 ${mode}  |  拟合 ${e.fitResidual.iterations} 次迭代, ${e.fitResidual.status}, 拟合残差 RMS ${e.fitResidual.rmsPx.toFixed(4)} px`);
  console.log(`检测标记 ${detected.length} 个, 匹配 ${fitPoints.length} 个 (画面内真值 ${visible.length} 个, 拟合剔除 ${fit.outliers.length} 个)`);
  console.log(`校正后坐标残差: RMS ${fmt(e.coordinateResidual.rmsPx)} px, 最大 ${fmt(e.coordinateResidual.maxPx)} px (n=${e.coordinateResidual.count})`);
  console.log(`拟合模型对真值前向残差: RMS ${fmt(e.forwardResidual.rmsPx)} px, 最大 ${fmt(e.forwardResidual.maxPx)} px`);
  console.log(`线条弯曲 (源像素): 畸变图 RMS ${fmt(e.lineBending.distorted.rmsPx)} px → 校正后 RMS ${fmt(e.lineBending.rectified.rmsSourcePx)} px (改善 ${fmt(e.lineBending.improvementRatio)}×)`);
  console.log(`        最大: ${fmt(e.lineBending.distorted.maxPx)} px → ${fmt(e.lineBending.rectified.maxSourcePx)} px`);
  console.log(`输出 ${plan.width}×${plan.height}, 有效像素 ${(rectified.stats.validFraction * 100).toFixed(2)}%, 越界 ${rectified.stats.outOfFrame}, 模型外 ${rectified.stats.outsideModel}`);
  console.log(`映射探针 ${report.mappingProbes.length} 个 -> mapping-probes.json`);
  console.log(`判定: ${e.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(e.checks)}`);
  for (const w of plan.warnings) console.log(`提示: ${w.message}`);
  console.log(`产物目录 ${outDir}`);
  if (!e.pass) process.exitCode = 2;
}

async function cmdInspect(args) {
  // Rectify an arbitrary PNG with a parameter file, used for ad-hoc verification.
  const imagePath = args.image;
  const calPath = args.calibration;
  if (!imagePath || !calPath) throw new Error('用法: inspect --image <png> --calibration <json> [--mode preserve-field|crop] [--out dir]');
  const outDir = resolve(args.out || DEFAULT_DIR);
  await ensureDir(outDir);
  const img = await readPng(resolve(imagePath));
  const raw = await readJson(resolve(calPath));
  let cal = raw;
  if (!raw.intrinsics) {
    cal = {
      model: raw.model, intrinsics: {
        referenceWidth: raw.referenceResolution.width, referenceHeight: raw.referenceResolution.height,
        fx: raw.intrinsics?.fx ?? raw.fx, fy: raw.intrinsics?.fy ?? raw.fy, cx: raw.intrinsics?.cx ?? raw.cx, cy: raw.intrinsics?.cy ?? raw.cy,
      }, distortion: raw.distortion, projection: raw.projection || { mode: 'preserve-field', fillColor: [16, 20, 28, 255] },
    };
  }
  let adapted = cal;
  if (cal.intrinsics.referenceWidth !== img.width || cal.intrinsics.referenceHeight !== img.height) {
    console.log(`[inspect] ${describeResolutionRelation(cal, img.width, img.height).message}`);
    adapted = adaptCalibrationToSize(cal, img.width, img.height);
  }
  const { warnings } = validateCalibration(adapted);
  for (const w of warnings) console.log(`[inspect] 提示: ${w.message}`);
  const mode = args.mode === 'crop' ? 'crop' : 'preserve-field';
  const plan = planOutput(adapted, img.width, img.height, mode);
  const rect = renderRectified(img.rgba, img.width, img.height, plan, adapted.distortion, { fillColor: adapted.projection?.fillColor });
  await writePng(resolve(outDir, 'inspect-rectified.png'), rect.rgba, rect.width, rect.height);
  await writePng(resolve(outDir, 'inspect-invalid.png'), overlayInvalidMask(rect.rgba, rect.invalidMask, rect.width, rect.height), rect.width, rect.height);
  const map = buildReverseMap(Math.min(320, img.width), Math.min(240, img.height), adapted);
  console.log(`[inspect] 输出 ${plan.width}×${plan.height} (${mode}), 有效 ${(rect.stats.validFraction * 100).toFixed(2)}%`);
  console.log(`[inspect] 反向映射样本 ${map.width}×${map.height}: 模型外 ${map.stats.outsideModel}, 越界 ${map.stats.outOfFrame}, 最大迭代 ${map.stats.maxIterations}`);
  await writeJson(resolve(outDir, 'inspect-report.json'), {
    image: { width: img.width, height: img.height },
    plan: { width: plan.width, height: plan.height, offsetX: plan.offsetX, offsetY: plan.offsetY, stepX: plan.stepX, stepY: plan.stepY, mode, notes: plan.notes, warnings: plan.warnings },
    renderStats: rect.stats,
    reverseMapSample: { width: map.width, height: map.height, stats: map.stats },
    calibration: formatCalibration(adapted),
  });
  await writeJson(resolve(outDir, 'inspect-adaptive-calibration.json'), adapted);
  console.log(`[inspect] 写入 ${outDir}/inspect-rectified.png, inspect-report.json`);
}

function fmt(v) {
  return v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(4);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] || 'evaluate';
  try {
    if (cmd === 'generate') await cmdGenerate(args);
    else if (cmd === 'evaluate') await cmdEvaluate(args);
    else if (cmd === 'all') { await cmdGenerate(args); await cmdEvaluate(args); }
    else if (cmd === 'inspect') await cmdInspect(args);
    else if (cmd === 'adapt') {
      const p = args.calibration;
      if (!p) throw new Error('用法: adapt --calibration <json> --width W --height H');
      const cal = await readJson(resolve(p));
      const w = Math.round(num(args.width, cal.intrinsics.referenceWidth));
      const h = Math.round(num(args.height, cal.intrinsics.referenceHeight));
      const adapted = adaptCalibrationToSize(cal, w, h);
      const out = resolve(args.out || `${p.replace(/\.json$/, '')}-${w}x${h}.json`);
      await writeFile(out, `${JSON.stringify(adapted, null, 2)}\n`);
      console.log(describeResolutionRelation(cal, w, h).message);
      console.log(`写入 ${out}`);
    } else {
      console.log('命令: generate | evaluate | all | inspect | adapt');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`错误: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exitCode = 1;
  }
}

main();
