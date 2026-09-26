// A minimal stdio MCP server for tests: one tool marked read-only, one not.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.registerTool(
  'read_thing',
  { description: 'Reads a thing', annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: 'the thing' }] }),
);
server.registerTool(
  'write_thing',
  { description: 'Writes a thing', annotations: { readOnlyHint: false } },
  async () => ({ content: [{ type: 'text', text: 'written' }] }),
);

await server.connect(new StdioServerTransport());
