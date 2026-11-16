import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDefaultScene, generateDistortedImage } from '../src/core/synthetic.js';
import { planOutput } from '../src/core/projection.js';
import { renderRectified } from '../src/core/render.js';
import { validateCalibration } from '../src/core/calibration.js';
import { diagnoseRectification, CAUSE, STAGES } from '../src/core/diagnosis.js';

const execFileAsync = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../tools/wideangle-cli.mjs');

const cache = {};

/** Small real pipeline: known ground-truth calibration on a synthetic photo. */
async function pipeline(mode = 'preserve-field') {
  cache[mode] ||= (() => {
    const scene = makeDefaultScene(400, 300);
    const distorted = generateDistortedImage(scene.calibration, scene.grid);
    const plan = planOutput(scene.calibration, scene.width, scene.height, mode, { padding: 0 });
    const rect = renderRectified(distorted.rgba, distorted.width, distorted.height, plan, scene.calibration.distortion, {
      fillColor: scene.calibration.projection.fillColor,
    });
    return { scene, distorted, plan, rect };
  })();
  return cache[mode];
}

test('diagnosis builds a stage-located evidence chain with bounded anomalies', async () => {
  const { scene, plan, rect } = await pipeline();
  const d = diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'preserve-field',
    plan,
    rect,
  });
  assert.deepEqual(d.evidenceChain.map((s) => s.stage), [...STAGES]);
  assert.ok(rect.stats.outOfFrame > 0, 'preserve-field must have out-of-frame pixels');
  const coverage = d.causes.find((c) => c.id === CAUSE.COVERAGE);
  assert.ok(coverage, 'insufficient-coverage cause expected');
  assert.equal(coverage.stage, 'render');
  assert.ok(coverage.evidence.outOfFrame === rect.stats.outOfFrame);

  const render = d.evidenceChain.find((s) => s.stage === 'render');
  assert.ok(render.measurements.anomalies.length <= 48, 'anomaly cap');
  assert.ok(render.measurements.regions.length <= 8, 'region cap');
  for (const a of render.measurements.anomalies) {
    assert.equal(a.stage, 'render');
    assert.ok(Number.isFinite(a.destination.x) && Number.isFinite(a.destination.y));
    assert.ok(['non-finite', 'extreme-distortion', 'edge-out-of-frame', 'unclassified'].includes(a.cause));
    assert.equal(a.validMaxRadius, scene.calibration.distortion.validMaxNormalizedRadius);
  }
  assert.equal(d.logBudget.anomaliesRecorded + d.logBudget.anomaliesDropped, rect.stats.invalid);
  assert.equal(d.verdict, 'ok', `healthy run should be ok, got ${d.verdict}: ${d.summary}`);
});

test('log cost stays bounded under tiny caps and dropped entries are counted', async () => {
  const { scene, plan, rect } = await pipeline();
  const d = diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'preserve-field',
    plan,
    rect,
    limits: { maxAnomalies: 5, maxRegions: 2, samplesPerRegion: 1 },
  });
  const render = d.evidenceChain.find((s) => s.stage === 'render');
  assert.ok(render.measurements.anomalies.length <= 5);
  assert.ok(render.measurements.regions.length <= 2);
  assert.ok(d.logBudget.truncated);
  assert.ok(d.logBudget.anomaliesDropped > 0);
  assert.equal(d.logBudget.anomaliesRecorded + d.logBudget.anomaliesDropped, rect.stats.invalid);
});

test('diagnosis never paints over failed pixels: render buffers are untouched', async () => {
  const { scene, plan, rect } = await pipeline();
  const rgbaBefore = Buffer.from(rect.rgba.buffer, rect.rgba.byteOffset, rect.rgba.byteLength).toString('base64');
  const maskBefore = Buffer.from(rect.invalidMask.buffer).toString('base64');
  diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'preserve-field',
    plan,
    rect,
  });
  assert.equal(Buffer.from(rect.rgba.buffer, rect.rgba.byteOffset, rect.rgba.byteLength).toString('base64'), rgbaBefore);
  assert.equal(Buffer.from(rect.invalidMask.buffer).toString('base64'), maskBefore);
});

