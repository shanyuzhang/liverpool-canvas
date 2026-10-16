// A synthetic Canvas for tests and the demo. Fictional courses, a fake user, generated files.
// It checks the session cookie, paginates every list (small pages, to exercise Link headers),
// refuses anything but GET, and serves file bodies from a separate "storage" origin the way
// Canvas hands downloads to its file servers. That storage server records any request that
// carries a Cookie header, so tests can prove credentials never leave Canvas.
import http from 'node:http';

const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

export function defaultModel() {
  const t = '2026-09-22T00:00:00Z';
  return {
    user: { id: 7, name: 'Test Student' },
    cookie: 'canvas_session=good',
    pageSize: 2,
    courses: [
      {
        id: 101, name: 'Linear Algebra (fictional)', course_code: 'MATH253', term: { name: '2026-27 Semester 1', start_at: '2026-09-01T00:00:00Z' },
        filesHidden: true, pagesListDisabled: true,
        frontPage: '<p>Welcome. <a href="/courses/101/pages/reading-list">Reading list</a></p>',
        pages: {
          'week-1': { title: 'Week 1', body: '<p>Slides: <a class="instructure_file_link" href="/courses/101/files/1001?wrap=1&amp;verifier=abc" data-api-endpoint="http://x/api/v1/courses/101/files/1001" data-api-returntype="File">Week 1 slides</a></p><p>Question figure <img src="/courses/101/files/1009/preview"></p><p>See <a href="/courses/101/pages/week-1-extra">extra</a> and <a href="https://www.youtube.com/watch?v=1">video</a>. Room 1002.</p>' },
          'week-1-extra': { title: 'Week 1 extra', body: '<a href="/courses/101/files/1003/download?download_frd=1">Solutions</a> <a href="/courses/101/pages/week-1">back</a>' },
          'reading-list': { title: 'Reading list', body: '<a href="/files/1004">Reading list</a>' },
        },
        modules: [
          { id: 1, name: 'Week 1', omitItems: true, items: [
            { id: 11, type: 'Page', title: 'Week 1', page_url: 'week-1' },
            { id: 12, type: 'File', title: 'Problem sheet 1', content_id: 1002 },
            { id: 13, type: 'ExternalUrl', title: 'Lecture recording', external_url: 'https://video.example.com/abc' },
            { id: 14, type: 'ExternalUrl', title: 'Data file', external_url: 'CANVAS/courses/101/files/1005' },
          ] },
          { id: 2, name: 'Week 2: Matrices/Inverses', items: [{ id: 21, type: 'File', title: 'Problem sheet 1 (again)', content_id: 1002 }] },
        ],
        announcements: [{ id: 501, title: 'Assignment 1 is out', message: '<p>See the attached sheet, also <a href="/courses/101/files/1006">here</a>.</p>', posted_at: '2026-09-20T09:00:00Z', attachments: [{ id: 1007 }] }],
        assignments: [{ id: 601, name: 'Assignment 1', due_at: '2026-10-24T16:00:00Z', description: '<p>Template: <a href="/courses/101/files/1008">template</a> and <a href="/courses/202/files/2001">shared data</a></p>', points_possible: 10, submission_types: ['online_upload'] }],
        files: {
          1001: { display_name: 'Week 1 slides.pdf', content: 'slides-week-1', 'content-type': 'application/pdf', updated_at: t },
          1002: { display_name: 'Problem sheet 1.pdf', content: 'problems-1', 'content-type': 'application/pdf', updated_at: t },
          1003: { display_name: 'Solutions', content: 'solutions-no-extension', 'content-type': 'application/octet-stream', updated_at: t },
          1004: { display_name: 'Reading list.docx', content: 'reading', 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', updated_at: t },
          1005: { display_name: 'data.csv', content: 'a,b\n1,2\n', 'content-type': 'text/csv', updated_at: t },
          1006: { display_name: 'Assignment 1.pdf', content: 'assignment-1', 'content-type': 'application/pdf', updated_at: t },
          1007: { display_name: 'Assignment 1 sheet.pdf', content: 'assignment-1-sheet', 'content-type': 'application/pdf', updated_at: t },
          1008: { display_name: 'template.tex', content: '\\documentclass{article}', 'content-type': 'text/x-tex', updated_at: t },
          1009: { display_name: 'figure.png', content: 'PNG', 'content-type': 'image/png', updated_at: t },
        },
      },
      {
        id: 202, name: 'Statistics (fictional)', course_code: 'MATH268', term: { name: '2026-27 Semester 1', start_at: '2026-09-01T00:00:00Z' },
        filesHidden: false,
        pages: {}, modules: [{ id: 3, name: 'Lectures', items: [{ id: 31, type: 'File', title: 'Notes', content_id: 2002 }] }], announcements: [], assignments: [],
        folders: { 9: 'course files/Lectures' },
        files: {
          2001: { display_name: 'shared data.csv', content: 'x\n1\n', 'content-type': 'text/csv', updated_at: t, folder_id: 9 },
          2002: { display_name: 'Notes.pdf', content: 'stat-notes', 'content-type': 'application/pdf', updated_at: t, folder_id: 9 },
          2003: { display_name: 'Locked exam.pdf', content: 'secret', 'content-type': 'application/pdf', updated_at: t, locked: true, folder_id: 9 },
        },
      },
      { id: 303, name: 'Careers Hub (fictional)', course_code: 'CAREERS', term: { name: 'Default Term' }, pages: {}, modules: [], announcements: [], assignments: [], files: {}, filesHidden: true, pagesListDisabled: true },
      { id: 404, name: 'Linear Algebra (fictional, resit)', course_code: 'MATH253-RESIT', term: { name: '2025-26 Semester 2', start_at: '2026-01-20T00:00:00Z' }, pages: {}, modules: [], announcements: [], assignments: [], files: {}, filesHidden: true, pagesListDisabled: true },
    ],
    planner: [
      { context_name: 'MATH253', plannable_type: 'assignment', plannable: { title: 'Assignment 1', due_at: '2026-10-24T16:00:00Z', points_possible: 10 }, plannable_date: '2026-10-24T16:00:00Z', submissions: { submitted: false, missing: false }, course_id: 101, plannable_id: 601, html_url: '/courses/101/assignments/601' },
      { context_name: 'MATH253', plannable_type: 'announcement', plannable: { title: 'Assignment 1 is out', posted_at: '2026-09-20T09:00:00Z' }, plannable_date: '2026-09-20T09:00:00Z', submissions: false, course_id: 101, plannable_id: 501, html_url: '/courses/101/discussion_topics/501' },
      { context_name: 'MATH268', plannable_type: 'assignment', plannable: { title: 'Turnitin essay', due_at: '2026-11-02T12:00:00Z' }, plannable_date: '2026-11-02T12:00:00Z', submissions: false, course_id: 202, plannable_id: 701, html_url: '/courses/202/assignments/701' },
      { context_name: 'MATH268', plannable_type: 'calendar_event', plannable: { title: 'Class test', start_at: '2026-10-20T09:00:00Z', end_at: '2026-10-20T10:00:00Z' }, plannable_date: '2026-10-20T09:00:00Z', course_id: 202, plannable_id: 801 },
    ],
    faults: {},     // pathname → { status, times, delayMs, body }
    truncate: {},   // file id → true: the storage server cuts the body short
  };
}

export async function startFakeCanvas(model = defaultModel()) {
  const log = [];
  const storageLog = [];
  const cookieLeaks = [];
  let base; let storage;
  const fileById = (id) => {
    for (const c of model.courses) if (c.files[id]) return { course: c, f: c.files[id] };
    return null;
  };
  const meta = (id, c, f) => ({
    id: Number(id), display_name: f.display_name, filename: f.display_name, 'content-type': f['content-type'], size: Buffer.byteLength(f.content),
    updated_at: f.updated_at, modified_at: f.updated_at, folder_id: f.folder_id ?? null,
    url: f.locked ? '' : `${base}/files/${id}/download?download_frd=1&verifier=v${id}`, locked_for_user: !!f.locked,
  });
  const pageOf = (req, res, list) => {
    const u = new URL(req.url, base);
    const per = Math.min(Number(u.searchParams.get('per_page')) || 10, model.pageSize || 10);
    const page = Number(u.searchParams.get('page') || 1);
    const slice = list.slice((page - 1) * per, page * per);
    const headers = {};
    if (page * per < list.length) { u.searchParams.set('page', String(page + 1)); headers.Link = `<${u.href}>; rel="next"`; }
    return json(res, 200, slice, headers);
  };

  const canvas = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.method !== 'GET') return json(res, 405, { errors: [{ message: 'read only' }] });
    const fault = model.faults[u.pathname];
    if (fault && (fault.times === undefined || fault.times-- > 0)) {
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault.status) return json(res, fault.status, fault.body || { errors: [{ message: `fault ${fault.status}` }] }, fault.status === 429 ? { 'Retry-After': '0' } : {});
    }
    if (req.headers.cookie !== model.cookie) {
      if (u.pathname.startsWith('/api/')) return json(res, 401, { errors: [{ message: 'Invalid access token.' }] });
      res.writeHead(302, { Location: '/login/saml' }); return res.end();
    }
    let m;
    if ((m = /^\/files\/(\d+)\/download$/.exec(u.pathname))) {
      const hit = fileById(m[1]);
      if (!hit || hit.f.locked) return json(res, 404, {});
      res.writeHead(302, { Location: `${storage}/blob/${m[1]}?sig=secret-${m[1]}` });
      return res.end();
    }
    const p = u.pathname.replace(/^\/api\/v1\//, '');
    if (p === 'users/self') return json(res, 200, 'while(1);' + JSON.stringify(model.user));
    if (p === 'courses') {
      const active = u.searchParams.get('enrollment_state') === 'active';
      return pageOf(req, res, model.courses.filter((c) => !active || !c.concluded).map((c) => ({ id: c.id, name: c.name, course_code: c.course_code, term: c.term })));
    }
    if (p === 'planner/items') return pageOf(req, res, model.planner);
    if (p === 'announcements') {
      const codes = u.searchParams.getAll('context_codes[]');
      return pageOf(req, res, model.courses.filter((c) => codes.includes(`course_${c.id}`)).flatMap((c) => c.announcements.map((a) => ({ ...a, context_code: `course_${c.id}`, attachments: (a.attachments || []).map((x) => meta(x.id, c, c.files[x.id])) }))));
    }
    if ((m = /^files\/(\d+)$/.exec(p))) {
      const hit = fileById(m[1]);
      return hit ? json(res, 200, meta(m[1], hit.course, hit.f)) : json(res, 404, { errors: [{ message: 'not found' }] });
    }
    if ((m = /^courses\/(\d+)(?:\/(.*))?$/.exec(p))) {
      const c = model.courses.find((x) => String(x.id) === m[1]);
      if (!c || c.noAccess) return json(res, c ? 403 : 404, { errors: [{ message: 'unauthorized' }] });
      const rest = m[2] || '';
      if (!rest) return json(res, 200, { id: c.id, name: c.name, course_code: c.course_code, term: c.term });
      if (rest === 'files') return c.filesHidden ? json(res, 403, { status: 'unauthorized' }) : pageOf(req, res, Object.entries(c.files).map(([id, f]) => meta(id, c, f)));
      if (rest === 'folders') return c.folders ? pageOf(req, res, Object.entries(c.folders).map(([id, full]) => ({ id: Number(id), full_name: full }))) : json(res, 403, {});
      let mm;
      if ((mm = /^files\/(\d+)$/.exec(rest))) return c.files[mm[1]] ? json(res, 200, meta(mm[1], c, c.files[mm[1]])) : json(res, 404, { errors: [{ message: 'not found' }] });
      if (rest === 'modules') return pageOf(req, res, c.modules.map((mod) => ({ id: mod.id, name: mod.name, items_count: mod.items.length, ...(mod.omitItems ? {} : { items: mod.items }) })));
      if ((mm = /^modules\/(\d+)\/items$/.exec(rest))) { const mod = c.modules.find((x) => String(x.id) === mm[1]); return mod ? pageOf(req, res, mod.items) : json(res, 404, {}); }
      if (rest === 'front_page') return c.frontPage ? json(res, 200, { title: 'Home', body: c.frontPage, front_page: true, updated_at: '2026-09-01T00:00:00Z' }) : json(res, 404, { message: 'No front page' });
      if (rest === 'pages') return c.pagesListDisabled ? json(res, 403, { message: 'disabled' }) : pageOf(req, res, Object.entries(c.pages).map(([slug, pg]) => ({ url: slug, title: pg.title })));
      if ((mm = /^pages\/([^/]+)$/.exec(rest))) {
        const pg = c.pages[decodeURIComponent(mm[1])];
        if (!pg) return json(res, 404, { message: 'page not found' });
        return pg.locked ? json(res, 403, { message: 'locked' }) : json(res, 200, { title: pg.title, body: pg.body, url: mm[1], updated_at: '2026-09-01T00:00:00Z' });
      }
      if (rest === 'discussion_topics' && u.searchParams.get('only_announcements') === 'true') return pageOf(req, res, c.announcements.map((a) => ({ ...a, attachments: (a.attachments || []).map((x) => meta(x.id, c, c.files[x.id])) })));
      if (rest === 'discussion_topics') return pageOf(req, res, [{ id: 901, title: 'Questions about week 1', posted_at: '2026-09-21T10:00:00Z', discussion_subentry_count: 1 }]);
      if (rest === 'discussion_topics/901') return json(res, 200, { id: 901, title: 'Questions about week 1', message: '<p>Ask here</p>', author: { display_name: 'Dr Example' } });
      if (rest === 'discussion_topics/901/view') return json(res, 200, { participants: [{ id: 5, display_name: 'Classmate' }], view: [{ id: 1, user_id: 5, created_at: '2026-09-21T11:00:00Z', message: '<p>Is Q2 about inverses?</p>' }] });
      if (rest === 'assignments') return pageOf(req, res, c.assignments.map((a) => ({ ...a, submission: { workflow_state: 'unsubmitted' } })));
      if ((mm = /^assignments\/(\d+)$/.exec(rest))) {
        const a = c.assignments.find((x) => String(x.id) === mm[1]);
        return a ? json(res, 200, { ...a, rubric: [{ description: 'Correctness', points: 6, ratings: [{ points: 6, description: 'All correct' }] }], submission: { workflow_state: 'unsubmitted', missing: false } }) : json(res, 404, {});
      }
      if (rest === 'students/submissions') return pageOf(req, res, c.assignments.map((a) => ({ assignment: a, score: 8, grade: '8', workflow_state: 'graded', submission_comments: [{ author_name: 'Dr Example', comment: 'Good work' }] })));
    }
    if (p === 'users/self/enrollments') return pageOf(req, res, model.courses.map((c) => ({ course_id: c.id, grades: { current_score: 72.5, current_grade: null } })));
    if (p === 'conversations') return pageOf(req, res, [{ id: 31, subject: 'Office hours', context_name: 'MATH253', participants: [{ name: 'Dr Example' }], last_message_at: '2026-09-25T10:00:00Z', last_message: 'Moved to Friday', workflow_state: 'unread' }]);
    if (p === 'conversations/31') return json(res, 200, { subject: 'Office hours', participants: [{ id: 1, name: 'Dr Example' }], messages: [{ author_id: 1, created_at: '2026-09-25T10:00:00Z', body: 'Moved to Friday' }] });
    if (p === 'calendar_events') return pageOf(req, res, [{ title: 'Class test', start_at: '2026-10-20T09:00:00Z', end_at: '2026-10-20T10:00:00Z', location_name: 'Room 1', context_name: 'MATH268' }]);
    if (p === 'folders/9') return json(res, 200, { id: 9, context_type: 'Course', context_id: 202 });
    return json(res, 404, { errors: [{ message: 'not found' }] });
  });

  const store = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    storageLog.push(u.pathname);
    if (req.headers.cookie) cookieLeaks.push(u.pathname);
    const m = /^\/blob\/(\d+)$/.exec(u.pathname);
    const hit = m && fileById(m[1]);
    if (!hit || u.searchParams.get('sig') !== `secret-${m[1]}`) { res.writeHead(403); return res.end(); }
    const body = Buffer.from(hit.f.content);
    if (model.truncate[m[1]]) {
      res.writeHead(200, { 'Content-Type': hit.f['content-type'], 'Content-Length': String(body.length + 100) });
      res.write(body.subarray(0, Math.max(1, body.length - 2)));
      return setTimeout(() => res.destroy(), 20);
    }
    if (model.slow?.[m[1]]) {
      res.writeHead(200, { 'Content-Type': hit.f['content-type'], 'Content-Length': String(body.length) });
      res.write(body.subarray(0, 1));
      return setTimeout(() => { res.end(body.subarray(1)); }, model.slow[m[1]]);
    }
    res.writeHead(200, { 'Content-Type': hit.f['content-type'], 'Content-Length': String(body.length) });
    res.end(body);
  });

  await new Promise((r) => canvas.listen(0, '127.0.0.1', r));
  await new Promise((r) => store.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${canvas.address().port}`;
  // A different origin (localhost vs 127.0.0.1 and another port), like Canvas's file servers.
  storage = `http://localhost:${store.address().port}`;
  for (const c of model.courses) {
    for (const mod of c.modules) for (const it of mod.items) if (it.external_url?.startsWith('CANVAS/')) it.external_url = it.external_url.replace('CANVAS', base);
  }
  return {
    base, storage, model, log, storageLog, cookieLeaks,
    bodyRequests: (id) => storageLog.filter((p) => p === `/blob/${id}`).length,
    close: () => Promise.all([new Promise((r) => canvas.close(r)), new Promise((r) => store.close(r))]),
  };
}

// A session provider that hands out the fake cookie, like a saved sign-in.
export const fakeSession = (cookie = 'canvas_session=good') => async () => ({ cookieHeader: cookie });
