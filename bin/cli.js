#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';

const HELP = `Liverpool Canvas Assistant (command: liverpool-canvas) — your AI assistant for University of Liverpool Canvas
(unofficial student tool; read-only on Canvas)

Usage: liverpool-canvas [command] [options]

  (no command)   first run: setup; afterwards a short menu (connect AI / open local page)
  setup          choose the download folder, sign in, optionally connect one AI app
  login          sign in again in a separate Chrome/Edge window (SSO and MFA as usual)
  logout         forget the saved sign-in on this computer
  status         sign-in state, download folder, remembered courses
  courses        list your courses, grouped by term
  preview        show what would be downloaded for --course, without downloading
  download       download the courses given with --course (repeatable); only missing files are fetched
  sync           fetch new files for the courses you chose before
  reindex        adopt files already in the download folder (see below)
  connect        connect an AI app you choose (Claude Desktop, Claude Code, Codex, Cursor, Windsurf)
  web            open the local page (download courses without an AI app)
  mcp            run the MCP server on stdio (this is what AI apps start)
  update         update the local copy that AI apps start (published versions only)

Options:
  --course <code|id>     a course code such as MATH253, or a Canvas course id; repeat for more
  --folder <path>        download folder (default: Documents/Canvas)
  --include-images       also save images that only appear inside page text
  --include-past         also look at past courses
  --no-save              download, but do not remember the course choice for sync
  --client <id>          for connect/setup: claude-desktop, claude-code, codex, cursor, windsurf
  --skip-ai              setup without connecting an AI app
  --no-login             setup without signing in now
  --port <n>             web: port on 127.0.0.1 (default: any free port)
  --no-open              web: do not open the browser
  --json                 machine-readable output on stdout (progress goes to stderr)
  -y, --yes              accept defaults where a default is safe (never connects AI apps or picks courses)
  -h, --help             this help

Downloads never replace or move a file that is already saved. A file is fetched only if it is not
in the download index yet, or if its saved copy was deleted. Files changed on Canvas are reported,
and your copy is kept.

reindex: for files that are not in the index yet, a file already at exactly the path this tool
would use, with exactly the size Canvas reports, is recorded as saved. Nothing is downloaded,
moved or overwritten; files that do not match both are left alone and downloaded next to them.
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      course: { type: 'string', multiple: true }, folder: { type: 'string' }, client: { type: 'string', multiple: true },
      'include-images': { type: 'boolean' }, 'include-past': { type: 'boolean' }, 'no-save': { type: 'boolean' },
      'skip-ai': { type: 'boolean' }, 'no-login': { type: 'boolean' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
      json: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  process.stderr.write(`${e.message}\n\n${HELP}`);
  process.exit(2);
}
const { positionals, values } = parsed;
const cmd = positionals[0] || '';
const JSON_OUT = !!values.json;

// MCP owns stdout in `mcp`; with --json stdout carries only the JSON result.
const say = (s = '') => (cmd === 'mcp' || JSON_OUT ? process.stderr : process.stdout).write(s + '\n');
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const interactive = () => process.stdin.isTTY && process.stdout.isTTY && !JSON_OUT;

let rl = null;
async function ask(question, fallback = '') {
  if (!interactive()) return fallback;
  rl ||= readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim();
  return a || fallback;
}
const confirm = async (question, def = true) => {
  if (!interactive()) return def && values.yes;
  const a = await ask(`${question} ${def ? '(Y/n)' : '(y/N)'}`, def ? 'y' : 'n');
  return /^(y|yes|是|好)$/i.test(a);
};
async function choose(question, options) {
  options.forEach((o, i) => say(`  ${i + 1}) ${o.label}`));
  for (;;) {
    const a = await ask(question);
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
    if (/^q$/i.test(a) || !interactive()) return null;
    say('Type one of the numbers above (or q to stop).');
  }
}

const cfg = await import('../src/config.js');
const { cliHint, release } = await import('../src/release.js');

async function makeApp() {
  const { App } = await import('../src/app.js');
  return new App();
}

async function signIn() {
  const { openSession } = await import('../src/browser.js');
  const base = cfg.baseUrl();
  say(`\nOpening ${base} in a separate Chrome/Edge window.`);
  say('  · Sign in there with your university account, password and MFA, as on the Canvas website.');
  say('  · This window has its own profile: it is not signed in to your everyday Google/Microsoft accounts.');
  say('  · Never type your password into a chat or this terminal. The window closes by itself when you are in.');
  const { me } = await openSession(base, { headless: false, onLoginPath: (p) => cfg.writeConfig({ loginPath: p }) });
  cfg.writeConfig({ user: { id: me.id, name: me.name }, loggedInAt: new Date().toISOString() });
  say(`✓ Signed in as ${me.name}`);
  return me;
}

async function signedInUser() {
  const { savedSession } = await import('../src/browser.js');
  const { CanvasClient } = await import('../src/canvas.js');
  const base = cfg.baseUrl();
  const saved = savedSession(base);
  if (!saved) return null;
  return new CanvasClient({ base, session: async () => saved, retries: 1 }).get('users/self').catch((e) => (e.code === 'auth' ? null : Promise.reject(e)));
}

async function chooseFolder({ forceAsk = false } = {}) {
  const current = cfg.downloadRoot();
  if (values.folder) return applyFolder(path.resolve(values.folder));
  if (current && !forceAsk) return current;
  const proposed = current || cfg.defaultDownloadRoot();
  const answer = await ask('Where should course files be saved?', proposed);
  if (!interactive() && !values.yes && !current) throw new Error(`Choose a download folder with --folder (for example --folder "${proposed}"), or add --yes to use it.`);
  return applyFolder(path.resolve(answer || proposed));
}

function applyFolder(dir) {
  const r = cfg.confirmDownloadRoot(dir);
  if (r.changed) say(`Note: ${r.root} is a new download folder. Files saved in ${r.previous} stay there; courses for this folder are chosen again.`);
  say(`✓ Course files will be saved in ${r.root}`);
  return r.root;
}

async function connect({ fromSetup = false } = {}) {
  const { clients, ensureStableInstall, manualConfig } = await import('../src/clients.js');
  const all = clients();
  const found = all.filter((c) => c.detect());
  let picked = [];
  if (values.client?.length) {
    for (const want of values.client.flatMap((s) => s.split(','))) {
      const c = all.find((x) => x.id === want.trim());
      if (!c) throw new Error(`Unknown AI app "${want}". Use one of: ${all.map((x) => x.id).join(', ')}`);
      picked.push(c);
    }
  } else if (!interactive()) {
    if (fromSetup) return [];
    throw new Error(`Say which AI app to connect with --client (${all.map((x) => x.id).join(', ')}).`);
  } else {
    say('\nWhich AI app should get Liverpool Canvas Assistant? Only the one you pick is changed.');
    const opts = [...found.map((c) => ({ label: `${c.name}`, c })), { label: 'Another app (show the settings to paste)', manual: true }, { label: fromSetup ? 'Skip for now — I will use the local page' : 'Cancel', skip: true }];
    if (!found.length) say('(No supported AI app was found on this computer.)');
    const o = await choose('Number:', opts);
    if (!o || o.skip) return [];
    if (o.manual) {
      const launch = ensureStableInstall({ log: say });
      say(`\nAdd this server in your app's MCP settings:\n\n${manualConfig(launch)}\n`);
      say('Plain chat websites cannot start programs on your computer; you need an app that supports local MCP servers.');
      return [];
    }
    picked = [o.c];
  }
  const launch = ensureStableInstall({ log: say });
  const done = [];
  for (const c of picked) {
    try {
      const r = c.install(launch);
      done.push({ id: c.id, name: c.name, where: r.where, backup: r.backup, restart: c.restart.en });
      say(`✓ ${c.name} → ${r.where}${r.backup ? `\n  backup of the previous file: ${r.backup}` : ''}`);
      say(`  Next: ${c.restart.en}\n  然后: ${c.restart.zh}`);
    } catch (e) { say(`✗ ${c.name}: ${e.message}`); done.push({ id: c.id, error: e.message }); }
  }
  if (done.some((d) => !d.error)) {
    say('\nNote: what the AI reads from Canvas through this tool is sent to that AI app and its provider, like anything else you share in a chat.');
    say('Try asking: "List my courses and what is due this week" / “列出我的课程和本周截止的作业”');
  }
  return done;
}

