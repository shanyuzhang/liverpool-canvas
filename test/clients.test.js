import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsertCodex, clients, mergeJson } from '../src/clients.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
const launch = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\me\\.liverpool-canvas\\app\\cli.js', 'mcp'] };

test('codex: adds our block, replaces only it later, leaves other servers alone (including upstream "canvas")', () => {
  const first = upsertCodex('model = "o4"\n\n[mcp_servers.canvas]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "x"\n', launch);
  assert.match(first, /\[mcp_servers\.canvas\]\ncommand = "old"/);
  assert.match(first, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(first, /\[mcp_servers\.liverpool-canvas\]\ncommand = 'C:\\Program Files\\nodejs\\node\.exe'\nargs = \['C:\\Users\\me\\\.liverpool-canvas\\app\\cli\.js', 'mcp'\]/);
  const second = upsertCodex(first, { command: 'node', args: ['b.js', 'mcp'] });
  assert.equal(second.match(/\[mcp_servers\.liverpool-canvas\]/g).length, 1);
  assert.match(second, /args = \['b\.js', 'mcp'\]/);
  assert.match(second, /\[mcp_servers\.other\]/);
});

test('JSON configs: only our entry changes, others are kept, a timestamped backup is made, broken JSON is not touched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cl-'));
  fs.mkdirSync(path.join(home, '.cursor'));
  const f = path.join(home, '.cursor', 'mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { github: { command: 'gh' }, canvas: { command: 'x' } }, other: 1 }));
  const cursor = clients({ home, env: {}, platform: 'linux' }).find((c) => c.id === 'cursor');
  assert.equal(cursor.detect(), true);
  const r = cursor.install(launch);
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['github', 'canvas', 'liverpool-canvas']);
  assert.equal(cfg.other, 1);
  assert.deepEqual(cfg.mcpServers['liverpool-canvas'].args, launch.args);
  assert.match(r.backup, /mcp\.json\.liverpool-canvas-\d{8}-\d{6}\.bak$/);
  assert.equal(JSON.parse(fs.readFileSync(r.backup, 'utf8')).mcpServers['liverpool-canvas'], undefined);
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => mergeJson(f, 'mcpServers', launch), /not valid JSON/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ broken');
  assert.equal(clients({ home, env: {}, platform: 'linux' }).find((c) => c.id === 'windsurf').detect(), false);
});

function setupEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-setup-'));
  const appData = path.join(home, 'AppData', 'Roaming');
  for (const d of [path.join(appData, 'Claude'), path.join(home, '.codex'), path.join(home, 'Library', 'Application Support', 'Claude'), path.join(home, '.config', 'Claude'), path.join(home, '.cursor')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LIVERPOOL_CANVAS_HOME: path.join(home, '.liverpool-canvas'), PATH: process.env.PATH };
  delete env.CODEX_HOME;
  return { home, appData, env };
}

test('setup: saves the folder and connects only the app the user chose', () => {
  const { home, appData, env } = setupEnv();
  const downloads = path.join(home, 'My Canvas Files');
  const r = spawnSync(process.execPath, [cli, 'setup', '--no-login', '--folder', downloads, '--client', 'codex'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.liverpool-canvas', 'config.json'), 'utf8'));
  assert.equal(cfg.downloadDir, downloads);
  assert.ok(cfg.downloadDirConfirmedAt);
  assert.ok(fs.existsSync(downloads));
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.liverpool-canvas\]\ncommand = .*\nargs = \[.*cli\.js', 'mcp'\]/);
  const desktopDir = process.platform === 'win32' ? path.join(appData, 'Claude') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(home, '.config', 'Claude');
  assert.ok(!fs.existsSync(path.join(desktopDir, 'claude_desktop_config.json')), 'Claude Desktop was not chosen, so it is untouched');
  assert.ok(!fs.existsSync(path.join(home, '.cursor', 'mcp.json')));
  assert.match(r.stdout, /Close and reopen Codex/);
});

test('setup --yes never connects AI apps on its own', () => {
  const { home, env } = setupEnv();
  const r = spawnSync(process.execPath, [cli, 'setup', '--yes', '--no-login', '--folder', path.join(home, 'C')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')));
  assert.match(r.stdout, /Connect an AI app any time/);
});

test('connect without a choice in a script asks for --client instead of guessing', () => {
  const { env } = setupEnv();
  const r = spawnSync(process.execPath, [cli, 'connect'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /--client/);
});
