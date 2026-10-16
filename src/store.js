import fs from 'node:fs';
import path from 'node:path';
import { accountDir, rootKey, writePrivate } from './config.js';

// ---------------------------------------------------------------------------------------------
// Safe names. Each piece of a path is cleaned on its own, so a course, module or file name can
// never climb out of the download folder or be a name Windows refuses.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
export function safeName(s, fallback = 'untitled') {
  let n = String(s ?? '').normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!n || n === '.' || n === '..') n = fallback;
  if (RESERVED.test(n)) n = `_${n}`;
  // Keep names well under common 255-byte limits, without cutting a character in half.
  const ext = path.extname(n);
  if (Buffer.byteLength(n) > 150) {
    let stem = n.slice(0, n.length - ext.length);
    while (Buffer.byteLength(stem + ext) > 150) stem = Array.from(stem).slice(0, -1).join('');
    n = stem.trimEnd() + (ext.length < 12 ? ext : '');
  }
  return n;
}

export function insideRoot(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Files without an extension keep their name; a known type gets an extension so it opens.
const EXT = { 'application/pdf': '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/zip': '.zip', 'text/plain': '.txt', 'text/csv': '.csv' };
export function fileNameFor(name, contentType) {
  const n = safeName(name, 'file');
  return !path.extname(n) && EXT[String(contentType || '').split(';')[0]] ? n + EXT[String(contentType).split(';')[0]] : n;
}

// "notes.pdf" → "notes (canvas-123).pdf": a stable suffix for a different Canvas file that
// wants a name already in use, so nothing is ever overwritten.
export function withIdSuffix(name, fileId, n = 1) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return `${stem} (canvas-${fileId}${n > 1 ? `-${n}` : ''})${ext}`;
}

export function courseFolderName(course) {
  const code = course.code || course.name || `course-${course.id}`;
  const term = course.term && !/^default term$/i.test(course.term) ? course.term : (course.termStart ? String(course.termStart).slice(0, 4) : '');
  return safeName(term && !code.includes(term) ? `${code} (${term})` : code, `course-${course.id}`);
}

// ---------------------------------------------------------------------------------------------
// Locks. A lock is a directory (creating one is atomic on every OS) holding the owner's pid.
// A lock whose process is gone, or that is very old, is taken over.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function tryLock(dir, { staleMs = 10 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { /* being written, or broken */ }
    const age = Date.now() - (owner?.at || fs.statSync(dir).mtimeMs);
    if ((owner && owner.pid !== process.pid && !alive(owner.pid)) || age > staleMs) {
      fs.rmSync(dir, { recursive: true, force: true });
      return tryLock(dir, { staleMs });
    }
    return null;
  }
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  return { release: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export async function withLock(dir, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lock;
  while (!(lock = tryLock(dir, { staleMs }))) {
    if (Date.now() > deadline) throw new Error('The download index is busy; try again in a moment.');
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  try { return await fn(); } finally { lock.release(); }
}

// ---------------------------------------------------------------------------------------------
// The download index: which Canvas file was saved where. One index per Canvas account and
// download folder. Records are keyed by course id + file id, so the same file in two courses
// is kept in both course folders, and two different files that share a name are both kept.
//
// record: { courseId, fileId, name, path, status: 'complete' | 'pending' | 'failed', size,
//           sha256, remoteUpdatedAt, remoteSize, downloadedAt, sources, error?, adopted? }
export class DownloadIndex {
  constructor({ origin, userId, root }) {
    this.origin = origin;
    this.userId = String(userId);
    this.root = path.resolve(root);
    this.dir = accountDir(origin, userId);
    this.file = path.join(this.dir, `index-${rootKey(this.root)}.json`);
    this.lockDir = path.join(this.dir, `index-${rootKey(this.root)}.lock`);
    this.jobLockDir = path.join(this.dir, `job-${rootKey(this.root)}.lock`);
  }

  static key(courseId, fileId) { return `${courseId}:${fileId}`; }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version === 1 && data.root === this.root) return data;
    } catch { /* first use */ }
    return { version: 1, origin: this.origin, userId: this.userId, root: this.root, courses: {}, files: {} };
  }

  // Read-modify-write under the index lock, so two programs (say the local page and an AI
  // tool) updating at once never lose each other's records. The file is replaced atomically.
  async update(fn) {
    return withLock(this.lockDir, async () => {
      const data = this.load();
      const result = await fn(data);
      writePrivate(this.file, JSON.stringify(data));
      return result;
    });
  }

  get(courseId, fileId) { return this.load().files[DownloadIndex.key(courseId, fileId)] || null; }

  // A download job holds this for its whole run; a second job for the same folder is refused.
  lockJob() { return tryLock(this.jobLockDir, { staleMs: 6 * 60 * 60 * 1000 }); }
}

// ---------------------------------------------------------------------------------------------
// The missing-only rule, as one pure decision:
//   recorded + local file present → skip (no body request, nothing touched); note remote changes
//   recorded but local file gone  → download again
//   pending/failed/no record      → download
export function decide(record, remote, exists = fs.existsSync) {
  if (record?.status === 'complete' && record.path && exists(record.path)) {
    const remoteChanged = (remote.updatedAt && record.remoteUpdatedAt && remote.updatedAt !== record.remoteUpdatedAt)
      || (remote.size != null && record.remoteSize != null && Number(remote.size) !== Number(record.remoteSize));
    return { action: 'skip', remoteChanged: !!remoteChanged };
  }
  if (record?.status === 'complete') return { action: 'download', reason: 'missing-local' };
  return { action: 'download', reason: 'new' };
}

// Picks where a new download goes. Never a path that exists on disk or that the index has
// given to another file; the first free one of name, name (canvas-ID), name (canvas-ID-2) …
export function choosePath(dir, name, fileId, taken, exists = fs.existsSync) {
  const busy = (p) => exists(p) || taken.has(path.resolve(p));
  let p = path.join(dir, name);
  if (!busy(p)) return p;
  for (let n = 1; ; n++) {
    p = path.join(dir, withIdSuffix(name, fileId, n));
    if (!busy(p)) return p;
  }
}

export function takenPaths(data, exceptKey) {
  const s = new Set();
  for (const [k, r] of Object.entries(data.files)) if (k !== exceptKey && r.path) s.add(path.resolve(r.path));
  return s;
}
