import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeName, decide, choosePath, courseFolderName, fileNameFor, insideRoot, withIdSuffix } from '../src/store.js';
import { matchCourses, normaliseCourses, groupCourses, londonTime } from '../src/courses.js';
import { plannerRow } from '../src/tools.js';

test('safe names: illegal characters, traversal, Windows reserved names, long and non-ASCII names', () => {
  assert.equal(safeName('Week 1: Intro/Overview?'), 'Week 1_ Intro_Overview_');
  assert.equal(safeName('..'), 'untitled');
  assert.equal(safeName('../../etc/passwd'), '_.._etc_passwd');
  assert.ok(!safeName('../../etc/passwd').includes('/'));
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('aux.txt'), '_aux.txt');
  assert.equal(safeName('LPT1'), '_LPT1');
  assert.equal(safeName('name. '), 'name');
  assert.equal(safeName('线性代数 第一周.pdf'), '线性代数 第一周.pdf');
  const long = safeName('讲义'.repeat(100) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 150 && long.endsWith('.pdf'), long);
  assert.equal(fileNameFor('Solutions', 'application/pdf'), 'Solutions.pdf');
  assert.equal(fileNameFor('Solutions', 'application/octet-stream'), 'Solutions');
  assert.equal(withIdSuffix('notes.pdf', 42), 'notes (canvas-42).pdf');
  assert.ok(insideRoot('/r', '/r/a/b'));
  assert.ok(!insideRoot('/r', '/r/../x'));
  assert.ok(!insideRoot('/r', '/r'));
});

test('missing-only decision', () => {
  const rec = { status: 'complete', path: '/x/a.pdf', remoteUpdatedAt: '1', remoteSize: 10 };
  const yes = () => true; const no = () => false;
  assert.deepEqual(decide(rec, { updatedAt: '1', size: 10 }, yes), { action: 'skip', remoteChanged: false });
  assert.deepEqual(decide(rec, { updatedAt: '2', size: 10 }, yes), { action: 'skip', remoteChanged: true });
  assert.deepEqual(decide(rec, { updatedAt: '1', size: 11 }, yes), { action: 'skip', remoteChanged: true });
  assert.deepEqual(decide(rec, { updatedAt: '1', size: 10 }, no), { action: 'download', reason: 'missing-local' });
  assert.deepEqual(decide({ ...rec, status: 'pending' }, {}, yes), { action: 'download', reason: 'new' });
  assert.deepEqual(decide({ ...rec, status: 'failed' }, {}, yes), { action: 'download', reason: 'new' });
  assert.deepEqual(decide(null, {}, yes), { action: 'download', reason: 'new' });
});

test('a new file never takes a path that exists or belongs to another record', () => {
  const dir = '/d';
  const exists = (p) => p === path.join(dir, 'notes.pdf');
  assert.equal(choosePath(dir, 'notes.pdf', 5, new Set(), exists), path.join(dir, 'notes (canvas-5).pdf'));
  const taken = new Set([path.resolve(dir, 'notes (canvas-5).pdf')]);
  assert.equal(choosePath(dir, 'notes.pdf', 5, taken, exists), path.join(dir, 'notes (canvas-5-2).pdf'));
  assert.equal(choosePath(dir, 'other.pdf', 5, taken, exists), path.join(dir, 'other.pdf'));
});

test('course folders carry the term; Default Term is left out', () => {
  assert.equal(courseFolderName({ id: 1, code: 'MATH253', term: '2026-27 Semester 1' }), 'MATH253 (2026-27 Semester 1)');
  assert.equal(courseFolderName({ id: 2, code: 'CAREERS', term: 'Default Term' }), 'CAREERS');
  assert.equal(courseFolderName({ id: 3, code: 'COMP: 1/2', termStart: '2025-09-01' }), 'COMP_ 1_2 (2025)');
});

test('course matching never guesses between candidates', () => {
  const list = normaliseCourses([
    { id: 1, name: 'A', course_code: 'MATH253', term: { name: 'S1', start_at: '2026-09-01' } },
    { id: 2, name: 'B', course_code: 'MATH253-RESIT', term: { name: 'S2', start_at: '2026-01-20' } },
    { id: 3, name: 'C', course_code: 'MATH2530', term: { name: 'S1', start_at: '2026-09-01' } },
    { id: 4, name: 'D', course_code: 'COMP101-202627', term: { name: 'S1', start_at: '2026-09-01' } },
    { id: 5, name: 'E', course_code: 'COMP101-202526', term: { name: 'S1', start_at: '2025-09-01' } },
  ], '2026-10-17T00:00:00Z');
  assert.deepEqual(matchCourses(list, 'math253').map((c) => c.id), ['1']);          // exact code wins
  assert.deepEqual(matchCourses(list, 'COMP101').map((c) => c.id).sort(), ['4', '5']); // two terms: caller must ask
  assert.deepEqual(matchCourses(list, '3').map((c) => c.id), ['3']);
  assert.deepEqual(matchCourses(list, 'MATH25'), []);
  const groups = groupCourses(list);
  assert.equal(groups[0].kind, 'current');
});

test('UK time: BST in October before the clocks change, GMT after', () => {
  assert.match(londonTime('2026-10-24T16:00:00Z'), /17:00 BST/);
  assert.match(londonTime('2026-10-26T16:00:00Z'), /16:00 GMT/);
  assert.match(londonTime('2026-03-29T00:30:00Z'), /00:30 GMT/);
  assert.match(londonTime('2026-03-29T01:30:00Z'), /02:30 BST/);
});

test('planner rows: announcements have a posting time, not a deadline; unknown submissions stay unknown', () => {
  const ann = plannerRow({ plannable_type: 'announcement', plannable: { title: 'News', posted_at: '2026-09-20T09:00:00Z' }, plannable_date: '2026-09-20T09:00:00Z', submissions: false }, 'https://c');
  assert.equal(ann.due, undefined);
  assert.equal(ann.posted, '2026-09-20T09:00:00Z');
  const ext = plannerRow({ plannable_type: 'assignment', plannable: { title: 'Essay', due_at: '2026-11-02T12:00:00Z' }, submissions: false }, 'https://c');
  assert.match(ext.submission, /unknown/);
  assert.equal(ext.submitted, undefined);
  const undated = plannerRow({ plannable_type: 'quiz', plannable: { title: 'Practice' }, plannable_date: '2026-10-01T00:00:00Z', submissions: { submitted: true } }, 'https://c');
  assert.equal(undated.no_due_date, true);
  assert.equal(undated.submitted, true);
  const ev = plannerRow({ plannable_type: 'calendar_event', plannable: { title: 'Exam', start_at: '2026-12-01T10:00:00Z' } }, 'https://c');
  assert.equal(ev.type, 'calendar event');
  assert.equal(ev.due, undefined);
});
