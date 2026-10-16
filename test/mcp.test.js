import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeCanvas } from './fake-canvas.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

// The 17 tools of canvas-session-mcp (upstream commit 9780f27). Every one must still exist with
// the same name and required arguments.
export const UPSTREAM_TOOLS = {
  canvas_whoami: [], canvas_list_courses: [], canvas_upcoming: [], canvas_list_assignments: ['course_id'], canvas_get_assignment: ['course_id', 'assignment_id'],
  canvas_list_announcements: [], canvas_list_modules: ['course_id'], canvas_get_page: ['course_id', 'page_url'], canvas_list_files: ['course_id'],
  canvas_read_file: ['file_id'], canvas_save_course_files: ['course_id'], canvas_list_discussions: ['course_id'], canvas_get_discussion: ['course_id', 'topic_id'],
  canvas_grades: [], canvas_inbox: [], canvas_calendar: [], canvas_api_get: ['path'],
};

let fake; let home; let downloads; let client;
async function connect(extraEnv = {}) {
  const env = { ...process.env, LIVERPOOL_CANVAS_HOME: home, LIVERPOOL_CANVAS_TEST_ORIGIN: fake.base, LIVERPOOL_CANVAS_RENEW: 'hidden', LIVERPOOL_CANVAS_DOWNLOADS: downloads, ...extraEnv };
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env, stderr: 'pipe' }));
  return c;
}
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
};

before(async () => {
  fake = await startFakeCanvas();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-home-'));
  downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-dl-'));
  // A saved sign-in for the fake Canvas, as `login` would leave it.
  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify([{ name: 'canvas_session', value: 'good', domain: '127.0.0.1', path: '/', expires: -1 }]));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiddenRenewWorks: false }));
  client = await connect();
});
after(async () => { await client?.close(); await fake.close(); });

