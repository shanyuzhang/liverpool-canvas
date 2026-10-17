// Sets the real npm scope, repository and website in one go, so package.json, release.json, the
// website and every printed command agree. Run it once the names exist:
//   node scripts/configure-release.mjs --scope my-scope --repo owner/liverpool-canvas [--pages https://owner.github.io/liverpool-canvas/]
//   node scripts/configure-release.mjs --published     (only after `npm publish` succeeded)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { scope: { type: 'string' }, repo: { type: 'string' }, pages: { type: 'string' }, published: { type: 'boolean' }, unpublished: { type: 'boolean' } } });
const pkgFile = path.join(root, 'package.json');
const relFile = path.join(root, 'release.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const rel = JSON.parse(fs.readFileSync(relFile, 'utf8'));

if (values.scope) {
  const scope = values.scope.replace(/^@/, '');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope)) throw new Error('npm scopes are lowercase letters, digits, ".", "_" or "-"');
  pkg.name = rel.npmPackage = `@${scope}/liverpool-canvas`;
  pkg.publishConfig = { access: 'public' };
}
if (values.repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('--repo is owner/name');
  rel.repository = `https://github.com/${values.repo}`;
  pkg.repository = { type: 'git', url: `git+https://github.com/${values.repo}.git` };
  pkg.bugs = { url: `https://github.com/${values.repo}/issues` };
}
if (values.pages) { rel.pagesUrl = values.pages; pkg.homepage = values.pages; }
if (values.published) {
  if (/your-npm-scope/.test(pkg.name)) throw new Error('Set the real scope first (--scope).');
  rel.published = true;
}
if (values.unpublished) rel.published = false;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(relFile, JSON.stringify(rel, null, 2) + '\n');
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, ...rel }, null, 2));
