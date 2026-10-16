import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discoverCourseFiles, subfolderFor, describeSource } from './discovery.js';
import { DownloadIndex, decide, choosePath, takenPaths, safeName, fileNameFor, courseFolderName, insideRoot } from './store.js';
import { isAuthError, isNoAccess } from './canvas.js';
import { writePrivate } from './config.js';

export class BusyError extends Error {
  constructor() { super('Another download into this folder is already running. Wait for it to finish (or cancel it), then try again.'); this.code = 'busy'; }
}

const cancelled = (signal) => signal?.aborted;
const PART = /^\.lc-\d+-[0-9a-f]+\.part$/;

// Course folder name, decided once and remembered in the index: a later rename of the course
// on Canvas never moves files that are already saved. Two courses that would get the same
// name are told apart by their Canvas id.
async function courseFolder(index, course) {
  return index.update((data) => {
    const cid = String(course.id);
    if (data.courses[cid]?.folder) return data.courses[cid].folder;
    let folder = courseFolderName(course);
    const used = new Set(Object.entries(data.courses).filter(([k]) => k !== cid).map(([, v]) => v.folder.toLowerCase()));
    if (used.has(folder.toLowerCase())) folder = safeName(`${folder} [${cid}]`);
    data.courses[cid] = { folder, code: course.code, name: course.name, term: course.term };
    return folder;
  });
}

// Leftovers of interrupted downloads (only this tool's own temporary files) are removed.
function cleanParts(dir, olderThanMs = 60 * 60 * 1000) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) cleanParts(p, olderThanMs);
    else if (PART.test(e.name)) { try { if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p); } catch { /* gone */ } }
  }
}