test('every upstream tool is still there with the same required arguments; new tools are added, none removed', async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const [name, required] of Object.entries(UPSTREAM_TOOLS)) {
    assert.ok(byName.has(name), `missing ${name}`);
    assert.deepEqual((byName.get(name).inputSchema.required || []).sort(), [...required].sort(), name);
  }
  for (const name of ['canvas_preview_download', 'canvas_download_courses', 'canvas_sync_courses', 'canvas_download_status']) assert.ok(byName.has(name), name);
  // read-only on Canvas; only the tools that save files into the chosen folder are not marked read-only
  for (const t of tools) {
    const saves = ['canvas_save_course_files', 'canvas_download_courses', 'canvas_sync_courses'].includes(t.name);
    assert.equal(t.annotations.readOnlyHint, !saves, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

test('regression: each upstream capability returns normal results', async () => {
  assert.equal((await call('canvas_whoami')).json.name, 'Test Student');
  const courses = (await call('canvas_list_courses')).json;
  assert.deepEqual(courses.filter((c) => c.current_term).map((c) => c.code).sort(), ['MATH253', 'MATH268']);
  assert.ok(courses.find((c) => c.code === 'CAREERS').kind);
  const up = (await call('canvas_upcoming', { days: 60, past_days: 60 })).json;
  assert.ok(up.find((x) => x.title === 'Assignment 1').due_uk.includes('BST'));
  assert.equal(up.find((x) => x.type === 'announcement').due, undefined, 'announcement post date is not a deadline');
  assert.match(up.find((x) => x.title === 'Turnitin essay').submission, /unknown/);
  assert.ok(!up.some((x) => x.type === 'calendar event'));
  assert.ok((await call('canvas_upcoming', { days: 60, past_days: 60, include_events: true })).json.some((x) => x.type === 'calendar event'));
  assert.equal((await call('canvas_list_assignments', { course_id: '101' })).json[0].name, 'Assignment 1');
  const a = (await call('canvas_get_assignment', { course_id: 101, assignment_id: 601 })).json;
  assert.deepEqual(a.file_ids, ['1008', '2001']);
  assert.equal(a.rubric[0].criterion, 'Correctness');
  const ann = (await call('canvas_list_announcements', { days: 365 })).json;
  assert.equal(ann[0].attachments[0].name, 'Assignment 1 sheet.pdf');
  const mods = (await call('canvas_list_modules', { course_id: '101' })).json;
  assert.equal(mods[0].items.length, 4, 'items fetched for a module whose items were left out');
  assert.match((await call('canvas_get_page', { course_id: '101', page_url: 'week-1' })).text, /linked file ids: 1001, 1009/);
  const files = (await call('canvas_list_files', { course_id: '101' })).json;
  assert.equal(files.complete, true);
  assert.equal(files.files.length, 9);
  const read = await call('canvas_read_file', { file_id: '1005', course_id: '101' });
  assert.match(read.text, /a,b\n1,2/);
  assert.ok(read.text.includes(downloads));
  assert.equal((await call('canvas_list_discussions', { course_id: '101' })).json[0].title, 'Questions about week 1');
  assert.match((await call('canvas_get_discussion', { course_id: '101', topic_id: '901' })).text, /inverses/);
  assert.equal((await call('canvas_grades')).json[0].current_score, 72.5);
  assert.equal((await call('canvas_grades', { course_id: '101' })).json[0].comments[0], 'Dr Example: Good work');
  assert.equal((await call('canvas_inbox')).json[0].subject, 'Office hours');
  assert.match((await call('canvas_inbox', { conversation_id: '31' })).text, /Moved to Friday/);
  assert.match((await call('canvas_calendar', { days: 60 })).json[0].start_uk, /BST/);
  assert.match((await call('canvas_api_get', { path: 'courses/101/assignments' })).text, /Assignment 1/);
  const bad = await call('canvas_api_get', { path: 'https://evil.example/x' });
  assert.equal(bad.error, true);
  assert.ok(fake.log.every((l) => l.startsWith('GET ')));
});

test('download tools: missing-only, the same rule as the command line and the local page', async () => {
  const first = (await call('canvas_save_course_files', { course_id: '101' })).json;
  assert.equal(first.state, 'done');
  const s = first.summary[0];
  assert.equal(s.new, 8, 'data.csv was already saved by canvas_read_file');
  assert.equal(s.already_saved, 1);
  const again = (await call('canvas_download_courses', { course_ids: ['101', '202'] })).json.summary;
  assert.equal(again[0].new, 0);
  assert.equal(again[0].already_saved, 9);
  assert.equal(again[1].new, 2);
  const preview = (await call('canvas_preview_download', { course_ids: ['202'] })).json;
  assert.equal(preview[0].to_download, 0);
  const sync = (await call('canvas_sync_courses')).json;
  assert.deepEqual(sync.summary.map((x) => x.already_saved), [9, 2]);
  const status = (await call('canvas_download_status')).json;
  assert.deepEqual(status.remembered_courses, ['101', '202']);
  assert.ok(status.history.length >= 3);
});

test('no access and expired sessions come back as clear errors', async () => {
  fake.model.courses[2].noAccess = true;
  const denied = await call('canvas_list_modules', { course_id: '303' });
  assert.equal(denied.error, true);
  assert.match(denied.text, /403/);
  fake.model.courses[2].noAccess = false;
  fake.model.cookie = 'canvas_session=rotated';
  try {
    const r = await call('canvas_whoami');
    assert.equal(r.error, true);
    assert.match(r.text, /expired|sign in|login/i);
    assert.match(r.text, /login/);
  } finally { fake.model.cookie = 'canvas_session=good'; }
});

test('without a confirmed folder, download tools ask for one instead of picking it silently', async () => {
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-home2-'));
  fs.copyFileSync(path.join(home, 'session.json'), path.join(h2, 'session.json'));
  const env = { ...process.env, LIVERPOOL_CANVAS_HOME: h2, LIVERPOOL_CANVAS_TEST_ORIGIN: fake.base, LIVERPOOL_CANVAS_RENEW: 'hidden' };
  delete env.LIVERPOOL_CANVAS_DOWNLOADS;
  const c2 = new Client({ name: 't2', version: '0' });
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env, stderr: 'pipe' }));
  try {
    const r = await c2.callTool({ name: 'canvas_download_courses', arguments: { course_ids: ['202'] } });
    assert.match(r.content[0].text, /Ask the user where/);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-chosen-'));
    const ok = JSON.parse((await c2.callTool({ name: 'canvas_download_courses', arguments: { course_ids: ['202'], download_folder: target } })).content[0].text);
    assert.equal(ok.summary[0].new, 2);
    assert.ok(fs.existsSync(path.join(target, 'MATH268 (2026-27 Semester 1)', 'Lectures', 'Notes.pdf')));
  } finally { await c2.close(); }
});