async function resolveCourses(app, queries) {
  const { listCourses, matchCourses } = await import('../src/courses.js');
  let courses = await listCourses(app.client, { includePast: values['include-past'] });
  const ids = [];
  for (const q of queries) {
    let hits = matchCourses(courses, q);
    if (!hits.length && !values['include-past']) {
      courses = await listCourses(app.client, { includePast: true });
      hits = matchCourses(courses, q);
    }
    if (!hits.length) throw new Error(`No course matches "${q}". Run "courses" to see your courses and their ids.`);
    if (hits.length > 1) {
      const label = (c) => `${c.code} — ${c.name}${c.term ? ` (${c.term})` : ''} [id ${c.id}]`;
      if (!interactive()) throw new Error(`"${q}" matches more than one course; use the id:\n${hits.map((c) => '  ' + label(c)).join('\n')}`);
      say(`"${q}" matches more than one course:`);
      const o = await choose('Which one?', hits.map((c) => ({ label: label(c), c })));
      if (!o) throw new Error('No course chosen.');
      hits = [o.c];
    }
    ids.push(hits[0].id);
  }
  return [...new Set(ids)];
}

function progressPrinter() {
  let last = '';
  const out = process.stderr;
  return (e) => {
    let line = '';
    if (e.type === 'course' && e.state === 'scanning') line = `\n▸ Course ${e.courseId}: looking for files…`;
    else if (e.type === 'phase') line = `  · checking ${e.phase}`;
    else if (e.type === 'course' && e.state === 'downloading') line = `  ${e.total} files found, ${e.existing} already saved`;
    else if (e.type === 'file' && e.state === 'start') line = `  ↓ ${e.name}`;
    else if (e.type === 'file' && e.state === 'failed') line = `  ✗ ${e.name}`;
    else if (e.type === 'course-done') {
      const c = e.summary.counts;
      line = `  ${e.summary.code || e.summary.id}: ${c.new} new, ${c.existing} already saved${c.restored ? `, ${c.restored} restored` : ''}, ${c.failed} failed${c.skipped ? `, ${c.skipped} no access/locked` : ''}${c.remoteUpdated ? `, ${c.remoteUpdated} changed on Canvas (local copy kept)` : ''}${e.summary.complete ? '' : '  ⚠ not complete'}`;
    }
    if (line && line !== last) { out.write(line + '\n'); last = line; }
  };
}