// Streams one file body to a temporary file next to its destination, checks the size, then
// moves it into place without ever replacing an existing file.
async function fetchToTemp(client, url, dir, fileId, expectedSize, { signal, onBytes, idleMs = 60000 }) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.lc-${fileId}-${crypto.randomBytes(4).toString('hex')}.part`);
  let fh;
  try {
    const res = await client.request(url, { raw: true, signal, timeoutMs: 30 * 60 * 1000 });
    let idle;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => res.abortController?.abort(new Error('the download stalled')), idleMs); };
    fh = await fs.promises.open(tmp, 'wx', 0o644);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    try {
      arm();
      for await (const chunk of res.body) {
        arm();
        hash.update(chunk);
        bytes += chunk.length;
        await fh.write(chunk);
        onBytes?.(chunk.length);
      }
    } finally { clearTimeout(idle); res.finish?.(); }
    await fh.sync().catch(() => {});
    await fh.close();
    fh = null;
    const length = Number(res.headers.get('content-length'));
    const encoded = res.headers.get('content-encoding');
    if (!encoded && Number.isFinite(length) && length > 0 && length !== bytes) throw new Error(`incomplete download (${bytes} of ${length} bytes)`);
    if (expectedSize != null && Number(expectedSize) > 0 && Number(expectedSize) !== bytes) throw new Error(`incomplete download (${bytes} of ${expectedSize} bytes)`);
    return { tmp, bytes, sha256: hash.digest('hex') };
  } catch (e) {
    await fh?.close().catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw signal?.aborted ? signal.reason || new Error('cancelled') : e;
  }
}

function place(tmp, target) {
  try {
    fs.linkSync(tmp, target);          // fails if target exists: nothing is ever overwritten
    fs.rmSync(tmp, { force: true });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (fs.existsSync(target)) return false;
    fs.renameSync(tmp, target);        // file systems without hard links
    return true;
  }
}

// Saves one Canvas file of a course under the missing-only rule. Returns
//   { status: 'existing' | 'new' | 'restored' | 'failed' | 'cancelled', path, remoteChanged, error }
export async function saveFile(client, index, { courseId, folder, file, signal, onBytes }) {
  const key = DownloadIndex.key(courseId, file.id);
  const rec = index.get(courseId, file.id);
  const d = decide(rec, { updatedAt: file.updatedAt, size: file.size });
  if (d.action === 'skip') return { status: 'existing', path: rec.path, remoteChanged: d.remoteChanged };

  const sub = (file.subfolder || subfolderFor(file.primary)).map((s) => safeName(s));
  const dir = path.join(index.root, folder, ...sub);
  const name = fileNameFor(file.name, file.contentType);
  const reserve = () => index.update((data) => {
    const r = data.files[key];
    let target = r?.path && insideRoot(index.root, r.path) && !fs.existsSync(r.path) && !takenPaths(data, key).has(path.resolve(r.path)) ? r.path : null;
    if (!target) target = choosePath(r?.path && insideRoot(index.root, r.path) ? path.dirname(r.path) : dir, name, file.id, takenPaths(data, key));
    if (!insideRoot(index.root, target)) throw new Error('refusing a path outside the download folder');
    data.files[key] = { ...(r || {}), courseId: String(courseId), fileId: String(file.id), name: file.name, path: target, status: r?.status === 'complete' ? 'complete' : 'pending', sources: file.sources };
    return target;
  });

  let target;
  let got;
  try {
    target = await reserve();
    got = await fetchToTemp(client, file.url, path.dirname(target), file.id, file.size, { signal, onBytes });
    while (!place(got.tmp, target)) {
      // Something appeared at that path meanwhile (another program, the user): pick another.
      await index.update((data) => { data.files[key].path = null; });
      target = await reserve();
    }
  } catch (e) {
    if (got) fs.rmSync(got.tmp, { force: true });
    if (isAuthError(e)) throw e;
    const wasCancelled = cancelled(signal);
    await index.update((data) => {
      const r = data.files[key];
      if (r && r.status !== 'complete') { r.status = 'failed'; r.error = wasCancelled ? 'cancelled' : e.message; }
    }).catch(() => {});
    return { status: wasCancelled ? 'cancelled' : 'failed', error: wasCancelled ? 'cancelled' : (isNoAccess(e) ? `no permission (${e.status})` : e.message) };
  }
  await index.update((data) => {
    data.files[key] = {
      courseId: String(courseId), fileId: String(file.id), name: file.name, path: target, status: 'complete',
      size: got.bytes, sha256: got.sha256, remoteUpdatedAt: file.updatedAt, remoteSize: file.size,
      downloadedAt: new Date().toISOString(), sources: file.sources,
    };
  });
  return { status: d.reason === 'missing-local' ? 'restored' : 'new', path: target, remoteChanged: false };
}

const emptyCounts = () => ({ found: 0, new: 0, existing: 0, restored: 0, remoteUpdated: 0, failed: 0, skipped: 0, images: 0, cancelled: 0 });

// Plans and (unless preview) runs a download of whole courses.
//   courseIds    the courses the user chose
//   preview      only list what would be downloaded; no file body is requested
//   onEvent(e)   progress: { type: 'course', ... } | { type: 'phase' } | { type: 'file' } | { type: 'course-done' }
export async function runDownload(client, index, { courseIds, preview = false, includeImages = false, search, max, concurrency = 3, signal, onEvent = () => {} }) {
  const lock = preview ? null : index.lockJob();
  if (!preview && !lock) throw new BusyError();
  const started = new Date().toISOString();
  const courses = [];
  try {
    for (const cid of courseIds.map(String)) {
      if (cancelled(signal)) break;
      const summary = { id: cid, counts: emptyCounts(), failed: [], skipped: [], incomplete: [], remoteUpdated: [], files: preview ? [] : undefined, complete: false };
      courses.push(summary);
      onEvent({ type: 'course', courseId: cid, state: 'scanning' });
      let disc;
      try {
        disc = await discoverCourseFiles(client, cid, { includeImages, signal, onProgress: (p) => onEvent({ type: 'phase', courseId: cid, ...p }) });
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (cancelled(signal)) break;
        summary.error = isNoAccess(e) ? 'You do not have access to this course.' : e.message;
        summary.incomplete.push({ source: 'course', reason: summary.error });
        onEvent({ type: 'course-done', summary });
        continue;
      }
      Object.assign(summary, { code: disc.course.code, name: disc.course.name, term: disc.course.term, notes: disc.notes });
      const q = String(search || '').toLowerCase();
      let files = disc.files.filter((f) => !q || f.name.toLowerCase().includes(q));
      if (max) files = files.slice(0, max);
      summary.counts.found = files.length;
      summary.skipped = disc.skipped.filter((s) => !s.image);
      summary.counts.skipped = summary.skipped.length;
      summary.counts.images = disc.skipped.filter((s) => s.image).length;
      summary.incomplete = disc.incomplete;
      const folder = preview ? (index.load().courses[cid]?.folder || courseFolderName(disc.course)) : await courseFolder(index, disc.course);
      summary.folder = path.join(index.root, folder);

      const data = index.load();
      const plan = files.map((f) => ({ file: f, d: decide(data.files[DownloadIndex.key(cid, f.id)], { updatedAt: f.updatedAt, size: f.size }) }));
      for (const { file, d } of plan) {
        if (d.action === 'skip' && d.remoteChanged) { summary.counts.remoteUpdated++; summary.remoteUpdated.push(file.name); }
      }
      if (preview) {
        for (const { file, d } of plan) {
          if (d.action === 'skip') summary.counts.existing++; else if (d.reason === 'missing-local') summary.counts.restored++; else summary.counts.new++;
          summary.files.push({ id: file.id, name: file.name, size: file.size, action: d.action === 'skip' ? 'already saved' : d.reason === 'missing-local' ? 'download again (local copy missing)' : 'download', remoteChanged: d.remoteChanged || undefined, folder: path.join(folder, ...subfolderFor(file.primary).map((s) => safeName(s))), found_in: file.sources.map(describeSource) });
        }
        summary.complete = disc.complete;
        onEvent({ type: 'course-done', summary });
        continue;
      }

      onEvent({ type: 'course', courseId: cid, state: 'downloading', total: files.length, existing: plan.filter((p) => p.d.action === 'skip').length });
      cleanParts(path.join(index.root, folder));
      let next = 0;
      const worker = async () => {
        while (next < plan.length && !cancelled(signal)) {
          const { file, d } = plan[next++];
          if (d.action !== 'skip') onEvent({ type: 'file', courseId: cid, name: file.name, state: 'start', size: file.size });
          const r = await saveFile(client, index, { courseId: cid, folder, file, signal });
          if (r.status === 'existing') summary.counts.existing++;
          else if (r.status === 'new') summary.counts.new++;
          else if (r.status === 'restored') summary.counts.restored++;
          else if (r.status === 'cancelled') summary.counts.cancelled++;
          else { summary.counts.failed++; summary.failed.push({ id: file.id, name: file.name, error: r.error }); }
          onEvent({ type: 'file', courseId: cid, name: file.name, state: r.status, counts: { ...summary.counts } });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.length)) }, worker));
      summary.counts.cancelled += plan.length - summary.counts.existing - summary.counts.new - summary.counts.restored - summary.counts.failed - summary.counts.cancelled;
      summary.complete = disc.complete && summary.counts.failed === 0 && summary.counts.cancelled === 0;
      onEvent({ type: 'course-done', summary });
    }
  } finally {
    lock?.release();
  }
  const result = { root: index.root, preview, cancelled: !!cancelled(signal), started, finished: new Date().toISOString(), courses };
  result.complete = !result.cancelled && courses.length === courseIds.length && courses.every((c) => c.complete);
  if (!preview) appendHistory(index, result);
  return result;
}

function appendHistory(index, result) {
  const file = path.join(index.dir, 'history.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first */ }
  list.unshift({
    at: result.finished, root: result.root, cancelled: result.cancelled, complete: result.complete,
    courses: result.courses.map((c) => ({ id: c.id, code: c.code, counts: c.counts, failed: c.failed.slice(0, 20), incomplete: c.incomplete.slice(0, 10), complete: c.complete })),
  });
  try { writePrivate(file, JSON.stringify(list.slice(0, 30))); } catch { /* history is a convenience */ }
}

export function readHistory(index) {
  try { return JSON.parse(fs.readFileSync(path.join(index.dir, 'history.json'), 'utf8')); } catch { return []; }
}

// One file, for reading it as text (canvas_read_file). The same index and rule as course
// downloads: a file already saved is read from disk, never fetched again or replaced.
export async function saveSingleFile(client, index, fileId, courseId) {
  let meta;
  const hinted = courseId || client.fileHints.get(String(fileId))?.courseId;
  try {
    meta = hinted ? await client.get(`courses/${hinted}/files/${fileId}`) : await client.get(`files/${fileId}`);
  } catch (e) {
    if (!hinted || !isNoAccess(e)) throw e;
    meta = await client.get(`files/${fileId}`);
  }
  if (meta.locked_for_user || !meta.url) throw new Error(`File ${fileId} (${meta.display_name || 'unknown'}) is locked or not available to you yet.`);
  let cid = hinted;
  if (!cid && meta.folder_id) {
    try { const f = await client.get(`folders/${meta.folder_id}`); if (f.context_type === 'Course') cid = String(f.context_id); } catch (e) { if (isAuthError(e)) throw e; }
  }
  let folder = 'Other files';
  if (cid) {
    const c = await client.course(cid).catch(() => null);
    if (c) folder = await courseFolder(index, { id: cid, code: c.course_code, name: c.name, term: c.term?.name, termStart: c.term?.start_at || c.start_at });
  }
  const where = client.fileHints.get(String(fileId))?.where;
  const file = {
    id: meta.id, name: meta.display_name || meta.filename || `file-${meta.id}`, size: meta.size ?? null,
    updatedAt: meta.modified_at || meta.updated_at, contentType: meta['content-type'], url: meta.url,
    subfolder: where ? [where] : [], sources: [{ kind: 'read', title: meta.display_name }],
  };
  const r = await saveFile(client, index, { courseId: cid || 'none', folder, file });
  if (r.status === 'failed') throw new Error(`Could not download ${file.name}: ${r.error}`);
  return { ...r, name: file.name, contentType: file.contentType, size: file.size, updatedAt: file.updatedAt };
}
