import { cliHint } from './release.js';
import { isLoopbackHost } from './config.js';

const parseJson = (text) => JSON.parse(text.replace(/^while\(1\);/, ''));   // Canvas's anti-XSSI prefix
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

export class CanvasError extends Error {
  constructor(message, { status = 0, code = 'canvas', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

// The saved session is gone or was rejected: the user has to sign in again.
export class AuthError extends CanvasError {
  constructor(message = `Your Canvas session has expired. Sign in again: ${cliHint('login')}`) {
    super(message, { status: 401, code: 'auth' });
  }
}

export const isAuthError = (e) => e?.code === 'auth';
// No access for this user (or the item does not exist): skip it and say why.
export const isNoAccess = (e) => e?.status === 403 || e?.status === 404;

function nextLink(header) {
  const part = String(header || '').split(',').find((s) => s.includes('rel="next"'));
  return part ? part.slice(part.indexOf('<') + 1, part.indexOf('>')) : null;
}

export function query(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(k.endsWith('[]') ? k : `${k}[]`, String(x));
    else q.append(k, String(v));
  }
  return q.toString();
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

// Read-only Canvas client. It only ever sends GET requests, and only sends the session cookie
// to the Canvas address itself. File bodies that Canvas hands off to its storage servers are
// fetched from there without any Canvas credentials.
// `session({ fresh })` returns { cookieHeader }; it is asked once more (fresh) after a 401.
export class CanvasClient {
  constructor({ base, session, fetchImpl = fetch, timeoutMs = 30000, retries = 3, backoffMs = 800 }) {
    this.base = base;
    this.origin = new URL(base).origin;
    this.session = session;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.backoffMs = backoffMs;
    this.cookie = null;
    this.courseInfo = new Map();     // course id → course object
    this.fileHints = new Map();      // file id → { courseId, where } noted whenever a tool sees the file inside a course
  }

  noteFiles(courseId, ids, where) {
    for (const id of ids || []) {
      if (!id) continue;
      const prev = this.fileHints.get(String(id));
      this.fileHints.set(String(id), { courseId: String(courseId), where: prev?.where || where });
    }
  }

  async course(courseId) {
    const key = String(courseId);
    if (!this.courseInfo.has(key)) this.courseInfo.set(key, await this.get(`courses/${key}`, { include: ['term'] }));
    return this.courseInfo.get(key);
  }

  isCanvasUrl(url) { try { return new URL(url).origin === this.origin; } catch { return false; } }

  // One GET with a timeout. Cookies only ever go to the Canvas origin.
  async #fetchOnce(url, { accept, withCookie, signal, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new CanvasError('Canvas did not answer in time.', { code: 'timeout', retryable: true })), timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const headers = { Accept: accept };
      if (withCookie) headers.Cookie = this.cookie;
      const res = await this.fetch(url, { method: 'GET', headers, redirect: 'manual', signal: ctrl.signal });
      return { res, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }, ctrl };
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw signal.reason;
      if (e instanceof CanvasError) throw e;
      if (ctrl.signal.aborted && ctrl.signal.reason instanceof CanvasError) throw ctrl.signal.reason;
      throw new CanvasError(`Could not reach Canvas (${e.cause?.code || e.message}).`, { code: 'network', retryable: true });
    }
  }

  // GET with session refresh on 401, limited retries on rate limits / server errors / timeouts,
  // and manual redirects so credentials never follow a redirect to another site.
  //   raw: a file body (any content type); the caller reads the stream.
  //   keepTimer: leave the timeout running while the caller streams the body (file downloads)
  async request(url, { raw = false, signal, timeoutMs = this.timeoutMs } = {}) {
    if (!this.isCanvasUrl(url)) throw new CanvasError('Refusing to send the Canvas session to another site.', { code: 'origin' });
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (!this.cookie) this.cookie = (await this.session({ fresh: false }))?.cookieHeader;
      if (!this.cookie) throw new AuthError(`Not signed in to Canvas yet. Run: ${cliHint('login')}`);
      let current = url;
      let res; let done; let ctrl;
      try {
        for (let hop = 0; ; hop++) {
          const canvas = this.isCanvasUrl(current);
          ({ res, done, ctrl } = await this.#fetchOnce(current, { accept: raw ? '*/*' : 'application/json', withCookie: canvas, signal, timeoutMs }));
          if (res.status < 300 || res.status >= 400 || res.status === 304) break;
          const loc = res.headers.get('location');
          await res.body?.cancel?.();
          done();
          if (!loc || hop >= 5) throw new CanvasError('Canvas redirected too many times.', { code: 'redirect' });
          const next = new URL(loc, current);
          // An API call that bounces to a sign-in page means the session is no longer valid.
          if (!raw && (!this.isCanvasUrl(next.href) || /^\/login\b/.test(next.pathname))) { res = { status: 401, headers: new Headers(), body: null, text: async () => '' }; done = () => {}; break; }
          if (!this.isCanvasUrl(next.href) && next.protocol !== 'https:' && !isLoopbackHost(next.hostname)) {
            throw new CanvasError('Canvas pointed the file at an insecure address; not downloading it.', { code: 'redirect' });
          }
          current = next.href;
        }
      } catch (e) {
        if (e?.retryable && attempt < this.retries) { await sleep(this.backoffMs * 2 ** attempt, signal); continue; }
        throw e;
      }

      if (res.status === 401) {
        done();
        await res.body?.cancel?.();
        if (refreshed) throw new AuthError();
        refreshed = true;
        this.cookie = (await this.session({ fresh: true }))?.cookieHeader || null;
        if (!this.cookie) throw new AuthError();
        attempt--;
        continue;
      }
      if (RETRY_STATUS.has(res.status) && attempt < this.retries) {
        done();
        await res.body?.cancel?.();
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : this.backoffMs * 2 ** attempt, 30000), signal);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        done();
        const text = await res.text().catch(() => '');
        let msg = '';
        try { const j = parseJson(text); msg = j.errors?.[0]?.message || j.message || ''; } catch { /* not JSON */ }
        const label = { 403: 'no permission', 404: 'not found', 429: 'Canvas is rate-limiting requests' }[res.status] || '';
        throw new CanvasError(`Canvas ${res.status}${label ? ` (${label})` : ''}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`,
          { status: res.status, retryable: RETRY_STATUS.has(res.status) || res.status >= 500 });
      }
      res.finish = done;
      res.abortController = ctrl;
      if (!raw) done();
      return res;
    }
  }

  url(p, params) {
    const rel = p.startsWith('/') ? p : `/api/v1/${p}`;
    const q = query(params);
    return `${this.origin}${rel}${q ? (rel.includes('?') ? '&' : '?') + q : ''}`;
  }

  async get(p, params = {}, opts = {}) {
    const res = await this.request(this.url(p, params), opts);
    return parseJson(await res.text());
  }

  // Follows Canvas's Link: rel="next" pagination. The array gets `truncated = true` when it
  // stopped at maxPages, so callers can say a scan was not complete.
  async list(p, params = {}, { maxPages = 50, signal } = {}) {
    let url = this.url(p, { per_page: 100, ...params });
    const out = [];
    for (let i = 0; url && i < maxPages; i++) {
      const res = await this.request(url, { signal });
      const data = parseJson(await res.text());
      out.push(...(Array.isArray(data) ? data : [data]));
      const next = nextLink(res.headers.get('link'));
      url = next && this.isCanvasUrl(next) ? next : null;
    }
    out.truncated = !!url;
    return out;
  }
}
