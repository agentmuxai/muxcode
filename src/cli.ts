import { program, Command } from 'commander';
import { createBackend } from './backends/index.js';
import { initMcpServers, closeMcpServers } from './mcp/client.js';
import { StreamJsonEmitter } from './emit/stream-json.js';
import { runLoop } from './loop.js';
import { getCatalog, findModel } from './models/catalog.js';
import { downloadModel } from './models/download.js';
import { listInstalled } from './models/list.js';
import { removeModel } from './models/download.js';
import { stopServer } from './llama-server/manager.js';
import path from 'path';
import { unlinkSync } from 'fs';

export function buildCli(): Command {
  program
    .name('mux-code')
    .description('Agentic coding assistant with local and cloud backends')
    .version('0.1.0');

  // ── main run command ────────────────────────────────────────────────────────
  program
    .command('run', { isDefault: true })
    .description('Run an agentic coding task')
    .option('-p, --prompt <text>', 'Prompt to execute')
    .option('-b, --backend <name>', 'Backend: local | anthropic | openai | openai-compat')
    .option('-m, --model <name>', 'Model name or path')
    .option('--base-url <url>', 'Base URL for openai-compat backend')
    .option('--mcp-config <path>', 'Path to .mcp.json config')
    .option('--system <text>', 'Override system prompt')
    .action(async (opts) => {
      const prompt = opts.prompt ?? await readStdin();
      if (!prompt.trim()) {
        process.stderr.write('Error: no prompt provided (use -p or pipe via stdin)\n');
        process.exit(1);
      }

      const emitter = new StreamJsonEmitter();

      try {
        const tools = await initMcpServers(opts.mcpConfig);
        const backend = createBackend({
          backend: opts.backend,
          model: opts.model,
          baseUrl: opts.baseUrl,
          onProgress: (pct, label) => emitter.loading(`${label} (${pct}%)`),
        });

        emitter.init(opts.model ?? 'auto', []);
        await runLoop(prompt, backend, tools, emitter, opts.system);
      } catch (err) {
        emitter.error((err as Error).message);
        process.exitCode = 1;
      } finally {
        await closeMcpServers();
        await stopServer();
      }
    });

  // ── model subcommands ───────────────────────────────────────────────────────
  const modelCmd = program
    .command('model')
    .description('Manage local models');

  modelCmd
    .command('list')
    .description('List available and installed models')
    .option('--installed', 'Show only installed models')
    .action(async (opts) => {
      const installed = listInstalled();
      if (opts.installed || installed.length === 0) {
        if (installed.length === 0) {
          console.log('No models installed. Run: mux-code model pull <id>');
          return;
        }
        console.log('Installed models:');
        for (const m of installed) {
          const gb = (m.sizeBytes / 1e9).toFixed(1);
          console.log(`  ${m.name.padEnd(30)} ${gb} GB  ${m.path}`);
        }
        return;
      }

      const catalog = await getCatalog();
      const installedNames = new Set(installed.map(m => m.name));

      console.log('Available models:');
      for (const m of catalog) {
        const status = installedNames.has(m.id) ? '✓' : ' ';
        console.log(`  [${status}] ${m.id.padEnd(30)} ${m.sizeGb}GB  ${m.description}`);
      }
    });

  modelCmd
    .command('pull <id>')
    .description('Download a model from the catalog')
    .action(async (id) => {
      const catalog = await getCatalog();
      const model = findModel(id, catalog);
      if (!model) {
        console.error(`Model "${id}" not found. Run: mux-code model list`);
        process.exit(1);
      }

      console.log(`Downloading ${model.name} (${model.sizeGb} GB)...`);
      let lastPct = -1;

      const dest = await downloadModel(model, ({ pct }) => {
        const rounded = Math.floor(pct / 5) * 5;
        if (rounded !== lastPct) {
          process.stdout.write(`\r  ${rounded}%`);
          lastPct = rounded;
        }
      });

      process.stdout.write('\n');
      console.log(`Saved to ${dest}`);
    });

  modelCmd
    .command('rm <name>')
    .description('Remove an installed model')
    .action((name) => {
      const installed = listInstalled();
      const model = installed.find(m => m.name === name || path.basename(m.path) === name);
      if (!model) {
        console.error(`Model "${name}" not installed.`);
        process.exit(1);
      }
      removeModel(model.path);
      console.log(`Removed ${model.path}`);
    });

  return program;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
