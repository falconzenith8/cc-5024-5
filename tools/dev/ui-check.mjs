/**
 * Headless UI verification. Not part of the product; used to prove the page
 * performs real computation and to capture review screenshots.
 * Usage: node tools/dev/ui-check.mjs
 */

import { openApp } from './ui-harness.mjs';
import { writeFileSync } from 'node:fs';

const outDir = process.argv[2] || '/tmp';

function log(...a) { console.log(...a); }

const { browser, page, logs } = await openApp();
try {
  await page.waitForTimeout(9000);
  const initial = await page.evaluate(() => ({
    verdict: document.getElementById('verdict')?.textContent,
    imageMeta: document.getElementById('imageMeta')?.textContent,
    renderNote: document.getElementById('renderNote')?.textContent,
    errorBar: document.getElementById('errorBar')?.hidden ? '' : document.getElementById('errorBar')?.innerText,
    plan: document.getElementById('planBox')?.innerText,
    errors: document.getElementById('errorSummary')?.innerText,
    bend: document.getElementById('bendSummary')?.innerText,
    invalid: document.getElementById('invalidBox')?.innerText,
    diagnosis: document.getElementById('diagnosisBox')?.innerText,
    fit: document.getElementById('fitBox')?.innerText,
    distorted: [document.getElementById('distortedCanvas')?.width, document.getElementById('distortedCanvas')?.height],
    rectified: [document.getElementById('rectifiedCanvas')?.width, document.getElementById('rectifiedCanvas')?.height],
    status: window.__state ? 'exposed' : 'not-exposed',
  }));
  log('=== INITIAL ===');
  log(JSON.stringify(initial, null, 2));
  await page.screenshot({ path: `${outDir}/ui-01-initial.png` });

  // Probe the rectified canvas to verify coordinate readout.
  const rBox = await page.locator('#rectifiedCanvas').boundingBox();
  if (rBox) {
    await page.mouse.move(rBox.x + rBox.width * 0.5, rBox.y + rBox.height * 0.5);
    await page.waitForTimeout(500);
    const probe = await page.evaluate(() => document.getElementById('probeBox')?.innerText);
    log('=== PROBE (rectified center) ===');
    log(probe);
    await page.screenshot({ path: `${outDir}/ui-02-probe.png` });
  }

  // Switch to crop mode.
  await page.locator('.segbtn[data-mode="crop"]').click();
  await page.waitForTimeout(5000);
  const crop = await page.evaluate(() => ({
    plan: document.getElementById('planBox')?.innerText,
    invalid: document.getElementById('invalidBox')?.innerText,
    errors: document.getElementById('errorSummary')?.innerText,
    verdict: document.getElementById('verdict')?.textContent,
  }));
  log('=== CROP MODE ===');
  log(JSON.stringify(crop, null, 2));
  await page.screenshot({ path: `${outDir}/ui-03-crop.png` });

  // Switch back, change radial order to 2 to prove the model choice matters.
  await page.locator('.segbtn[data-mode="preserve-field"]').click();
  await page.waitForTimeout(3000);
  const before = await page.evaluate(() => document.getElementById('errorSummary')?.innerText);
  await page.selectOption('#radialOrder', '2');
  await page.waitForTimeout(4000);
  const order2 = await page.evaluate(() => ({
    errors: document.getElementById('errorSummary')?.innerText,
    fit: document.getElementById('fitBox')?.innerText,
    verdict: document.getElementById('verdict')?.textContent,
  }));
  log('=== RADIAL ORDER 2 ===');
  log(JSON.stringify({ before, order2 }, null, 2));
  await page.screenshot({ path: `${outDir}/ui-04-order2.png` });

  await page.selectOption('#radialOrder', '6');
  await page.waitForTimeout(4000);

  // Drag a calibration point by 6 px and measure the change.
  const dBox = await page.locator('#distortedCanvas').boundingBox();
  const beforeDrag = await page.evaluate(() => ({
    errors: document.getElementById('errorSummary')?.innerText,
    fit: document.getElementById('fitBox')?.innerText,
  }));
  if (dBox) {
    // Pick a point near the middle of the image where a marker is drawn.
    const pt = await page.evaluate(() => {
      const c = document.getElementById('distortedCanvas');
      return { w: c.width, h: c.height };
    });
    const canvasBox = dBox;
    // Find nearest drawn marker to the centre by probing pixel colour around candidates.
    const targets = await page.evaluate(() => {
      const c = document.getElementById('distortedCanvas');
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const out = [];
      for (let y = 10; y < c.height - 10; y += 4) {
        for (let x = 10; x < c.width - 10; x += 4) {
          const i = (y * c.width + x) * 4;
          // Selection ring is white-ish and near orange fill; detect orange cross color.
          if (data[i] > 240 && data[i + 1] > 190 && data[i + 1] < 235 && data[i + 2] > 140 && data[i + 2] < 190) out.push({ x, y });
        }
      }
      return out.slice(0, 400);
    });
    let chosen = null;
    let bestD = Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.x - pt.w / 2, t.y - pt.h / 2);
      if (d < bestD) { bestD = d; chosen = t; }
      if (d > 120 && chosen) break;
    }
    if (chosen) {
      const scale = canvasBox.width / pt.w;
      const sx = canvasBox.x + chosen.x * scale;
      const sy = canvasBox.y + chosen.y * scale;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 7, sy + 5, { steps: 6 });
      await page.waitForTimeout(1500);
      await page.mouse.up();
      await page.waitForTimeout(4500);
      const afterDrag = await page.evaluate(() => ({
        errors: document.getElementById('errorSummary')?.innerText,
        fit: document.getElementById('fitBox')?.innerText,
        diagnosis: document.getElementById('diagnosisBox')?.innerText,
        pointInfo: document.getElementById('pointInfo')?.innerText,
        verdict: document.getElementById('verdict')?.textContent,
      }));
      log('=== DRAG POINT ===');
      log(JSON.stringify({ chosen, beforeDrag, afterDrag }, null, 2));
      await page.screenshot({ path: `${outDir}/ui-05-drag.png` });
    } else {
      log('=== DRAG POINT: no marker pixel found ===');
    }
  }

  // Trigger exports to verify files are produced from actual computation.
  const downloads = [];
  page.on('download', async (d) => {
    const p = `${outDir}/${d.suggestedFilename()}`;
    await d.saveAs(p);
    downloads.push(p);
  });
  await page.locator('#btnExportPng').click();
  await page.waitForTimeout(6000);
  await page.locator('#btnExportCal').click();
  await page.waitForTimeout(1500);
  await page.locator('#btnExportEval').click();
  await page.waitForTimeout(9000);
  await page.locator('#btnExportDiag').click();
  await page.waitForTimeout(9000);
  log('=== DOWNLOADS ===');
  log(JSON.stringify(downloads, null, 2));

  const final = await page.evaluate(() => ({
    renderNote: document.getElementById('renderNote')?.innerText,
    errorBar: document.getElementById('errorBar')?.hidden ? '' : document.getElementById('errorBar')?.innerText,
  }));
  log('=== FINAL ===');
  log(JSON.stringify(final, null, 2));
  await page.screenshot({ path: `${outDir}/ui-06-final.png` });
  log('=== CONSOLE LOGS ===');
  log(logs.slice(0, 60).join('\n') || '(none)');
  writeFileSync(`${outDir}/ui-logs.txt`, logs.join('\n'));
} finally {
  await browser.close();
}
