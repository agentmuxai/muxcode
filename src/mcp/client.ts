import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import type { McpTool, ToolCall } from '../types.js';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface ActiveServer {
  id: string;
  client: Client;
  tools: McpTool[];
}

let activeServers: ActiveServer[] = [];

export async function initMcpServers(configPath?: string): Promise<McpTool[]> {
  const config = loadMcpConfig(configPath);
  if (!config || Object.keys(config.mcpServers).length === 0) return [];

  activeServers = [];
  const allTools: McpTool[] = [];

  for (const [id, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        env: { ...process.env, ...serverConfig.env } as Record<string, string>,
      });

      const client = new Client(
        { name: 'mux-code', version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(transport);
      const { tools } = await client.listTools();

      const serverTools: McpTool[] = tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as McpTool['inputSchema'],
        _serverId: id,
      }));

      activeServers.push({ id, client, tools: serverTools });
      allTools.push(...serverTools);

      process.stderr.write(`[mcp] Connected to ${id} (${serverTools.length} tools)\n`);
    } catch (err) {
      process.stderr.write(`[mcp] Failed to connect to ${id}: ${(err as Error).message}\n`);
    }
  }

  return allTools;
}

export async function executeTool(call: ToolCall, tools: McpTool[]): Promise<string> {
  const tool = tools.find(t => t.name === call.name);
  if (!tool) return JSON.stringify({ error: `Tool "${call.name}" not found` });

  const server = activeServers.find(s => s.id === tool._serverId);
  if (!server) return JSON.stringify({ error: `Server for tool "${call.name}" not connected` });

  try {
    const result = await server.client.callTool({
      name: call.name,
      arguments: call.input,
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    return content
      .map(c => c.text ?? JSON.stringify(c))
      .join('\n');
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

export async function closeMcpServers(): Promise<void> {
  for (const server of activeServers) {
    try { await server.client.close(); } catch { /* ignore */ }
  }
  activeServers = [];
}

function loadMcpConfig(configPath?: string): McpConfig | null {
  const candidates = [
    configPath,
    process.env.MUX_MCP_CONFIG,
    path.join(process.cwd(), '.mcp.json'),
    path.join(os.homedir(), '.mcp.json'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as McpConfig;
      } catch {
        process.stderr.write(`[mcp] Failed to parse config at ${p}\n`);
      }
    }
  }

  return null;
}
