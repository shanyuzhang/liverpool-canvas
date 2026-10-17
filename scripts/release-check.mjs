// Pre-publish gate: refuses while names are placeholders or inconsistent, the work tree is dirty,
// or tests / the tarball install check fail. Publishing itself is a separate, manual step.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rel = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
const problems = [];
if (/your-npm-scope/i.test(pkg.name)) problems.push('package name is still the @your-npm-scope placeholder (run scripts/configure-release.mjs --scope …)');
if (rel.npmPackage !== pkg.name) problems.push(`release.json npmPackage (${rel.npmPackage}) differs from package.json name (${pkg.name})`);
if (!rel.repository) problems.push('release.json has no repository (configure-release --repo owner/name)');
if (pkg.publishConfig?.access !== 'public') problems.push('scoped packages need publishConfig.access = "public"');
const git = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
if (git.status === 0 && git.stdout.trim()) problems.push('uncommitted changes in the work tree');
if (problems.length) { console.error(`Not ready to publish:\n- ${problems.join('\n- ')}`); process.exit(1); }
for (const [cmd, args] of [[process.execPath, ['--test']], [process.execPath, ['scripts/pack-check.mjs']]]) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`\nReady: ${pkg.name}@${pkg.version}. Publish with: npm publish (then: node scripts/configure-release.mjs --published, commit, rebuild the site).`);
