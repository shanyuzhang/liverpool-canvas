import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startFakeCanvas } from './fake-canvas.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
const real = (p) => fs.realpathSync(p);
let fake;
before(async () => { fake = await startFakeCanvas(); });
after(() => fake.close());

function newHome({ defaultFolder } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fold-home-'));
  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify([{ name: 'canvas_session', value: 'good', domain: '127.0.0.1', path: '/', expires: -1 }]));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false, ...(defaultFolder ? { downloadDir: defaultFolder, downloadDirConfirmedAt: new Date().toISOString() } : {}) }));
  return home;
}
async function connect({ home, cwd, roots }) {
  const env = { ...process.env, LIVERPOOL_CANVAS_HOME: home, LIVERPOOL_CANVAS_TEST_ORIGIN: fake.base, LIVERPOOL_CANVAS_RENEW: 'hidden' };
  delete env.LIVERPOOL_CANVAS_DOWNLOADS;
  const c = new Client({ name: 'folders-test', version: '0' }, roots ? { capabilities: { roots: {} } } : {});
  if (roots) c.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href, name: path.basename(r) })) }));
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env, cwd, stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const t = r.content[0].text;
    let j = null; try { j = JSON.parse(t); } catch { /* text */ }
    return { error: !!r.isError, text: t, json: j };
  };
  return { c, call };
}

test('working in a project folder: the AI is offered that folder, and "download it here" lands right there', async () => {
  const project = real(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-project-')));
  const home = newHome();
  const { c, call } = await connect({ home, cwd: project });
  try {
    const ask = await call('canvas_download_courses', { course_ids: ['202'] });
    assert.match(ask.text, /ask the user before downloading/);
    assert.ok(ask.text.includes(`the folder they are working in now: ${project}`), ask.text);
    const st = await call('canvas_download_status');
    assert.equal(st.json.user_workspace, project);

    // "put the exam paper in a papers folder here"
    const one = await call('canvas_download_file', { file_ids: ['1006', '1003'], course_id: '101', download_folder: 'papers' });
    assert.equal(one.json.folder, path.join(project, 'papers'));
    assert.deepEqual(fs.readdirSync(path.join(project, 'papers')).sort(), ['Assignment 1.pdf', 'Solutions']);
    assert.equal(fs.readFileSync(path.join(project, 'papers', 'Assignment 1.pdf'), 'utf8'), 'assignment-1');
    const again = await call('canvas_download_file', { file_ids: ['1006'], course_id: '101', download_folder: 'papers' });
    assert.match(again.json.files[0].status, /already there/);
    assert.match((await call('canvas_download_status')).json.default_folder, /not chosen yet/, 'a single-file download does not set the default folder');

    // reading a file into the folder they are in
    const read = await call('canvas_read_file', { file_id: '1005', course_id: '101', download_folder: '.' });
    assert.match(read.text, /a,b/);
    assert.ok(fs.existsSync(path.join(project, 'data.csv')));
  } finally { await c.close(); }
});

test('the workspace the AI app reports wins over where the server was started', async () => {
  const workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-roots-')));
  const elsewhere = real(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-elsewhere-')));
  const { c, call } = await connect({ home: newHome(), cwd: elsewhere, roots: [workspace] });
  try {
    assert.equal((await call('canvas_download_status')).json.user_workspace, workspace);
    const r = await call('canvas_download_courses', { course_ids: ['202'], download_folder: 'Canvas files' });
    assert.equal(r.json.state, 'done');
    assert.ok(fs.existsSync(path.join(workspace, 'Canvas files', 'MATH268 (2026-27 Semester 1)', 'Lectures', 'Notes.pdf')));
    // no default existed, so this folder became the default (as before)
    assert.equal((await call('canvas_download_status')).json.default_folder, path.join(workspace, 'Canvas files'));
  } finally { await c.close(); }
});

test('with a default folder set, a folder named in one request is used for that request only', async () => {
  const def = real(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-default-')));
  const project = real(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-proj2-')));
  const { c, call } = await connect({ home: newHome({ defaultFolder: def }), cwd: project });
  try {
    const r = await call('canvas_download_courses', { course_ids: ['202'], download_folder: project });
    assert.equal(r.json.folder, project);
    assert.ok(fs.existsSync(path.join(project, 'MATH268 (2026-27 Semester 1)', 'Lectures', 'Notes.pdf')));
    assert.deepEqual(fs.readdirSync(def), []);
    assert.equal((await call('canvas_download_status')).json.default_folder, def);
    const sync = await call('canvas_sync_courses', { download_folder: project });
    assert.equal(sync.json.summary[0].already_saved, 2);
    const kept = await call('canvas_save_course_files', { course_id: '202', download_folder: project, remember_folder: true });
    assert.equal(kept.json.state, 'done');
    assert.equal((await call('canvas_download_status')).json.default_folder, project);
  } finally { await c.close(); }
});

test('folder names: relative, ~, and refused places', async () => {
  const { resolveFolder, HOME } = await import('../src/config.js');
  const { looksLikeProject } = await import('../src/app.js');
  assert.equal(resolveFolder('papers', '/work/proj'), path.resolve('/work/proj/papers'));
  assert.equal(resolveFolder('~/Desktop/x', '/work'), path.join(os.homedir(), 'Desktop', 'x'));
  assert.throws(() => resolveFolder('/', '/work'), /top of the disk/);
  assert.throws(() => resolveFolder(path.join(HOME, 'x')), /data folder/);
  assert.equal(looksLikeProject(os.homedir()), false);
  assert.equal(looksLikeProject(path.parse(process.cwd()).root), false);
  assert.equal(looksLikeProject('/Users/me/.npm/_npx/abc/node_modules/x'), false);
  assert.equal(looksLikeProject('/Users/me/Documents/study'), true);
});
