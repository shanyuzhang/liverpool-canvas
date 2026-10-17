import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LIVERPOOL_CANVAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-login-'));
const { startFakeCanvas, defaultModel } = await import('./fake-canvas.js');
const { openSession, savedSession, clearSession, hasSavedSession } = await import('../src/browser.js');
const { HOME, PROFILE_DIR } = await import('../src/config.js');

// Runs the real sign-in code in a real (headless) Chrome/Edge against the synthetic Canvas and
// its demo SSO page. Skipped where no such browser is installed.
let browserMissing = false;
try { const { launch } = await import('../src/browser.js'); const ctx = await launch({ headless: true }); await ctx.close(); } catch { browserMissing = true; }

test('sign-in through SSO redirects saves a private session, which logout removes', { skip: browserMissing && 'no Chrome/Edge installed' }, async () => {
  const model = defaultModel();
  model.autoLogin = true;
  const fake = await startFakeCanvas(model);
  try {
    let loginPath = null;
    const { me, cookieHeader } = await openSession(fake.base, { headless: true, timeoutMs: 20000, onLoginPath: (p) => { loginPath = p; } });
    assert.equal(me.name, 'Test Student');
    assert.match(cookieHeader, /canvas_session=good/);
    assert.equal(loginPath, '/login/saml');
    assert.equal(savedSession(fake.base).cookieHeader, 'canvas_session=good');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(HOME, 'session.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(HOME).mode & 0o777, 0o700);
    }
    clearSession();
    assert.equal(hasSavedSession(), false);
    assert.ok(!fs.existsSync(PROFILE_DIR));
  } finally { await fake.close(); }
});