function printResult(r) {
  if (JSON_OUT) return emit(r);
  for (const c of r.courses) {
    say(`\n${c.code || c.id}${c.name ? ` — ${c.name}` : ''}`);
    if (c.folder) say(`  folder: ${c.folder}`);
    if (r.preview) {
      say(`  would download ${c.counts.new}${c.counts.restored ? ` + ${c.counts.restored} missing locally` : ''}, already saved ${c.counts.existing}`);
      for (const f of c.files.filter((x) => x.action !== 'already saved').slice(0, 50)) say(`   + ${f.folder}/${f.name}`);
    } else {
      say(`  new ${c.counts.new} · already saved ${c.counts.existing} · restored ${c.counts.restored} · failed ${c.counts.failed}`);
      for (const f of c.failed.slice(0, 20)) say(`   ✗ ${f.name}: ${f.error}`);
    }
    if (c.counts.remoteUpdated) say(`  changed on Canvas since saved (kept your copy): ${c.remoteUpdated.slice(0, 10).join(', ')}`);
    if (c.counts.skipped) say(`  ${c.counts.skipped} item(s) locked or without permission`);
    if (c.counts.images) say(`  ${c.counts.images} page image(s) left out (--include-images to save them)`);
    for (const x of c.incomplete) say(`  ⚠ not fully scanned — ${x.source}: ${x.reason}`);
    if (c.error) say(`  ✗ ${c.error}`);
  }
  say(r.complete ? '\n✓ Done.' : r.cancelled ? '\nStopped. Files that finished are kept; run again to continue.' : '\n⚠ Finished, but not everything could be checked or saved (see above). Running it again only fetches what is still missing.');
}

