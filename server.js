// Local server: serves the UI and turns "get a move" requests into Claude Code / Codex CLI calls.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TIMEOUT_MS = 20 * 60 * 1000; // max effort can think for a long time

const STATIC = {
  '/vendor/chess.js': join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// session id -> working folder; resuming needs the same folder the session started in.
// shortcut: kept in memory and the folders stay in the OS temp dir; fine for a local app.
const sessions = new Map();

const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

async function codexModels() {
  // Codex keeps the list of models your account can use in this cache file.
  try {
    const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    return (cache.models || [])
      .filter(m => m.visibility === 'list')
      .map(m => ({ id: m.slug, efforts: (m.supported_reasoning_levels || []).map(e => e.effort) }));
  } catch {
    return [];
  }
}

const WINDOWS = process.platform === 'win32';
const running = new Set(); // kill functions of CLIs still running, for shutdown

// Runs a CLI with text on stdin. On Windows, npm installs CLIs as .cmd files, which
// only start through the shell, so every argument is quoted for cmd.exe. Long text
// (prompts) never goes on the command line: it is sent on stdin or in a file.
function run(cmd, args, { cwd, input, signal }) {
  return new Promise((resolve, reject) => {
    if (WINDOWS && args.some(a => /["%\r\n]/.test(a))) return reject(new Error('Unsafe argument for cmd.exe'));
    const child = WINDOWS
      ? spawn(cmd, args.map(a => `"${a}"`), { cwd, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd, detached: true });
    // CLIs can start helper processes (npm's codex wraps a native binary), so kill the
    // whole tree: taskkill on Windows, the process group elsewhere.
    const kill = () => {
      try {
        if (WINDOWS) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, 'SIGTERM');
      } catch {}
    };
    running.add(kill);
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.stdin.on('error', () => {}); // the CLI may exit before reading all input; close reports it
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error(`"${cmd}" was not found. Is it installed and on your PATH?`) : e));
    child.on('close', code => {
      running.delete(kill);
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      else if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}: ${(err || out).slice(-800)}`));
    });
    child.stdin.end(input);
  });
}

async function askClaude({ model, effort, system, prompt, image, session }, cwd, signal) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } });
  content.push({ type: 'text', text: prompt });
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const id = session || randomUUID();
  await writeFile(join(cwd, 'system.txt'), system);
  // No tools, no MCP, no user/project settings: the model only sees our prompt.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--effort', effort, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt-file', join(cwd, 'system.txt'), ...(session ? ['--resume', id] : ['--session-id', id])];
  const out = await run('claude', args, { cwd, input, signal });
  const result = out.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
    .find(e => e?.type === 'result');
  if (!result || result.is_error) throw new Error(result?.result || 'Claude returned no result');
  return { text: result.result, session: id };
}

async function askCodex({ model, effort, system, prompt, image, session }, cwd, signal) {
  // Codex is cut off from the computer: no shell, browser, computer use or web search,
  // and a read-only sandbox as a second wall. It can only answer in text.
  const args = ['exec', ...(session ? ['resume', session] : []), '--skip-git-repo-check', '--ignore-user-config',
    '--json', '-m', model, '-c', 'sandbox_mode=read-only', '-c', 'web_search=disabled',
    '--disable', 'shell_tool', '--disable', 'browser_use', '--disable', 'computer_use'];
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (image) {
    await writeFile(join(cwd, 'board.png'), Buffer.from(image, 'base64'));
    args.push('-i', join(cwd, 'board.png'));
  }
  args.push('-o', join(cwd, 'answer.txt'), '-');
  await rm(join(cwd, 'answer.txt'), { force: true }); // never read last turn's answer
  // shortcut: Codex has no flag to replace its system prompt, so ours opens the first message of the session.
  const out = await run('codex', args, { cwd, input: session ? prompt : `${system}\n\n${prompt}`, signal });
  const started = out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
    .find(e => e?.type === 'thread.started');
  return { text: await readFile(join(cwd, 'answer.txt'), 'utf8'), session: session || started?.thread_id };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20e6) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Only this app's own page may talk to the server. Checking Host blocks DNS rebinding;
// checking Origin and requiring a JSON content type blocks other websites, because the
// browser then has to ask first (a CORS preflight) and this server never says yes.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const SAFE_NAME = /^\w[\w.:[\]-]{0,99}$/;
const busy = new Set(); // sessions with a request in flight

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin;
  if (!HOSTS.has(req.headers.host) || (origin && !HOSTS.has(origin.replace(/^http:\/\//, '')))) {
    return send(res, 403, { error: 'Forbidden' });
  }
  try {
    if (url.pathname === '/api/models') {
      return send(res, 200, { claude: { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }, codex: await codexModels() });
    }
    if (url.pathname === '/api/move' && req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Send JSON' });
      const body = await readJson(req);
      if (!['claude', 'codex'].includes(body.engine)) return send(res, 400, { error: 'Unknown engine' });
      for (const k of ['model', 'effort', 'system', 'prompt']) if (typeof body[k] !== 'string') return send(res, 400, { error: `Missing ${k}` });
      // These go on the CLI command line, so only plain names are allowed.
      for (const k of ['model', 'effort', 'session']) {
        const optional = k === 'session' || (k === 'effort' && body.engine === 'codex');
        if (optional && !body[k]) continue;
        if (typeof body[k] !== 'string' || !SAFE_NAME.test(body[k])) return send(res, 400, { error: `Invalid ${k}` });
      }
      // Kill the CLI if the browser gives up (new game, page closed).
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      // One session per player per game: the first move opens it, later moves resume it.
      // A session the server does not know (e.g. after a restart) starts over.
      const session = sessions.get(body.session) ? body.session : null;
      if (session && busy.has(session)) return send(res, 409, { error: 'This player is already thinking' });
      const cwd = session ? sessions.get(session) : await mkdtemp(join(tmpdir(), 'llm-chess-'));
      const started = Date.now();
      if (session) busy.add(session);
      try {
        const answer = await (body.engine === 'claude' ? askClaude : askCodex)({ ...body, session }, cwd, abort.signal);
        if (answer.session) sessions.set(answer.session, cwd);
        return send(res, 200, { ...answer, ms: Date.now() - started });
      } catch (e) {
        if (!session) await rm(cwd, { recursive: true, force: true }); // a first move that failed leaves nothing behind
        throw e;
      } finally {
        if (session) busy.delete(session);
      }
    }
    const file = STATIC[url.pathname] || join(ROOT, 'public', normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(join(ROOT, 'public')) && !STATIC[url.pathname]) return send(res, 403, { error: 'Forbidden' });
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.destroy();
  }
});

// Stop running CLIs on Ctrl+C; they run in their own process group and would outlive us.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const kill of running) kill();
    process.exit(0);
  });
}

// Bound to localhost only: this server runs CLIs on your account.
server.listen(PORT, '127.0.0.1', () => console.log(`LLM Chess running at http://localhost:${PORT}`));
