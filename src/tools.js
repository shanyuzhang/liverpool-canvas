import fs from 'node:fs';
import { z } from 'zod';
import { htmlToText, extractText, window } from './text.js';
import { fileIdsIn } from './links.js';
import { confirmDownloadRoot, defaultDownloadRoot, savedSelection, resolveFolder } from './config.js';
import { isAuthError } from './canvas.js';
import { discoverCourseFiles, describeSource } from './discovery.js';
import { saveSingleFile, readHistory } from './downloader.js';
import { normaliseCourses, londonTime } from './courses.js';

// Every tool only reads from Canvas (GET requests). The download tools write course files into
// the folder the user chose, never anywhere else, and never replace a file that is already there.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const SAVES_FILES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const id = z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String);
const days = (d) => new Date(Date.now() + d * 86400000).toISOString();

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 1));
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));

function submissionSummary(s) {
  if (!s) return undefined;
  return drop({
    state: s.workflow_state, submitted_at: s.submitted_at, late: s.late || undefined, missing: s.missing || undefined,
    excused: s.excused || undefined, score: s.score, grade: s.grade,
  });
}

async function activeCourseIds(c) {
  const all = await c.list('courses', { enrollment_state: 'active' });
  for (const x of all) c.courseInfo.set(String(x.id), x);
  return { ids: all.filter((x) => x.id).map((x) => String(x.id)), names: new Map(all.map((x) => [String(x.id), x.course_code || x.name])) };
}

// Planner item → one row. Announcements carry a *posted* time and calendar events a *start*
// time; only real work has a *due* time, so a post date is never shown as a deadline.
const KIND = { assignment: 'assignment', sub_assignment: 'assignment', quiz: 'quiz', discussion_topic: 'discussion', wiki_page: 'page to-do', planner_note: 'personal to-do', calendar_event: 'calendar event', announcement: 'announcement', assessment_request: 'peer review' };
export function plannerRow(it, base) {
  const p = it.plannable || {};
  const type = KIND[it.plannable_type] || it.plannable_type;
  const row = { course: it.context_name, type, title: p.title || p.name };
  if (it.plannable_type === 'announcement') Object.assign(row, { posted: p.posted_at || it.plannable_date, posted_uk: londonTime(p.posted_at || it.plannable_date) });
  else if (it.plannable_type === 'calendar_event') Object.assign(row, { starts: p.start_at || it.plannable_date, starts_uk: londonTime(p.start_at || it.plannable_date), ends_uk: londonTime(p.end_at), all_day: p.all_day || undefined });
  else {
    const due = p.due_at || p.todo_date || null;
    if (due) Object.assign(row, { due, due_uk: londonTime(due) });
    else Object.assign(row, { no_due_date: true, planner_date_uk: londonTime(it.plannable_date) });
    row.points = p.points_possible;
    if (it.submissions && typeof it.submissions === 'object') {
      Object.assign(row, { submitted: !!it.submissions.submitted, missing: it.submissions.missing || undefined, late: it.submissions.late || undefined, graded: it.submissions.graded || undefined, excused: it.submissions.excused || undefined });
    } else if (['assignment', 'quiz', 'discussion_topic', 'sub_assignment'].includes(it.plannable_type)) {
      row.submission = 'unknown: Canvas has no submission record (work handed in on another platform, on paper, or not submittable). Check there; do not assume it is missing.';
    }
  }
  return drop({ ...row, course_id: it.course_id, id: it.plannable_id, url: it.html_url ? new URL(it.html_url, base).href : undefined });
}

// Where files go. A folder the user names (for example the project folder they have open in
// their AI app) is used for that request; it becomes the default only when there is no default
// yet or the user asks to remember it. Relative paths are taken inside their workspace.
const FOLDER_HELP = 'Folder to save into, as the user asked. If they want the files where they are working, pass that folder (a relative path such as "papers" is created inside their current workspace). Used for this request; it becomes the default folder only if none is set yet or remember_folder is true.';
const folderInput = {
  download_folder: z.string().optional().describe(FOLDER_HELP),
  remember_folder: z.boolean().optional().describe('Also make download_folder the default for later downloads (only when the user wants that)'),
};

