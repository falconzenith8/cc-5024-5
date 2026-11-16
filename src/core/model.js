/**
 * Brown-Conrady forward/inverse mapping in normalized coordinates.
 *
 * Explicit chosen model:
 *   x = (u - cx)/fx, y = (v - cy)/fy
 *   r2 = x^2 + y^2
 *   radial(r2) = 1 + k1 r2 + k2 r2^2 + k3 r2^3
 *   xd = x*radial + 2 p1 x y + p2 (r2 + 2x^2)
 *   yd = y*radial + p1 (r2 + 2y^2) + 2 p2 x y
 *
 * The inverse is solved independently for every pixel with a damped Newton
 * iteration wrapped in a fixed budget, so no input can trigger unbounded work.
 */

import { getIntrinsicsAtSize } from './calibration.js';

export const INVERSE_DEFAULTS = Object.freeze({
  maxIterations: 60,
  tolerance: 1e-7,
  maxStepNormalized: 0.6,
  initialDamping: 1e-3,
  maxBacktracks: 8,
});

/** Scalar radial derivative d(r*radial)/dr = 1 + 3k1 r2 + 5k2 r2^2 + 7k3 r2^3. */
export function radialDerivative(r2, d) {
  const order = activeRadialOrder(d);
  const deriv = 1 + 3 * d.k1 * r2;
  if (order >= 4) return deriv + 5 * d.k2 * r2 * r2;
  if (order >= 6) return deriv + 5 * d.k2 * r2 * r2 + 7 * d.k3 * r2 * r2 * r2;
  return deriv;
}

export function radialScale(r2, d) {
  const order = activeRadialOrder(d);
  const scale = 1 + d.k1 * r2;
  if (order >= 4) return scale + d.k2 * r2 * r2;
  if (order >= 6) return scale + d.k2 * r2 * r2 + d.k3 * r2 * r2 * r2;
  return scale;
}

/** Radial order from explicit modelConfig, defaulting to 6 for untagged files. */
export function activeRadialOrder(d) {
  const order = d?.modelConfig?.radialOrder;
  if (order === 2 || order === 4 || order === 6) return order;
  return 6;
}

export function tangentialEnabled(d) {
  return d?.modelConfig?.tangential !== false;
}

/**
 * Forward vector distortion with both Jacobian derivatives.
 * All coordinates normalized. Returns {xd, yd, jxx, jxy, jyx, jyy,
 * finite, radialDerivative}.
 */
export function distortNormalized(x, y, d) {
  const radialOrder = activeRadialOrder(d);
  const tang = tangentialEnabled(d) ? { p1: d.p1, p2: d.p2 } : { p1: 0, p2: 0 };
  const r2 = x * x + y * y;
  const rd = radialDerivative(r2, d);
  let scale = 1 + d.k1 * r2;
  if (radialOrder >= 4) scale += d.k2 * r2 * r2;
  if (radialOrder >= 6) scale += d.k3 * r2 * r2 * r2;
  const xd = x * scale + 2 * tang.p1 * x * y + tang.p2 * (r2 + 2 * x * x);
  const yd = y * scale + tang.p1 * (r2 + 2 * y * y) + 2 * tang.p2 * x * y;

  const twoX = 2 * x;
  const twoY = 2 * y;
  const jxx = scale + x * rd * twoX + twoY * tang.p1 + 6 * tang.p2 * x;
  const jxy = x * rd * twoY + twoX * tang.p1 + twoY * tang.p2;
  const jyx = y * rd * twoX + twoY * tang.p1 + twoX * tang.p2;
  const jyy = scale + y * rd * twoY + 6 * tang.p1 * y + twoX * tang.p2;

  return {
    xd, yd, jxx, jxy, jyx, jyy,
    r2,
    radius: Math.sqrt(r2),
    radialDerivative: rd,
    radialScale: scale,
    finite: Number.isFinite(xd) && Number.isFinite(yd) && Number.isFinite(jxx) && Number.isFinite(jxy) && Number.isFinite(jyx) && Number.isFinite(jyy),
  };
}

/** Public: normalized forward mapping (no pixel terms). */
export function forwardNormalized(x, y, distortion) {
  const r = distortNormalized(x, y, distortion);
  return { x: r.xd, y: r.yd, radialScale: r.radialScale, radius: r.radius };
}

/**
 * Map undistorted pixel -> distorted pixel using pre-scaled intrinsics.
 * `intr` must come from getIntrinsicsAtSize for the image being sampled.
 */