async function download({ preview = false, sync = false } = {}) {
  const app = await makeApp();
  const root = preview ? (cfg.downloadRoot() || cfg.defaultDownloadRoot()) : await chooseFolder();
  const me = await app.user();
  let ids;
  if (sync) {
    ids = cfg.savedSelection(app.base, me.id, root);
    if (!ids?.length) {
      throw new Error(`No courses chosen for ${root} yet. Choose some first, e.g.:\n  ${cliHint('download --course MATH253')}\nor pick them in the local page: ${cliHint('web')}`);
    }
  } else {
    if (!values.course?.length) throw new Error('Say which courses with --course (for example --course MATH253). See "courses" for the list.');
    ids = await resolveCourses(app, values.course);
  }
  const { runDownload } = await import('../src/downloader.js');
  const index = await app.index(root);
  if (!preview && !sync && !values['no-save']) {
    const before = cfg.savedSelection(app.base, me.id, root) || [];
    cfg.saveSelection(app.base, me.id, root, [...before, ...ids]);
  }
  const ctrl = new AbortController();
  process.once('SIGINT', () => { say('\nStopping… (finished files are kept)'); ctrl.abort(new Error('cancelled')); });
  const r = await runDownload(app.client, index, { courseIds: ids, preview, includeImages: values['include-images'], signal: ctrl.signal, onEvent: progressPrinter() });
  printResult(r);
  if (!r.complete) process.exitCode = r.cancelled ? 130 : 3;
}

async function reindex() {
  const app = await makeApp();
  const root = await chooseFolder();
  if (!values.course?.length) throw new Error('Say which courses with --course.');
  const ids = await resolveCourses(app, values.course);
  const { discoverCourseFiles, subfolderFor } = await import('../src/discovery.js');
  const { safeName, fileNameFor, DownloadIndex, courseFolderName } = await import('../src/store.js');
  const index = await app.index(root);
  const report = [];
  for (const cid of ids) {
    const d = await discoverCourseFiles(app.client, cid, { includeImages: true });
    let adopted = 0; let left = 0;
    await index.update((data) => {
      const folder = data.courses[cid]?.folder || courseFolderName(d.course);
      data.courses[cid] ||= { folder, code: d.course.code, name: d.course.name, term: d.course.term };
      for (const f of d.files) {
        const key = DownloadIndex.key(cid, f.id);
        if (data.files[key]?.status === 'complete') continue;
        const p = path.join(root, folder, ...subfolderFor(f.primary).map((s) => safeName(s)), fileNameFor(f.name, f.contentType));
        const st = fs.existsSync(p) ? fs.statSync(p) : null;
        const claimed = Object.values(data.files).some((r) => r.path && path.resolve(r.path) === path.resolve(p));
        if (st?.isFile() && f.size != null && st.size === Number(f.size) && !claimed) {
          data.files[key] = { courseId: cid, fileId: String(f.id), name: f.name, path: p, status: 'complete', size: st.size, remoteUpdatedAt: f.updatedAt, remoteSize: f.size, downloadedAt: null, adopted: true, sources: f.sources };
          adopted++;
        } else if (st) left++;
      }
    });
    report.push({ course: d.course.code || cid, adopted, leftAlone: left, scanComplete: d.complete });
    say(`${d.course.code || cid}: recorded ${adopted} existing file(s); ${left} file(s) with the same name but a different size were left alone${d.complete ? '' : ' (scan incomplete)'}`);
  }
  if (JSON_OUT) emit(report);
}

async function status() {
  const base = cfg.baseUrl();
  const me = await signedInUser().catch((e) => ({ error: e.message }));
  const root = cfg.downloadRoot();
  const sel = me?.id && root ? cfg.savedSelection(base, me.id, root) : null;
  const r = release();
  const out = {
    canvas: base, signedIn: !!me?.id, user: me?.id ? me.name : null, error: me?.error,
    downloadFolder: root, defaultDownloadFolder: cfg.defaultDownloadRoot(), rememberedCourses: sel || [],
    dataFolder: cfg.HOME, version: r.version, published: r.published,
  };
  if (JSON_OUT) return emit(out);
  say(`Canvas: ${base}`);
  say(out.signedIn ? `✓ Signed in as ${out.user}` : out.error ? `✗ Could not check the sign-in: ${out.error}` : `✗ Not signed in (or the session expired). Run: ${cliHint('login')}`);
  say(`Download folder: ${root || `not chosen yet (default would be ${out.defaultDownloadFolder})`}`);
  if (sel?.length) say(`Courses remembered for sync: ${sel.join(', ')}`);
  say(`Data folder (settings, sign-in, download index): ${cfg.HOME}`);
}