test('known radial transform separates parameter-scale mismatch from healthy runs', async () => {
  const { scene, plan, rect } = await pipeline();
  const healthy = diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'preserve-field',
    plan,
    rect,
  });
  assert.ok(!healthy.causes.some((c) => c.id === CAUSE.PARAM_SCALE));
  const model = healthy.evidenceChain.find((s) => s.stage === 'model');
  assert.equal(model.measurements.frameInsideModelFraction, 1);
  assert.ok(model.measurements.roundTrip.maxError < 1e-5);

  // Intrinsics authored in the wrong unit (e.g. millimetres) on a pixel frame.
  const wrongUnits = {
    formatVersion: 1,
    model: 'brown-conrady',
    source: { width: 120, height: 90 },
    intrinsics: { referenceWidth: 120, referenceHeight: 90, fx: 24, fy: 24, cx: 12, cy: 9 },
    distortion: {
      k1: -0.42, k2: 0.19, k3: -0.028, p1: 0.004, p2: -0.003,
      validMaxNormalizedRadius: 1.06,
      modelConfig: { radialOrder: 6, tangential: true },
    },
    projection: { mode: 'preserve-field', fillColor: [16, 20, 28, 255] },
  };
  validateCalibration(wrongUnits); // syntactically valid; the scale is the problem
  const w = 120;
  const h = 90;
  const src = new Uint8ClampedArray(w * h * 4).fill(255);
  const badPlan = planOutput(wrongUnits, w, h, 'preserve-field');
  const badRect = renderRectified(src, w, h, badPlan, wrongUnits.distortion, {});
  const sick = diagnoseRectification({
    calibration: wrongUnits,
    sourceWidth: w,
    sourceHeight: h,
    mode: 'preserve-field',
    plan: badPlan,
    rect: badRect,
  });
  const param = sick.causes.find((c) => c.id === CAUSE.PARAM_SCALE);
  assert.ok(param, 'parameter-scale cause expected for wrong-unit intrinsics');
  assert.equal(param.stage, 'model');
  assert.equal(param.severity, 'fail');
  assert.ok(param.evidence.frameInsideModelFraction < 0.2);
  assert.equal(sick.verdict, 'broken');
});

test('a starved inverse budget is reported as inversion non-convergence', async () => {
  const { scene, plan, rect } = await pipeline();
  const d = diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'preserve-field',
    plan,
    rect,
    inverse: { maxIterations: 2, tolerance: 1e-12, maxStepNormalized: 0.6 },
  });
  const cause = d.causes.find((c) => c.id === CAUSE.NON_CONVERGENCE);
  assert.ok(cause, 'non-convergence cause expected');
  assert.equal(cause.stage, 'reverse-map');
  assert.ok(cause.evidence.iterationsExhausted > 0);
  const rmap = d.evidenceChain.find((s) => s.stage === 'reverse-map');
  assert.ok(rmap.measurements.iterationsExhausted > 0);
});

test('coordinate residuals above threshold are located at the measure stage', async () => {
  const { scene, plan, rect } = await pipeline();
  const d = diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'preserve-field',
    plan,
    rect,
    evaluation: {
      coordinateResidual: {
        rmsPx: 3.5,
        maxPx: 9.25,
        count: 3,
        points: [
          { ideal: { x: 84, y: 42 }, errorPx: 9.25 },
          { ideal: { x: 168, y: 126 }, errorPx: 2.1 },
          { ideal: { x: 252, y: 210 }, errorPx: 1.4 },
        ],
      },
      thresholds: scene.thresholds,
      units: 'source-pixel',
    },
  });
  const cause = d.causes.find((c) => c.id === CAUSE.RESIDUAL);
  assert.ok(cause, 'residual cause expected');
  assert.equal(cause.stage, 'measure');
  assert.equal(cause.evidence.topPoints[0].errorPx, 9.25);
  const measure = d.evidenceChain.find((s) => s.stage === 'measure');
  assert.equal(measure.measurements.rmsPx, 3.5);
  assert.ok(measure.measurements.topPoints.length <= 8);
});

test('crop mode with full coverage yields a clean render stage', async () => {
  const { scene, plan, rect } = await pipeline('crop');
  assert.equal(rect.stats.invalid, 0);
  const d = diagnoseRectification({
    calibration: scene.calibration,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    mode: 'crop',
    plan,
    rect,
  });
  const render = d.evidenceChain.find((s) => s.stage === 'render');
  assert.equal(render.measurements.regionCount, 0);
  assert.equal(render.measurements.anomalies.length, 0);
  assert.ok(!d.causes.some((c) => c.stage === 'render'));
  assert.equal(d.verdict, 'ok');
});

test('CLI diagnose refuses to mask a missing calibration with defaults', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, 'diagnose', '--image', 'no-such.png']),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /必须同时提供/);
      return true;
    },
  );
});

test('CLI diagnose rejects an invalid --max-anomalies instead of defaulting', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, 'diagnose', '--image', 'a.png', '--calibration', 'b.json', '--max-anomalies=abc']),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--max-anomalies/);
      return true;
    },
  );
});
