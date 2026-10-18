import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, readConfig, writeConfig, downloadRoot, defaultDownloadRoot, HOME } from './config.js';
import { renewSession, savedSession } from './browser.js';
import { CanvasClient } from './canvas.js';
import { DownloadIndex } from './store.js';

// What the command line, the MCP server and the local page share: one Canvas client, the
// signed-in user, and the download index for the chosen folder.

// The browser is only started to get (or refresh) the session cookie; API calls then go
// straight from Node. One refresh at a time even if several requests need it at once.
// Saved cookies are tried first (no browser at all); the browser only opens when Canvas rejects them.
const renewWithConfig = (base) => renewSession(base, {
  loginPath: readConfig().loginPath,
  onLoginPath: (p) => writeConfig({ loginPath: p }),
  hiddenWorks: readConfig().hiddenRenewWorks,
  onHiddenResult: (ok) => writeConfig({ hiddenRenewWorks: ok }),
  log: (m) => process.stderr.write(m + '\n'),
});

export function sessionProvider(base, open = renewWithConfig, saved = savedSession) {
  let pending = null;
  let cached = null;
  return async ({ fresh = false } = {}) => {
    if (!cached && !fresh) cached = saved(base);
    if (cached && !fresh) return cached;
    if (!pending) pending = open(base).then((s) => { cached = s; return s; }).finally(() => { pending = null; });
    return pending;
  };
}

export function looksLikeProject(dir) {
  const d = path.resolve(dir);
  const inside = (parent) => { const rel = path.relative(path.resolve(parent), d); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  return d !== path.parse(d).root && d !== path.resolve(os.homedir()) && !inside(HOME) && !/[\\/](_npx|node_modules)([\\/]|$)/.test(d);
}

export class App {
  constructor({ client, base = baseUrl(), session } = {}) {
    this.base = base;
    this.client = client || new CanvasClient({ base, session: session || sessionProvider(base) });
    this.me = null;
  }

  async user({ refresh = false } = {}) {
    if (!this.me || refresh) {
      const me = await this.client.get('users/self');
      if (this.me && String(this.me.id) !== String(me.id)) this.client.courseInfo.clear();
      this.me = me;
      writeConfig({ user: { id: me.id, name: me.name } });
    }
    return this.me;
  }

  root() { return downloadRoot(); }

  // The folder the user is working in inside their AI app: the workspace the app reports
  // (MCP "roots"), else the folder the app started this server in when that looks like a
  // project folder (not the disk root, the home folder, or an install/cache folder).
  async workspace() {
    try {
      if (this.mcp?.getClientCapabilities?.()?.roots) {
        const r = await Promise.race([this.mcp.listRoots(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]);
        const uri = (r.roots || []).find((x) => String(x.uri).startsWith('file://'))?.uri;
        if (uri) return fileURLToPath(uri);
      }
    } catch { /* the app does not report a workspace */ }
    return looksLikeProject(process.cwd()) ? process.cwd() : null;
  }
  rootOrDefault() { return downloadRoot() || defaultDownloadRoot(); }

  async index(root = this.rootOrDefault()) {
    const me = await this.user();
    return new DownloadIndex({ origin: this.base, userId: me.id, root });
  }
}