async function courses() {
  const app = await makeApp();
  const { listCourses, groupCourses } = await import('../src/courses.js');
  const list = await listCourses(app.client, { includePast: values['include-past'] });
  const groups = groupCourses(list);
  if (JSON_OUT) return emit(groups);
  for (const g of groups) {
    say(`\n${g.kind === 'other' ? 'Other sites' : g.label || 'No term'}${g.kind === 'current' ? '  (this term)' : ''}`);
    for (const c of g.courses) say(`  ${c.code.padEnd(16)} ${c.name}   [id ${c.id}]`);
  }
}

async function setup() {
  say('Liverpool Canvas Assistant setup');
  say(`Canvas address: ${cfg.baseUrl()}  (University of Liverpool)\n`);
  const root = await chooseFolder({ forceAsk: !values.folder });
  if (!values['no-login']) {
    const me = await signedInUser().catch(() => null);
    if (me?.name) say(`✓ Already signed in as ${me.name}`);
    else await signIn();
  }
  let connected = [];
  if (!values['skip-ai']) connected = await connect({ fromSetup: true });
  rl?.close();
  say('\nAll set.');
  say(`  · Download courses without an AI app: ${cliHint('web')}`);
  say(`  · Or from here: ${cliHint('download --course MATH253')}, and later ${cliHint('sync')}`);
  if (!connected.length) say(`  · Connect an AI app any time: ${cliHint('connect')}`);
  if (JSON_OUT) emit({ downloadFolder: root, connected });
}

async function menu() {
  if (!cfg.downloadRoot() || !cfg.readConfig().user) return setup();
  say('Liverpool Canvas Assistant');
  const o = await choose('What would you like to do?', [
    { label: 'Connect an AI app (Claude, Codex, …)', run: () => connect() },
    { label: 'Open the local page to download course files', run: () => web() },
    { label: 'Check status', run: status },
    { label: 'Sign in again', run: signIn },
  ]);
  if (o) await o.run();
}

async function web() {
  const { startWeb } = await import('../src/web/server.js');
  const port = values.port ? Number(values.port) : 0;
  const s = await startWeb({ port, open: !values['no-open'], log: say });
  say(`Local page: ${s.url}\n(only reachable from this computer; press Ctrl+C here to stop it)`);
  if (JSON_OUT) emit({ url: s.url });
  await s.closed;
}

try {
  if (values.help || cmd === 'help') {
    say(HELP);
  } else if (cmd === 'mcp') {
    const { startServer } = await import('../src/server.js');
    await startServer();
  } else if (cmd === '') {
    if (!interactive()) { say(HELP); say('AI apps start the MCP server with the "mcp" command.'); process.exitCode = 2; }
    else await menu();
  } else if (cmd === 'setup') await setup();
  else if (cmd === 'login') { await signIn(); }
  else if (cmd === 'logout') {
    const { clearSession } = await import('../src/browser.js');
    clearSession();
    cfg.writeConfig({ user: undefined, loggedInAt: undefined });
    say('✓ Signed out on this computer (saved session and the sign-in browser profile were removed). Downloaded files were not touched.');
  } else if (cmd === 'status') await status();
  else if (cmd === 'courses') await courses();
  else if (cmd === 'preview') await download({ preview: true });
  else if (cmd === 'download') await download();
  else if (cmd === 'sync') await download({ sync: true });
  else if (cmd === 'reindex') await reindex();
  else if (cmd === 'connect') { const r = await connect(); if (JSON_OUT) emit(r); }
  else if (cmd === 'web') await web();
  else if (cmd === 'update') {
    const { updateStableInstall } = await import('../src/clients.js');
    const v = updateStableInstall({ log: say });
    say(`✓ Updated to ${v}. Restart your AI app to use it.`);
  } else {
    say(`Unknown command "${cmd}".\n`);
    say(HELP);
    process.exitCode = 2;
  }
} catch (e) {
  if (JSON_OUT) emit({ error: e.message, code: e.code || undefined });
  else say(`✗ ${e.message}`);
  if (e.code === 'auth' && !JSON_OUT) say(`  Sign in: ${cliHint('login')}`);
  process.exitCode = e.code === 'auth' ? 4 : 1;
} finally {
  rl?.close();
}
