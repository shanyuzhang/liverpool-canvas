// Runs the local page against a synthetic Canvas with fictional courses, for trying the
// interface and taking screenshots. Nothing here touches a real Canvas account.
//   node scripts/demo.mjs              signed in as a fictional student
//   node scripts/demo.mjs --signed-out start signed out (the sign-in button opens Chrome on a demo sign-in page)
//   node scripts/demo.mjs --slow       some files take seconds, to try cancelling
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeCanvas, defaultModel } from '../test/fake-canvas.js';

const signedOut = process.argv.includes('--signed-out');
const model = defaultModel();
model.user = { id: 42, name: 'Alex Example' };
const term = { name: '2026-27 Semester 1', start_at: '2026-09-01T00:00:00Z' };
const mk = (id, code, name, files) => ({
  id, name, course_code: code, term, filesHidden: true, pagesListDisabled: true, pages: {}, announcements: [], assignments: [],
  modules: [{ id: id * 10, name: 'Week 1', items: Object.keys(files).map((fid, i) => ({ id: id * 100 + i, type: 'File', content_id: Number(fid) })) }],
  files: Object.fromEntries(Object.entries(files).map(([fid, n]) => [fid, { display_name: n, content: `demo ${n}`, 'content-type': 'application/pdf', updated_at: '2026-09-25T00:00:00Z' }])),
});
model.courses.splice(2, 0,
  mk(505, 'COMP207', 'Database Development (fictional)', { 5001: 'Lecture 1.pdf', 5002: 'Lab sheet 1.pdf' }),
  mk(606, 'ENVS101', 'Climate and Society (fictional)', { 6001: 'Reading pack.pdf' }));
model.courses.find((c) => c.id === 404).name = 'Linear Algebra (fictional, last year)';

if (process.argv.includes('--slow')) model.slow = { 5002: 6000, 6001: 6000 };   // to try "cancel"
const fake = await startFakeCanvas(model);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-demo-home-'));
const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-demo-files-')), 'Canvas');
if (!signedOut) fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify([{ name: 'canvas_session', value: 'good', domain: '127.0.0.1', path: '/', expires: -1 }]));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false }));
process.env.LIVERPOOL_CANVAS_HOME = home;
process.env.LIVERPOOL_CANVAS_TEST_ORIGIN = fake.base;
process.env.LIVERPOOL_CANVAS_DEMO_DEFAULT_ROOT = root;

const { startWeb } = await import('../src/web/server.js');
const web = await startWeb({ open: !process.argv.includes('--no-open'), port: Number(process.env.PORT) || 0 });
console.log(`Synthetic Canvas: ${fake.base}`);
console.log(`Demo data folder: ${home}`);
console.log(`Suggested download folder: ${root}`);
console.log(`Local page: ${web.url}`);
await web.closed;
await fake.close();
