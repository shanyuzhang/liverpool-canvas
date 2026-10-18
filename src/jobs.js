import crypto from 'node:crypto';
import { runDownload, BusyError } from './downloader.js';
import { saveSelection } from './config.js';

// Runs one download (or preview) at a time in this process and keeps its live progress, so the
// local page can poll it and an AI tool call can return before a long download finishes.
export class Jobs {
  constructor(app) {
    this.app = app;
    this.current = null;
  }

  running() { return this.current && this.current.state === 'running' ? this.current : null; }

  async start({ courseIds, preview = false, includeImages = false, rememberSelection = false, search, max, root: folder }) {
    if (this.running()) throw new BusyError();
    if (!courseIds?.length) throw new Error('Choose at least one course.');
    const root = folder || this.app.root();
    if (!root) throw new Error('Choose and confirm a download folder first.');
    const index = await this.app.index(root);
    const ctrl = new AbortController();
    const job = {
      id: crypto.randomBytes(6).toString('hex'), preview, state: 'running', root, startedAt: new Date().toISOString(),
      courses: courseIds.map((id) => ({ id: String(id), state: 'waiting', counts: null })), current: null, result: null, error: null,
    };
    job.cancel = () => ctrl.abort(new Error('cancelled'));
    const course = (id) => job.courses.find((c) => c.id === String(id));
    const onEvent = (e) => {
      const c = course(e.courseId ?? e.summary?.id);
      if (e.type === 'course' && c) { c.state = e.state; if (e.total != null) c.total = e.total; }
      else if (e.type === 'phase' && c) c.phase = e.phase;
      else if (e.type === 'file' && c) {
        if (e.state === 'start') job.current = { courseId: c.id, name: e.name, size: e.size };
        else if (e.counts) c.counts = e.counts;
      } else if (e.type === 'course-done' && c) {
        Object.assign(c, { state: 'done', code: e.summary.code, name: e.summary.name, counts: e.summary.counts, complete: e.summary.complete, incomplete: e.summary.incomplete, error: e.summary.error });
      }
    };
    if (rememberSelection && !preview) {
      const me = await this.app.user();
      saveSelection(this.app.base, me.id, root, courseIds);
    }
    this.current = job;
    job.promise = runDownload(this.app.client, index, { courseIds, preview, includeImages, search, max, signal: ctrl.signal, onEvent })
      .then((r) => { job.result = r; job.state = r.cancelled ? 'cancelled' : 'done'; })
      .catch((e) => { job.error = { message: e.message, code: e.code }; job.state = ctrl.signal.aborted ? 'cancelled' : 'failed'; })
      .finally(() => { job.current = null; job.finishedAt = new Date().toISOString(); });
    return job;
  }

  cancel() { const j = this.running(); if (j) j.cancel(); return !!j; }

  // Waits for the job to finish, or at most `ms`. Returns true when it finished.
  async wait(job, ms) {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(false), ms); });
    try { return await Promise.race([job.promise.then(() => true), late]); } finally { clearTimeout(timer); }
  }

  view(job = this.current) {
    if (!job) return null;
    const { cancel, promise, ...rest } = job;
    return rest;
  }
}
