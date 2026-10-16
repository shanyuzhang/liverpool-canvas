import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeCanvas } from './fake-canvas.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
let fake; let home; let root;
const run = (args, extra = {}) => new Promise((resolve) => {
  const env = { ...process.env, LIVERPOOL_CANVAS_HOME: home, LIVERPOOL_CANVAS_TEST_ORIGIN: fake.base, LIVERPOOL_CANVAS_RENEW: 'hidden', ...extra };
  delete env.LIVERPOOL_CANVAS_DOWNLOADS;
  const p = spawn(process.execPath, [cli, ...args], { env });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() }));
});

before(async () => {
  fake = await startFakeCanvas();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cli-home-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cli-root-'));
  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify([{ name: 'canvas_session', value: 'good', domain: '127.0.0.1', path: '/', expires: -1 }]));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false }));
});
after(() => fake.close());

test('--help explains every command', async () => {
  const r = await run(['--help']);
  for (const c of ['setup', 'login', 'logout', 'status', 'courses', 'preview', 'download', 'sync', 'reindex', 'connect', 'web', 'mcp', 'update', '--json', '--course']) assert.ok(r.stdout.includes(c), c);
});

test('no command in a script prints help instead of starting anything (MCP needs "mcp")', async () => {
  const r = await run([]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /"mcp" command/);
});

test('courses --json groups by term and keeps other sites apart', async () => {
  const r = await run(['courses', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json[0].kind, 'current');
  assert.deepEqual(r.json[0].courses.map((c) => c.code).sort(), ['MATH253', 'MATH268']);
  assert.equal(r.json.at(-1).kind, 'other');
});

test('download needs a folder; an ambiguous code lists the candidates instead of guessing', async () => {
  const noFolder = await run(['download', '--course', 'MATH253']);
  assert.equal(noFolder.status, 1);
  assert.match(noFolder.stdout, /--folder/);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false, downloadDir: root, downloadDirConfirmedAt: new Date().toISOString() }));
  fake.model.courses[3].course_code = 'MATH253';   // a resit course with the same code
  try {
    const r = await run(['download', '--course', 'MATH253']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /matches more than one course/);
    assert.match(r.stdout, /id 101/);
    assert.match(r.stdout, /id 404/);
  } finally { fake.model.courses[3].course_code = 'MATH253-RESIT'; }
});

test('sync before any choice explains what to do; download --json, then sync only fetches new files', async () => {
  const empty = await run(['sync']);
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /No courses chosen/);
  const r = await run(['download', '--course', 'MATH253', '--course', '202', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.complete, true);
  assert.deepEqual(r.json.courses.map((c) => c.counts.new), [9, 2]);
  assert.match(r.stderr, /looking for files/);   // progress on stderr, JSON alone on stdout
  fake.model.courses[1].files[2004] = { display_name: 'Week 5.pdf', content: 'w5', 'content-type': 'application/pdf', updated_at: 'x', folder_id: 9 };
  const s = await run(['sync', '--json']);
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(s.json.courses.map((c) => [c.counts.new, c.counts.existing]), [[0, 9], [1, 2]]);
  const st = await run(['status', '--json']);
  assert.equal(st.json.signedIn, true);
  assert.deepEqual(st.json.rememberedCourses, ['101', '202']);
});

test('reindex adopts files at the expected path with the expected size, and leaves others alone', async () => {
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cli-h2-'));
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cli-r2-'));
  fs.copyFileSync(path.join(home, 'session.json'), path.join(h2, 'session.json'));
  fs.writeFileSync(path.join(h2, 'config.json'), JSON.stringify({ hiddenRenewWorks: false, downloadDir: r2, downloadDirConfirmedAt: new Date().toISOString() }));
  const dir = path.join(r2, 'MATH268 (2026-27 Semester 1)', 'Lectures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Notes.pdf'), 'stat-notes');            // same size as on Canvas
  fs.writeFileSync(path.join(dir, 'shared data.csv'), 'edited by me');     // different size
  const r = await run(['reindex', '--course', '202', '--json'], { LIVERPOOL_CANVAS_HOME: h2 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json[0].adopted, 1);
  assert.equal(r.json[0].leftAlone, 1);
  const d = await run(['download', '--course', '202', '--json'], { LIVERPOOL_CANVAS_HOME: h2 });
  assert.equal(d.json.courses[0].counts.existing, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'shared data.csv'), 'utf8'), 'edited by me');
  assert.ok(fs.existsSync(path.join(dir, 'shared data (canvas-2001).csv')));
});

test('an expired session exits with a sign-in hint and code 4', async () => {
  fake.model.cookie = 'canvas_session=rotated';
  try {
    const r = await run(['courses']);
    assert.equal(r.status, 4);
    assert.match(r.stdout, /login/);
  } finally { fake.model.cookie = 'canvas_session=good'; }
});
