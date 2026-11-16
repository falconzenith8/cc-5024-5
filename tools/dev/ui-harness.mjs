import { chromium } from 'playwright';

const executablePath = process.env.CHROMIUM_PATH
  || '/home/node/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell';

export async function openApp({ width = 1600, height = 1050 } = {}) {
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto('http://127.0.0.1:5178/', { waitUntil: 'load' });
  return { browser, page, logs };
}
