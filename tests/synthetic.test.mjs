import test from 'node:test';
import assert from 'node:assert/strict';

import { makeDefaultScene, generateDistortedImage, makeApproximateCalibration } from '../src/core/synthetic.js';
import {
  detectMarkers, matchPoints, fitCalibration, measureLineBending, measureRoundTrip, evaluateRectification,
} from '../src/core/analysis.js';
import { planOutput } from '../src/core/projection.js';
import { renderRectified } from '../src/core/render.js';
import { validateCalibration } from '../src/core/calibration.js';

const cache = {};

async function buildScene() {
  if (!cache.scene) {
    const scene = makeDefaultScene(1200, 900);
    const distorted = generateDistortedImage(scene.calibration, scene.grid);
    cache.scene = scene;
    cache.distorted = distorted;
  }
  return cache;
}

function fitFromScene(scene, distorted) {
  const detected = detectMarkers(distorted.rgba, distorted.width, distorted.height);
  const visible = scene.visibleMarkers;
  const pairs = matchPoints(detected, visible.map((p) => p.observed), 16);
  const usedD = new Set();
  const usedT = new Set();
  const fitPoints = [];
  const matchedVisible = [];
  for (const p of pairs) {
    if (usedD.has(p.detected) || usedT.has(p.expected)) continue;
    usedD.add(p.detected);
    usedT.add(p.expected);
    matchedVisible.push(visible[p.expected]);
    fitPoints.push({
      ideal: visible[p.expected].ideal,
      observed: { x: detected[p.detected].x, y: detected[p.detected].y },
      truthObserved: visible[p.expected].observed,
    });
  }
  const fit = fitCalibration(fitPoints, makeApproximateCalibration(scene), { freeFocal: false });
  return { detected, fitPoints, matchedVisible, fit };
}

test('synthetic scene is a real resampling with known ground truth', async () => {
  const { scene, distorted } = await buildScene();
  assert.ok(distorted.stats.validFraction > 0.98, 'generated photo should be almost fully valid');
  assert.ok(distorted.stats.meanResidual < 1e-6);
  assert.ok(scene.visibleMarkers.length > 80);
});

test('detected markers match ground truth to well under a pixel', async () => {
  const { scene, distorted } = await buildScene();
  const detected = detectMarkers(distorted.rgba, distorted.width, distorted.height);
  // Clipped edge markers are intentionally excluded from ground truth but may
  // still be detected; require every visible marker to have a close match.
  assert.ok(detected.length >= scene.visibleMarkers.length);
  let maxErr = 0;
  for (const vm of scene.visibleMarkers) {
    let best = Infinity;
    for (const d of detected) best = Math.min(best, Math.hypot(d.x - vm.observed.x, d.y - vm.observed.y));
    maxErr = Math.max(maxErr, best);
  }
  assert.ok(maxErr < 0.3, `marker detection error ${maxErr}`);
});

test('fitted model recovers ground truth parameters and reprojects accurately', async () => {
  const { scene, distorted } = await buildScene();
  const { fit, fitPoints } = fitFromScene(scene, distorted);
  assert.equal(fit.status, 'converged');
  assert.ok(fit.rmsPx < 0.5, `fit RMS ${fit.rmsPx}`);
  assert.ok(Math.abs(fit.calibration.distortion.k1 - scene.calibration.distortion.k1) < 0.01);
  assert.ok(Math.abs(fit.calibration.distortion.k2 - scene.calibration.distortion.k2) < 0.01);
  assert.ok(Math.abs(fit.calibration.distortion.k3 - scene.calibration.distortion.k3) < 0.005);
  assert.ok(Math.abs(fit.calibration.intrinsics.cx - scene.calibration.intrinsics.cx) < 1.5);
  assert.ok(Math.abs(fit.calibration.intrinsics.cy - scene.calibration.intrinsics.cy) < 1.5);
  validateCalibration(fit.calibration);
  assert.ok(fitPoints.length > 80);
});

test('model orders are distinguishable: higher order reduces residual for strong distortion', async () => {
  const { scene, distorted } = await buildScene();
  const { fitPoints } = fitFromScene(scene, distorted);
  const start = makeApproximateCalibration(scene);
  const results = {};
  for (const cfg of [{ radialOrder: 2, tangential: false }, { radialOrder: 4, tangential: false }, { radialOrder: 6, tangential: true }]) {
    const s = JSON.parse(JSON.stringify(start));
    s.distortion.modelConfig = cfg;
    results[cfg.radialOrder] = fitCalibration(fitPoints, s, { freeFocal: false }).rmsPx;
  }
  assert.ok(results[2] > results[4], `2nd order ${results[2]} should be worse than 4th ${results[4]}`);
  assert.ok(results[4] > results[6], `4th order ${results[4]} should be worse than 6th ${results[6]}`);
  assert.ok(results[6] < 0.5);
});

