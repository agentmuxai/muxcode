import { program, Command } from 'commander';
import { createBackend } from './backends/index.js';
import { initMcpServers, closeMcpServers, getActiveServerIds } from './mcp/client.js';
import { StreamJsonEmitter } from './emit/stream-json.js';
import { runLoop } from './loop.js';
import { getCatalog, findModel } from './models/catalog.js';
import { downloadModel } from './models/download.js';
import { listInstalled } from './models/list.js';
import { removeModel } from './models/download.js';
import { stopServer } from './llama-server/manager.js';
import { muxHome } from './llama-server/acquire.js';
import path from 'path';

export function buildCli(): Command {
  program
    .name('muxcode')
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
    .option('--resume <session-id>', 'Resume a previous session by ID')
    .action(async (opts) => {
      const prompt = opts.prompt ?? await readStdin();
      if (!prompt.trim()) {
        process.stderr.write('Error: no prompt provided (use -p or pipe via stdin)\n');
        process.exit(1);
      }

      const emitter = new StreamJsonEmitter(opts.resume);

      try {
        let tools;
        let backend;
        let initEmitted = false;
        try {
          tools = await initMcpServers(opts.mcpConfig);
          emitter.init(opts.model ?? 'auto', getActiveServerIds(), tools.map(t => t.name));
          initEmitted = true;
          backend = createBackend({
            backend: opts.backend,
            model: opts.model,
            baseUrl: opts.baseUrl,
            onProgress: (pct, label) => emitter.loading(`${label} (${pct}%)`),
          });
        } catch (err) {
          // Ensure init always precedes the error event
          if (!initEmitted) emitter.init(opts.model ?? 'auto', [], []);
          emitter.error((err as Error).message);
          process.exitCode = 1;
          return;
        }

        try {
          await runLoop(prompt, backend, tools, emitter, opts.system);
        } catch {
          // runLoop already emitted the error event with accumulated token counts
          process.exitCode = 1;
        }
      } finally {
        await closeMcpServers();
        await stopServer();
      }
    });

  // ── auth subcommand ─────────────────────────────────────────────────────────
  const authCmd = program
    .command('auth')
    .description('Authentication and backend configuration');

  authCmd
    .command('status')
    .description('Exit 0 if any backend is ready (API key or local model), else exit 1')
    .action(() => {
      if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
        process.exit(0);
      }
      const installed = listInstalled();
      process.exit(installed.length > 0 ? 0 : 1);
    });

  authCmd
    .command('login')
    .description('Set up authentication: download a local model or configure an API key')
    .action(async () => {
      if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
        console.log('Cloud backend ready (API key found in environment).');
        return;
      }
      const installed = listInstalled();
      if (installed.length > 0) {
        console.log(`Local model ready: ${installed[0].name}`);
        return;
      }

      const defaultModelId = 'qwen2.5-coder:7b';
      console.log('No backend configured. To use a cloud backend, set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
      console.log(`Downloading default local model (${defaultModelId})...`);
      try {
        const catalog = await getCatalog();
        const model = findModel(defaultModelId, catalog);
        if (!model) {
          console.error(`Default model "${defaultModelId}" not found. Run: muxcode model list`);
          process.exit(1);
        }
        let lastPct = -1;
        await downloadModel(model, ({ pct }) => {
          const rounded = Math.floor(pct / 5) * 5;
          if (rounded !== lastPct) {
            process.stdout.write(`\r  Downloading... ${rounded}%`);
            lastPct = rounded;
          }
        });
        process.stdout.write('\n');
        console.log(`Model ready. Run: muxcode run -p "your prompt"`);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
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
    .option('--available', 'Show only catalog models that are not installed')
    .action(async (opts) => {
      const installed = listInstalled();

      if (opts.installed) {
        if (installed.length === 0) {
          console.log('No models installed. Run: muxcode model pull <id>');
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

      if (opts.available) {
        const notInstalled = catalog.filter(m => !installedNames.has(m.id));
        if (notInstalled.length === 0) {
          console.log('All catalog models are already installed.');
          return;
        }
        console.log('Available (not installed) models:');
        for (const m of notInstalled) {
          console.log(`  ${m.id.padEnd(30)} ${m.sizeGb}GB  ${m.description}`);
        }
        return;
      }

      if (installed.length === 0) {
        console.log('No models installed. Run: muxcode model pull <id>');
        return;
      }

      console.log('Available models:');
      for (const m of catalog) {
        const status = installedNames.has(m.id) ? '✓' : ' ';
        console.log(`  [${status}] ${m.id.padEnd(30)} ${m.sizeGb}GB  ${m.description}`);
      }
    });

  modelCmd
    .command('pull <id>')
    .description('Download a model from the catalog')
    .option('--json-progress', 'Emit NDJSON progress events instead of a human-readable bar')
    .action(async (id, opts) => {
      const catalog = await getCatalog();
      const model = findModel(id, catalog);
      if (!model) {
        console.error(`Model "${id}" not found. Run: muxcode model list`);
        process.exit(1);
      }

      if (!opts.jsonProgress) {
        console.log(`Downloading ${model.name} (${model.sizeGb} GB)...`);
      }

      let lastPct = -1;

      const dest = await downloadModel(model, ({ bytesDownloaded, totalBytes, pct }) => {
        if (opts.jsonProgress) {
          process.stdout.write(JSON.stringify({
            type: 'progress',
            id: model.id,
            bytesDownloaded,
            totalBytes,
            pct: Math.floor(pct),
          }) + '\n');
        } else {
          const rounded = Math.floor(pct / 5) * 5;
          if (rounded !== lastPct) {
            process.stdout.write(`\r  ${rounded}%`);
            lastPct = rounded;
          }
        }
      });

      if (!opts.jsonProgress) {
        process.stdout.write('\n');
        console.log(`Saved to ${dest}`);
      } else {
        process.stdout.write(JSON.stringify({ type: 'done', id: model.id, path: dest }) + '\n');
      }
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

  modelCmd
    .command('du')
    .description('Show total disk usage of installed models')
    .action(() => {
      const installed = listInstalled();
      const totalBytes = installed.reduce((sum, m) => sum + m.sizeBytes, 0);
      const totalGb = (totalBytes / 1e9).toFixed(1);
      const modelsDir = path.join(muxHome(), 'models');
      console.log(`Models: ${totalGb} GB  (${installed.length} model${installed.length !== 1 ? 's' : ''} in ${modelsDir})`);
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
