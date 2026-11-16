import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL, createDefaultCalibration, adaptCalibrationToSize, describeResolutionRelation,
  validateCalibration, getIntrinsicsAtSize, ParameterError,
} from '../src/core/calibration.js';
import {
  distortNormalized, forwardNormalized, undistortedToDistorted, distortedToUndistorted,
  inverseNormalized, radialScale, buildReverseMap, INVERSE_DEFAULTS,
} from '../src/core/model.js';
import { planOutput, measureFieldBounds, measureCropRect, destinationToSource } from '../src/core/projection.js';
import { renderRectified } from '../src/core/render.js';

const strong = () => ({
  formatVersion: 1,
  model: MODEL,
  source: { width: 1200, height: 900 },
  intrinsics: { referenceWidth: 1200, referenceHeight: 900, fx: 1020, fy: 1020, cx: 648, cy: 418.5 },
  distortion: {
    k1: -0.42, k2: 0.19, k3: -0.028, p1: 0.004, p2: -0.003,
    validMaxNormalizedRadius: 1.06,
    modelConfig: { radialOrder: 6, tangential: true },
  },
  projection: { mode: 'preserve-field', fillColor: [16, 20, 28, 255] },
});

test('model is explicitly declared and validated', () => {
  const cal = strong();
  assert.equal(validateCalibration(cal).calibration.model, MODEL);
  assert.throws(() => validateCalibration({ ...cal, model: 'kannala-brandt' }), (e) => e.code === 'INVALID_CALIBRATION' || e.code === 'MODEL');
  const noCfg = JSON.parse(JSON.stringify(cal));
  noCfg.distortion.modelConfig = { radialOrder: 5, tangential: true };
  assert.throws(() => validateCalibration(noCfg), (e) => e.errors?.some((x) => x.code === 'RADIAL_ORDER'));
});

test('radial order and tangential toggle actually change the model', () => {
  const base = strong();
  const order2 = { ...base.distortion, modelConfig: { radialOrder: 2, tangential: false } };
  const order6 = base.distortion;
  const a = forwardNormalized(0.7, 0.35, order2);
  const b = forwardNormalized(0.7, 0.35, order6);
  assert.ok(Math.abs(a.x - b.x) > 0.01, 'radial order must change forward mapping');
  const noTang = forwardNormalized(0.7, 0.35, { ...order6, modelConfig: { radialOrder: 6, tangential: false } });
  assert.ok(Math.abs(noTang.x - b.x) > 1e-5, 'tangential toggle must change mapping');
  const r2 = 0.7 * 0.7 + 0.35 * 0.35;
  const expectedRadial = 1 + order6.k1 * r2;
  assert.ok(Math.abs(radialScale(r2, order2) - expectedRadial) < 1e-12);
});

test('round trip forward then inverse converges over the valid disk', () => {
  const cal = strong();
  const d = cal.distortion;
  const vmax = d.validMaxNormalizedRadius;
  let maxErr = 0;
  for (let i = 0; i < 40; i++) {
    const r = vmax * Math.sqrt((i + 0.5) / 40);
    for (let j = 0; j < 24; j++) {
      const th = (2 * Math.PI * j) / 24;
      const x = r * Math.cos(th);
      const y = r * Math.sin(th);
      const f = distortNormalized(x, y, d);
      const inv = inverseNormalized(f.xd, f.yd, d, { maxIterations: 80, tolerance: 1e-9, maxStepNormalized: 0.6 });
      assert.notEqual(inv.status, 'diverged');
      maxErr = Math.max(maxErr, Math.hypot(inv.x - x, inv.y - y));
    }
  }
  assert.ok(maxErr < 1e-5, `max round-trip error ${maxErr}`);
});

