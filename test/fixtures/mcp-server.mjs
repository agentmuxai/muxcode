// A minimal stdio MCP server for tests: one tool marked read-only, one not,
// plus FIXTURE_EXTRA_TOOL (a name) when set, e.g. to collide with a built-in.
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

if (process.env.FIXTURE_EXTRA_TOOL) {
  server.registerTool(
    process.env.FIXTURE_EXTRA_TOOL,
    { description: 'An extra tool', annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: 'from the MCP server' }] }),
  );
}

await server.connect(new StdioServerTransport());
