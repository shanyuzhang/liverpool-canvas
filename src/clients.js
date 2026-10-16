import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME } from './config.js';
import { CLI_PATH, release } from './release.js';

export const SERVER_NAME = 'liverpool-canvas';

// npm and claude are .cmd shims on Windows, which Node only starts through a shell; a shell
// takes one command line, so build it with every argument quoted.
const q = (a) => (process.platform === 'win32' ? `"${String(a).replace(/"/g, '""')}"` : `'${String(a).replace(/'/g, "'\\''")}'`);
const sh = (cmd, args, opts = {}) => spawnSync([cmd, ...args.map(q)].join(' '), { shell: true, stdio: 'ignore', ...opts });

// How AI apps start the server. npx runs from a temporary cache that can be cleaned at any time,
// so when started through npx we first install this exact version into the data folder and
// point the AI apps there. A copy installed any other way (git clone, npm install of the
// package tarball) is used where it is.
export const STABLE_PREFIX = path.join(HOME, 'app');
const stableCli = (name) => path.join(STABLE_PREFIX, 'node_modules', ...name.split('/'), 'bin', 'cli.js');
export const fromNpxCache = (p = CLI_PATH) => /[\\/]_npx[\\/]/.test(p);

export function ensureStableInstall({ log = () => {}, spec } = {}) {
  if (!fromNpxCache()) return { command: process.execPath, args: [path.resolve(CLI_PATH), 'mcp'] };
  const r = release();
  const want = spec || `${r.name}@${r.version}`;
  const cli = stableCli(r.name);
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8')).version; } catch { /* none yet */ }
  if (installed !== r.version || spec) {
    fs.mkdirSync(STABLE_PREFIX, { recursive: true });
    log(`Installing ${want} into ${STABLE_PREFIX} …`);
    const res = sh('npm', ['install', '--prefix', STABLE_PREFIX, '--no-audit', '--no-fund', '--omit=dev', '--save-exact', want], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (res.status !== 0) throw new Error('npm install failed');
  }
  return { command: process.execPath, args: [cli, 'mcp'] };
}

// The explicit update path: the AI apps keep pointing at the same local copy, which is replaced
// by the newest published version.
export function updateStableInstall({ log = () => {} } = {}) {
  const r = release();
  if (!r.published) throw new Error('This version has not been published to npm, so there is nothing to update from. Update your local copy with git pull instead.');
  fs.mkdirSync(STABLE_PREFIX, { recursive: true });
  log(`Updating ${r.name} in ${STABLE_PREFIX} …`);
  const res = sh('npm', ['install', '--prefix', STABLE_PREFIX, '--no-audit', '--no-fund', '--omit=dev', '--save-exact', `${r.name}@latest`], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (res.status !== 0) throw new Error('npm install failed');
  return JSON.parse(fs.readFileSync(path.join(path.dirname(stableCli(r.name)), '..', 'package.json'), 'utf8')).version;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
// A copy of a config file before it is changed, next to it: <file>.liverpool-canvas-<time>.bak
export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const to = `${file}.liverpool-canvas-${stamp()}.bak`;
  fs.copyFileSync(file, to);
  return to;
}

// Only our own entry is added or replaced; everything else in the file stays as it was.
export function mergeJson(file, key, launch) {
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    try { cfg = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${file} is not valid JSON; fix it first (nothing was changed).`); }
  }
  const saved = backup(file);
  cfg[key] = { ...(cfg[key] || {}), [SERVER_NAME]: { command: launch.command, args: launch.args } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return saved;
}

// TOML literal strings ('...') keep Windows backslashes as they are.
const tomlStr = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
export function codexBlock(launch) {
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlStr(launch.command)}\nargs = [${launch.args.map(tomlStr).join(', ')}]\n`;
}
export function upsertCodex(text, launch) {
  const block = codexBlock(launch);
  const re = new RegExp(`^\\[mcp_servers\\.(?:"${SERVER_NAME}"|${SERVER_NAME})\\][^\\n]*\\n(?:(?!\\[)[^\\n]*\\n?)*`, 'm');
  if (re.test(text)) return text.replace(re, block + '\n');
  return (text && !text.endsWith('\n') ? text + '\n' : text) + (text.trim() ? '\n' : '') + block;
}

const onPath = (cmd) => sh(cmd, ['--version']).status === 0;

// The AI apps this tool can configure: how to tell one is installed, how to add the server,
// and what the user has to do afterwards for the app to pick it up.
export function clients({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const claudeDesktopDir = platform === 'win32' ? path.join(appData, 'Claude')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
      : path.join(home, '.config', 'Claude');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  return [
    {
      id: 'claude-desktop', name: 'Claude Desktop',
      detect: () => fs.existsSync(claudeDesktopDir),
      file: path.join(claudeDesktopDir, 'claude_desktop_config.json'),
      install(l) { const backupFile = mergeJson(this.file, 'mcpServers', l); return { where: this.file, backup: backupFile }; },
      restart: { zh: '完全退出 Claude Desktop（菜单里选“退出”，不是只关窗口），再重新打开。', en: 'Quit Claude Desktop completely (Quit from the menu, not just closing the window), then open it again.' },
    },
    {
      id: 'claude-code', name: 'Claude Code',
      detect: () => onPath('claude'),
      file: path.join(home, '.claude.json'),
      install(l) {
        const backupFile = backup(this.file);
        sh('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
        const r = sh('claude', ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', l.command, ...l.args]);
        if (r.status !== 0) throw new Error('`claude mcp add` failed');
        return { where: 'claude mcp (user scope)', backup: backupFile };
      },
      restart: { zh: '新开一个 Claude Code 会话；在会话里输入 /mcp 可以看到 liverpool-canvas。', en: 'Start a new Claude Code session; /mcp shows liverpool-canvas.' },
    },
    {
      id: 'codex', name: 'Codex',
      detect: () => fs.existsSync(codexHome),
      file: path.join(codexHome, 'config.toml'),
      install(l) {
        const old = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
        const backupFile = backup(this.file);
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(this.file, upsertCodex(old, l));
        return { where: this.file, backup: backupFile };
      },
      restart: { zh: '关闭并重新打开 Codex（命令行或应用）。', en: 'Close and reopen Codex (CLI or app).' },
    },
    {
      id: 'cursor', name: 'Cursor',
      detect: () => fs.existsSync(path.join(home, '.cursor')),
      file: path.join(home, '.cursor', 'mcp.json'),
      install(l) { const backupFile = mergeJson(this.file, 'mcpServers', l); return { where: this.file, backup: backupFile }; },
      restart: { zh: '重启 Cursor，或在设置的 MCP 页面里刷新。', en: 'Restart Cursor, or refresh it on the MCP settings page.' },
    },
    {
      id: 'windsurf', name: 'Windsurf',
      detect: () => fs.existsSync(path.join(home, '.codeium', 'windsurf')),
      file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      install(l) { const backupFile = mergeJson(this.file, 'mcpServers', l); return { where: this.file, backup: backupFile }; },
      restart: { zh: '重启 Windsurf。', en: 'Restart Windsurf.' },
    },
  ];
}

// For apps not listed above: the entry to paste by hand.
export function manualConfig(launch) {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: launch.command, args: launch.args } } }, null, 2);
}
