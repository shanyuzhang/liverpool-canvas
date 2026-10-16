import { Parser } from 'htmlparser2';
import { CANVAS_ALIASES } from './config.js';

// Finds the Canvas files and pages that a piece of course HTML (a page, an announcement, an
// assignment description) points at. It reads real attributes with an HTML parser, so a
// number in the text or an unrelated URL is never mistaken for a file.
//
// Returns { files: [{ fileId, courseId, kind }], pages: [{ courseId, slug }], moduleItems: [{ courseId, itemId }] }
//   kind: 'link'  an <a> link or Canvas file attachment: a document someone is meant to open
//         'embed' an <iframe>/<embed>/<object>/<video>/<audio> source
//         'image' an <img> shown inside the page (often decoration, sometimes a question figure)

const FILE_PATH = /^\/(?:api\/v1\/)?(?:(courses|groups|users)\/(\d+)\/)?files\/(\d+)(?:\/(?:download|preview|file_preview|thumbnail))?\/?$/;
const FILES_PREVIEW = /^\/(?:courses\/(\d+)\/)?files(?:\/folder\/.*)?\/?$/;   // /courses/1/files?preview=123
const PAGE_PATH = /^\/(?:api\/v1\/)?courses\/(\d+)\/(?:pages|wiki)\/([^/]+)\/?$/;
const FRONT_PAGE = /^\/courses\/(\d+)\/?$/;
const MODULE_ITEM = /^\/courses\/(\d+)\/modules\/items\/(\d+)\/?$/;

const SOURCE_ATTRS = {
  a: [['href', 'link']],
  img: [['src', 'image']],
  iframe: [['src', 'embed']],
  embed: [['src', 'embed']],
  object: [['data', 'embed']],
  source: [['src', 'embed']],
  video: [['src', 'embed'], ['poster', 'image']],
  audio: [['src', 'embed']],
  track: [['src', 'embed']],
};

export function canvasUrl(raw, base) {
  if (!raw || /^(javascript|data|mailto|tel):/i.test(String(raw).trim())) return null;
  let u;
  try { u = new URL(String(raw).trim(), base); } catch { return null; }
  const b = new URL(base);
  if (u.origin !== b.origin && !(u.protocol === 'https:' && CANVAS_ALIASES.includes(u.hostname))) return null;
  return u;
}

// Classifies one URL. Returns { file }, { page }, { moduleItem } or null.
export function classifyCanvasUrl(raw, base) {
  const u = canvasUrl(raw, base);
  if (!u) return null;
  let pathname;
  try { pathname = decodeURI(u.pathname); } catch { pathname = u.pathname; }
  let m = FILE_PATH.exec(u.pathname);
  if (m) return { file: { fileId: m[3], courseId: m[1] === 'courses' ? m[2] : null } };
  m = FILES_PREVIEW.exec(u.pathname);
  if (m && /^\d+$/.test(u.searchParams.get('preview') || '')) return { file: { fileId: u.searchParams.get('preview'), courseId: m[1] || null } };
  m = PAGE_PATH.exec(u.pathname);
  if (m) {
    let slug = m[2];
    try { slug = decodeURIComponent(slug); } catch { /* keep as is */ }
    return { page: { courseId: m[1], slug } };
  }
  m = MODULE_ITEM.exec(u.pathname);
  if (m) return { moduleItem: { courseId: m[1], itemId: m[2] } };
  m = FRONT_PAGE.exec(pathname);
  if (m) return { page: { courseId: m[1], slug: 'front_page' } };
  return null;
}

export function extractCanvasLinks(html, base) {
  const files = new Map();
  const pages = new Map();
  const moduleItems = new Map();
  const rank = { link: 3, embed: 2, image: 1 };
  const addFile = (f, kind) => {
    const key = `${f.courseId || ''}:${f.fileId}`;
    const prev = files.get(key);
    if (!prev || rank[kind] > rank[prev.kind]) files.set(key, { ...f, kind });
  };
  const take = (raw, kind) => {
    const c = classifyCanvasUrl(raw, base);
    if (!c) return;
    if (c.file) addFile(c.file, kind);
    else if (c.page && kind === 'link') pages.set(`${c.page.courseId}:${c.page.slug.toLowerCase()}`, c.page);
    else if (c.moduleItem && kind === 'link') moduleItems.set(`${c.moduleItem.courseId}:${c.moduleItem.itemId}`, c.moduleItem);
  };

  const parser = new Parser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      for (const [attr, kind] of SOURCE_ATTRS[tag] || []) if (attrs[attr]) take(attrs[attr], kind);
      // Canvas's editor marks file links and embedded images with their API address too.
      const endpoint = attrs['data-api-endpoint'];
      const type = String(attrs['data-api-returntype'] || '').toLowerCase();
      if (endpoint && (type === 'file' || type === 'page')) take(endpoint, tag === 'img' ? 'image' : tag === 'a' ? 'link' : 'embed');
    },
  }, { decodeEntities: true, lowerCaseAttributeNames: true });
  parser.write(String(html || ''));
  parser.end();
  return { files: [...files.values()], pages: [...pages.values()], moduleItems: [...moduleItems.values()] };
}

// File ids linked from some HTML, for tools that report them (canvas_get_assignment etc.).
export function fileIdsIn(html, base = 'https://canvas.invalid') {
  return [...new Set(extractCanvasLinks(html, base).files.map((f) => f.fileId))];
}