test('rectification removes measured line bending by a large factor', async () => {
  const { scene, distorted } = await buildScene();
  const { fit, detected, fitPoints, matchedVisible } = fitFromScene(scene, distorted);
  const plan = planOutput(fit.calibration, scene.width, scene.height, 'preserve-field', { padding: 0 });
  const rectified = renderRectified(distorted.rgba, distorted.width, distorted.height, plan, fit.calibration.distortion, { sampling: 'bilinear' });
  const evaluation = evaluateRectification({
    scene, distorted, rectified, plan, calibration: fit.calibration,
    detection: { markers: detected, fitPoints, matchedVisible }, fit,
  });
  assert.ok(evaluation.pass, JSON.stringify(evaluation.checks));
  assert.ok(evaluation.coordinateResidual.rmsPx < 0.5, `coordinate RMS ${evaluation.coordinateResidual.rmsPx}`);
  assert.ok(evaluation.lineBending.rectified.rmsSourcePx < 0.4, `bending ${evaluation.lineBending.rectified.rmsSourcePx}`);
  assert.ok(evaluation.lineBending.improvementRatio > 10, `improvement ${evaluation.lineBending.improvementRatio}`);
});

test('round-trip solver stays within budget over the valid disk', async () => {
  const { scene } = await buildScene();
  const rt = measureRoundTrip(scene.calibration, 120);
  assert.ok(rt.maxNormalized < 1e-5, `max ${rt.maxNormalized}`);
  assert.ok(rt.rmsNormalized < 1e-6);
});

test('without correction the lines are measurably bent', async () => {
  const { scene, distorted } = await buildScene();
  const { makeGroundTruthMapper, buildGuidesForGrid } = await import('../src/core/analysis.js');
  const mapper = makeGroundTruthMapper(scene.calibration);
  const guides = buildGuidesForGrid(scene.grid, mapper, { margin: 24, samples: 90 });
  const bend = measureLineBending(distorted.rgba, distorted.width, distorted.height, guides, { searchRadius: 10, markers: scene.grid.markers });
  assert.ok(bend.summary.rmsPx > 3, `distorted bending ${bend.summary.rmsPx}`);
  assert.ok(bend.summary.lineCount >= 20);
});

test('crop mode yields a fully valid measured rectangle', async () => {
  const { scene, distorted } = await buildScene();
  const { fit } = fitFromScene(scene, distorted);
  const plan = planOutput(fit.calibration, scene.width, scene.height, 'crop');
  const rect = renderRectified(distorted.rgba, distorted.width, distorted.height, plan, fit.calibration.distortion, {});
  const invalid = rect.stats.invalid;
  assert.equal(invalid, 0, `crop should have no invalid pixels, got ${invalid}`);
  assert.ok(Math.abs(plan.width / plan.height - scene.width / scene.height) < 0.01);
  assert.ok(plan.width < scene.width * 1.5);
});

test('one dragged correspondence is rejected instead of degrading the fit', async () => {
  const { scene, distorted } = await buildScene();
  const { fitPoints } = fitFromScene(scene, distorted);
  const start = makeApproximateCalibration(scene);
  const baseline = fitCalibration(fitPoints, JSON.parse(JSON.stringify(start)), { freeFocal: false });
  const mid = fitPoints.length >> 1;
  const dragged = fitPoints.map((p, i) => (i === mid
    ? { ideal: p.ideal, observed: { x: p.observed.x + 40, y: p.observed.y + 30 } }
    : p));
  const robust = fitCalibration(dragged, JSON.parse(JSON.stringify(start)), { freeFocal: false });
  assert.equal(robust.outliers.length, 1, 'exactly the dragged point should be reported');
  assert.equal(robust.inlierCount, fitPoints.length - 1);
  assert.ok(robust.rmsPx < baseline.rmsPx * 1.5, `robust rms ${robust.rmsPx} vs ${baseline.rmsPx}`);
  assert.ok(Math.abs(robust.calibration.distortion.k1 - baseline.calibration.distortion.k1) < 0.02);
});

test('valid radius is clamped to the measured monotonic range for a weak model', async () => {
  const { scene, distorted } = await buildScene();
  const { fitPoints } = fitFromScene(scene, distorted);
  const start = makeApproximateCalibration(scene);
  start.distortion.modelConfig = { radialOrder: 2, tangential: true };
  const weak = fitCalibration(fitPoints, JSON.parse(JSON.stringify(start)), { freeFocal: false });
  const { clampValidRadius, validateCalibration } = await import('../src/core/calibration.js');
  const notice = clampValidRadius(weak.calibration);
  assert.ok(notice.changed, '2nd-order fit must report a narrower valid radius');
  assert.ok(notice.applied < 1.06);
  validateCalibration(weak.calibration);
  const plan = planOutput(weak.calibration, scene.width, scene.height, 'preserve-field');
  assert.ok(plan.width > 2 && plan.height > 2);
});