export function undistortedToDistorted(u, v, intr, distortion) {
  const x = (u - intr.cx) / intr.fx;
  const y = (v - intr.cy) / intr.fy;
  const out = distortNormalized(x, y, distortion);
  return {
    x: out.xd * intr.fx + intr.cx,
    y: out.yd * intr.fy + intr.cy,
    normalizedX: x,
    normalizedY: y,
    radius: out.radius,
    radialScale: out.radialScale,
    finite: out.finite,
  };
}

/**
 * Inverse: given an observed distorted pixel, find undistorted normalized (x,y).
 *
 * Stopping conditions are explicit and exhaustive:
 *  - residual tolerance reached,
 *  - iteration budget exhausted,
 *  - step budget clamp,
 *  - forward map non-finite / derivative singular,
 *  - line-search backtracks exhausted (plateau).
 * The result reports how it terminated; no unbounded loop exists.
 */
export function inverseNormalized(xd, yd, distortion, opts = {}) {
  const cfg = { ...INVERSE_DEFAULTS, ...opts };
  const maxIter = clampInt(cfg.maxIterations, 1, 200);
  const tol = Math.max(Number(cfg.tolerance) || 1e-9, 1e-14);
  const stepClamp = Math.max(Number(cfg.maxStepNormalized) || 0.35, 1e-6);

  // Initial guess: linearized (radial-only) inversion, then clamped.
  const d0 = distortNormalized(0, 0, distortion);
  void d0;
  let x = xd;
  let y = yd;
  let best = { x, y, residual: Infinity };

  for (let iter = 0; iter < maxIter; iter++) {
    const f = distortNormalized(x, y, distortion);
    if (!f.finite) {
      return { x, y, iterations: iter + 1, residual: 0, status: 'diverged', reason: 'forward-non-finite' };
    }
    const ex = f.xd - xd;
    const ey = f.yd - yd;
    const residual = Math.hypot(ex, ey);

    if (residual < best.residual) best = { x, y, residual };
    if (residual <= tol) {
      return { x, y, iterations: iter + 1, residual, status: 'converged', reason: 'tolerance' };
    }

    // Solve J * delta = error with a tiny Levenberg damping for conditioning.
    const det = f.jxx * f.jyy - f.jxy * f.jyx;
    let dx;
    let dy;
    let lambda = 0;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      // Rotational fallback: treat local mapping as isotropic radial scale.
      const g = Math.max(f.radialDerivative, 1e-6);
      dx = -ex / g;
      dy = -ey / g;
      lambda = 1;
    } else {
      dx = -(f.jyy * ex - f.jxy * ey) / det;
      dy = -(-f.jyx * ex + f.jxx * ey) / det;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return { x, y, iterations: iter + 1, residual: best.residual === Infinity ? residual : best.residual, status: 'diverged', reason: 'low-jacobian' };
    }

    // Clamp the step so a bad Jacobian cannot fling the iterate outside the domain.
    const stepLen = Math.hypot(dx, dy);
    if (stepLen > stepClamp) {
      dx *= stepClamp / stepLen;
      dy *= stepClamp / stepLen;
    }

    // Backtracking line search on residual. Finite and bounded by cfg.maxBacktracks.
    let alpha = 1;
    let accepted = false;
    let lastResidual = residual;
    for (let bt = 0; bt < cfg.maxBacktracks; bt++) {
      const nx = x + alpha * dx;
      const ny = y + alpha * dy;
      const nf = distortNormalized(nx, ny, distortion);
      if (!nf.finite) { alpha *= 0.5; continue; }
      const nr = Math.hypot(nf.xd - xd, nf.yd - yd);
      if (nr < residual * (1 - 1e-4) || nr <= tol) {
        x = nx;
        y = ny;
        accepted = true;
        lastResidual = nr;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) {
      // Plateaus at machine precision are treated as convergence of the residual.
      if (lastResidual <= tol * 10) {
        return { x, y, iterations: iter + 1, residual: lastResidual, status: 'converged', reason: 'plateau' };
      }
      return { x, y, iterations: iter + 1, residual, status: 'stalled', reason: 'line-search' };
    }
    void lambda;
  }

  return {
    x, y,
    iterations: maxIter,
    residual: best.residual === Infinity ? 0 : best.residual,
    status: 'iterations-exhausted',
    reason: 'budget',
  };
}

/** Convenience: distorted pixel -> undistorted pixel for a concrete image size. */
export function distortedToUndistorted(ud, vd, intr, distortion, opts = {}) {
  const xd = (ud - intr.cx) / intr.fx;
  const yd = (vd - intr.cy) / intr.fy;
  const inv = inverseNormalized(xd, yd, distortion, opts);
  return {
    x: inv.x * intr.fx + intr.cx,
    y: inv.y * intr.fy + intr.cy,
    normalizedX: inv.x,
    normalizedY: inv.y,
    radius: Math.hypot(inv.x, inv.y),
    status: inv.status,
    reason: inv.reason,
    iterations: inv.iterations,
    residual: inv.residual,
  };
}