test('inverse reports explicit stopping condition and never loops unbounded', () => {
  const cal = strong();
  const d = cal.distortion;
  const f = distortNormalized(0.9, 0.2, d);
  const tight = inverseNormalized(f.xd, f.yd, d, { maxIterations: 3, tolerance: 1e-15, maxStepNormalized: 1e-4, maxBacktracks: 1 });
  assert.ok(['iterations-exhausted', 'stalled', 'converged'].includes(tight.status));
  assert.equal(tight.iterations <= 3, true);
  assert.ok(Number.isFinite(tight.x) && Number.isFinite(tight.y));

  const normal = inverseNormalized(f.xd, f.yd, d, INVERSE_DEFAULTS);
  assert.ok(normal.iterations <= INVERSE_DEFAULTS.maxIterations);
  assert.ok(normal.residual <= 1e-4);
});

test('invalid parameters are rejected rather than producing infinite work', () => {
  const cal = strong();
  const bad = JSON.parse(JSON.stringify(cal));
  bad.distortion.k1 = -80; // non-monotonic inside valid radius
  assert.throws(() => validateCalibration(bad), (e) => e instanceof ParameterError && e.errors.some((x) => ['NON_MONOTONIC', 'NON_POSITIVE_SCALE', 'EXTREME_SCALE'].includes(x.code)));

  const nan = JSON.parse(JSON.stringify(cal));
  nan.intrinsics.fx = Number.NaN;
  assert.throws(() => validateCalibration(nan));

  const inf = JSON.parse(JSON.stringify(cal));
  inf.distortion.validMaxNormalizedRadius = Infinity;
  assert.throws(() => validateCalibration(inf));

  const outOfFrame = JSON.parse(JSON.stringify(cal));
  outOfFrame.intrinsics.cx = 5000;
  assert.throws(() => validateCalibration(outOfFrame));
});

test('resolution change scales pixel intrinsics, not dimensionless coefficients', () => {
  const cal = strong();
  const half = adaptCalibrationToSize(cal, 600, 450);
  assert.equal(half.intrinsics.fx, 510);
  assert.equal(half.intrinsics.cx, 324);
  assert.equal(half.intrinsics.cy, 209.25);
  assert.equal(half.distortion.k1, cal.distortion.k1);
  assert.equal(half.distortion.k2, cal.distortion.k2);
  assert.equal(half.distortion.validMaxNormalizedRadius, cal.distortion.validMaxNormalizedRadius);

  // Same normalized point must map to the same normalized distorted point.
  const a = getIntrinsicsAtSize(cal, 1200, 900);
  const b = getIntrinsicsAtSize(cal, 600, 450);
  const pa = undistortedToDistorted(700, 500, a, cal.distortion);
  const pb = undistortedToDistorted(350, 250, b, cal.distortion);
  assert.ok(Math.abs(pa.radius - pb.radius) < 1e-12);
  assert.ok(Math.abs(pa.x / 2 - pb.x) < 1e-9);
  assert.ok(Math.abs(pa.y / 2 - pb.y) < 1e-9);

  // Non-proportional resize is reported, never silently pretended to be native.
  const rel = describeResolutionRelation(cal, 1200, 700);
  assert.equal(rel.native, false);
  assert.ok(rel.scale.y !== rel.scale.x);
});

test('output framing is measured from the mapping, not a fixed rectangle', () => {
  const cal = strong();
  const field = measureFieldBounds(cal, 1200, 900, { boundarySamples: 240 });
  assert.ok(field.bounds.width > 1200 && field.bounds.height > 900, 'barrel distortion widens the ideal field');
  const pf = planOutput(cal, 1200, 900, 'preserve-field');
  assert.ok(pf.width > 1200);
  assert.ok(Math.abs(pf.width / pf.height - field.bounds.width / field.bounds.height) < 0.01);

  const crop = planOutput(cal, 1200, 900, 'crop');
  assert.equal(crop.coverage.crop.scale >= 0.02, true);
  assert.ok(crop.width > 0 && crop.height > 0);
  assert.ok(Math.abs(crop.width / crop.height - 1200 / 900) < 0.01, 'crop keeps source aspect without stretching');

  const wide = JSON.parse(JSON.stringify(cal));
  wide.distortion.k1 = -0.1;
  wide.distortion.k2 = 0.01;
  const pf2 = planOutput(wide, 1200, 900, 'preserve-field');
  assert.ok(Math.abs(pf2.width / pf2.height - pf.width / pf.height) > 1e-4, 'different model gives different framing');
});

