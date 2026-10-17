// Builds the public website (GitHub Pages) into site/ from docs/. The commands, package name,
// repository and version on the page all come from release.json + package.json, so the page
// never shows an npm command as usable before the package is really published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from '../src/release.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site');
const r = release();
const data = { npmPackage: r.npmPackage, published: r.published, version: r.version, repository: r.repository, pagesUrl: r.pagesUrl };
let html = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
const marker = /<script id="release" type="application\/json">[\s\S]*?<\/script>/;
if (!marker.test(html)) throw new Error('docs/index.html lost its release marker');
html = html.replace(marker, `<script id="release" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of fs.readdirSync(path.join(root, 'docs', 'assets'))) fs.copyFileSync(path.join(root, 'docs', 'assets', f), path.join(out, 'assets', f));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Built ${path.relative(root, out)}/ (${data.published ? `published ${data.npmPackage}@${data.version}` : 'not published: npm commands are labelled "available once published"'})`);
