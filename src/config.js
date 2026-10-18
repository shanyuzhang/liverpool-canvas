import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// This tool is for one Canvas only.
export const LIVERPOOL_CANVAS = 'https://canvas.liverpool.ac.uk';

// Everything this tool keeps lives in one folder in your home directory: settings, the
// separate browser profile used for signing in, saved session cookies and the download index.
// Course files go to the download folder you choose, never in here.
export const HOME = process.env.LIVERPOOL_CANVAS_HOME || path.join(os.homedir(), '.liverpool-canvas');
export const PROFILE_DIR = path.join(HOME, 'browser-profile');
const CONFIG_FILE = path.join(HOME, 'config.json');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const isLoopbackHost = (host) => LOOPBACK.has(String(host).toLowerCase());

// Tests and the demo point the tool at a synthetic Canvas running on this computer.
// Only plain-http loopback addresses are accepted, so it can never be aimed at another school.
export function baseUrl() {
  const test = process.env.LIVERPOOL_CANVAS_TEST_ORIGIN;
  if (!test) return LIVERPOOL_CANVAS;
  const u = new URL(test);
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) {
    throw new Error('LIVERPOOL_CANVAS_TEST_ORIGIN only accepts a local test server (http://127.0.0.1:<port>).');
  }
  return u.origin;
}

// Links in course content occasionally use Canvas's instructure.com name for the same site.
// They are recognised as Canvas links, but requests always go to the main address.
export const CANVAS_ALIASES = ['liverpool.instructure.com'];

// Files and folders here are readable only by you (where the OS supports POSIX modes).
export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(HOME, 0o700); } catch { /* Windows: ACLs of the user profile apply */ }
  return HOME;
}

export function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

export function writeConfig(patch) {
  ensureHome();
  const next = { ...readConfig(), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  writePrivate(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

// The user's Documents folder from the OS (it can be redirected, e.g. to OneDrive on Windows).
let documents = null;
export function documentsDir() {
  if (documents) return documents;
  const home = os.homedir();
  let dir = null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("MyDocuments")'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      dir = r.status === 0 ? r.stdout.trim() : null;
    } else if (process.platform === 'linux') {
      const r = spawnSync('xdg-user-dir', ['DOCUMENTS'], { encoding: 'utf8', timeout: 3000 });
      dir = r.status === 0 && r.stdout.trim() !== home ? r.stdout.trim() : null;
    }
  } catch { dir = null; }
  documents = dir && path.isAbsolute(dir) ? dir : path.join(home, 'Documents');
  return documents;
}

export const defaultDownloadRoot = () => (process.env.LIVERPOOL_CANVAS_TEST_ORIGIN && process.env.LIVERPOOL_CANVAS_DEMO_DEFAULT_ROOT) || path.join(documentsDir(), 'Canvas');

// The download folder the user confirmed (setup, local page, or an AI tool call that asked them).
// Null until confirmed. LIVERPOOL_CANVAS_DOWNLOADS overrides it, e.g. for scripts.
export function downloadRoot() {
  if (process.env.LIVERPOOL_CANVAS_DOWNLOADS) return path.resolve(process.env.LIVERPOOL_CANVAS_DOWNLOADS);
  const c = readConfig();
  return c.downloadDir && c.downloadDirConfirmedAt ? c.downloadDir : null;
}

// Sets the download folder. Returns whether it is a new destination for an existing setup.
export function confirmDownloadRoot(dir) {
  if (!dir || !path.isAbsolute(String(dir))) throw new Error('Choose a full folder path, e.g. ' + defaultDownloadRoot());
  const resolved = path.resolve(String(dir));
  const before = downloadRoot();
  fs.mkdirSync(resolved, { recursive: true });
  writeConfig({ downloadDir: resolved, downloadDirConfirmedAt: new Date().toISOString() });
  return { root: resolved, changed: !!before && before !== resolved, previous: before };
}

// A folder the user named for a download. "~" is their home folder; a relative path such as
// "papers" is taken inside `base` (the folder they are working in). The disk root and this
// tool's own data folder are refused.
export function resolveFolder(input, base = process.cwd()) {
  let p = String(input || '').trim();
  if (!p) throw new Error('Name a folder.');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  const dir = path.resolve(base, p);
  if (dir === path.parse(dir).root) throw new Error('Choose a folder of its own, not the top of the disk.');
  const rel = path.relative(path.resolve(HOME), dir);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`That is this tool's own data folder (${HOME}); choose another folder.`);
  return dir;
}

// Download indexes and saved course choices belong to one Canvas account; another student
// signing in on the same computer gets their own.
export const accountKey = (origin, userId) => crypto.createHash('sha256').update(`${origin}|${userId}`).digest('hex').slice(0, 16);
export const rootKey = (root) => crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
export const accountDir = (origin, userId) => path.join(HOME, 'accounts', accountKey(origin, userId));

export function savedSelection(origin, userId, root) {
  const s = readConfig().selections?.[accountKey(origin, userId)]?.[rootKey(root)];
  return s ? s.courseIds.map(String) : null;
}

export function saveSelection(origin, userId, root, courseIds) {
  const all = readConfig().selections || {};
  const acct = all[accountKey(origin, userId)] || {};
  acct[rootKey(root)] = { root: path.resolve(root), courseIds: [...new Set(courseIds.map(String))], savedAt: new Date().toISOString() };
  writeConfig({ selections: { ...all, [accountKey(origin, userId)]: acct } });
  return acct[rootKey(root)].courseIds;
}