test('crop mode rejects a request it cannot satisfy instead of fabricating output', () => {
  const cal = strong();
  cal.distortion.validMaxNormalizedRadius = 0.25;
  // The centre itself is still valid for this model, so crop succeeds at a
  // measured small scale; forcing a sub-valid radius around the point is the
  // real failure case and must throw rather than pretend.
  const tiny = measureCropRect(cal, 1200, 900);
  assert.ok(tiny.width < 1200 && tiny.height < 900);
  cal.distortion.validMaxNormalizedRadius = 0.004;
  assert.throws(() => measureCropRect(cal, 1200, 900), (e) => e.code === 'CROP_TOO_SMALL' || e.code === 'EMPTY_FIELD');
});

test('reverse map marks outside-model and out-of-frame pixels as invalid', () => {
  const cal = strong();
  const map = buildReverseMap(160, 120, cal, { inverse: { maxIterations: 40, tolerance: 1e-7, maxStepNormalized: 0.5 } });
  assert.equal(map.valid.length, map.width * map.height);
  assert.ok(map.stats.invalid > 0, 'some destination pixels must be outside the source frame');
  let invalidMarked = 0;
  for (let i = 0; i < map.valid.length; i++) {
    if (map.valid[i] === 0) {
      invalidMarked++;
      const u = map.coords[i * 2];
      const v = map.coords[i * 2 + 1];
      const insideFrame = u >= -0.5 && v >= -0.5 && u <= map.width - 0.5 && v <= map.height - 0.5;
      const r = Math.hypot((u - map.intr.cx) / map.intr.fx, (v - map.intr.cy) / map.intr.fy);
      assert.ok(!insideFrame || r > cal.distortion.validMaxNormalizedRadius);
    }
  }
  assert.equal(invalidMarked, map.stats.invalid);
});

test('renderer fills invalid regions with the configured colour and never samples out of bounds', () => {
  const cal = strong();
  const w = 120;
  const h = 90;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    src[i * 4] = 20; src[i * 4 + 1] = 30; src[i * 4 + 2] = 200; src[i * 4 + 3] = 255;
  }
  const plan = planOutput(cal, w, h, 'preserve-field');
  const fill = [200, 10, 10, 255];
  const out = renderRectified(src, w, h, plan, cal.distortion, { fillColor: fill });
  assert.equal(out.stats.pixels, out.stats.sampled + out.stats.invalid);
  let fillSeen = 0;
  for (let i = 0; i < out.invalidMask.length; i++) {
    if (!out.invalidMask[i]) continue;
    fillSeen++;
    assert.equal(out.rgba[i * 4], fill[0]);
    assert.equal(out.rgba[i * 4 + 1], fill[1]);
    assert.equal(out.rgba[i * 4 + 2], fill[2]);
  }
  assert.equal(fillSeen, out.stats.invalid);
  assert.ok(out.stats.validFraction > 0.2);
});

test('destinationToSource agrees with forward mapping and flags validity', () => {
  const cal = strong();
  const plan = planOutput(cal, 1200, 900, 'preserve-field');
  const p = destinationToSource(plan, cal.distortion, 10, 10);
  assert.ok(Number.isFinite(p.u) && Number.isFinite(p.sourceX));
  const f = undistortedToDistorted(p.u, p.v, plan.intrinsics, cal.distortion);
  assert.ok(Math.abs(f.x - p.sourceX) < 1e-9);
  assert.equal(p.valid, p.insideModel && p.inFrame);
});

test('strong distortion with shifted centre still produces a valid plan', () => {
  const cal = strong();
  cal.intrinsics.cx = 1200 * 0.18;
  cal.intrinsics.cy = 900 * 0.82;
  const plan = planOutput(cal, 1200, 900, 'preserve-field');
  assert.ok(plan.width > 0 && plan.height > 0);
  assert.ok(plan.offsetX < plan.width);
  const crop = planOutput(cal, 1200, 900, 'crop');
  assert.ok(crop.width * crop.height > 1000);
});