async function pickFolder(app, download_folder, remember_folder, { rememberIfNoDefault = true } = {}) {
  if (!download_folder) return app.root();
  const dir = resolveFolder(download_folder, (await app.workspace?.()) || process.cwd());
  fs.mkdirSync(dir, { recursive: true });
  if (remember_folder || (rememberIfNoDefault && !app.root())) confirmDownloadRoot(dir);
  return dir;
}

async function needFolder(app) {
  const ws = await app.workspace?.();
  return text([
    'Where should the files go? No folder has been chosen yet, so ask the user before downloading. Offer:',
    ws ? `- the folder they are working in now: ${ws}` : null,
    `- ${defaultDownloadRoot()} (the usual default)`,
    '- any other folder they name',
    `Then call again with download_folder set to their choice${ws ? ` (a relative path goes inside ${ws})` : ''}.`,
  ].filter(Boolean).join('\n'));
}

function jobReport(job, finished) {
  const v = { state: job.state, folder: job.root, courses: job.courses.map((c) => drop({ id: c.id, code: c.code, state: c.state, phase: c.state === 'scanning' ? c.phase : undefined, counts: c.counts })) };
  if (!finished) return { ...v, note: 'Still running in the background. Call canvas_download_status in a little while to see the result.' };
  if (job.error) return { ...v, error: job.error.message };
  const r = job.result;
  return drop({
    ...v, complete: r.complete,
    summary: r.courses.map((c) => drop({
      course: c.code || c.id, folder: c.folder, new: c.counts.new, already_saved: c.counts.existing, downloaded_again_missing_locally: c.counts.restored || undefined,
      changed_on_canvas_kept_local: c.counts.remoteUpdated || undefined, changed_files: c.remoteUpdated.slice(0, 20),
      failed: c.failed.map((f) => `${f.name}: ${f.error}`), no_access_or_locked: c.counts.skipped || undefined, page_images_left_out: c.counts.images || undefined,
      scan_incomplete: c.incomplete.length ? c.incomplete.map((x) => `${x.source}: ${x.reason}`) : undefined, error: c.error,
    })),
    note: r.complete ? undefined : 'Not everything was checked or saved; see failed / scan_incomplete. Running it again only fetches what is still missing.',
  });
}

async function startAndWait(app, opts, waitMs = 45000) {
  const job = await app.jobs.start(opts);
  const finished = await app.jobs.wait(job, waitMs);
  return json(jobReport(job, finished));
}

