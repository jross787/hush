#!/usr/bin/env node
// hush — a quiet front door for building software with Claude Code.
// Zero dependencies. Talks to the `claude` CLI via -p / --resume,
// so the user's existing OAuth login just works.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.HUSH_PORT || 4117);
const CLAUDE_BIN = process.env.HUSH_CLAUDE_BIN || 'claude';
const ELICIT_MODEL = process.env.HUSH_ELICIT_MODEL || 'sonnet';
const RUN_MODEL = process.env.HUSH_RUN_MODEL || ''; // '' = account default
const MAX_QUESTIONS = Number(process.env.HUSH_MAX_QUESTIONS || 5);
const RUN_TIMEOUT = Number(process.env.HUSH_RUN_TIMEOUT || 20 * 60 * 1000);
const YOLO = process.env.HUSH_YOLO === '1'; // skip all permission checks in the run phase

const HUSH_DIR = path.join(os.homedir(), '.hush');
const RECENTS = path.join(HUSH_DIR, 'recents.json');
mkdirSync(HUSH_DIR, { recursive: true });

// Bash commands the builder may run without prompting (acceptEdits covers file edits).
const RUN_TOOLS =
  process.env.HUSH_RUN_TOOLS ||
  [
    'WebSearch', 'WebFetch',
    'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(node *)',
    'Bash(python *)', 'Bash(python3 *)', 'Bash(pytest *)', 'Bash(pip *)',
    'Bash(cargo *)', 'Bash(go *)', 'Bash(make *)',
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)',
    'Bash(ls *)', 'Bash(mkdir *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(rg *)',
  ].join(',');

// ---------------------------------------------------------------------------
// Prompts

const ELICIT_SYSTEM = `You are the quiet interviewer behind "hush", a minimal interface for starting software work without decision fatigue. The user wants to build or change something in their project. A <project-context> block gathered automatically arrives with their first message. Your job is to gather JUST enough context, one small question at a time, then hand off a precise build brief. You never build anything during this phase.

Rules:
- Ask exactly ONE question per turn.
- Prefer yes/no questions. Use an open question only when yes/no cannot capture it (behavior details, names, examples).
- Yes/no questions must be truly binary. Never phrase "A or B?" as a yes/no question.
- Ask at most ${MAX_QUESTIONS} questions total. Stop the moment another question would not change what you would build. Two or three is usually right.
- Ask about what actually changes the work: intended behavior, scope boundaries, edge cases that matter, how the user will know it works. Never ask what the <project-context> already answers, what you can read from convention, or what a competent builder would just decide.
- If the request is already specific enough, skip questions entirely and return "ready".
- If the user replies with the single token ENOUGH, immediately return "ready" with your best-effort understanding, stating your assumptions in the summary.
- Keep questions under 20 words when you can. Tone: warm, plain, unhurried. No exclamation marks.

Respond with ONLY one JSON object. No prose, no markdown fences, nothing else. One of:
{"kind":"ask_yesno","question":"..."}
{"kind":"ask_open","question":"...","hint":"a short example of the kind of answer that helps"}
{"kind":"ready","summary":"2-3 plain sentences: what you understood and what will be built","coach":"one gentle sentence naming the piece of context that most sharpened this brief, so the user learns what to include next time","refined_prompt":"a complete build brief addressed to a coding agent: what to build, where it lives (concrete file paths when known), constraints, and how to verify it works"}`;

const RUN_SYSTEM = `You are the builder behind "hush", a minimal interface built to prevent decision fatigue and burnout. The interview is over. Execute the brief now, autonomously and completely.

While building:
- Make every implementation decision yourself. Never ask questions, never present options.
- Follow the repository's existing conventions. Keep the diff as small as the task allows.
- Verify your work: run the project's tests, build, or a quick sanity check when one is available.
- If part of the brief proves impossible, do the closest sensible thing and say so plainly in your report.

Then report back under the calm contract:
- Under 200 words, plain prose. What you built, where it lives (file paths), and how you verified it. No headers, no emoji, no exclamation marks, no walls of pasted code.
- If there is one command to try it, give exactly one, on its own line in backticks.
- End with exactly one final line, alone on its own line, in the form:
NEXT: <the single smallest concrete action the user should take>`;

// ---------------------------------------------------------------------------
// Project scanning & recents

