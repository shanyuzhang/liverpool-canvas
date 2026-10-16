import { extractCanvasLinks, classifyCanvasUrl } from './links.js';
import { isAuthError, isNoAccess } from './canvas.js';
import { htmlToText } from './text.js';

// One function finds every file of a course, for the local page, the command line and the AI
// tools alike. It merges all the places Canvas courses keep material instead of stopping at
// the first source that answers:
//   the Files list, every module and its items (paged), files linked from module pages, the
//   course home page and pages they link to, announcement attachments and links, assignment
//   descriptions, and module links that point at a Canvas file.
//
// Result:
//   course     { id, name, code, term }
//   files      [{ id, name, size, updatedAt, contentType, folderPath, sources: [...] }]   downloadable
//   skipped    [{ id?, name?, reason, source? }]   locked, no permission, not found, page images left out
//   incomplete [{ source, reason }]                 a source that failed: the scan is NOT complete
//   notes      ['files-tab-hidden', 'pages-list-disabled', ...]
//   complete   true only when nothing is in `incomplete`

const SOURCE_RANK = { module: 0, 'module-page': 1, files: 2, page: 3, home: 4, assignment: 5, announcement: 6, external: 7 };

export async function discoverCourseFiles(client, courseId, opts = {}) {
  const { includeImages = false, maxPages = 300, signal, onProgress = () => {}, metaConcurrency = 4 } = opts;
  const cid = String(courseId);
  const base = client.base;
  const files = new Map();        // file id → entry
  const pending = new Map();      // file id → { courseId, sources } still needing metadata
  const skipped = [];
  const incomplete = [];
  const notes = new Set();

  // Every source error ends up here: sign-in problems stop the scan; missing permission is a
  // normal "skip"; anything else (server errors, rate limits after retries, timeouts) makes the
  // scan incomplete, so nobody is told "all downloaded" when it is not.
  const failed = (source, e, { quietNoAccess = false } = {}) => {
    if (isAuthError(e) || signal?.aborted) throw e;
    if (isNoAccess(e)) { if (!quietNoAccess) skipped.push({ source, reason: e.status === 403 ? 'no permission' : 'not found' }); return; }
    incomplete.push({ source, reason: e.message });
  };

  const course = await client.course(cid);
  const out = { id: Number(course.id) || cid, name: course.name, code: course.course_code, term: course.term?.name, termStart: course.term?.start_at || course.start_at };

  const addSource = (entry, source) => {
    const key = JSON.stringify(source);
    if (!entry.sources.some((s) => JSON.stringify(s) === key)) entry.sources.push(source);
  };
  const want = (fileId, linkCourseId, source) => {
    const id = String(fileId);
    if (files.has(id)) return addSource(files.get(id), source);
    const p = pending.get(id) || { courseId: linkCourseId || cid, sources: [] };
    if (!p.sources.some((s) => JSON.stringify(s) === JSON.stringify(source))) p.sources.push(source);
    pending.set(id, p);
  };
  const accept = (meta, sources, extra = {}) => {
    const id = String(meta.id);
    if (files.has(id)) { for (const s of sources) addSource(files.get(id), s); return; }
    if (meta.locked_for_user || meta.hidden_for_user || !meta.url) {
      if (!skipped.some((s) => String(s.id) === id)) {
        skipped.push({ id: meta.id, name: meta.display_name, reason: meta.lock_explanation ? `locked: ${htmlToText(meta.lock_explanation).slice(0, 160)}` : 'locked or not available yet', source: sources[0] });
      }
      return;
    }
    files.set(id, {
      id: meta.id, name: meta.display_name || meta.filename || `file-${meta.id}`, size: meta.size ?? null,
      updatedAt: meta.modified_at || meta.updated_at || null, contentType: meta['content-type'] || meta.content_type || null,
      folderId: meta.folder_id ?? null, url: meta.url, sources: [...sources], ...extra,
    });
  };

  // 1. Files list (many courses hide it from students; that is not an error)
  onProgress({ phase: 'files' });
  let folders = new Map();
  try {
    const list = await client.list(`courses/${cid}/files`, {}, { maxPages: 100, signal });
    if (list.truncated) incomplete.push({ source: 'files', reason: 'the Files list is longer than this tool reads in one scan' });
    try {
      const fl = await client.list(`courses/${cid}/folders`, {}, { maxPages: 20, signal });
      folders = new Map(fl.map((f) => [String(f.id), f.full_name]));
    } catch (e) { if (isAuthError(e)) throw e; }
    for (const f of list) {
      const folder = String(folders.get(String(f.folder_id)) || '').replace(/^course files\/?/i, '');
      accept(f, [{ kind: 'files', folder: folder || undefined }]);
    }
  } catch (e) {
    if (isNoAccess(e)) notes.add('files-tab-hidden'); else failed('files', e);
  }

  // 2. Modules and their items. Canvas leaves `items` out for large modules, so those are paged.
  onProgress({ phase: 'modules' });
  const moduleItems = new Map();   // module item id → { item, module }
  const pageQueue = [];            // [{ slug, context }]
  const queued = new Set();
  const queuePage = (slug, context) => {
    const k = String(slug).toLowerCase();
    if (queued.has(k)) return;
    queued.add(k);
    pageQueue.push({ slug, context });
  };
  let modules = [];
  try {
    modules = await client.list(`courses/${cid}/modules`, { include: ['items'] }, { signal });
    if (modules.truncated) incomplete.push({ source: 'modules', reason: 'more modules than this tool reads in one scan' });
  } catch (e) {
    if (isNoAccess(e)) notes.add('modules-hidden'); else failed('modules', e);
  }
  for (const m of modules) {
    if (m.published === false) continue;
    let items = m.items;
    if (!Array.isArray(items) || (Number.isFinite(m.items_count) && items.length < m.items_count)) {
      try {
        items = await client.list(`courses/${cid}/modules/${m.id}/items`, {}, { signal });
        if (items.truncated) incomplete.push({ source: `module "${m.name}"`, reason: 'too many items to read in one scan' });
      } catch (e) { failed(`module "${m.name}"`, e); items = items || []; }
    }
    for (const it of items) {
      if (it.published === false) continue;
      moduleItems.set(String(it.id), { item: it, module: m.name });
      if (it.type === 'File' && it.content_id) want(it.content_id, cid, { kind: 'module', module: m.name, title: it.title });
      else if (it.type === 'Page' && it.page_url) queuePage(it.page_url, { module: m.name, title: it.title });
      else if (it.type === 'ExternalUrl' || it.type === 'ExternalTool') {
        // Only links that are themselves Canvas files are followed; other sites and video
        // platforms are never fetched.
        for (const u of [it.external_url, it.url]) {
          const c = u && classifyCanvasUrl(u, base);
          if (c?.file) want(c.file.fileId, c.file.courseId, { kind: 'external', module: m.name, title: it.title });
        }
      }
    }
  }

  // 3. Home page and the Pages list. The list is often switched off for students while the
  //    pages linked from modules still open, so a 403/404 here is only a note.
  onProgress({ phase: 'pages' });
  queuePage('front_page', { home: true });
  try {
    const pages = await client.list(`courses/${cid}/pages`, { published: true }, { signal });
    if (pages.truncated) incomplete.push({ source: 'pages', reason: 'more pages than this tool reads in one scan' });
    for (const p of pages) if (p.url) queuePage(p.url, {});
  } catch (e) {
    if (isNoAccess(e)) notes.add('pages-list-disabled'); else failed('pages list', e);
  }

  const collectLinks = (html, source, context) => {
    const links = extractCanvasLinks(html, base);
    for (const f of links.files) want(f.fileId, f.courseId, { ...source, embed: f.kind === 'link' ? undefined : f.kind });
    for (const p of links.pages) if (String(p.courseId) === cid) queuePage(p.slug, context);
    for (const mi of links.moduleItems) {
      if (String(mi.courseId) !== cid) continue;
      const hit = moduleItems.get(String(mi.itemId));
      if (hit?.item.type === 'File') want(hit.item.content_id, cid, { kind: 'module', module: hit.module, title: hit.item.title });
      else if (hit?.item.type === 'Page') queuePage(hit.item.page_url, { module: hit.module, title: hit.item.title });
    }
  };

  // 4. Pages, breadth first, each read once; links to pages of the same course are followed,
  //    links into other courses are not.
  let read = 0;
  for (let i = 0; i < pageQueue.length; i++) {
    const { slug, context } = pageQueue[i];
    if (read >= maxPages) {
      incomplete.push({ source: 'pages', reason: `stopped after ${maxPages} pages; ${pageQueue.length - i} linked pages were not scanned` });
      break;
    }
    read++;
    let page;
    try {
      page = slug === 'front_page' ? await client.get(`courses/${cid}/front_page`, {}, { signal }) : await client.get(`courses/${cid}/pages/${encodeURIComponent(slug)}`, {}, { signal });
    } catch (e) {
      failed(slug === 'front_page' ? 'home page' : `page "${context.title || slug}"`, e, { quietNoAccess: slug === 'front_page' || !context.module });
      continue;
    }
    if (page.locked_for_user && !page.body) { skipped.push({ reason: 'page locked', source: { kind: 'page', page: page.title } }); continue; }
    const kind = context.home || page.front_page ? 'home' : context.module ? 'module-page' : 'page';
    const source = { kind, module: context.module, page: page.title };
    collectLinks(page.body, source, { module: context.module, title: page.title });
  }

  // 5. Announcements: every one the course still shows, not only the last few weeks.
  onProgress({ phase: 'announcements' });
  try {
    const anns = await client.list(`courses/${cid}/discussion_topics`, { only_announcements: true }, { signal });
    if (anns.truncated) incomplete.push({ source: 'announcements', reason: 'more announcements than this tool reads in one scan' });
    for (const a of anns) {
      const source = { kind: 'announcement', title: a.title };
      for (const f of a.attachments || []) {
        if (f.id && f.url !== undefined) accept(f, [source]);
        else if (f.id) want(f.id, cid, source);
      }
      collectLinks(a.message, source, {});
    }
  } catch (e) { failed('announcements', e, { quietNoAccess: true }); }

  // 6. Assignment descriptions
  onProgress({ phase: 'assignments' });
  try {
    const assigns = await client.list(`courses/${cid}/assignments`, {}, { signal });
    if (assigns.truncated) incomplete.push({ source: 'assignments', reason: 'more assignments than this tool reads in one scan' });
    for (const a of assigns) collectLinks(a.description, { kind: 'assignment', title: a.name }, {});
  } catch (e) { failed('assignments', e, { quietNoAccess: true }); }

  // 7. Metadata for files only known by id. Links into another course are kept only when
  //    Canvas gives this user the file; that course is never scanned as a whole.
  onProgress({ phase: 'metadata', total: [...pending.keys()].filter((id) => !files.has(id)).length });
  const todo = [...pending.entries()].filter(([id]) => !files.has(id));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [id, p] = todo[next++];
      const sameCourse = String(p.courseId) === cid;
      let meta = null;
      try {
        meta = await client.get(`courses/${p.courseId}/files/${id}`, {}, { signal });
      } catch (e) {
        if (isAuthError(e) || signal?.aborted) throw e;
        if (!isNoAccess(e)) { incomplete.push({ source: `file ${id}`, reason: e.message }); continue; }
        try { meta = await client.get(`files/${id}`, {}, { signal }); } catch (e2) {
          if (isAuthError(e2) || signal?.aborted) throw e2;
          if (isNoAccess(e2)) skipped.push({ id: Number(id), reason: e2.status === 403 ? 'no permission' : 'not found (deleted or moved)', source: p.sources[0] });
          else incomplete.push({ source: `file ${id}`, reason: e2.message });
          continue;
        }
      }
      accept(meta, p.sources, sameCourse ? {} : { linkedFromCourse: cid, otherCourse: String(p.courseId) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(metaConcurrency, todo.length) }, worker));
  for (const [id, p] of pending) if (files.has(id)) for (const s of p.sources) addSource(files.get(id), s);

  // 8. Images that only appear inside page text are left out unless asked for: most are
  //    banners and icons. Linked images and images in modules or the Files list are kept.
  const result = [];
  for (const f of files.values()) {
    const image = /^image\//i.test(f.contentType || '');
    const onlyEmbedded = f.sources.every((s) => s.embed === 'image' || (s.kind === 'files' && /uploaded media|unfiled/i.test(s.folder || '')));
    if (image && onlyEmbedded && !includeImages) { skipped.push({ id: f.id, name: f.name, reason: 'page image (turn on "include page images" to get it)', source: f.sources[0], image: true }); continue; }
    f.primary = [...f.sources].sort((a, b) => SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind])[0];
    f.folderPath = f.primary.kind === 'files' ? f.primary.folder : undefined;
    result.push(f);
  }
  return {
    course: out, files: result, skipped, incomplete, notes: [...notes],
    complete: incomplete.length === 0,
  };
}

// Where a file goes inside the course folder: the module or page it was found in.
export function subfolderFor(primary) {
  if (!primary) return [];
  switch (primary.kind) {
    case 'module': case 'external': return [primary.module];
    case 'module-page': return [primary.module];
    case 'files': return primary.folder ? primary.folder.split('/') : ['Files'];
    case 'page': return [primary.page || 'Pages'];
    case 'home': return ['Home page'];
    case 'assignment': return ['Assignments'];
    case 'announcement': return ['Announcements'];
    default: return [];
  }
}

// Short human description of where a file was found.
export function describeSource(s) {
  const bits = { module: `module "${s.module}"`, 'module-page': `page "${s.page}" in module "${s.module}"`, files: `Files${s.folder ? `/${s.folder}` : ''}`, page: `page "${s.page}"`, home: 'home page', assignment: `assignment "${s.title}"`, announcement: `announcement "${s.title}"`, external: `module link "${s.title}"` };
  return bits[s.kind] || s.kind;
}
