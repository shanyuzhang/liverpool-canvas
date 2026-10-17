// Packs the real npm tarball, installs it into an empty temporary folder (no source checkout
// involved) and checks that the installed program works: help, status, the MCP server over
// stdio, and the local page. Also fails if the tarball contains anything private or stray.
//   node scripts/pack-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (args, opts = {}) => {
  const r = spawnSync(npm, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
};
const ok = (m) => console.log(`✓ ${m}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pack-'));
const [info] = JSON.parse(sh(['pack', '--json', '--pack-destination', work]));
const files = info.files.map((f) => f.path);
ok(`packed ${info.filename} (${files.length} files, ${(info.size / 1024).toFixed(0)} kB)`);

const allowed = /^(bin\/cli\.js|src\/.+\.js|web\/(index\.html|app\.js|i18n\.js|style\.css|icon\.svg)|release\.json|package\.json|README\.md|PRIVACY\.md|LICENSE)$/;
const stray = files.filter((f) => !allowed.test(f));
if (stray.length) throw new Error(`unexpected files in the tarball:\n${stray.join('\n')}`);
for (const need of ['bin/cli.js', 'src/server.js', 'src/web/server.js', 'web/index.html', 'web/app.js', 'release.json', 'LICENSE']) if (!files.includes(need)) throw new Error(`missing ${need}`);
const tarText = files.filter((f) => /\.(js|json|md|html)$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
for (const bad of [os.homedir(), 'session.json"', 'canvas_session=', '/Users/kyle']) if (bad && tarText.includes(bad)) throw new Error(`tarball contains "${bad}"`);
ok('tarball holds only the program, the local page and docs; no personal paths or sessions');

const app = path.join(work, 'install');
fs.mkdirSync(app);
sh(['install', '--prefix', app, '--no-audit', '--no-fund', '--omit=dev', path.join(work, info.filename)], { cwd: app });
const pkgName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
const cli = path.join(app, 'node_modules', ...pkgName.split('/'), 'bin', 'cli.js');
if (!fs.existsSync(cli)) throw new Error('installed CLI not found');
const bin = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'liverpool-canvas.cmd' : 'liverpool-canvas');
if (!fs.existsSync(bin)) throw new Error('bin link "liverpool-canvas" missing');
ok(`installed into ${app}`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pack-home-'));
const env = { ...process.env, LIVERPOOL_CANVAS_HOME: home };
delete env.LIVERPOOL_CANVAS_TEST_ORIGIN;
const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
const help = run(['--help']);
if (help.status !== 0 || !help.stdout.includes('liverpool-canvas')) throw new Error('--help failed');
const status = JSON.parse(run(['status', '--json']).stdout);
if (status.canvas !== 'https://canvas.liverpool.ac.uk' || status.signedIn !== false) throw new Error(`status: ${JSON.stringify(status)}`);
ok('installed CLI runs from outside the source folder (help, status --json)');

const client = new Client({ name: 'pack-check', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env, cwd: os.tmpdir(), stderr: 'pipe' }));
const { tools } = await client.listTools();
const r = await client.callTool({ name: 'canvas_whoami', arguments: {} });
await client.close();
if (tools.length < 21 || !r.isError || !/login/.test(r.content[0].text)) throw new Error('MCP check failed');
ok(`installed MCP server lists ${tools.length} tools and reports "not signed in" with a working hint`);

const web = spawn(process.execPath, [cli, 'web', '--no-open', '--json'], { cwd: os.tmpdir(), env });
const url = await new Promise((resolve, reject) => {
  let out = '';
  web.stdout.on('data', (d) => { out += d; try { resolve(JSON.parse(out).url); } catch { /* more */ } });
  web.on('exit', () => reject(new Error('web exited')));
  setTimeout(() => reject(new Error('web did not start')), 10000);
});
const get = (u, headers = {}) => new Promise((resolve, reject) => http.get(u, { headers }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject));
const first = await get(url);
const cookie = first.headers['set-cookie']?.[0]?.split(';')[0];
const page = await get(new URL('/', url).href, { Cookie: cookie });
const js = await get(new URL('/app.js', url).href, { Cookie: cookie });
web.kill('SIGTERM');
if (first.status !== 303 || page.status !== 200 || !page.body.includes('Liverpool Canvas') || js.status !== 200) throw new Error('local page check failed');
ok('installed local page starts on 127.0.0.1 and serves its files');
console.log(`\nAll pack checks passed. Tarball: ${path.join(work, info.filename)}`);