async function git(project, args) {
  try {
    const { stdout } = await execFileP('git', args, { cwd: project });
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

async function scanProject(project) {
  const name = path.basename(project);
  const lines = [`Project: ${name} (${project})`];
  try {
    const entries = (await readdir(project, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.'))
      .slice(0, 30)
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    lines.push('Top level: ' + entries.join(', '));
  } catch {}
  try {
    const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    lines.push(
      `package.json: name=${pkg.name || '?'}; scripts: ${Object.keys(pkg.scripts || {}).join(', ') || 'none'}`
    );
  } catch {}
  for (const f of ['pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile', 'CLAUDE.md']) {
    if (existsSync(path.join(project, f))) lines.push(`Has ${f}`);
  }
  const branch = await git(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const isGit = branch !== null;
  let dirty = false;
  if (isGit) {
    const status = (await git(project, ['status', '--porcelain'])) || '';
    dirty = status.trim().length > 0;
    lines.push(`Git: branch ${branch}${dirty ? ', uncommitted changes present' : ', clean'}`);
    const log = await git(project, ['log', '--oneline', '-3']);
    if (log) lines.push('Recent commits:\n' + log);
  } else {
    lines.push('Not a git repository');
  }
  return { name, context: lines.join('\n'), isGit, dirty, branch };
}

// numstat map used to report only what changed during THIS run
async function diffSnapshot(project) {
  const map = new Map();
  const numstat =
    (await git(project, ['diff', 'HEAD', '--numstat'])) ??
    (await git(project, ['diff', '--numstat']));
  if (numstat) {
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [add, del, file] = line.split('\t');
      map.set(file, `${add}/${del}`);
    }
  }
  const status = await git(project, ['status', '--porcelain']);
  if (status) {
    for (const line of status.split('\n').filter(Boolean)) {
      if (line.startsWith('??')) map.set(line.slice(3).trim(), 'new');
    }
  }
  return map;
}

async function collectChanges(project, before) {
  const after = await diffSnapshot(project);
  const changes = [];
  for (const [file, sig] of after) {
    if (before.get(file) === sig) continue; // unchanged by this run
    if (sig === 'new') changes.push({ file, added: true });
    else {
      const [add, del] = sig.split('/');
      changes.push({ file, add: +add || 0, del: +del || 0 });
    }
  }
  return changes.slice(0, 14);
}

async function loadRecents() {
  try {
    return JSON.parse(await readFile(RECENTS, 'utf8'));
  } catch {
    return [];
  }
}

async function saveRecent(project) {
  const list = (await loadRecents()).filter((r) => r.path !== project);
  list.unshift({ path: project, last: Date.now() });
  await writeFile(RECENTS, JSON.stringify(list.slice(0, 8), null, 2));
}

// ---------------------------------------------------------------------------
// Claude CLI plumbing

const sessions = new Map(); // id -> { claudeId, asks, busy, project, progress }

function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// simple one-shot call (elicitation) — whole reply as one JSON envelope
function runClaude({ prompt, resume, system, model, cwd, timeoutMs = 150000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--append-system-prompt', system,
      '--strict-mcp-config',
    ];
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);

    const child = spawn(CLAUDE_BIN, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude took too long and was stopped'));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error((err || out || `claude exited ${code}`).trim().slice(0, 500)));
      }
      try {
        const data = JSON.parse(out);
        if (data.is_error) return reject(new Error(String(data.result).slice(0, 500)));
        resolve({ text: data.result ?? '', claudeId: data.session_id });
      } catch {
        reject(new Error('could not parse claude output: ' + out.slice(0, 300)));
      }
    });

    child.stdin.end(prompt);
  });
}

function progressLabel(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return `reading ${base(input.file_path || input.path || input.pattern || '')}`.trim();
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `editing ${base(input.file_path)}`.trim();
    case 'Bash':
      return `running ${String(input.command || '').split('\n')[0].slice(0, 48)}`.trim();
    case 'TodoWrite':
    case 'Task':
      return 'planning';
    case 'WebSearch':
    case 'WebFetch':
      return 'searching the web';
    default:
      return name.toLowerCase();
  }
}

// streaming call (build phase) — parses stream-json for live progress
function runClaudeStream({ prompt, resume, system, model, cwd, onProgress, timeoutMs = RUN_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', system,
      '--strict-mcp-config',
    ];
    if (YOLO) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits', '--allowedTools', RUN_TOOLS);
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);

    const child = spawn(CLAUDE_BIN, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let result = null;
    let claudeId = resume || null;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the build ran too long and was stopped'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id) claudeId = ev.session_id;
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content || []) {
            if (block.type === 'tool_use') onProgress?.(progressLabel(block.name, block.input));
          }
        }
        if (ev.type === 'result') {
          result = ev.is_error ? { error: String(ev.result).slice(0, 500) } : { text: ev.result ?? '' };
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (result?.error) return reject(new Error(result.error));
      if (result) return resolve({ text: result.text, claudeId });
      reject(new Error((err || `claude exited ${code} without a result`).trim().slice(0, 500)));
    });

    child.stdin.end(prompt);
  });
}

// ---------------------------------------------------------------------------
// Parsing

function parseStep(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      if (obj && typeof obj.kind === 'string') return obj;
    } catch {}
  }
  return { kind: 'ask_open', question: String(text).trim() };
}

