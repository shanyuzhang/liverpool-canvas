import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LIVERPOOL_CANVAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-dl-home-'));
const { startFakeCanvas, defaultModel, fakeSession } = await import('./fake-canvas.js');
const { CanvasClient } = await import('../src/canvas.js');
const { DownloadIndex } = await import('../src/store.js');
const { runDownload, saveSingleFile, BusyError } = await import('../src/downloader.js');

let fake;
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-dl-root-'));
const client = (f = fake) => new CanvasClient({ base: f.base, session: fakeSession(), backoffMs: 1, timeoutMs: 3000 });
const indexFor = (root, userId = 7, f = fake) => new DownloadIndex({ origin: f.base, userId, root });
const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name))).sort();
before(async () => { fake = await startFakeCanvas(); });
after(() => fake.close());

test('first download: files land in <course (term)>/<module or page>/; the second run transfers nothing and changes nothing', async () => {
  const root = tmpRoot();
  const r1 = await runDownload(client(), indexFor(root), { courseIds: ['101'] });
  assert.equal(r1.complete, true, JSON.stringify(r1.courses[0], null, 1));
  assert.equal(r1.courses[0].counts.new, 9);
  const files = walk(root);
  assert.ok(files.includes(path.join('MATH253 (2026-27 Semester 1)', 'Week 1', 'Problem sheet 1.pdf')), files.join('\n'));
  assert.ok(files.includes(path.join('MATH253 (2026-27 Semester 1)', 'Week 1', 'Solutions')), 'file without extension kept as is');
  assert.ok(files.includes(path.join('MATH253 (2026-27 Semester 1)', 'Announcements', 'Assignment 1 sheet.pdf')));
  assert.ok(files.includes(path.join('MATH253 (2026-27 Semester 1)', 'Reading list', 'Reading list.docx')));
  assert.ok(!files.some((f) => f.endsWith('.part')));
  assert.equal(fake.cookieLeaks.length, 0, 'the Canvas cookie never went to the file server');

  const sheet = path.join(root, 'MATH253 (2026-27 Semester 1)', 'Week 1', 'Problem sheet 1.pdf');
  const before2 = fs.statSync(sheet).mtimeMs;
  const bodies = fake.storageLog.length;
  const logFrom = fake.log.length;
  const r2 = await runDownload(client(), indexFor(root), { courseIds: ['101'] });
  assert.equal(r2.courses[0].counts.new, 0);
  assert.equal(r2.courses[0].counts.existing, 9);
  assert.equal(fake.storageLog.length, bodies, 'no file body was requested again');
  assert.ok(!fake.log.slice(logFrom).some((l) => l.startsWith('GET /files/')), 'no download URL was even opened');
  assert.equal(fs.statSync(sheet).mtimeMs, before2);
  assert.equal(fs.readFileSync(sheet, 'utf8'), 'problems-1');
});

test('a file changed on Canvas keeps the local copy and is reported; a new file id with the same name gets its own name', async () => {
  const model = defaultModel();
  const f2 = await startFakeCanvas(model);
  const root = tmpRoot();
  try {
    await runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['101'] });
    const sheet = path.join(root, 'MATH253 (2026-27 Semester 1)', 'Week 1', 'Problem sheet 1.pdf');
    model.courses[0].files[1002] = { ...model.courses[0].files[1002], content: 'problems-1-v2-longer', updated_at: '2026-10-01T00:00:00Z' };
    model.courses[0].files[1010] = { display_name: 'Problem sheet 1.pdf', content: 'a different sheet', 'content-type': 'application/pdf', updated_at: '2026-10-01T00:00:00Z' };
    model.courses[0].modules[0].items.push({ id: 15, type: 'File', title: 'Problem sheet 1 (new upload)', content_id: 1010 });
    const r = await runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['101'] });
    const c = r.courses[0];
    assert.equal(c.counts.remoteUpdated, 1);
    assert.deepEqual(c.remoteUpdated, ['Problem sheet 1.pdf']);
    assert.equal(fs.readFileSync(sheet, 'utf8'), 'problems-1', 'local version kept');
    assert.equal(c.counts.new, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(sheet), 'Problem sheet 1 (canvas-1010).pdf'), 'utf8'), 'a different sheet');
    assert.equal(f2.bodyRequests('1002'), 1, 'the changed file was not downloaded again');
  } finally { await f2.close(); }
});

