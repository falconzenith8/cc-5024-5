/**
 * Synthetic wide-angle test scene.
 *
 * The physical scene is a perfectly straight grid drawn on an ideal plane.
 * A known strong Brown-Conrady model with an off-centre principal point
 * photographs that plane. The observed raster is produced by inverse-mapping
 * every observed pixel to plane coordinates and sampling the chart, so it is
 * a real resampling of a known scene.
 *
 * The plane is larger than the observed frame: with barrel distortion the
 * observed border corresponds to a wider ideal field, so the chart is drawn
 * over the *measured* ideal field. Rectification should recover that chart.
 */

import { getIntrinsicsAtSize } from './calibration.js';
import { inverseNormalized, distortNormalized } from './model.js';
import { measureFieldBounds } from './projection.js';

export const GRID_DEFAULTS = Object.freeze({
  spacing: 84,
  lineWidth: 1.5,
  majorEvery: 4,
  markerRadius: 4.5,
  background: [22, 26, 34],
  lineColor: [205, 214, 226],
  majorColor: [245, 248, 252],
  markerColor: [250, 150, 62],
  outsideColor: [10, 12, 16],
});

export function makeDefaultScene(width = 1200, height = 900) {
  width = Math.round(width);
  height = Math.round(height);
  const calibration = {
    formatVersion: 1,
    model: 'brown-conrady',
    source: { width, height, label: 'synthetic-ground-truth' },
    intrinsics: {
      referenceWidth: width,
      referenceHeight: height,
      fx: width * 0.85,
      fy: width * 0.85,
      cx: width / 2 + width * 0.04,
      cy: height / 2 - height * 0.035,
    },
    distortion: {
      k1: -0.42,
      k2: 0.19,
      k3: -0.028,
      p1: 0.004,
      p2: -0.003,
      validMaxNormalizedRadius: 1.06,
      edgeMode: 'background',
      modelConfig: { radialOrder: 6, tangential: true },
    },
    projection: { mode: 'preserve-field', fillColor: [16, 20, 28, 255] },
  };

  // Ideal field of the observed frame under the ground-truth model.
  const field = measureFieldBounds(calibration, width, height, {
    inverse: { maxIterations: 80, tolerance: 1e-9, maxStepNormalized: 0.6 },
    boundarySamples: 900,
  });
  const b = field.bounds; // undistorted pixel coordinates
  const chartOuter = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
  const spacing = GRID_DEFAULTS.spacing;
  // Extend to whole grid periods for a tidy straight-line chart.
  const chart = {
    minX: Math.floor((b.minX - spacing * 0.45) / spacing) * spacing,
    minY: Math.floor((b.minY - spacing * 0.45) / spacing) * spacing,
    maxX: Math.ceil((b.maxX + spacing * 0.45) / spacing) * spacing,
    maxY: Math.ceil((b.maxY + spacing * 0.45) / spacing) * spacing,
  };
  chart.width = chart.maxX - chart.minX;
  chart.height = chart.maxY - chart.minY;
  const grid = buildGridSpec(chart, spacing, { markerInset: spacing * 0.55 });
  const calibrationPoints = buildCalibrationPoints(calibration, grid);
  const vmax = calibration.distortion.validMaxNormalizedRadius;
  const margin = GRID_DEFAULTS.markerRadius + 3;
  // Only markers whose full disk lands in the observed frame and inside the
  // model's valid radius are treated as visible ground truth; clipped edge
  // markers would bias detection comparisons.
  const visibleMarkers = calibrationPoints.filter((p) => (
    p.observed.x >= margin && p.observed.y >= margin
    && p.observed.x <= width - 1 - margin && p.observed.y <= height - 1 - margin
    && p.radius <= vmax
  ));

  return {
    name: 'strong-barrel-offset',
    width,
    height,
    calibration,
    grid,
    chart,
    chartOuter,
    calibrationPoints,
    visibleMarkers,
    thresholds: {
      markerRmsPx: 0.8,
      markerMaxPx: 2.2,
      lineBendingRmsPx: 0.45,
      lineBendingMaxPx: 1.4,
      minimumImprovement: 3,
      roundTripNormalized: 1e-4,
    },
  };
}

export function buildGridSpec(chart, spacing, overrides = {}) {
  const spec = { ...GRID_DEFAULTS, ...overrides };
  const vertical = [];
  const horizontal = [];
  for (let x = chart.minX + spacing; x <= chart.maxX - spacing * 0.4; x += spacing) vertical.push(x);
  for (let y = chart.minY + spacing; y <= chart.maxY - spacing * 0.4; y += spacing) horizontal.push(y);
  const inset = spec.markerInset ?? spacing * 0.55;
  const markers = [];
  vertical.forEach((x, ix) => {
    horizontal.forEach((y, iy) => {
      if (x < chart.minX + inset || x > chart.maxX - inset) return;
      if (y < chart.minY + inset || y > chart.maxY - inset) return;
      // Marker grid period 2x2 lines to keep detection unambiguous.
      if ((ix + iy) % 2 !== 0) return;
      markers.push({ x, y });
    });
  });
  return { ...spec, chart, vertical, horizontal, markers };
}

export function buildCalibrationPoints(calibration, grid) {
  const width = calibration.source.width;
  const height = calibration.source.height;
  const intr = getIntrinsicsAtSize(calibration, width, height);
  return grid.markers.map((p, index) => {
    const x = (p.x - intr.cx) / intr.fx;
    const y = (p.y - intr.cy) / intr.fy;
    const f = distortNormalized(x, y, calibration.distortion);
    return {
      id: `P${index + 1}`,
      ideal: { x: p.x, y: p.y },
      observed: { x: f.xd * intr.fx + intr.cx, y: f.yd * intr.fy + intr.cy },
      radius: Math.sqrt(x * x + y * y),
    };
  });
}

