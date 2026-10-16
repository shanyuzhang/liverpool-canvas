import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.LIVERPOOL_CANVAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-home-'));
const { startFakeCanvas, fakeSession } = await import('./fake-canvas.js');
process.env.LIVERPOOL_CANVAS_TEST_ORIGIN = 'http://127.0.0.1:1';   // replaced below once the fake runs
const { App } = await import('../src/app.js');
const { CanvasClient } = await import('../src/canvas.js');
const { startWeb } = await import('../src/web/server.js');
const cfg = await import('../src/config.js');

let fake; let web; let cookie; let origin; let csrf;
// Raw requests, so Host / Origin headers can be forged the way an attacker would.
const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: web.port, method, path: p, headers: { Host: `127.0.0.1:${web.port}`, ...headers } }, (res) => {
    let data = ''; res.on('data', (d) => { data += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
  });
  r.on('error', reject);
  if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
  r.end();
});
const post = (p, body = {}, headers = {}) => req('POST', p, { body, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers } });

before(async () => {
  fake = await startFakeCanvas();
  process.env.LIVERPOOL_CANVAS_TEST_ORIGIN = fake.base;
  const app = new App({ base: fake.base, client: new CanvasClient({ base: fake.base, session: fakeSession() }) });
  web = await startWeb({ open: false, app });
  origin = `http://127.0.0.1:${web.port}`;
});
after(async () => { web.close(); await web.closed; await fake.close(); });

test('listens on 127.0.0.1 only', () => {
  assert.equal(web.server.address().address, '127.0.0.1');
});

test('the page needs the one-time key from the terminal; the key becomes an HttpOnly SameSite=Strict cookie', async () => {
  assert.equal((await req('GET', '/')).status, 403);
  assert.equal((await req('GET', '/?t=wrong')).status, 403);
  const r = await req('GET', `/?t=${web.tokens.launchToken}`);
  assert.equal(r.status, 303);
  const set = r.headers['set-cookie'][0];
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  const page = await req('GET', '/', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  csrf = (await req('GET', '/api/state', { headers: { Cookie: cookie } })).json.csrf;
  assert.ok(csrf);
});

test('DNS rebinding: other Host names are refused', async () => {
  const r = await req('GET', '/api/state', { headers: { Cookie: cookie, Host: 'evil.example:80' } });
  assert.equal(r.status, 421);
  assert.equal((await req('GET', '/api/state', { headers: { Cookie: cookie, Host: `localhost:${web.port}` } })).status, 200);
});

test('APIs need the session; side effects need same Origin, CSRF token and JSON', async () => {
  assert.equal((await req('GET', '/api/state')).status, 401);
  assert.equal((await post('/api/folder', { path: '/tmp/x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/folder', { path: '/tmp/x' }, { Origin: '' })).status, 403);
  assert.equal((await post('/api/folder', { path: '/tmp/x' }, { 'X-CSRF-Token': 'nope' })).status, 403);
  assert.equal((await post('/api/folder', { path: '/tmp/x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/folder', 'path=/tmp/x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 403);
  assert.equal((await req('POST', '/api/shutdown', { headers: { Origin: origin, 'Content-Type': 'application/json' }, body: {} })).status, 401);
  assert.equal(cfg.downloadRoot(), null, 'nothing was changed by refused requests');
});

test('no arbitrary file access: unknown and traversal paths are 404; the folder setting rejects system folders', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/web/app.js', '/src/config.js', '/..%2fsrc%2fconfig.js']) {
    const r = await req('GET', p, { headers: { Cookie: cookie } });
    assert.equal(r.status, 404, p);
  }
  assert.equal((await post('/api/folder', { path: 'relative/dir' })).status, 400);
  assert.equal((await post('/api/folder', { path: os.homedir() })).status, 400);
  assert.equal((await post('/api/folder', { path: path.parse(os.homedir()).root })).status, 400);
  assert.equal((await post('/api/folder', { path: path.join(cfg.HOME, 'x') })).status, 400);
  assert.equal((await post('/api/open', { courseId: '101' })).status, 400, 'no folder yet');
});

test('end to end: confirm folder, list courses, preview, download, sync; only course folders can be opened', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-root-'));
  const f = await post('/api/folder', { path: root });
  assert.equal(f.status, 200, f.body);
  const courses = await req('GET', '/api/courses', { headers: { Cookie: cookie } });
  assert.equal(courses.json.groups[0].courses[0].saved, 0);
  const pv = await post('/api/preview', { courseIds: ['202'] });
  assert.equal(pv.status, 200, pv.body);
  let job;
  for (let i = 0; i < 100; i++) { job = (await req('GET', '/api/job', { headers: { Cookie: cookie } })).json.job; if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 30)); }
  assert.equal(job.result.courses[0].counts.new, 2);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal((await post('/api/download', { courseIds: ['../../etc'] })).status, 400);
  const dl = await post('/api/download', { courseIds: ['202'] });
  assert.equal(dl.status, 200);
  const busy = await post('/api/download', { courseIds: ['101'] });
  assert.ok([200, 409].includes(busy.status));
  for (let i = 0; i < 100; i++) { job = (await req('GET', '/api/job', { headers: { Cookie: cookie } })).json.job; if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 30)); }
  assert.equal(job.state, 'done');
  const state = (await req('GET', '/api/state', { headers: { Cookie: cookie } })).json;
  assert.deepEqual(state.selection, busy.status === 200 ? ['101'] : ['202']);
  const hist = (await req('GET', '/api/history', { headers: { Cookie: cookie } })).json.history;
  assert.ok(hist.length >= 1);
  assert.equal((await post('/api/open', { courseId: '999' })).status, 404);
  assert.equal((await post('/api/open', { courseId: '../..' })).status, 404);
});