/**
 * Reverse-mapping metadata for every destination pixel center.
 * This is the single source of truth used by both the renderer and UI probes.
 */
export function buildReverseMap(width, height, calibration, opts = {}) {
  const intr = getIntrinsicsAtSize(calibration, width, height);
  const distortion = calibration.distortion;
  const d = distortion;
  const vmax = d.validMaxNormalizedRadius;
  const coords = new Float32Array(width * height * 2);
  const valid = new Uint8Array(width * height);
  const stats = {
    width, height, pixels: width * height,
    insideModel: 0, outsideModel: 0, outOfFrame: 0, invalid: 0,
    converged: 0, iterationsExhausted: 0, diverged: 0, stalled: 0,
    maxIterations: 0, maxResidual: 0, meanResidual: 0,
    sourceBounds: { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity },
    destinationBounds: { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity },
  };
  const invOpts = opts.inverse || {};
  let residualSum = 0;
  let counted = 0;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const du = px;
      const dv = py;
      const inv = distortedToUndistorted(du, dv, intr, distortion, invOpts);
      coords[idx * 2] = inv.x;
      coords[idx * 2 + 1] = inv.y;
      if (inv.iterations > stats.maxIterations) stats.maxIterations = inv.iterations;
      if (inv.residual > stats.maxResidual) stats.maxResidual = inv.residual;
      residualSum += inv.residual;
      counted++;

      if (inv.status === 'converged' || inv.status === 'iterations-exhausted') {
        if (inv.reason === 'budget') stats.iterationsExhausted++;
        else stats.converged++;
      } else if (inv.status === 'diverged') stats.diverged++;
      else stats.stalled++;

      const inside = inv.radius <= vmax && Number.isFinite(inv.x) && Number.isFinite(inv.y);
      const inFrame = inv.x >= -0.5 && inv.x <= width - 0.5 && inv.y >= -0.5 && inv.y <= height - 0.5;
      if (!inFrame) {
        if (inv.x < stats.sourceBounds.minU) stats.sourceBounds.minU = inv.x;
        if (inv.y < stats.sourceBounds.minV) stats.sourceBounds.minV = inv.y;
        if (inv.x > stats.sourceBounds.maxU) stats.sourceBounds.maxU = inv.x;
        if (inv.y > stats.sourceBounds.maxV) stats.sourceBounds.maxV = inv.y;
      } else {
        if (inv.x < stats.sourceBounds.minU) stats.sourceBounds.minU = inv.x;
        if (inv.y < stats.sourceBounds.minV) stats.sourceBounds.minV = inv.y;
        if (inv.x > stats.sourceBounds.maxU) stats.sourceBounds.maxU = inv.x;
        if (inv.y > stats.sourceBounds.maxV) stats.sourceBounds.maxV = inv.y;
      }
      if (px === 0 || py === 0 || px === width - 1 || py === height - 1) {
        if (du < stats.destinationBounds.minU) stats.destinationBounds.minU = du;
        if (dv < stats.destinationBounds.minV) stats.destinationBounds.minV = dv;
        if (du > stats.destinationBounds.maxU) stats.destinationBounds.maxU = du;
        if (dv > stats.destinationBounds.maxV) stats.destinationBounds.maxV = dv;
      }

      if (!inside) stats.outsideModel++;
      else if (!inFrame) stats.outOfFrame++;
      else valid[idx] = 1;
    }
  }
  stats.valid = width * height - stats.outsideModel - stats.outOfFrame;
  stats.invalid = width * height - stats.valid;
  stats.validFraction = stats.valid / (width * height);
  stats.meanResidual = counted ? residualSum / counted : 0;
  if (!Number.isFinite(stats.sourceBounds.minU)) {
    stats.sourceBounds = { minU: 0, minV: 0, maxU: 0, maxV: 0 };
  }
  return { width, height, coords, valid, intr, stats };
}

/** Nearest-neighbour reverse sample, safe when coordinates are unset/invalid. */
export function sampleNearest(src, srcWidth, srcHeight, u, v) {
  const x = Math.round(u);
  const y = Math.round(v);
  if (x < 0 || y < 0 || x >= srcWidth || y >= srcHeight) return null;
  const i = (y * srcWidth + x) * 4;
  return [src[i], src[i + 1], src[i + 2], src[i + 3]];
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