/** Colour of the ideal (undistorted) chart at continuous plane coordinates. */
export function sampleIdealPattern(u, v, grid) {
  let r = grid.background[0];
  let g = grid.background[1];
  let b = grid.background[2];
  const half = grid.lineWidth / 2;
  let cov = 0;
  let major = false;
  for (let i = 0; i < grid.vertical.length; i++) {
    const dist = Math.abs(u - grid.vertical[i]);
    if (dist <= half + 1) {
      const c = clamp01(half + 0.5 - dist);
      if (c > cov) { cov = c; major = (i + 1) % grid.majorEvery === 0; }
    }
  }
  for (let i = 0; i < grid.horizontal.length; i++) {
    const dist = Math.abs(v - grid.horizontal[i]);
    if (dist <= half + 1) {
      const c = clamp01(half + 0.5 - dist);
      if (c > cov) { cov = c; major = (i + 1) % grid.majorEvery === 0; }
    }
  }
  if (cov > 0) {
    const c = major ? grid.majorColor : grid.lineColor;
    r = mix(r, c[0], cov); g = mix(g, c[1], cov); b = mix(b, c[2], cov);
  }
  for (const m of grid.markers) {
    if (Math.abs(u - m.x) > grid.markerRadius + 1 || Math.abs(v - m.y) > grid.markerRadius + 1) continue;
    const dist = Math.hypot(u - m.x, v - m.y);
    if (dist <= grid.markerRadius + 1) {
      const c = clamp01(grid.markerRadius + 0.5 - dist);
      r = mix(r, grid.markerColor[0], c);
      g = mix(g, grid.markerColor[1], c);
      b = mix(b, grid.markerColor[2], c);
    }
  }
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

/**
 * Render the observed distorted photo: for each observed pixel, invert the
 * ground-truth model to plane coordinates and sample the chart there.
 */
export function generateDistortedImage(calibration, grid, options = {}) {
  const width = calibration.source.width;
  const height = calibration.source.height;
  const intr = getIntrinsicsAtSize(calibration, width, height);
  const vmax = calibration.distortion.validMaxNormalizedRadius;
  const opts = { maxIterations: 90, tolerance: 1e-9, maxStepNormalized: 0.6, ...(options.inverse || {}) };
  const rgba = new Uint8ClampedArray(width * height * 4);
  const status = new Uint8Array(width * height);
  const stats = {
    width, height, pixels: width * height,
    converged: 0, exhausted: 0, invalid: 0, outsideModel: 0, outsideChart: 0,
    maxIterations: 0, maxResidual: 0, valid: 0,
  };
  let residualSum = 0;
  const outside = grid.outsideColor || GRID_DEFAULTS.outsideColor;
  const chart = grid.chart;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const xd = (px - intr.cx) / intr.fx;
      const yd = (py - intr.cy) / intr.fy;
      const inv = inverseNormalized(xd, yd, calibration.distortion, opts);
      if (inv.iterations > stats.maxIterations) stats.maxIterations = inv.iterations;
      if (inv.residual > stats.maxResidual) stats.maxResidual = inv.residual;
      const r = Math.hypot(inv.x, inv.y);
      const u = inv.x * intr.fx + intr.cx;
      const v = inv.y * intr.fy + intr.cy;
      const inChart = u >= chart.minX && v >= chart.minY && u <= chart.maxX && v <= chart.maxY;      let valid = Number.isFinite(inv.x) && Number.isFinite(inv.y) && r <= vmax && inChart;
      if (r > vmax) valid = false;
      const di = idx * 4;
      if (!valid) {
        rgba[di] = outside[0]; rgba[di + 1] = outside[1]; rgba[di + 2] = outside[2]; rgba[di + 3] = 255;
        status[idx] = 2;
        stats.invalid++;
        if (r > vmax) stats.outsideModel++;
        if (!inChart) stats.outsideChart++;
        continue;
      }
      if (inv.status === 'converged') stats.converged++; else stats.exhausted++;
      residualSum += inv.residual;
      const c = sampleIdealPattern(u, v, grid);
      rgba[di] = c[0]; rgba[di + 1] = c[1]; rgba[di + 2] = c[2]; rgba[di + 3] = 255;
      status[idx] = 1;
    }
  }
  stats.valid = width * height - stats.invalid;
  stats.validFraction = stats.valid / stats.pixels;
  stats.meanResidual = stats.valid ? residualSum / stats.valid : 0;
  return { rgba, width, height, status, stats, calibration };
}

/** Approximate starting calibration: focal from the lens profile, no distortion. */
export function makeApproximateCalibration(scene) {
  const gt = scene.calibration;
  return {
    ...JSON.parse(JSON.stringify(gt)),
    source: { width: scene.width, height: scene.height, label: 'approximate-start' },
    intrinsics: {
      referenceWidth: scene.width,
      referenceHeight: scene.height,
      fx: gt.intrinsics.fx,
      fy: gt.intrinsics.fy,
      cx: (scene.width - 1) / 2,
      cy: (scene.height - 1) / 2,
    },
    distortion: {
      ...gt.distortion,
      k1: 0, k2: 0, k3: 0, p1: 0, p2: 0,
      validMaxNormalizedRadius: gt.distortion.validMaxNormalizedRadius,
    },
  };
}

function mix(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
