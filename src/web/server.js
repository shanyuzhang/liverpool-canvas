import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App, sessionProvider } from '../app.js';
import { Jobs } from '../jobs.js';
import { AuthError } from '../canvas.js';
import * as cfg from '../config.js';
import { release } from '../release.js';
import { listCourses, groupCourses } from '../courses.js';
import { readHistory } from '../downloader.js';
import { insideRoot } from '../store.js';
import { plannerRow } from '../tools.js';
import { htmlToText } from '../text.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function openInOs(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['explorer.exe', [target]] : ['xdg-open', [target]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// The local page: a small HTTP server on 127.0.0.1 only. Anything that signs in, downloads,
// changes settings or opens a folder needs the session cookie handed out through the link the
// program opened, a matching Origin and a CSRF token; other sites and other computers cannot
// trigger it. Folders that can be opened are the confirmed download folder and its course folders.
export async function startWeb({ port = 0, open = true, log = () => {}, idleMs = 45 * 60 * 1000, app: injected } = {}) {
  // The page never opens a sign-in window by surprise: an expired session is shown as
  // "signed out" and the user clicks "Sign in".
  const base = cfg.baseUrl();
  const app = injected || new App({ base, session: sessionProvider(base, async () => { throw new AuthError('Your Canvas session has expired. Sign in again.'); }) });
  app.jobs ||= new Jobs(app);
  const launchToken = crypto.randomBytes(24).toString('base64url');
  const sessionId = crypto.randomBytes(24).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const login = { state: 'idle', error: null };
  let detected = null;   // which AI apps are installed; checked once per run (it starts `claude --version`)
  let lastSeen = Date.now();
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });

  const server = http.createServer();
  let origins = new Set();
  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { ...SECURITY_HEADERS, ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const cookieOf = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((p) => p.length === 2));
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });

  const signedIn = async () => {
    try { return await app.user(); } catch (e) { if (e.code === 'auth') return null; throw e; }
  };

  const api = {
    'GET /api/state': async () => {
      const me = await signedIn().catch(() => null);
      const root = cfg.downloadRoot();
      detected ||= (await import('../clients.js')).clients().map((c) => ({ id: c.id, name: c.name, detected: c.detect() }));
      const r = release();
      return {
        version: r.version, published: r.published, canvas: base, user: me ? { name: me.name } : null, login,
        root, defaultRoot: cfg.defaultDownloadRoot(), selection: me && root ? cfg.savedSelection(base, me.id, root) || [] : [],
        clients: detected, job: app.jobs.view(), csrf, demo: !!process.env.LIVERPOOL_CANVAS_TEST_ORIGIN,
        platform: process.platform, dataFolder: cfg.HOME,
      };
    },
    'GET /api/courses': async () => {
      const list = await listCourses(app.client, { includePast: true });
      const root = cfg.downloadRoot();
      const saved = {};
      if (root) {
        const data = (await app.index(root)).load();
        for (const r of Object.values(data.files)) if (r.status === 'complete') saved[r.courseId] = (saved[r.courseId] || 0) + 1;
      }
      const last = {};
      if (root) for (const h of [...readHistory(await app.index(root))].reverse()) for (const c of h.courses) last[c.id] = { at: h.at, counts: c.counts, complete: c.complete, incomplete: c.incomplete?.length || 0 };
      return { groups: groupCourses(list.map((c) => ({ ...c, saved: saved[c.id] || 0, last: last[c.id] || null }))) };
    },
    'GET /api/overview': async () => {
      const c = app.client;
      const day = 86400000;
      const [items, courses] = await Promise.all([
        c.list('planner/items', { start_date: new Date(Date.now() - day).toISOString(), end_date: new Date(Date.now() + 14 * day).toISOString() }, { maxPages: 2 }),
        c.list('courses', { enrollment_state: 'active', include: ['term'] }),
      ]);
      const ids = courses.map((x) => `course_${x.id}`);
      const anns = [];
      for (let i = 0; i < Math.min(ids.length, 30); i += 10) {
        anns.push(...await c.list('announcements', { context_codes: ids.slice(i, i + 10), start_date: new Date(Date.now() - 30 * day).toISOString(), end_date: new Date(Date.now() + day).toISOString() }, { maxPages: 1 }).catch(() => []));
      }
      const names = new Map(courses.map((x) => [`course_${x.id}`, x.course_code || x.name]));
      return {
        upcoming: items.filter((it) => !['calendar_event', 'announcement'].includes(it.plannable_type)).map((it) => plannerRow(it, base)).slice(0, 12),
        announcements: anns.sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at))).slice(0, 6)
          .map((a) => ({ course: names.get(a.context_code), title: a.title, posted: a.posted_at, text: htmlToText(a.message, { links: false }).slice(0, 280), url: a.html_url ? new URL(a.html_url, base).href : null })),
      };
    },
    'GET /api/job': async () => ({ job: app.jobs.view() }),
    'GET /api/history': async () => {
      const root = cfg.downloadRoot();
      return { history: root && await signedIn() ? readHistory(await app.index(root)).slice(0, 10) : [] };
    },
    'POST /api/login': async () => {
      if (login.state === 'waiting') return { login };
      const { openSession } = await import('../browser.js');
      login.state = 'waiting'; login.error = null;
      openSession(base, { headless: false, onLoginPath: (p) => cfg.writeConfig({ loginPath: p }) })
        .then(async ({ me, cookieHeader }) => {
          app.client.cookie = cookieHeader;
          cfg.writeConfig({ user: { id: me.id, name: me.name }, loggedInAt: new Date().toISOString() });
          await app.user({ refresh: true });
          login.state = 'done';
        })
        .catch((e) => { login.state = 'failed'; login.error = e.message; });
      return { login };
    },
    'POST /api/logout': async () => {
      if (app.jobs.running()) throw httpError(409, 'A download is running; cancel it first.');
      const { clearSession } = await import('../browser.js');
      clearSession();
      app.client.cookie = null; app.me = null;
      cfg.writeConfig({ user: undefined, loggedInAt: undefined });
      return { ok: true };
    },
    'POST /api/folder': async (body) => {
      const p = String(body.path || '').trim();
      if (!p || !path.isAbsolute(p)) throw httpError(400, 'Enter a full folder path.');
      const resolved = path.resolve(p);
      const forbidden = [path.parse(resolved).root, os.homedir(), cfg.HOME].map((x) => path.resolve(x));
      if (forbidden.includes(resolved) || insideRoot(cfg.HOME, resolved)) throw httpError(400, 'Choose a folder of its own, e.g. Documents/Canvas.');
      if (app.jobs.running()) throw httpError(409, 'A download is running; wait or cancel it first.');
      return cfg.confirmDownloadRoot(resolved);
    },
    'POST /api/preview': async (body) => ({ job: app.jobs.view(await app.jobs.start({ courseIds: ids(body.courseIds), preview: true, includeImages: !!body.includeImages })) }),
    'POST /api/download': async (body) => ({ job: app.jobs.view(await app.jobs.start({ courseIds: ids(body.courseIds), includeImages: !!body.includeImages, rememberSelection: true })) }),
    'POST /api/sync': async (body) => {
      const root = cfg.downloadRoot();
      const me = await app.user();
      const sel = root && cfg.savedSelection(base, me.id, root);
      if (!sel?.length) throw httpError(400, 'No courses chosen for this folder yet.');
      return { job: app.jobs.view(await app.jobs.start({ courseIds: sel, includeImages: !!body.includeImages })) };
    },
    'POST /api/cancel': async () => ({ cancelled: app.jobs.cancel() }),
    'POST /api/open': async (body) => {
      const root = cfg.downloadRoot();
      if (!root) throw httpError(400, 'No download folder yet.');
      let target = root;
      if (body.courseId != null) {
        const folder = (await app.index(root)).load().courses[String(body.courseId)]?.folder;
        if (!folder) throw httpError(404, 'Nothing has been saved for this course yet.');
        target = path.join(root, folder);
        if (!insideRoot(root, target)) throw httpError(400, 'Not inside the download folder.');
      }
      if (!fs.existsSync(target)) throw httpError(404, 'That folder does not exist (yet).');
      openInOs(target);
      return { opened: target };
    },
    'POST /api/connect': async (body) => {
      // The demo and tests run against a synthetic Canvas; they never edit real AI app settings.
      if (process.env.LIVERPOOL_CANVAS_TEST_ORIGIN) throw httpError(400, 'Demo mode: AI app settings are not changed.');
      const { clients, ensureStableInstall } = await import('../clients.js');
      const c = clients().find((x) => x.id === body.clientId);
      if (!c) throw httpError(400, 'Unknown AI app.');
      const launch = ensureStableInstall();
      const r = c.install(launch);
      return { name: c.name, where: r.where, backup: r.backup, restart: c.restart };
    },
    'POST /api/shutdown': async () => { setTimeout(close, 100); return { ok: true }; },
  };
  const ids = (list) => {
    if (!Array.isArray(list) || !list.length || !list.every((x) => /^\d+$/.test(String(x)))) throw httpError(400, 'Choose at least one course.');
    return list.map(String);
  };

  server.on('request', async (req, res) => {
    lastSeen = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    // DNS-rebinding guard: only our own host names are served.
    if (!origins.has(`http://${req.headers.host}`)) return send(res, 421, { error: 'wrong host' });
    const cookies = cookieOf(req);
    const authed = same(cookies.lc_session, sessionId);

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!same(url.searchParams.get('t'), launchToken)) return send(res, 403, 'This link is not valid. Start the local page again from the terminal.', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 303, '', { Location: '/', 'Set-Cookie': `lc_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      if (url.pathname === '/' && !authed) return send(res, 403, 'Open the local page with the link printed in the terminal (it contains a one-time key).', { 'Content-Type': 'text/plain; charset=utf-8' });
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(WEB_DIR, file)), { 'Content-Type': type });
    }
    const handler = api[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'not found' });
    if (!authed) return send(res, 401, { error: 'no session' });
    if (req.method !== 'GET') {
      const site = req.headers['sec-fetch-site'];
      if (!origins.has(req.headers.origin) || (site && site !== 'same-origin') || !same(req.headers['x-csrf-token'], csrf)
        || !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 403, { error: 'cross-site request refused' });
      }
    }
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      send(res, 200, await handler(body));
    } catch (e) {
      if (e.code === 'auth') return send(res, 401, { error: 'signed-out', message: e.message });
      if (e.code === 'busy') return send(res, 409, { error: 'busy', message: e.message });
      send(res, e.httpStatus || 500, { error: e.httpStatus ? 'bad-request' : 'failed', message: e.message });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  origins = new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]);
  const url = `http://127.0.0.1:${actual}/?t=${launchToken}`;

  const idle = setInterval(() => { if (Date.now() - lastSeen > idleMs && !app.jobs.running()) { log('The local page was idle; stopping it.'); close(); } }, 30000);
  idle.unref();
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    clearInterval(idle);
    app.jobs.cancel();
    server.close(() => resolveClosed());
    server.closeAllConnections?.();
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (open) openInOs(url);
  return { url, port: actual, close, closed, app, server, tokens: { launchToken, csrf } };
}

function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }
