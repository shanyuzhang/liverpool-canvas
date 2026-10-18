import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { App } from './app.js';
import { Jobs } from './jobs.js';
import { registerTools } from './tools.js';
import { release } from './release.js';

export { sessionProvider } from './app.js';

// MCP over stdio. stdout carries only protocol messages; anything for people goes to stderr.
export async function startServer() {
  const server = new McpServer({ name: 'liverpool-canvas', version: release().version });
  let app = null;
  registerTools(server, async () => {
    if (!app) { app = new App(); app.jobs = new Jobs(app); app.mcp = server.server; }
    return app;
  });
  await server.connect(new StdioServerTransport());
}