function parseAnswer(text) {
  const lines = String(text).trim().split('\n');
  let next = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const m = lines[i].match(/^\s*(?:\*\*)?NEXT:?(?:\*\*)?\s*(.+?)\s*$/i);
    if (m) {
      next = m[1].replace(/\*\*$/, '').trim();
      lines.splice(i, 1);
    }
    break;
  }
  return { text: lines.join('\n').trim(), next };
}

// ---------------------------------------------------------------------------
// Phases

async function elicit(session, prompt) {
  const { text, claudeId } = await runClaude({
    prompt,
    resume: session.claudeId,
    system: ELICIT_SYSTEM,
    model: ELICIT_MODEL,
    cwd: session.project,
  });
  session.claudeId = claudeId;
  let step = parseStep(text);

  if (step.kind.startsWith('ask')) {
    if (session.asks >= MAX_QUESTIONS) {
      const forced = await runClaude({
        prompt: 'ENOUGH (question limit reached — return the ready JSON now)',
        resume: session.claudeId,
        system: ELICIT_SYSTEM,
        model: ELICIT_MODEL,
        cwd: session.project,
      });
      session.claudeId = forced.claudeId;
      step = parseStep(forced.text);
    } else {
      session.asks += 1;
    }
  }
  return step;
}

async function build(session, prompt) {
  const before = await diffSnapshot(session.project);
  session.progress = 'settling in';
  const { text, claudeId } = await runClaudeStream({
    prompt,
    resume: session.claudeId,
    system: RUN_SYSTEM,
    model: RUN_MODEL || undefined,
    cwd: session.project,
    onProgress: (p) => (session.progress = p),
  });
  session.claudeId = claudeId;
  session.progress = null;
  const changes = await collectChanges(session.project, before);
  return { answer: parseAnswer(text), changes };
}

// ---------------------------------------------------------------------------
// Routes

const routes = {
  '/api/start': async (body) => {
    const prompt = String(body.prompt || '').trim();
    const project = String(body.project || '').trim();
    if (!prompt) throw new Error('empty prompt');
    let stat;
    try {
      stat = statSync(project);
    } catch {}
    if (!stat?.isDirectory()) throw new Error('that folder does not exist');

    const scan = await scanProject(project);
    await saveRecent(project);

    const id = crypto.randomUUID();
    const session = { claudeId: null, asks: 0, busy: false, project, progress: null };
    sessions.set(id, session);

    const first = `<project-context>\n${scan.context}\n</project-context>\n\nThe user's request: ${prompt}`;
    const step = await elicit(session, first);
    return {
      session: id,
      step,
      project: { name: scan.name, branch: scan.branch, dirty: scan.dirty, git: scan.isGit },
    };
  },

  '/api/reply': async (body) => {
    const session = requireSession(body);
    const prompt = body.enough ? 'ENOUGH' : String(body.text || '').trim();
    if (!prompt) throw new Error('empty reply');
    const step = await elicit(session, prompt);
    return { step };
  },

  '/api/run': async (body) => {
    const session = requireSession(body);
    const note = String(body.note || '').trim();
    const prompt = note
      ? `One adjustment before you begin: ${note}\n\nNow execute the brief.`
      : 'Execute the brief now.';
    return build(session, prompt);
  },

  '/api/followup': async (body) => {
    const session = requireSession(body);
    const text = String(body.text || '').trim();
    if (!text) throw new Error('empty follow-up');
    return build(session, text);
  },
};

function requireSession(body) {
  const session = sessions.get(String(body.session || ''));
  if (!session) throw Object.assign(new Error('session lost — start again'), { status: 404 });
  return session;
}

// ---------------------------------------------------------------------------
// HTTP server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && routes[url.pathname]) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const session = sessions.get(String(body.session || ''));
    if (session?.busy) return json(res, 429, { error: 'already thinking — one breath at a time' });
    try {
      if (session) session.busy = true;
      const result = await routes[url.pathname](body);
      json(res, 200, result);
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    } finally {
      if (session) session.busy = false;
    }
    return;
  }

  if (req.method === 'GET') {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });

    if (url.pathname === '/api/projects') {
      const recents = (await loadRecents())
        .filter((r) => {
          try {
            return statSync(r.path).isDirectory();
          } catch {
            return false;
          }
        })
        .map((r) => ({ path: r.path, name: path.basename(r.path) }));
      return json(res, 200, { recents });
    }

    if (url.pathname === '/api/progress') {
      const session = sessions.get(url.searchParams.get('session') || '');
      return json(res, 200, { progress: session?.progress || null, running: session?.busy || false });
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB)) return json(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  json(res, 405, { error: 'method not allowed' });
});

server.requestTimeout = 0; // builds take as long as they take
server.listen(PORT, '127.0.0.1', () => {
  console.log(`hush · listening quietly on http://localhost:${PORT}`);
  console.log(`       elicit model ${ELICIT_MODEL}, build model ${RUN_MODEL || '(account default)'}`);
  console.log(`       permissions ${YOLO ? 'YOLO (skip all)' : 'acceptEdits + allowlisted commands'}`);
});
