// Screenshots of the local page for the README and the website, taken against the synthetic
// Canvas with fictional courses (never a real account).   node scripts/screenshots.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startFakeCanvas, defaultModel } from '../test/fake-canvas.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');
const model = defaultModel();
model.user = { id: 42, name: 'Alex Example' };
const fake = await startFakeCanvas(model);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-shots-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false }));
process.env.LIVERPOOL_CANVAS_HOME = home;
process.env.LIVERPOOL_CANVAS_TEST_ORIGIN = fake.base;
process.env.LIVERPOOL_CANVAS_DEMO_DEFAULT_ROOT = '/Users/alex/Documents/Canvas';
const { startWeb } = await import('../src/web/server.js');
const web = await startWeb({ open: false });
const browser = await chromium.launch({ channel: process.env.LIVERPOOL_CANVAS_BROWSER || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, colorScheme: 'light' });
try {
  await page.goto(web.url);
  await page.waitForSelector('#signin:not([hidden])');
  await page.screenshot({ path: path.join(out, 'step-1-sign-in.png') });

  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify([{ name: 'canvas_session', value: 'good', domain: '127.0.0.1', path: '/', expires: -1 }]));
  // The demo root shown on screen is a fictional path; files really go to a temporary folder.
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-shots-files-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false, downloadDir: real, downloadDirConfirmedAt: new Date().toISOString() }));
  await page.reload();
  await page.waitForSelector('#courses .course');
  await page.waitForSelector('#upcoming li strong');
  await page.screenshot({ path: path.join(out, 'step-2-overview.png') });

  for (const id of ['101', '202']) await page.check(`#courses input[value="${id}"]`);
  await page.evaluate(() => { document.getElementById('folderPath').textContent = '/Users/alex/Documents/Canvas'; });
  await page.locator('#download').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'step-3-choose.png') });
  await page.click('#start');
  await page.waitForSelector('#doneActions:not([hidden])');
  await page.evaluate(() => { document.getElementById('folderPath').textContent = '/Users/alex/Documents/Canvas'; document.getElementById('progress').scrollIntoView({ block: 'center' }); });
  await page.screenshot({ path: path.join(out, 'step-4-done.png') });
} finally {
  await browser.close();
  web.close();
  await fake.close();
}
console.log(`Saved screenshots in ${out}`);