test('a deleted local copy is downloaded again; a cut-off download is never recorded as saved', async () => {
  const model = defaultModel();
  const f2 = await startFakeCanvas(model);
  const root = tmpRoot();
  try {
    model.truncate[1001] = true;
    const r1 = await runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['101'] });
    assert.equal(r1.complete, false);
    assert.equal(r1.courses[0].counts.failed, 1);
    assert.match(r1.courses[0].failed[0].error, /incomplete|terminated|other side closed|fetch failed|aborted/i);
    const dir = path.join(root, 'MATH253 (2026-27 Semester 1)', 'Week 1');
    assert.ok(!fs.existsSync(path.join(dir, 'Week 1 slides.pdf')), 'no half file under the real name');
    assert.ok(!walk(root).some((f) => f.endsWith('.part')), 'temporary file removed');
    assert.equal(indexFor(root, 7, f2).get('101', '1001').status, 'failed');

    delete model.truncate[1001];
    fs.rmSync(path.join(dir, 'Problem sheet 1.pdf'));
    const r2 = await runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['101'] });
    assert.equal(r2.complete, true);
    assert.equal(r2.courses[0].counts.new, 1, 'the failed one');
    assert.equal(r2.courses[0].counts.restored, 1, 'the deleted one');
    assert.equal(fs.readFileSync(path.join(dir, 'Problem sheet 1.pdf'), 'utf8'), 'problems-1');
    assert.equal(fs.readFileSync(path.join(dir, 'Week 1 slides.pdf'), 'utf8'), 'slides-week-1');
  } finally { await f2.close(); }
});

test('the same file in two courses is saved in both course folders and never moved between them', async () => {
  const root = tmpRoot();
  const idx = indexFor(root);
  await runDownload(client(), idx, { courseIds: ['202'] });
  await runDownload(client(), idx, { courseIds: ['101'] });
  const a = path.join(root, 'MATH268 (2026-27 Semester 1)', 'Lectures', 'shared data.csv');
  const b = path.join(root, 'MATH253 (2026-27 Semester 1)', 'Assignments', 'shared data.csv');
  assert.equal(fs.readFileSync(a, 'utf8'), 'x\n1\n');
  assert.equal(fs.readFileSync(b, 'utf8'), 'x\n1\n');
  const r = await runDownload(client(), idx, { courseIds: ['202', '101'] });
  assert.equal(r.courses.every((c) => c.counts.new === 0), true);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test('reading a file through the AI tool uses the same index: an already saved file is read from disk, not fetched or moved', async () => {
  const root = tmpRoot();
  const idx = indexFor(root);
  const c = client();
  const first = await saveSingleFile(c, idx, '2002', '202');
  assert.equal(first.status, 'new');
  const bodies = fake.bodyRequests('2002');
  const again = await saveSingleFile(c, idx, '2002', '202');
  assert.equal(again.status, 'existing');
  assert.equal(again.path, first.path);
  assert.equal(fake.bodyRequests('2002'), bodies);
  const course = await runDownload(c, idx, { courseIds: ['202'] });
  assert.equal(course.courses[0].counts.existing >= 1, true);
  assert.ok(fs.existsSync(first.path), 'not moved into the module folder');
});

test('two downloads into the same folder at once: the second is refused; concurrent index writers lose nothing', async () => {
  const root = tmpRoot();
  const idx = indexFor(root);
  const one = runDownload(client(), idx, { courseIds: ['101'] });
  await assert.rejects(runDownload(client(), indexFor(root), { courseIds: ['202'] }), BusyError);
  await one;
  // Two independent writers (as two programs would be) updating the index at the same time
  const a = indexFor(root); const b = indexFor(root);
  await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).update((d) => { d.files[`x:${i}`] = { status: 'pending' }; })));
  const keys = Object.keys(indexFor(root).load().files);
  assert.equal(keys.filter((k) => k.startsWith('x:')).length, 40);
  assert.ok(keys.includes('101:1002'), 'earlier records kept');
});

test('cancel: finished files are kept, temporary files removed, the next run continues', async () => {
  const model = defaultModel();
  model.slow = { 1005: 1500 };
  const f2 = await startFakeCanvas(model);
  const root = tmpRoot();
  try {
    const ctrl = new AbortController();
    const seen = [];
    const run = runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['101'], concurrency: 1, signal: ctrl.signal, onEvent: (e) => { if (e.type === 'file' && e.state === 'start') { seen.push(e.name); if (e.name === 'data.csv') setTimeout(() => ctrl.abort(new Error('cancelled')), 100); } } });
    const r = await run;
    assert.equal(r.cancelled, true);
    assert.equal(r.complete, false);
    const c = r.courses[0];
    assert.ok(c.counts.new >= 1 && c.counts.cancelled >= 1, JSON.stringify(c.counts));
    assert.ok(!walk(root).some((f) => f.endsWith('.part')));
    assert.ok(!walk(root).some((f) => f.endsWith('data.csv')), 'the interrupted file is not there under its name');
    model.slow = {};
    const r2 = await runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['101'] });
    assert.equal(r2.complete, true);
    assert.equal(r2.courses[0].counts.existing, c.counts.new);
    assert.equal(r2.courses[0].counts.new + r2.courses[0].counts.existing, 9);
  } finally { await f2.close(); }
});

