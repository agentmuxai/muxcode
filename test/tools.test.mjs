// The built-in tools (src/tools), called directly from dist/ and through the
// CLI with a fake model that calls a tool and then answers.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { executeBuiltinTool, newToolContext } from '../dist/tools/index.js';
import { grepJs, grepJsGuarded } from '../dist/tools/grep.js';
import { FIXTURE_MCP_CONFIG, runMuxcode, startFakeModel } from './helpers.mjs';

let dir;
let ctx;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-tools-'));
  ctx = newToolContext(dir);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (name, input) => executeBuiltinTool({ id: 't', name, input }, ctx);
const file = (name, content) => {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};

describe('Read', () => {
  test('numbers lines like cat -n, honours offset and limit', async () => {
    file('lines.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const all = await run('Read', { file_path: 'lines.txt' });
    assert.equal(all.isError, false);
    assert.equal(all.content.split('\n')[0], '     1\tline 1');
    assert.equal(all.content.split('\n').length, 10);

    const part = await run('Read', { file_path: path.join(dir, 'lines.txt'), offset: 4, limit: 2 });
    assert.match(part.content, /^ {5}4\tline 4\n {5}5\tline 5\n/);
    assert.doesNotMatch(part.content, /line 6/);
    assert.match(part.content, /Showing lines 4-5 of 10/);
  });

  test('accepts numbers sent as strings, and strips CR and a BOM', async () => {
    file('crlf.txt', '\uFEFFa\r\nb\r\n');
    const r = await run('Read', { file_path: 'crlf.txt', offset: '2' });
    assert.match(r.content, /^ {5}2\tb$/m);
    assert.doesNotMatch(r.content, /\r/);
  });

  test('truncates very long lines', async () => {
    file('long.txt', 'x'.repeat(5000));
    const r = await run('Read', { file_path: 'long.txt' });
    assert.ok(r.content.length < 2100);
    assert.match(r.content, /line truncated/);
  });

  test('a missing file, a directory and a binary file are errors', async () => {
    const missing = await run('Read', { file_path: 'nope.txt' });
    assert.equal(missing.isError, true);
    assert.match(missing.content, /does not exist/);

    const directory = await run('Read', { file_path: '.' });
    assert.equal(directory.isError, true);
    assert.match(directory.content, /is a directory/);

    file('bin.dat', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const binary = await run('Read', { file_path: 'bin.dat' });
    assert.equal(binary.isError, true);
    assert.match(binary.content, /binary/);
  });

  test('a missing file_path is an error', async () => {
    const r = await run('Read', {});
    assert.equal(r.isError, true);
    assert.match(r.content, /file_path/);
  });
});

describe('Write', () => {
  test('creates parent directories, then overwrites', async () => {
    const created = await run('Write', { file_path: 'new/deep/file.txt', content: 'one' });
    assert.equal(created.isError, false);
    assert.match(created.content, /created/);
    assert.equal(readFileSync(path.join(dir, 'new', 'deep', 'file.txt'), 'utf8'), 'one');

    const over = await run('Write', { file_path: 'new/deep/file.txt', content: 'two' });
    assert.match(over.content, /overwritten/);
    assert.equal(readFileSync(path.join(dir, 'new', 'deep', 'file.txt'), 'utf8'), 'two');
  });
});

describe('Edit', () => {
  test('replaces a unique string and shows a snippet', async () => {
    const p = file('edit1.txt', 'alpha\nbeta\ngamma\n');
    const r = await run('Edit', { file_path: p, old_string: 'beta', new_string: 'BETA $& $1' });
    assert.equal(r.isError, false, r.content);
    assert.equal(readFileSync(p, 'utf8'), 'alpha\nBETA $& $1\ngamma\n');
    assert.match(r.content, / {5}2\tBETA/);
  });

  test('refuses an ambiguous match unless replace_all', async () => {
    const p = file('edit2.txt', 'x = 1\nx = 1\n');
    const r = await run('Edit', { file_path: p, old_string: 'x = 1', new_string: 'x = 2' });
    assert.equal(r.isError, true);
    assert.match(r.content, /occurs 2 times/);
    assert.equal(readFileSync(p, 'utf8'), 'x = 1\nx = 1\n');

    const all = await run('Edit', { file_path: p, old_string: 'x = 1', new_string: 'x = 2', replace_all: true });
    assert.equal(all.isError, false, all.content);
    assert.match(all.content, /2 occurrences/);
    assert.equal(readFileSync(p, 'utf8'), 'x = 2\nx = 2\n');
  });

  test('reports no match, an empty old_string and a no-op edit', async () => {
    const p = file('edit3.txt', 'hello\n');
    const none = await run('Edit', { file_path: p, old_string: 'bye', new_string: 'x' });
    assert.equal(none.isError, true);
    assert.match(none.content, /not found/);

    const empty = await run('Edit', { file_path: p, old_string: '', new_string: 'x' });
    assert.equal(empty.isError, true);
    assert.match(empty.content, /must not be empty/);

    const same = await run('Edit', { file_path: p, old_string: 'hello', new_string: 'hello' });
    assert.equal(same.isError, true);

    const missing = await run('Edit', { file_path: 'nope.txt', old_string: 'a', new_string: 'b' });
    assert.equal(missing.isError, true);
    assert.match(missing.content, /does not exist/);
  });

  test('matches LF strings in a CRLF file and writes CRLF, keeping a BOM', async () => {
    const p = file('edit4.txt', '\uFEFFone\r\ntwo\r\nthree\r\n');
    const r = await run('Edit', { file_path: p, old_string: 'one\ntwo', new_string: 'one\n1.5\ntwo' });
    assert.equal(r.isError, false, r.content);
    assert.equal(readFileSync(p, 'utf8'), '\uFEFFone\r\n1.5\r\ntwo\r\nthree\r\n');
  });

  test('keeps an LF file LF when the strings arrive with CRLF', async () => {
    const p = file('edit5.txt', 'a\nb\n');
    const r = await run('Edit', { file_path: p, old_string: 'a\r\nb', new_string: 'a\r\nc' });
    assert.equal(r.isError, false, r.content);
    assert.equal(readFileSync(p, 'utf8'), 'a\nc\n');
  });
});

describe('Bash', () => {
  test('returns stdout, stderr and the exit code, and the structured result', async () => {
    const ok = await run('Bash', { command: 'echo hello', description: 'say hello' });
    assert.equal(ok.isError, false);
    assert.equal(ok.content, 'hello');
    assert.deepEqual(ok.structured, { stdout: 'hello\n', stderr: '', interrupted: false });

    const bad = await run('Bash', { command: 'echo out; echo err 1>&2; exit 3' });
    assert.equal(bad.isError, true);
    assert.equal(bad.content, 'out\nerr\nExit code 3');
    assert.equal(bad.structured.stdout.trim(), 'out');
    assert.equal(bad.structured.stderr.trim(), 'err');
  });

  test('runs in the working directory', async () => {
    file('marker-file.txt', '');
    const r = await run('Bash', { command: 'ls' });
    assert.match(r.content, /marker-file\.txt/);
  });

  test('a timeout kills the command and reports interrupted', async () => {
    const start = Date.now();
    const r = await run('Bash', { command: 'sleep 20', timeout: 500 });
    assert.ok(Date.now() - start < 10_000, 'killed well before the command would finish');
    assert.equal(r.isError, true);
    assert.equal(r.structured.interrupted, true);
    assert.match(r.content, /timed out after 500 ms/);
  });

  test('caps long output, keeping the head and tail', async () => {
    const r = await run('Bash', { command: 'for i in $(seq 1 20000); do echo "line $i"; done' });
    assert.ok(r.content.length < 31_000, `content is ${r.content.length} chars`);
    assert.match(r.content, /^line 1\n/);
    assert.match(r.content, /line 20000$/);
    assert.match(r.content, /characters truncated/);
  });
});

describe('Grep', () => {
  let root;
  before(() => {
    root = path.join(dir, 'grep');
    file('grep/a.ts', 'const needle = 1;\nconst other = 2;\n');
    file('grep/b.js', 'nothing here\nNEEDLE shouting\n');
    file('grep/sub/c.ts', 'before\nneedle again\nafter\n');
    file('grep/node_modules/dep/d.ts', 'needle in a dependency\n');
    file('grep/ignored.log', 'needle in a log\n');
    file('grep/.gitignore', '*.log\n');
  });

  const base = { ignoreCase: false, lineNumbers: true, before: 0, after: 0, multiline: false };
  const rel = lines => lines.map(l => path.relative(root, l).split(path.sep).join('/')).sort();

  test('files_with_matches (default), with -i and glob', async () => {
    const r = await run('Grep', { pattern: 'needle', path: root });
    assert.equal(r.isError, false);
    const files = r.content.split('\n').slice(1).map(f => path.relative(root, f).split(path.sep).join('/')).sort();
    assert.deepEqual(files, ['a.ts', 'sub/c.ts']);
    assert.match(r.content, /^Found 2 files/);

    const ci = await run('Grep', { pattern: 'needle', path: root, '-i': true, glob: '*.js' });
    assert.match(ci.content, /b\.js/);
    assert.doesNotMatch(ci.content, /a\.ts/);
  });

  test('content mode with line numbers and context, and count mode', async () => {
    const r = await run('Grep', { pattern: 'needle again', path: root, output_mode: 'content', '-B': 1 });
    const lines = r.content.split('\n').map(l => l.slice(l.indexOf('c.ts')));
    assert.deepEqual(lines, ['c.ts-1-before', 'c.ts:2:needle again']);

    const count = await run('Grep', { pattern: 'e', path: path.join(root, 'a.ts'), output_mode: 'count' });
    assert.match(count.content, /a\.ts:2/);
  });

  test('no matches, and an invalid regex', async () => {
    assert.equal((await run('Grep', { pattern: 'zzz_not_there', path: root })).content, 'No files found');
    const bad = await run('Grep', { pattern: '(unclosed', path: root });
    assert.equal(bad.isError, true);
  });

  test('the JS fallback skips node_modules and .gitignore patterns', async () => {
    assert.deepEqual(rel(await grepJs({ ...base, pattern: 'needle', root, mode: 'files_with_matches' })), ['a.ts', 'sub/c.ts']);
    assert.deepEqual(rel(await grepJs({ ...base, pattern: 'needle', root, mode: 'files_with_matches', ignoreCase: true, glob: '*.js' })), ['b.js']);
    assert.deepEqual(rel(await grepJs({ ...base, pattern: 'needle', root, mode: 'files_with_matches', type: 'ts' })), ['a.ts', 'sub/c.ts']);

    const content = await grepJs({ ...base, pattern: 'needle again', root, mode: 'content', before: 1 });
    assert.deepEqual(content.map(l => l.slice(l.indexOf('c.ts'))), ['c.ts-1-before', 'c.ts:2:needle again']);

    const count = await grepJs({ ...base, pattern: 'const', root, mode: 'count' });
    assert.equal(count.length, 1);
    assert.match(count[0], /a\.ts:2$/);

    const multi = await grepJs({ ...base, pattern: 'before.needle', root, mode: 'files_with_matches', multiline: true });
    assert.deepEqual(rel(multi), ['sub/c.ts']);
  });
});

describe('Glob', () => {
  test('lists files newest first, skipping node_modules', async () => {
    const older = file('glob/old.ts', '');
    const newer = file('glob/deep/new.ts', '');
    file('glob/node_modules/x.ts', '');
    file('glob/other.js', '');
    utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(newer, new Date(2024, 0, 1), new Date(2024, 0, 1));

    const r = await run('Glob', { pattern: '**/*.ts', path: path.join(dir, 'glob') });
    assert.equal(r.isError, false);
    assert.deepEqual(r.content.split('\n'), [newer, older]);

    assert.equal((await run('Glob', { pattern: '*.none', path: path.join(dir, 'glob') })).content, 'No files found');
    assert.equal((await run('Glob', { pattern: '*', path: 'missing-dir' })).isError, true);
  });
});

describe('TodoWrite', () => {
  test('keeps the list for the run and validates it', async () => {
    const todos = [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run the tests', status: 'pending' },
    ];
    const r = await run('TodoWrite', { todos });
    assert.equal(r.isError, false);
    assert.match(r.content, /1\/3 completed/);
    assert.deepEqual(ctx.todos, todos);

    const bad = await run('TodoWrite', { todos: [{ content: 'x', status: 'done' }] });
    assert.equal(bad.isError, true);
    assert.deepEqual(ctx.todos, todos, 'a rejected update leaves the list alone');
  });
});

// ── Through the CLI ─────────────────────────────────────────────────────────

const AGENTMUX_ARGS = ['run', '-p', '--dangerously-skip-permissions'];

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A fake model that calls one tool, then answers "done". */
async function callOnce(name, args, opts = {}) {
  const model = await startFakeModel((_body, n) =>
    n === 0 ? { tool_calls: [toolCall('call_1', name, args)] } : { content: 'done' });
  try {
    const r = await runMuxcode(opts.args ?? AGENTMUX_ARGS, { stdin: 'go', modelUrl: model.url, ...opts });
    return { r, model, user: r.frames.find(f => f.type === 'user') };
  } finally {
    await model.close();
  }
}

describe('built-in tools through the CLI', () => {
  test('system/init lists the built-ins', async () => {
    const model = await startFakeModel();
    try {
      const r = await runMuxcode(AGENTMUX_ARGS, { stdin: 'hi', modelUrl: model.url });
      assert.deepEqual(r.frames[0].tools, ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite']);
      const schemas = Object.fromEntries(model.requests[0].tools.map(t => [t.function.name, t.function.parameters]));
      assert.deepEqual(Object.keys(schemas.Edit.properties), ['file_path', 'old_string', 'new_string', 'replace_all']);
      assert.deepEqual(schemas.Bash.required, ['command']);
      assert.deepEqual(schemas.TodoWrite.required, ['todos']);
    } finally {
      await model.close();
    }
  });

  test('Read result comes back as a tool_result, and the model sees it', async () => {
    const { r, model, user } = await callOnce('Read', { file_path: 'hello.txt' }, { files: { 'hello.txt': 'hi there\n' } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(user.message.content[0], { type: 'tool_result', tool_use_id: 'call_1', content: '     1\thi there', is_error: false });
    assert.equal(model.requests[1].messages.at(-1).content, '     1\thi there');
  });

  test('Bash emits the structured tool_use_result AgentMux\'s Bash viewer reads', async () => {
    const { r, user } = await callOnce('Bash', { command: 'echo from-bash' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(user.message.content[0].content, 'from-bash');
    assert.equal(user.message.content[0].is_error, false);
    assert.deepEqual(user.tool_use_result, { stdout: 'from-bash\n', stderr: '', interrupted: false });
  });

  test('a failing built-in is an is_error result, even without a JSON error key', async () => {
    const { user } = await callOnce('Edit', { file_path: 'f.txt', old_string: 'a', new_string: 'b' }, { files: { 'f.txt': 'a a' } });
    assert.equal(user.message.content[0].is_error, true);
    assert.match(user.message.content[0].content, /occurs 2 times/);
  });

  test('plan mode refuses a tool it did not offer', async () => {
    const { r, user } = await callOnce('Write', { file_path: 'x.txt', content: 'x' }, { args: ['run', '-p', '--permission-mode', 'plan'] });
    assert.deepEqual(r.frames[0].tools, ['Read', 'Grep', 'Glob', 'TodoWrite']);
    assert.equal(user.message.content[0].is_error, true);
    assert.match(user.message.content[0].content, /not found/);
  });

  test('an MCP tool named like a built-in does not shadow it', async () => {
    const config = structuredClone(FIXTURE_MCP_CONFIG);
    config.mcpServers.fixture.env = { FIXTURE_EXTRA_TOOL: 'Read' };
    const { r, user } = await callOnce('Read', { file_path: 'hello.txt' }, {
      files: { 'hello.txt': 'local\n', '.mcp.json': config },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.frames[0].tools.filter(t => t === 'Read').length, 1);
    assert.equal(user.message.content[0].content, '     1\tlocal');
    assert.match(r.stderr, /Ignoring MCP tool "Read"/);
  });
});

// ReAgent P1 on #46: an interrupt must stop a running Bash command, not leave
// it running (it's in its own process group, so nothing else would kill it).
test('interrupting the run kills a running Bash command and everything it started', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-abort-'));
  try {
    const ac = new AbortController();
    const ctx = newToolContext(dir, ac.signal);
    const started = Date.now();
    setTimeout(() => ac.abort(), 400);
    const out = await executeBuiltinTool({
      id: 'b1',
      name: 'Bash',
      input: { command: `node -e "setTimeout(()=>require('fs').writeFileSync('marker','x'),1500)"` },
    }, ctx);
    assert.equal(out.isError, true);
    assert.equal(out.structured.interrupted, true);
    assert.match(out.content, /interrupted/);
    assert.ok(Date.now() - started < 1400, 'returned promptly after the interrupt');
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(readdirSafe(dir).includes('marker'), false, 'the command was killed before it wrote the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Bash call made after the interrupt does not start', async () => {
  const ac = new AbortController();
  ac.abort();
  const out = await executeBuiltinTool({ id: 'b2', name: 'Bash', input: { command: 'echo hi' } }, newToolContext(os.tmpdir(), ac.signal));
  assert.equal(out.isError, true);
  assert.match(out.content, /interrupted before the command started/);
});

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ReAgent P1 on #46: a catastrophically backtracking pattern in the JS fallback
// must not freeze the CLI.
test('the JS Grep fallback stops a runaway regex without blocking the main thread', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-redos-'));
  try {
    writeFileSync(path.join(dir, 'bad.txt'), 'a'.repeat(30) + 'b\n');
    const opts = { pattern: '^(a+)+$', root: dir, mode: 'files_with_matches', ignoreCase: false, lineNumbers: true, before: 0, after: 0, multiline: false };
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 50);
    const started = Date.now();
    await assert.rejects(grepJsGuarded(opts, { timeoutMs: 500 }), /backtrack catastrophically/);
    clearInterval(ticker);
    assert.ok(Date.now() - started < 5000, 'stopped near the time budget');
    assert.ok(ticks >= 5, 'the main thread kept running while the pattern was being matched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupt stops the JS Grep fallback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-redos-'));
  try {
    writeFileSync(path.join(dir, 'bad.txt'), 'a'.repeat(30) + 'b\n');
    const opts = { pattern: '^(a+)+$', root: dir, mode: 'content', ignoreCase: false, lineNumbers: true, before: 0, after: 0, multiline: false };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(grepJsGuarded(opts, { signal: ac.signal }), /interrupted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the guarded JS fallback returns what the direct search returns', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-grepw-'));
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\n');
    writeFileSync(path.join(dir, 'b.txt'), 'gamma\nalphabet\n');
    const opts = { pattern: 'alpha', root: dir, mode: 'content', ignoreCase: false, lineNumbers: true, before: 0, after: 0, multiline: false };
    assert.deepEqual((await grepJsGuarded(opts)).sort(), (await grepJs(opts)).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ReAgent P2 on #46: head_limit must keep the NEWEST matching files.
test('Grep head_limit keeps the newest matching files', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-headlimit-'));
  try {
    const now = Date.now() / 1000;
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `f${i}.txt`);
      writeFileSync(f, 'needle\n');
      utimesSync(f, now - 1000 + i * 100, now - 1000 + i * 100); // f5 newest
    }
    const out = await executeBuiltinTool({ id: 'g1', name: 'Grep', input: { pattern: 'needle', head_limit: 2 } }, newToolContext(dir));
    const files = out.content.split('\n').slice(1).map(f => path.basename(f));
    assert.deepEqual(files, ['f5.txt', 'f4.txt']);

    const js = await grepJsGuarded({ pattern: 'needle', root: dir, mode: 'files_with_matches', ignoreCase: false, lineNumbers: true, before: 0, after: 0, multiline: false });
    assert.equal(js.length, 6, 'the fallback collects every match; the limit is applied after sorting');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
