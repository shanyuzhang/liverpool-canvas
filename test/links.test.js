import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCanvasLinks, classifyCanvasUrl, fileIdsIn } from '../src/links.js';

const base = 'https://canvas.liverpool.ac.uk';
const ids = (html) => extractCanvasLinks(html, base).files.map((f) => `${f.courseId || '-'}:${f.fileId}:${f.kind}`).sort();

test('file URL forms: course files, /files, download, preview, query strings, HTML escapes', () => {
  assert.deepEqual(ids(`
    <a href="/courses/1/files/11?wrap=1">a</a>
    <a href="/courses/1/files/12/download?download_frd=1&amp;verifier=x">b</a>
    <a href="https://canvas.liverpool.ac.uk/files/13/download">c</a>
    <a href="/courses/1/files?preview=14">d</a>
    <a href="/courses/1/files/folder/Week%201?preview=15">e</a>
    <a href="/api/v1/courses/1/files/16">f</a>
    <a href="https://liverpool.instructure.com/courses/1/files/17">alias</a>
  `), ['-:13:link', '1:11:link', '1:12:link', '1:14:link', '1:15:link', '1:16:link', '1:17:link']);
});

test('only Canvas links count: other sites, numbers in text and look-alike paths are ignored', () => {
  assert.deepEqual(ids(`
    <p>Room 1002, see files/99 on the wiki</p>
    <a href="https://evil.example/courses/1/files/21">x</a>
    <a href="https://canvas.liverpool.ac.uk.evil.example/files/22">y</a>
    <a href="/courses/1/files/23/edit">edit page, not a file</a>
    <a href="javascript:alert(1)">js</a>
    <a href="https://www.youtube.com/watch?v=24">video</a>
  `), []);
});

test('Canvas editor attributes, images and embeds are classified', () => {
  assert.deepEqual(ids(`
    <a class="instructure_file_link" href="#" data-api-endpoint="https://canvas.liverpool.ac.uk/api/v1/courses/1/files/31" data-api-returntype="File">x</a>
    <img src="/courses/1/files/32/preview" alt="">
    <iframe src="/courses/1/files/33/download"></iframe>
    <img src="/courses/1/files/34/preview"><a href="/courses/1/files/34">same file, linked</a>
  `), ['1:31:link', '1:32:image', '1:33:embed', '1:34:link']);
});

test('page links, front page and module item links', () => {
  const r = extractCanvasLinks('<a href="/courses/1/pages/week-2%20notes">p</a><a href="/courses/1/wiki/intro">w</a><a href="/courses/1/modules/items/77">m</a><a href="/courses/1">home</a>', base);
  assert.deepEqual(r.pages.map((p) => p.slug), ['week-2 notes', 'intro', 'front_page']);
  assert.deepEqual(r.moduleItems, [{ courseId: '1', itemId: '77' }]);
  assert.equal(classifyCanvasUrl('/courses/1/pages/x/edit', base), null);
});

test('fileIdsIn reports each id once', () => {
  assert.deepEqual(fileIdsIn('<a href="/courses/1/files/12?wrap=1">x</a><a href="/files/12/download">y</a>', base), ['12']);
});