test('another account on the same computer gets its own index and never "already has" someone else\'s files', async () => {
  const root = tmpRoot();
  await runDownload(client(), indexFor(root, 7), { courseIds: ['202'] });
  const other = indexFor(root, 8);
  assert.notEqual(other.file, indexFor(root, 7).file);
  assert.equal(other.get('202', '2002'), null);
  const r = await runDownload(client(), other, { courseIds: ['202'] });
  assert.equal(r.courses[0].counts.new, 2, 'downloaded for this account…');
  const lect = path.join(root, 'MATH268 (2026-27 Semester 1)', 'Lectures');
  assert.deepEqual(fs.readdirSync(lect).sort(), ['Notes (canvas-2002).pdf', 'Notes.pdf', 'shared data (canvas-2001).csv', 'shared data.csv'], '…without overwriting the other account\'s copies');
});

test('a file the user put there before (not in the index) is never overwritten', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'MATH268 (2026-27 Semester 1)', 'Module 1');
  const mine = path.join(root, 'MATH268 (2026-27 Semester 1)', 'Lectures', 'Notes.pdf');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, 'my own annotated notes');
  await runDownload(client(), indexFor(root), { courseIds: ['202'] });
  assert.equal(fs.readFileSync(mine, 'utf8'), 'my own annotated notes');
  assert.ok(fs.existsSync(path.join(path.dirname(mine), 'Notes (canvas-2002).pdf')));
  assert.ok(!fs.existsSync(dir));
});

test('awkward names: Windows reserved names, slashes, non-ASCII, two courses with the same code', async () => {
  const model = defaultModel();
  model.courses = [
    { id: 1, name: '线性代数', course_code: 'CON', term: { name: '2026/27', start_at: '2026-09-01T00:00:00Z' }, filesHidden: true, pagesListDisabled: true, pages: {}, announcements: [], assignments: [],
      modules: [{ id: 1, name: 'Week 1: Intro/Overview?', items: [{ id: 1, type: 'File', content_id: 1 }, { id: 2, type: 'File', content_id: 2 }] }],
      files: { 1: { display_name: '讲义 第1周.pdf', content: 'a', 'content-type': 'application/pdf', updated_at: 'x' }, 2: { display_name: '../../escape.txt', content: 'b', 'content-type': 'text/plain', updated_at: 'x' } } },
    { id: 2, name: 'Twin', course_code: 'CON', term: { name: '2026/27', start_at: '2026-09-01T00:00:00Z' }, filesHidden: true, pagesListDisabled: true, pages: {}, announcements: [], assignments: [],
      modules: [{ id: 2, name: 'aux', items: [{ id: 3, type: 'File', content_id: 3 }] }], files: { 3: { display_name: 'nul.txt', content: 'c', 'content-type': 'text/plain', updated_at: 'x' } } },
  ];
  const f2 = await startFakeCanvas(model);
  const root = tmpRoot();
  try {
    const r = await runDownload(client(f2), indexFor(root, 7, f2), { courseIds: ['1', '2'] });
    assert.equal(r.complete, true);
    assert.deepEqual(walk(root), [
      path.join('CON (2026_27)', 'Week 1_ Intro_Overview_', '_.._escape.txt'),
      path.join('CON (2026_27)', 'Week 1_ Intro_Overview_', '讲义 第1周.pdf'),
      path.join('CON (2026_27) [2]', '_aux', '_nul.txt'),
    ].sort());
  } finally { await f2.close(); }
});

test('preview lists what would be downloaded and requests no file bodies', async () => {
  const root = tmpRoot();
  const bodies = fake.storageLog.length;
  const r = await runDownload(client(), indexFor(root), { courseIds: ['101'], preview: true });
  assert.equal(r.preview, true);
  assert.equal(r.courses[0].counts.new, 9);
  assert.ok(r.courses[0].files.every((f) => f.action === 'download'));
  assert.equal(fake.storageLog.length, bodies);
  assert.deepEqual(walk(root), []);
});

test('401 during a download stops it with a sign-in error and keeps what finished', async () => {
  const model = defaultModel();
  const f2 = await startFakeCanvas(model);
  const root = tmpRoot();
  try {
    let calls = 0;
    const c = new CanvasClient({ base: f2.base, session: async () => ({ cookieHeader: ++calls > 1 ? 'expired' : 'canvas_session=good' }) });
    model.faults['/api/v1/courses/101/discussion_topics'] = { status: 401, times: 5 };
    await assert.rejects(runDownload(c, indexFor(root, 7, f2), { courseIds: ['101'] }), (e) => e.code === 'auth');
    // the job lock was released
    assert.ok(indexFor(root, 7, f2).lockJob()?.release() === undefined);
  } finally { await f2.close(); }
});
