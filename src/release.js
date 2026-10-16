import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(ROOT, 'bin', 'cli.js');

// release.json is the single place that says what has really been published: the npm package
// name, the repository and the website. Commands shown to people are generated from it.
export function release() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
  return {
    name: pkg.name,
    version: pkg.version,
    npmPackage: r.npmPackage,
    published: r.published === true && r.npmPackage === pkg.name && !/your-npm-scope/.test(pkg.name),
    repository: r.repository || null,
    pagesUrl: r.pagesUrl || null,
  };
}

const quote = (s) => (/[\s"'$`\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s);

// The command to tell someone to run, e.g. in an error message. Before the package is on npm
// it is this very copy of the program, so the hint always works when pasted.
export function cliHint(sub = '') {
  const r = release();
  const head = r.published ? `npx -y ${r.npmPackage}@latest` : `node ${quote(CLI_PATH)}`;
  return sub ? `${head} ${sub}` : head;
}