// Each tool is { name, title, description, input, run(client, args, app) }. Kept as plain data so
// tests can call run() directly with a fake client.
export const TOOLS = [
  {
    name: 'canvas_whoami',
    title: 'Who am I on Canvas',
    description: 'Check the Liverpool Canvas connection and return the signed-in user and Canvas URL.',
    input: {},
    async run(c) {
      const me = await c.get('users/self');
      return json({ canvas: c.base, id: me.id, name: me.name, short_name: me.short_name });
    },
  },
  {
    name: 'canvas_list_courses',
    title: 'List courses',
    description: 'List your Canvas courses (current ones by default) with ids, codes and terms; this term\'s are marked current_term. Most other tools need a course_id from here.',
    input: { include_past: z.boolean().optional().describe('Also include completed/past courses') },
    async run(c, { include_past }) {
      const raw = (await c.list('courses', { include: ['term'], ...(include_past ? {} : { enrollment_state: 'active' }) })).filter((x) => x.id && x.name);
      for (const x of raw) c.courseInfo.set(String(x.id), x);
      return json(normaliseCourses(raw).map((x) => drop({
        id: Number(x.id), code: x.code, name: x.name, term: x.term,
        current_term: x.current || undefined, kind: x.group === 'other' ? 'non-term site (community, orientation, etc.)' : undefined,
      })));
    },
  },
  {
    name: 'canvas_upcoming',
    title: 'Upcoming work',
    description: 'Everything due or scheduled across all courses in the next N days (assignments, quizzes, discussions, to-dos; announcements show their posting time, never as a deadline), with submission status and UK-time dates (GMT/BST). Best first call for "what is due".',
    input: {
      days: z.number().int().min(1).max(120).optional().describe('How many days ahead (default 14)'),
      past_days: z.number().int().min(0).max(60).optional().describe('Also include items from this many days ago, e.g. to find overdue work (default 0)'),
      include_events: z.boolean().optional().describe('Also list calendar events such as timetabled classes (default false: only things you have to do)'),
    },
    async run(c, { days: ahead = 14, past_days = 0, include_events = false }) {
      const items = (await c.list('planner/items', { start_date: days(-past_days), end_date: days(ahead) }))
        .filter((it) => include_events || it.plannable_type !== 'calendar_event');
      const rows = items.map((it) => plannerRow(it, c.base));
      const when = (r) => r.due || r.starts || r.posted || '';
      return json(rows.sort((a, b) => String(when(a)).localeCompare(String(when(b)))));
    },
  },
  {
    name: 'canvas_list_assignments',
    title: 'List assignments',
    description: 'Assignments in a course with due dates (UTC and UK time), points and your submission status/score.',
    input: {
      course_id: id,
      bucket: z.enum(['past', 'overdue', 'undated', 'ungraded', 'unsubmitted', 'upcoming', 'future']).optional(),
    },
    async run(c, { course_id, bucket }) {
      const list = await c.list(`courses/${course_id}/assignments`, { include: ['submission'], order_by: 'due_at', bucket });
      return json(list.map((a) => drop({
        id: a.id, name: a.name, due: a.due_at, due_uk: londonTime(a.due_at), no_due_date: a.due_at ? undefined : true, lock: a.lock_at, points: a.points_possible,
        types: a.submission_types, submission: submissionSummary(a.submission),
      })));
    },
  },
  {
    name: 'canvas_get_assignment',
    title: 'Assignment details',
    description: 'Full assignment instructions as text, rubric, your submission, and ids of attached files (read them with canvas_read_file).',
    input: { course_id: id, assignment_id: id },
    async run(c, { course_id, assignment_id }) {
      const a = await c.get(`courses/${course_id}/assignments/${assignment_id}`, { include: ['submission'] });
      const ids = fileIdsIn(a.description, c.base);
      c.noteFiles(course_id, ids, 'Assignments');
      const rubric = (a.rubric || []).map((r) => drop({
        criterion: r.description, points: r.points, details: r.long_description,
        ratings: (r.ratings || []).map((x) => `${x.points}: ${x.description}`),
      }));
      return json(drop({
        name: a.name, due: a.due_at, due_uk: londonTime(a.due_at), lock: a.lock_at, points: a.points_possible, types: a.submission_types,
        url: a.html_url, submission: submissionSummary(a.submission),
        instructions: htmlToText(a.description), file_ids: ids, rubric,
      }));
    },
  },
  {
    name: 'canvas_list_announcements',
    title: 'Announcements',
    description: 'Recent announcements, newest first, as text with attached files. Defaults to all current courses.',
    input: {
      course_ids: z.array(id).optional().describe('Limit to these courses'),
      days: z.number().int().min(1).max(365).optional().describe('How far back (default 30)'),
    },
    async run(c, { course_ids, days: back = 30 }) {
      let courses = course_ids;
      let names = new Map();
      if (!courses?.length) ({ ids: courses, names } = await activeCourseIds(c));
      if (!courses.length) return text('No current courses.');
      const list = [];
      for (let i = 0; i < courses.length; i += 10) {   // Canvas accepts at most 10 contexts per call
        list.push(...await c.list('announcements', { context_codes: courses.slice(i, i + 10).map((x) => `course_${x}`), start_date: days(-back), end_date: days(1) }));
      }
      list.sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
      for (const a of list) c.noteFiles(String(a.context_code).replace('course_', ''), [...fileIdsIn(a.message, c.base), ...(a.attachments || []).map((f) => f.id)], 'Announcements');
      return json(list.map((a) => drop({
        id: a.id, course: names.get(String(a.context_code).replace('course_', '')) || a.context_code,
        title: a.title, posted: a.posted_at, posted_uk: londonTime(a.posted_at), author: a.author?.display_name,
        text: htmlToText(a.message).slice(0, 4000), file_ids: fileIdsIn(a.message, c.base),
        attachments: (a.attachments || []).map((f) => ({ file_id: f.id, name: f.display_name })),
      })));
    },
  },
  {
    name: 'canvas_list_modules',
    title: 'Course modules',
    description: 'The course structure: modules and their items (pages, files, assignments, links). File items give a file id for canvas_read_file; page items give a page_url for canvas_get_page.',
    input: { course_id: id },
    async run(c, { course_id }) {
      const mods = await c.list(`courses/${course_id}/modules`, { include: ['items'] });
      for (const m of mods) {
        // Canvas leaves the items out of large modules; fetch those separately.
        if (!Array.isArray(m.items) || (Number.isFinite(m.items_count) && m.items.length < m.items_count)) {
          m.items = await c.list(`courses/${course_id}/modules/${m.id}/items`).catch(() => m.items || []);
        }
        c.noteFiles(course_id, m.items.filter((it) => it.type === 'File').map((it) => it.content_id), m.name);
      }
      return json(mods.map((m) => drop({
        module: m.name, state: m.state === 'locked' ? 'locked' : undefined,
        items: (m.items || []).map((it) => drop({
          type: it.type, title: it.title,
          file_id: it.type === 'File' ? it.content_id : undefined,
          assignment_id: ['Assignment', 'Quiz', 'Discussion'].includes(it.type) ? it.content_id : undefined,
          page_url: it.page_url, link: it.external_url,
        })),
      })));
    },
  },
  {
    name: 'canvas_get_page',
    title: 'Read a page',
    description: 'Read a course page (wiki page) as text, with the ids of files it links to. Use page_url from canvas_list_modules, or "front_page".',
    input: {
      course_id: id,
      page_url: z.string().describe('Page slug, e.g. "week-1-overview", or "front_page"'),
      offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(500).max(100000).optional(),
    },
    async run(c, { course_id, page_url, offset, max_chars }) {
      const p = page_url === 'front_page'
        ? await c.get(`courses/${course_id}/front_page`)
        : await c.get(`courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
      const ids = fileIdsIn(p.body, c.base);
      c.noteFiles(course_id, ids, p.title);
      const head = `# ${p.title}\nupdated: ${p.updated_at}${ids.length ? `\nlinked file ids: ${ids.join(', ')}` : ''}\n\n`;
      return text(head + window(htmlToText(p.body), { offset, maxChars: max_chars }));
    },
  },
  {
    name: 'canvas_list_files',
    title: 'List course files',
    description: 'Every file of a course you can open, gathered from the Files list, modules, files linked inside pages (including pages reached from modules when the Pages list is switched off), the home page, announcements and assignment descriptions. Each file appears once, with where it was found. Says when something could not be scanned.',
    input: {
      course_id: id,
      search: z.string().min(2).optional().describe('Part of the file name'),
      include_images: z.boolean().optional().describe('Also list images that only appear inside page text (default false)'),
    },
    async run(c, { course_id, search, include_images }) {
      const r = await discoverCourseFiles(c, course_id, { includeImages: include_images });
      const q = String(search || '').toLowerCase();
      const files = r.files.filter((f) => !q || f.name.toLowerCase().includes(q));
      for (const f of files) c.noteFiles(course_id, [f.id], f.primary?.module || f.primary?.page);
      return json(drop({
        complete: r.complete,
        note: r.notes.includes('files-tab-hidden') ? 'The Files tab is hidden in this course; files were gathered from modules, pages, announcements and assignments.' : undefined,
        files: files.map((f) => drop({ id: f.id, name: f.name, size: f.size, updated: f.updatedAt, found_in: f.sources.slice(0, 5).map(describeSource) })),
        not_available: r.skipped.filter((s) => !s.image).slice(0, 50).map((s) => drop({ id: s.id, name: s.name, reason: s.reason })),
        page_images_left_out: r.skipped.filter((s) => s.image).length || undefined,
        scan_incomplete: r.incomplete.length ? r.incomplete.map((x) => `${x.source}: ${x.reason}`) : undefined,
      }));
    },
  },
  {
    name: 'canvas_read_file',
    title: 'Read a course file',
    description: 'Read a course file (lecture slides, assignment PDF, handout) and return its text. Supports PDF, DOCX, HTML and plain-text files; other formats are saved locally and the path is returned. A file already saved on this computer is read from there and never replaced.',
    input: {
      file_id: id,
      course_id: id.optional().describe('The course it belongs to, so it is saved in that course folder'),
      download_folder: z.string().optional().describe('Save the file straight into this folder (e.g. the folder the user is working in) instead of the course folder. Relative paths are inside the user\'s workspace.'),
      offset: z.number().int().min(0).optional().describe('Character offset for long files'),
      max_chars: z.number().int().min(500).max(100000).optional().describe('Characters to return (default 20000)'),
    },
    async run(c, { file_id, course_id, download_folder, offset, max_chars }, app) {
      if (course_id) c.noteFiles(course_id, [file_id]);
      const folder = download_folder ? await pickFolder(app, download_folder, false, { rememberIfNoDefault: false }) : null;
      const index = await app.index(folder || undefined);
      const f = await saveSingleFile(c, index, file_id, course_id, { flat: !!folder });
      const buffer = fs.readFileSync(f.path);
      const head = `# ${f.name}\nsaved to: ${f.path}\nsize: ${buffer.length} bytes, updated on Canvas ${f.updatedAt}${f.remoteChanged ? '\nnote: Canvas has a newer version than the copy on this computer; the local copy was kept.' : ''}\n\n`;
      const body = await extractText(buffer, f).catch((e) => `(could not extract text: ${e.message})`);
      if (body === null) return text(head + `This file type (${f.contentType || 'unknown'}) cannot be read as text here. Open it from the saved path.`);
      if (!body.trim()) return text(head + '(No text layer, e.g. a scanned PDF. Open it from the saved path.)');
      return text(head + window(body, { offset, maxChars: max_chars }));
    },
  },
  {
    name: 'canvas_download_file',
    title: 'Download files into a folder',
    description: 'Save particular Canvas files (an exam paper, a handout, an assignment sheet the user asked for) straight into a folder, typically the folder the user is working in. Files land directly in that folder, without course/module subfolders unless keep_structure is true. A file already saved there is not downloaded again or overwritten; a different file with the same name is saved as "name (canvas-ID)". Returns the full path of each file.',
    input: {
      file_ids: z.array(id).min(1).max(100),
      course_id: id.optional().describe('The course the files belong to'),
      download_folder: z.string().optional().describe('Folder to save into, as the user asked. Relative paths such as "papers" are created inside the user\'s current workspace. Without it, the default download folder is used (with course folders).'),
      keep_structure: z.boolean().optional().describe('Put files in <course>/<module> subfolders inside the folder'),
    },
    annotations: SAVES_FILES,
    async run(c, { file_ids, course_id, download_folder, keep_structure }, app) {
      const root = await pickFolder(app, download_folder, false, { rememberIfNoDefault: false });
      if (!root) return needFolder(app);
      const index = await app.index(root);
      const flat = !!download_folder && !keep_structure;
      const files = [];
      for (const fid of file_ids) {
        try {
          const r = await saveSingleFile(c, index, fid, course_id, { flat });
          files.push(drop({ file_id: fid, name: r.name, path: r.path, status: r.status === 'existing' ? 'already there (kept as is)' : r.status === 'restored' ? 'downloaded again (local copy was missing)' : 'downloaded', changed_on_canvas: r.remoteChanged || undefined }));
        } catch (e) {
          if (isAuthError(e)) throw e;
          files.push({ file_id: fid, error: e.message });
        }
      }
      return json({ folder: root, files });
    },
  },
  {
    name: 'canvas_save_course_files',
    title: 'Save course files to your computer',
    description: 'Download one course\'s files into the chosen download folder (<course>/<module or page>/…). Only files not saved yet are fetched; saved files are never downloaded again, replaced or moved, so it is safe to run again to pick up new material.',
    input: {
      course_id: id,
      search: z.string().min(2).optional().describe('Only files whose name contains this'),
      max: z.number().int().min(1).max(2000).optional().describe('At most this many files'),
      ...folderInput,
    },
    annotations: SAVES_FILES,
    async run(c, { course_id, search, max, download_folder, remember_folder }, app) {
      const root = await pickFolder(app, download_folder, remember_folder);
      if (!root) return needFolder(app);
      return startAndWait(app, { courseIds: [course_id], search, max, root });
    },
  },
  {
    name: 'canvas_preview_download',
    title: 'Preview a course download',
    description: 'List which files of the chosen courses would be downloaded and which are already saved, without downloading anything.',
    input: { course_ids: z.array(id).min(1), include_images: z.boolean().optional(), download_folder: z.string().optional().describe('The folder the download would go to (see canvas_download_courses)') },
    async run(c, { course_ids, include_images, download_folder }, app) {
      const root = download_folder ? resolveFolder(download_folder, (await app.workspace?.()) || process.cwd()) : app.root();
      if (!root) return needFolder(app);
      const job = await app.jobs.start({ courseIds: course_ids, preview: true, includeImages: include_images, root });
      const done = await app.jobs.wait(job, 50000);
      if (!done) return json(jobReport(job, false));
      if (job.error) return json({ error: job.error.message });
      return json(job.result.courses.map((x) => drop({
        course: x.code || x.id, folder: x.folder, to_download: x.counts.new, missing_locally: x.counts.restored || undefined, already_saved: x.counts.existing,
        no_access_or_locked: x.counts.skipped || undefined, scan_incomplete: x.incomplete.length ? x.incomplete.map((i) => `${i.source}: ${i.reason}`) : undefined,
        files: x.files.filter((f) => f.action !== 'already saved').slice(0, 200).map((f) => `${f.folder}/${f.name}`),
      })));
    },
  },
  {
    name: 'canvas_download_courses',
    title: 'Download chosen courses',
    description: 'Download the files of the courses the user chose into the download folder, fetching only what is not saved yet. Remembers the choice so canvas_sync_courses can fetch new files later. Ask the user which courses (and the folder, if none is set) before calling.',
    input: {
      course_ids: z.array(id).min(1),
      include_images: z.boolean().optional().describe('Also save images that only appear inside page text'),
      ...folderInput,
      remember: z.boolean().optional().describe('Remember these courses (for this folder) for later syncs (default true)'),
    },
    annotations: SAVES_FILES,
    async run(c, { course_ids, include_images, download_folder, remember_folder, remember = true }, app) {
      const root = await pickFolder(app, download_folder, remember_folder);
      if (!root) return needFolder(app);
      return startAndWait(app, { courseIds: course_ids, includeImages: include_images, rememberSelection: remember, root });
    },
  },
  {
    name: 'canvas_sync_courses',
    title: 'Fetch new files',
    description: 'For the courses the user chose before (for the default folder, or for download_folder), download only files that are new on Canvas or missing locally. Does nothing until courses have been chosen.',
    input: { download_folder: z.string().optional().describe('Sync this folder instead of the default one') },
    annotations: SAVES_FILES,
    async run(c, { download_folder }, app) {
      const root = download_folder ? resolveFolder(download_folder, (await app.workspace?.()) || process.cwd()) : app.root();
      if (!root) return needFolder(app);
      const me = await app.user();
      const ids = savedSelection(app.base, me.id, root);
      if (!ids?.length) return text(`No courses have been chosen for ${root} yet. Ask the user which courses to download, then call canvas_download_courses.`);
      return startAndWait(app, { courseIds: ids, root });
    },
  },
  {
    name: 'canvas_download_status',
    title: 'Download status',
    description: 'The download folder, the remembered course choice, the download that is running (or just finished), and recent download history.',
    input: {},
    async run(c, args, app) {
      const root = app.root();
      const ws = await app.workspace?.();
      const out = { default_folder: root || `not chosen yet (suggest ${defaultDownloadRoot()})`, user_workspace: ws || undefined };
      if (app.jobs.current) out.current = jobReport(app.jobs.current, app.jobs.current.state !== 'running');
      if (root) {
        const me = await app.user();
        out.remembered_courses = savedSelection(app.base, me.id, root) || [];
        out.history = readHistory(await app.index(root)).slice(0, 5).map((h) => ({ at: h.at, complete: h.complete, courses: h.courses.map((x) => ({ course: x.code || x.id, ...x.counts })) }));
      }
      return json(out);
    },
  },
  {
    name: 'canvas_list_discussions',
    title: 'Discussion topics',
    description: 'Discussion topics in a course with reply counts and unread counts.',
    input: { course_id: id },
    async run(c, { course_id }) {
      const list = await c.list(`courses/${course_id}/discussion_topics`, { order_by: 'recent_activity' }, { maxPages: 3 });
      return json(list.map((d) => drop({
        id: d.id, title: d.title, posted: d.posted_at, last_reply: d.last_reply_at,
        replies: d.discussion_subentry_count, unread: d.unread_count || undefined,
      })));
    },
  },
  {
    name: 'canvas_get_discussion',
    title: 'Read a discussion',
    description: 'A discussion topic and all its replies as text.',
    input: { course_id: id, topic_id: id, offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(500).max(100000).optional() },
    async run(c, { course_id, topic_id, offset, max_chars }) {
      const t = await c.get(`courses/${course_id}/discussion_topics/${topic_id}`);
      const v = await c.get(`courses/${course_id}/discussion_topics/${topic_id}/view`).catch(() => ({ view: [], participants: [] }));
      const who = new Map((v.participants || []).map((p) => [p.id, p.display_name]));
      const lines = [`# ${t.title}`, `${t.author?.display_name || ''} · ${t.posted_at || ''}`, '', htmlToText(t.message), ''];
      const walk = (entries, depth) => {
        for (const e of entries || []) {
          if (e.deleted) continue;
          const pad = '  '.repeat(depth);
          lines.push(`${pad}— ${who.get(e.user_id) || 'someone'} · ${e.created_at}`);
          lines.push(htmlToText(e.message).split('\n').map((l) => pad + l).join('\n'), '');
          walk(e.replies, depth + 1);
        }
      };
      walk(v.view, 0);
      return text(window(lines.join('\n'), { offset, maxChars: max_chars }));
    },
  },
  {
    name: 'canvas_grades',
    title: 'Grades',
    description: 'Without course_id: your current overall grade in each course. With course_id: every graded item with score and teacher comments.',
    input: { course_id: id.optional() },
    async run(c, { course_id }) {
      if (!course_id) {
        const enr = await c.list('users/self/enrollments', { type: ['StudentEnrollment'], state: ['active'] });
        const courses = new Map((await c.list('courses', { enrollment_state: 'active' })).map((x) => [x.id, x.course_code || x.name]));
        return json(enr.map((e) => drop({
          course_id: e.course_id, course: courses.get(e.course_id),
          current_score: e.grades?.current_score, current_grade: e.grades?.current_grade, final_score: e.grades?.final_score,
        })));
      }
      const subs = await c.list(`courses/${course_id}/students/submissions`, { include: ['assignment', 'submission_comments'] });
      return json(subs.filter((s) => s.assignment).map((s) => drop({
        assignment: s.assignment.name, due: s.assignment.due_at, due_uk: londonTime(s.assignment.due_at), points: s.assignment.points_possible,
        score: s.score, grade: s.grade, state: s.workflow_state, late: s.late || undefined, missing: s.missing || undefined,
        comments: (s.submission_comments || []).map((x) => `${x.author_name}: ${x.comment}`),
      })));
    },
  },
  {
    name: 'canvas_inbox',
    title: 'Canvas inbox',
    description: 'Canvas Inbox conversations (messages from teachers and classmates). Pass conversation_id to read one thread in full.',
    input: { conversation_id: id.optional(), max: z.number().int().min(1).max(100).optional().describe('How many conversations to list (default 20)') },
    async run(c, { conversation_id, max = 20 }) {
      if (conversation_id) {
        const cv = await c.get(`conversations/${conversation_id}`);
        const who = new Map((cv.participants || []).map((p) => [p.id, p.name]));
        return text([`# ${cv.subject || '(no subject)'}`, ...(cv.messages || []).slice().reverse()
          .map((m) => `— ${who.get(m.author_id) || m.author_id} · ${m.created_at}\n${m.body}`)].join('\n\n'));
      }
      const list = await c.list('conversations', { scope: 'inbox', per_page: Math.min(max, 100) }, { maxPages: 1 });
      return json(list.slice(0, max).map((cv) => drop({
        id: cv.id, subject: cv.subject, course: cv.context_name, with: (cv.participants || []).map((p) => p.name).join(', '),
        last: cv.last_message_at, unread: cv.workflow_state === 'unread' || undefined, preview: String(cv.last_message || '').slice(0, 300),
      })));
    },
  },
  {
    name: 'canvas_calendar',
    title: 'Calendar events',
    description: 'Calendar events (classes, exams, consultation times) in the next N days, with UK times. Defaults to all current courses.',
    input: { days: z.number().int().min(1).max(180).optional().describe('Days ahead (default 30)'), course_ids: z.array(id).optional() },
    async run(c, { days: ahead = 30, course_ids }) {
      let courses = course_ids;
      if (!courses?.length) courses = (await activeCourseIds(c)).ids;
      const list = [];
      for (let i = 0; i < courses.length; i += 10) {   // Canvas accepts at most 10 contexts per call
        list.push(...await c.list('calendar_events', { type: 'event', context_codes: courses.slice(i, i + 10).map((x) => `course_${x}`), start_date: days(0), end_date: days(ahead) }));
      }
      list.sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
      return json(list.map((e) => drop({
        title: e.title, start: e.start_at, start_uk: londonTime(e.start_at), end_uk: londonTime(e.end_at), all_day: e.all_day || undefined,
        where: e.location_name, course: e.context_name, details: htmlToText(e.description).slice(0, 1000),
      })));
    },
  },
  {
    name: 'canvas_api_get',
    title: 'Raw Canvas API GET',
    description: 'Escape hatch: GET any Canvas REST endpoint (https://canvas.instructure.com/doc/api/) with your session, e.g. "courses/123/quizzes". Read-only.',
    input: {
      path: z.string().describe('Path after /api/v1/, e.g. "courses/123/quizzes"'),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).optional(),
      all_pages: z.boolean().optional().describe('Follow pagination (lists only)'),
    },
    async run(c, { path: p, params = {}, all_pages }) {
      const clean = p.replace(/^\/?(api\/v1\/)?/, '');
      if (/^[a-z]+:|\/\/|\.\.|\\/i.test(clean)) throw new Error('Give a path relative to /api/v1/.');
      const data = all_pages ? await c.list(clean, params) : await c.get(clean, params);
      return text(window(JSON.stringify(data, null, 1), { maxChars: 40000 }));
    },
  },
];

export function registerTools(server, getApp) {
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: { ...(t.annotations || READ_ONLY), title: t.title } },
      async (args) => {
        try { const app = await getApp(); return await t.run(app.client, args || {}, app); }
        catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
      });
  }
}
