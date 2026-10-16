import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LIVERPOOL_CANVAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-disc-'));
const { startFakeCanvas, defaultModel, fakeSession } = await import('./fake-canvas.js');
const { CanvasClient } = await import('../src/canvas.js');
const { discoverCourseFiles } = await import('../src/discovery.js');

let fake;
const client = (opts = {}) => new CanvasClient({ base: fake.base, session: fakeSession(), backoffMs: 1, timeoutMs: 2000, ...opts });
const names = (r) => r.files.map((f) => f.name).sort();
before(async () => { fake = await startFakeCanvas(); });
after(() => fake.close());

test('Files hidden + Pages list disabled: files are still found through modules, pages, home page, announcements and assignments', async () => {
  const from = fake.log.length;
  const r = await discoverCourseFiles(client(), 101);
  assert.equal(r.complete, true, JSON.stringify(r.incomplete));
  // week-1 ↔ week-1-extra link to each other: each page is read exactly once
  const reads = (slug) => fake.log.slice(from).filter((l) => l.split('?')[0] === `GET /api/v1/courses/101/pages/${slug}`).length;
  assert.equal(reads('week-1'), 1);
  assert.equal(reads('week-1-extra'), 1);
  assert.ok(r.notes.includes('files-tab-hidden'));
  assert.ok(r.notes.includes('pages-list-disabled'));
  assert.deepEqual(names(r), [
    'Assignment 1 sheet.pdf', 'Assignment 1.pdf', 'Problem sheet 1.pdf', 'Reading list.docx', 'Solutions', 'Week 1 slides.pdf', 'data.csv', 'shared data.csv', 'template.tex',
  ].sort());
  const sheet = r.files.find((f) => f.name === 'Problem sheet 1.pdf');
  assert.equal(sheet.sources.length, 2, 'one file, two module sources, listed once');
  assert.equal(sheet.primary.module, 'Week 1');
  const sol = r.files.find((f) => f.name === 'Solutions');
  assert.equal(sol.primary.kind, 'module-page', 'found on a page linked from a module page');
  assert.equal(sol.primary.module, 'Week 1');
  // module items were omitted from the modules list, so they were paged separately
  assert.ok(fake.log.some((l) => l.startsWith('GET /api/v1/courses/101/modules/1/items')));
  // the cross-course link is kept only because Canvas gave this user the file; course 202 is not scanned
  const shared = r.files.find((f) => f.name === 'shared data.csv');
  assert.equal(shared.otherCourse, '202');
  assert.ok(!fake.log.some((l) => l.startsWith('GET /api/v1/courses/202/modules')));
  // video links are never fetched
  assert.ok(!fake.log.some((l) => l.includes('video.example')));
  // the embedded question figure is left out by default, but reported
  assert.equal(r.skipped.filter((s) => s.image).length, 1);
});

test('page images can be included', async () => {
  const r = await discoverCourseFiles(client(), 101, { includeImages: true });
  assert.ok(names(r).includes('figure.png'));
});

test('Files list available: its files and folders are used, and modules are merged in, not skipped', async () => {
  const r = await discoverCourseFiles(client(), 202);
  assert.equal(r.complete, true);
  assert.deepEqual(names(r), ['Notes.pdf', 'shared data.csv']);
  const notes = r.files.find((f) => f.name === 'Notes.pdf');
  assert.deepEqual(notes.sources.map((s) => s.kind).sort(), ['files', 'module']);
  assert.equal(notes.primary.kind, 'module');
  assert.equal(r.files.find((f) => f.name === 'shared data.csv').primary.folder, 'Lectures');
  assert.ok(r.skipped.some((s) => s.name === 'Locked exam.pdf' && /locked/.test(s.reason)));
});

test('the Pages list being off does not hide pages, and with it on, unlinked pages are scanned too', async () => {
  const model = defaultModel();
  model.courses[0].pagesListDisabled = false;
  model.courses[0].pages.orphan = { title: 'Orphan', body: '<a href="/courses/101/files/1009">figure as a link</a>' };
  const f2 = await startFakeCanvas(model);
  try {
    const r = await discoverCourseFiles(new CanvasClient({ base: f2.base, session: fakeSession() }), 101);
    assert.ok(names(r).includes('figure.png'), 'linked image from an unlinked page');
  } finally { await f2.close(); }
});

test('a page limit is reported as incomplete', async () => {
  const r = await discoverCourseFiles(client(), 101, { maxPages: 2 });
  assert.equal(r.complete, false);
  assert.match(r.incomplete.map((x) => x.reason).join(' '), /stopped after 2 pages/);
});

test('a failing source makes the scan incomplete instead of looking empty', async () => {
  const model = defaultModel();
  model.faults['/api/v1/courses/101/assignments'] = { status: 500 };
  const f2 = await startFakeCanvas(model);
  try {
    const r = await discoverCourseFiles(new CanvasClient({ base: f2.base, session: fakeSession(), backoffMs: 1 }), 101);
    assert.equal(r.complete, false);
    assert.equal(r.incomplete[0].source, 'assignments');
    assert.ok(r.files.length > 0);
  } finally { await f2.close(); }
});

test('429 is retried; persistent timeouts end up as incomplete', async () => {
  const model = defaultModel();
  model.faults['/api/v1/courses/101/modules'] = { status: 429, times: 2 };
  model.faults['/api/v1/courses/101/discussion_topics'] = { delayMs: 400 };
  const f2 = await startFakeCanvas(model);
  try {
    const r = await discoverCourseFiles(new CanvasClient({ base: f2.base, session: fakeSession(), backoffMs: 1, timeoutMs: 150, retries: 2 }), 101);
    assert.ok(names(r).includes('Problem sheet 1.pdf'), 'modules read after two 429s');
    assert.equal(r.complete, false);
    assert.equal(r.incomplete[0].source, 'announcements');
    assert.match(r.incomplete[0].reason, /in time/);
  } finally { await f2.close(); }
});

test('401 stops the scan with a sign-in error; 403 on a course is a no-access error', async () => {
  const c = new CanvasClient({ base: fake.base, session: async () => ({ cookieHeader: 'canvas_session=expired' }) });
  await assert.rejects(discoverCourseFiles(c, 101), (e) => e.code === 'auth' && /login/.test(e.message));
  fake.model.courses[2].noAccess = true;
  await assert.rejects(discoverCourseFiles(client(), 303), (e) => e.status === 403);
  fake.model.courses[2].noAccess = false;
});

test('a locked module page is skipped with a reason, the rest is still found', async () => {
  const model = defaultModel();
  model.courses[0].pages['week-1'].locked = true;
  const f2 = await startFakeCanvas(model);
  try {
    const r = await discoverCourseFiles(new CanvasClient({ base: f2.base, session: fakeSession() }), 101);
    assert.equal(r.complete, true);
    assert.ok(r.skipped.some((s) => s.reason === 'no permission' && /Week 1/.test(s.source)));
    assert.ok(names(r).includes('Problem sheet 1.pdf'));
    assert.ok(!names(r).includes('Week 1 slides.pdf'));
  } finally { await f2.close(); }
});
