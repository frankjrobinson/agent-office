#!/usr/bin/env node
/*
 * Agent Office — an agile-team view of your Claude Code sessions.
 *
 *   One desk per session. The session's main agent is the scrum master at the
 *   head of the table, subagents sit around it, the whiteboard above shows the
 *   session's own task board, and the wall on the left is the GitLab backlog.
 *
 * Zero dependencies (Node 20+). Local only: binds to 127.0.0.1.
 *
 * Data sources
 *   1. Claude Code transcripts in ~/.claude/projects/** (always)
 *   2. Live hook events — piggybacks on the hooks Pixel Agents installed: the
 *      Pixel Agents hook script fans every event out to each server registered
 *      in ~/.pixel-agents/servers/, so we register there too. Nothing in
 *      ~/.claude/settings.json is touched.
 *   3. `glab issue list` for each repo a session is working in.
 *
 * Usage
 *   node server.js [--port 3200] [--hours 8] [--repo ~/path/to/repo ...] [--demo] [--allow-replies]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ── Config ──────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port) || 3200;
const HOST = '127.0.0.1';
const LOOKBACK_MS = (Number(args.hours) || 8) * 3600_000;
const DEMO = !!args.demo;
const ALLOW_REPLIES = !!args['allow-replies'];
const EXTRA_REPOS = [].concat(args.repo || []).map(expandHome);
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const REGISTRY_DIR = path.join(HOME, '.agent-office', 'servers');
// Pixel Agents' hook fans events out to every server registered in its own
// folder, so registering there too means either tool's hook feeds this one.
const PIXEL_REGISTRY_DIR = path.join(HOME, '.pixel-agents', 'servers');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
];
const TOKEN = crypto.randomUUID();
// The board's own token for actions (POSTs). Separate from TOKEN so the hook
// token never reaches a browser. Served inside index.html, which another site
// can't read, and sent back in a custom header, which another site can't send
// without a CORS preflight this server never answers.
const PAGE_TOKEN = crypto.randomUUID();
const STARTED_AT = Date.now();
const PUBLIC_DIR = path.join(__dirname, 'public');
// Cowork (desktop) runs Claude in a local VM and keeps its transcripts under the
// Claude app's support folder, in the same JSONL format as Claude Code.
const CLAUDE_APP_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude');
const EXTRA_TRANSCRIPT_ROOTS = [].concat(args.transcripts || []).map(expandHome);
// Cloud sessions (Cowork in the cloud, Claude Code on the web) leave nothing on
// this machine, so they report in instead: a session linked to this Mac writes a
// small JSON "beacon" into this folder and refreshes it as it works.
const BEACON_DIR = expandHome(typeof args.beacons === 'string' ? args.beacons : path.join(__dirname, 'beacons'));
const BEACON_STALE_MS = 6 * 60_000;
// Codex CLI keeps rollout transcripts under ~/.codex/sessions/YYYY/MM/DD/
const CODEX_DIR = expandHome(typeof args.codex === 'string' ? args.codex : path.join(HOME, '.codex', 'sessions'));
// Which issue tracker to ask: auto (from the git remote), gitlab, github or none
const FORGE = ['auto', 'gitlab', 'github', 'none'].includes(args.forge) ? args.forge : 'auto';

const SCAN_INTERVAL_MS = 4000;
const GLAB_INTERVAL_MS = 90_000;
const ENDED_VISIBLE_MS = 15 * 60_000;
const BIG_FILE = 24 * 1024 * 1024; // above this, read head (metadata) + tail only
const TAIL_BYTES = 6 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

// launchd / GUI launches don't get Homebrew on PATH
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? (i++, next) : true;
    if (out[key] !== undefined) out[key] = [].concat(out[key], val);
    else out[key] = val;
  }
  return out;
}
function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ── Session model ───────────────────────────────────────────────────────────
/** @type {Map<string, any>} */
const sessions = new Map();

function newSession(id) {
  return {
    id,
    transcriptPath: null,
    offset: 0,
    partial: '',
    backfilled: false,
    cwd: null,
    repoRoot: null,
    project: null,
    worktree: null,
    branch: null,
    customTitle: null,
    summary: null,
    startedAt: 0,
    lastActivity: 0,
    lastKind: null, // prompt | tool_use | tool_result | text
    status: 'your_turn', // working | needs_you | your_turn | ended
    activity: null,
    waiting: null, // { kind: 'permission'|'question'|'plan', text, detail }
    goal: null,
    lastPrompt: null,
    lastAssistant: null,
    tasks: new Map(),
    agents: new Map(),
    pendingTools: new Map(),
    toolCount: 0,
    hooked: false,
    lastHookAt: 0,
    ended: false,
    endedAt: 0,
    live: false, // true once backfill finished; later records are "live"
    kind: 'transcript', // transcript | beacon
    agent: 'Claude Code', // which tool is running this session — shown on the desk
    format: 'claude', // which transcript parser to use: claude | codex
    beacon: false,
    surface: null,
    link: null,
  };
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = newSession(id);
    sessions.set(id, s);
  }
  return s;
}

function setCwd(s, cwd) {
  if (!cwd || typeof cwd !== 'string' || !cwd.startsWith('/') || s.cwd === cwd) return;
  s.cwd = cwd;
  const m = cwd.match(/^(.*?)\/\.claude(?:\/|-)worktrees\/([^/]+)/);
  if (m) {
    s.repoRoot = m[1];
    s.worktree = m[2];
  } else {
    s.repoRoot = cwd;
    s.worktree = null;
  }
  s.project = path.basename(s.repoRoot);
}

function humanize(slug) {
  if (!slug) return null;
  const noHash = slug.replace(/[-_][0-9a-f]{5,8}$/i, '');
  return noHash.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(str, n) {
  if (!str) return str;
  const t = String(str).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ── Tool descriptions ──────────────────────────────────────────────────────
function base(p) {
  return typeof p === 'string' ? path.basename(p) : '';
}
function describeTool(name, input) {
  const inp = input || {};
  if (!name) return null;
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `Using ${tool || name} (${(server || '').replace(/_/g, ' ')})`;
  }
  switch (name) {
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'NotebookEdit':
      return `Editing ${base(inp.notebook_path)}`;
    case 'Bash':
      return inp.description ? clip(inp.description, 90) : `Running: ${clip(inp.command, 80)}`;
    case 'BashOutput':
      return 'Checking background command';
    case 'Grep':
      return `Searching code for “${clip(inp.pattern, 40)}”`;
    case 'Glob':
      return `Finding files ${clip(inp.pattern, 40)}`;
    case 'WebSearch':
      return `Searching the web: ${clip(inp.query, 60)}`;
    case 'WebFetch':
      try {
        return `Reading ${new URL(inp.url).host}`;
      } catch {
        return 'Reading a web page';
      }
    case 'Task':
    case 'Agent':
      return `Briefing ${inp.subagent_type || 'agent'}: ${clip(inp.description, 60)}`;
    case 'TodoWrite':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return 'Updating the board';
    case 'TaskCreate':
      return `Adding card: ${clip(inp.subject, 60)}`;
    case 'AskUserQuestion':
      return 'Asking you a question';
    case 'ExitPlanMode':
      return 'Presenting a plan';
    case 'EnterPlanMode':
      return 'Planning';
    case 'Skill':
      return `Using skill ${inp.skill || inp.name || ''}`.trim();
    case 'SendMessage':
      return `Messaging ${inp.to || inp.recipient || 'teammate'}`;
    default:
      return `Using ${name}`;
  }
}

// ── Transcript parsing ─────────────────────────────────────────────────────
function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function isHumanPrompt(text, rec) {
  if (!text || rec.isMeta) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('<')) return false; // command tags, reminders, notifications
  if (t.startsWith('Caveat:')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  if (t.startsWith('This session is being continued from a previous conversation')) return false;
  return true;
}

function applyRecord(s, r, metaOnly) {
  const ts = Date.parse(r.timestamp) || 0;
  if (ts) {
    if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
    if (ts > s.lastActivity) s.lastActivity = ts;
  }
  if (r.type === 'custom-title' && r.customTitle) s.customTitle = r.customTitle;
  if (r.type === 'summary' && r.summary) s.summary = r.summary;
  if (r.isSidechain) return;
  if (r.cwd) setCwd(s, r.cwd);
  if (r.gitBranch && r.gitBranch !== 'HEAD') s.branch = r.gitBranch;

  const content = r.message && r.message.content;

  if (r.type === 'user') {
    if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) {
      if (metaOnly) return;
      for (const c of content) {
        if (c && c.type === 'tool_result') handleToolResult(s, c, r.toolUseResult, ts);
      }
      s.lastKind = 'tool_result';
      return;
    }
    const text = textOf(content);
    if (isHumanPrompt(text, r)) {
      const t = clip(text, 400);
      if (!s.goal) s.goal = t;
      if (metaOnly) return;
      s.lastPrompt = t;
      s.lastKind = 'prompt';
      s.status = 'working';
      s.waiting = null;
      s.activity = 'Reading your message';
    }
    return;
  }

  if (r.type === 'assistant' && Array.isArray(content) && !metaOnly) {
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'text' && c.text && c.text.trim()) {
        s.lastAssistant = clip(c.text, 900);
        s.lastKind = 'text';
      } else if (c.type === 'tool_use') {
        handleToolUse(s, c.id, c.name, c.input, ts);
        s.lastKind = 'tool_use';
      }
    }
    if (s.lastKind === 'tool_use' || s.lastKind === 'text') {
      if (s.lastKind === 'tool_use') s.status = s.waiting ? 'needs_you' : 'working';
      else if (!s.hooked && s.pendingTools.size === 0) s.status = 'your_turn';
    }
  }
}

function handleToolUse(s, id, name, input, ts) {
  const inp = input || {};
  s.toolCount++;
  s.pendingTools.set(id, { name, input: inp, ts });
  s.activity = describeTool(name, inp);

  switch (name) {
    case 'TodoWrite': {
      s.tasks.clear();
      (inp.todos || []).forEach((t, i) => {
        const tid = `todo-${i}`;
        s.tasks.set(tid, {
          id: tid,
          subject: t.content || t.subject || '',
          activeForm: t.activeForm || null,
          status: t.status || 'pending',
        });
      });
      break;
    }
    case 'TaskCreate': {
      const tid = `tc-${id}`;
      s.tasks.set(tid, {
        id: tid,
        subject: inp.subject || inp.title || 'Task',
        activeForm: inp.activeForm || null,
        status: 'pending',
        provisional: true,
      });
      break;
    }
    case 'TaskUpdate': {
      const key = String(inp.taskId ?? inp.id ?? '');
      let t = s.tasks.get(key);
      if (!t && inp.status === 'deleted') break;
      if (!t) {
        t = { id: key, subject: inp.subject || `Task #${key}`, activeForm: null, status: 'pending' };
        s.tasks.set(key, t);
      }
      if (inp.status === 'deleted') s.tasks.delete(key);
      else {
        if (inp.status) t.status = inp.status;
        if (inp.subject) t.subject = inp.subject;
        if (inp.activeForm) t.activeForm = inp.activeForm;
        if (inp.owner) t.owner = inp.owner;
      }
      break;
    }
    case 'Task':
    case 'Agent': {
      s.agents.set(id, {
        id,
        agentId: null,
        type: inp.subagent_type || 'general-purpose',
        name: inp.name || null,
        description: clip(inp.description || '', 120),
        prompt: clip(inp.prompt || '', 400),
        background: inp.run_in_background === true,
        status: 'running',
        startedAt: ts || Date.now(),
        endedAt: 0,
        activity: 'Reading the brief',
      });
      break;
    }
    case 'AskUserQuestion': {
      const qs = (inp.questions || []).map((q) => q.question).filter(Boolean);
      s.waiting = { kind: 'question', text: qs.join('  ·  ') || 'Claude has a question for you', toolId: id };
      s.status = 'needs_you';
      break;
    }
    case 'ExitPlanMode': {
      s.waiting = { kind: 'plan', text: 'Plan ready for your approval', detail: clip(inp.plan, 600), toolId: id };
      s.status = 'needs_you';
      break;
    }
  }
}

function toolResultText(item) {
  const c = item && item.content;
  if (typeof c === 'string') return c;
  return textOf(c);
}

function handleToolResult(s, item, tur, ts) {
  const id = item.tool_use_id;
  const p = s.pendingTools.get(id);
  s.pendingTools.delete(id);
  if (s.waiting && s.waiting.toolId === id) s.waiting = null;
  if (s.waiting && s.waiting.kind === 'permission') s.waiting = null;
  if (s.status === 'needs_you' && !s.waiting) s.status = 'working';
  if (!p) return;

  if (p.name === 'TaskCreate') {
    const text = toolResultText(item);
    const realId =
      (tur && tur.task && tur.task.id != null && String(tur.task.id)) ||
      (text.match(/Task #?([\w-]+) created/i) || [])[1] ||
      (text.match(/#(\d+)/) || [])[1];
    const prov = s.tasks.get(`tc-${id}`);
    if (prov && realId) {
      s.tasks.delete(`tc-${id}`);
      prov.id = realId;
      delete prov.provisional;
      const existing = s.tasks.get(realId);
      s.tasks.set(realId, existing ? { ...prov, ...existing, subject: prov.subject } : prov);
    }
  }

  if (p.name === 'Task' || p.name === 'Agent') {
    const a = s.agents.get(id);
    if (a) {
      const text = toolResultText(item);
      const launchedAsync =
        a.background ||
        (tur && (tur.status === 'async_launched' || tur.isAsync)) ||
        /running in the background|launched in background|async agent/i.test(text.slice(0, 400));
      if (launchedAsync) {
        a.background = true;
      } else {
        a.status = item.is_error ? 'failed' : 'done';
        a.endedAt = ts || Date.now();
        a.activity = item.is_error ? 'Hit a problem' : 'Reported back';
      }
    }
  }

  s.activity = s.pendingTools.size ? s.activity : 'Thinking';
}

// ── Codex CLI transcripts ──────────────────────────────────────────────────
function describeCodexTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'shell':
    case 'local_shell': {
      const cmd = Array.isArray(a.command) ? a.command.join(' ') : a.command || '';
      return cmd ? `Running: ${clip(cmd, 80)}` : 'Running a command';
    }
    case 'apply_patch':
      return 'Editing files';
    case 'update_plan':
      return 'Updating the plan';
    case 'view_image':
      return 'Looking at an image';
    case 'web_search':
      return `Searching the web: ${clip(a.query, 60)}`;
    default:
      return `Using ${name || 'a tool'}`;
  }
}

function codexText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** One line of a Codex rollout file: { timestamp, type, payload }. */
function applyCodexRecord(s, r, metaOnly) {
  const ts = Date.parse(r.timestamp) || 0;
  if (ts) {
    if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
    if (ts > s.lastActivity) s.lastActivity = ts;
  }
  const p = r.payload || {};
  if (r.type === 'session_meta' || r.type === 'turn_context') {
    setCwd(s, p.cwd);
    const branch = (p.git && (p.git.branch || p.git.ref)) || p.branch;
    if (branch && branch !== 'HEAD') s.branch = clip(branch, 80);
    return;
  }

  const takePrompt = (text) => {
    if (!isHumanPrompt(text, {})) return;
    const t = clip(text, 400);
    if (!s.goal) s.goal = t;
    if (metaOnly) return;
    s.lastPrompt = t;
    s.lastKind = 'prompt';
    s.status = 'working';
    s.waiting = null;
    s.activity = 'Reading your message';
  };

  if (r.type === 'event_msg') {
    if (p.type === 'user_message') return takePrompt(p.message || codexText(p.content));
    if (metaOnly) return;
    if (p.type === 'agent_message') {
      s.lastAssistant = clip(p.message || codexText(p.content), 900);
      s.lastKind = 'text';
    } else if (p.type === 'task_started') {
      s.status = 'working';
      s.lastKind = 'tool_use';
    } else if (p.type === 'task_complete') {
      if (p.last_agent_message) s.lastAssistant = clip(p.last_agent_message, 900);
      s.status = s.waiting ? 'needs_you' : 'your_turn';
      s.activity = null;
      s.lastKind = 'text';
    } else if (/approval_request/.test(p.type || '')) {
      // Codex asks before running a command or writing a patch
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : p.command;
      s.status = 'needs_you';
      s.waiting = {
        kind: 'permission',
        text: cmd ? 'Wants to run a command' : 'Wants to apply a patch',
        detail: clip(cmd || p.reason || p.patch, 300) || null,
      };
    } else if (p.type === 'thread_name_updated' && p.name) {
      s.customTitle = clip(p.name, 80);
    }
    return;
  }

  if (r.type !== 'response_item' || metaOnly) return;

  if (p.type === 'message') {
    const text = codexText(p.content);
    if (p.role === 'user') return takePrompt(text);
    if (p.role === 'assistant' && text.trim()) {
      s.lastAssistant = clip(text, 900);
      s.lastKind = 'text';
    }
    return;
  }

  if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
    let a = {};
    try {
      a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || p.action || {};
    } catch {
      a = {};
    }
    const name = p.name || (p.type === 'local_shell_call' ? 'shell' : 'tool');
    s.toolCount++;
    s.lastKind = 'tool_use';
    if (!s.waiting) s.status = 'working';
    if (name === 'update_plan' && Array.isArray(a.plan)) {
      s.tasks = new Map(
        a.plan.map((step, i) => [
          String(i),
          {
            id: String(i),
            subject: clip(step.step || step.title || '', 160),
            activeForm: null,
            status: ['pending', 'in_progress', 'completed'].includes(step.status) ? step.status : 'pending',
          },
        ]),
      );
      s.activity = 'Updating the plan';
    } else {
      s.pendingTools.set(p.call_id || `c${s.toolCount}`, { name, input: a, ts });
      s.activity = describeCodexTool(name, a);
    }
    return;
  }

  if (p.type === 'function_call_output' || p.type === 'local_shell_call_output' || p.type === 'custom_tool_call_output') {
    s.pendingTools.delete(p.call_id);
    if (s.waiting && s.waiting.kind === 'permission') {
      s.waiting = null;
      s.status = 'working';
    }
    s.lastKind = 'tool_result';
    if (!s.pendingTools.size) s.activity = 'Thinking';
    return;
  }
}

// Incremental transcript reader. Big files: metadata from the head, full parse
// of the tail, so a 200MB session doesn't stall the server.
function syncTranscript(s) {
  if (!s.transcriptPath) return false;
  let st;
  try {
    st = fs.statSync(s.transcriptPath);
  } catch {
    return false;
  }
  if (st.size < s.offset) {
    // file was rewritten; start over
    Object.assign(s, { offset: 0, partial: '', tasks: new Map(), agents: new Map(), pendingTools: new Map() });
  }
  if (st.size === s.offset) return false;

  let fd;
  try {
    fd = fs.openSync(s.transcriptPath, 'r');
  } catch {
    return false;
  }
  try {
    if (s.offset === 0 && st.size > BIG_FILE) {
      readRange(fd, s, 0, Math.min(512 * 1024, st.size), true);
      s.partial = '';
      const start = st.size - TAIL_BYTES;
      s.offset = start;
      s.skipFirstLine = true;
    }
    while (s.offset < st.size) {
      const len = Math.min(CHUNK, st.size - s.offset);
      readRange(fd, s, s.offset, len, false);
      s.offset += len;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!s.backfilled) {
    s.backfilled = true;
    finishBackfill(s);
  }
  return true;
}

function readRange(fd, s, pos, len, metaOnly) {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  let text = (metaOnly ? '' : s.partial) + buf.toString('utf8');
  const lines = text.split('\n');
  const rest = lines.pop();
  if (!metaOnly) s.partial = rest;
  for (let i = 0; i < lines.length; i++) {
    if (s.skipFirstLine && !metaOnly) {
      s.skipFirstLine = false;
      continue;
    }
    const line = lines[i];
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (s.format === 'codex') applyCodexRecord(s, rec, metaOnly);
    else applyRecord(s, rec, metaOnly);
  }
}

// After replaying history, settle status from where the transcript ended.
function finishBackfill(s) {
  s.live = true;
  const now = Date.now();
  // Foreground subagents whose result never arrived and are old: assume done
  for (const a of s.agents.values()) {
    if (a.status === 'running' && now - a.startedAt > 45 * 60_000) {
      a.status = 'done';
      a.endedAt = a.startedAt;
      a.activity = 'Reported back';
    }
  }
  if (s.waiting) s.status = 'needs_you';
  else if (s.lastKind === 'text') s.status = 'your_turn';
  else if (s.lastKind === 'prompt' || s.lastKind === 'tool_use' || s.lastKind === 'tool_result') {
    s.status = now - s.lastActivity < 5 * 60_000 ? 'working' : 'your_turn';
  }
  if (s.status === 'your_turn') s.activity = null;
}

// ── Hook events (fan-out from the Pixel Agents hook script) ────────────────
function handleHook(ev) {
  const sid = ev.session_id;
  if (!sid) return;
  const s = getSession(sid);
  const now = Date.now();
  s.hooked = true;
  s.lastHookAt = now;
  s.lastActivity = now;
  if (ev.transcript_path && !s.transcriptPath) s.transcriptPath = ev.transcript_path;
  if (ev.cwd && !s.cwd) setCwd(s, ev.cwd);
  syncTranscript(s);

  const name = ev.hook_event_name;

  // Events fired inside a subagent carry agent_id — route them to that seat.
  if (ev.agent_id && name !== 'SubagentStart' && name !== 'SubagentStop') {
    const a = findAgentByAgentId(s, ev.agent_id, ev.agent_type);
    if (a) {
      if (name === 'PreToolUse') a.activity = describeTool(ev.tool_name, ev.tool_input);
      if (name === 'PermissionRequest') {
        a.activity = 'Waiting for your permission';
        s.status = 'needs_you';
        s.waiting = {
          kind: 'permission',
          text: `${a.type} wants to: ${describeTool(ev.tool_name, ev.tool_input)}`,
          detail: permissionDetail(ev.tool_name, ev.tool_input),
        };
      }
      if (name === 'PostToolUse' && s.waiting && s.waiting.kind === 'permission') {
        s.waiting = null;
        s.status = 'working';
      }
      return;
    }
  }

  switch (name) {
    case 'SessionStart':
      s.ended = false;
      s.endedAt = 0;
      if (s.status === 'ended') s.status = 'your_turn';
      break;
    case 'UserPromptSubmit':
      s.status = 'working';
      s.waiting = null;
      if (ev.prompt && isHumanPrompt(ev.prompt, {})) {
        s.lastPrompt = clip(ev.prompt, 400);
        if (!s.goal) s.goal = s.lastPrompt;
      }
      break;
    case 'PreToolUse':
      if (ev.tool_name === 'AskUserQuestion' || ev.tool_name === 'ExitPlanMode') {
        s.status = 'needs_you';
        if (!s.waiting) {
          handleToolUse(s, ev.tool_use_id || `hook-${now}`, ev.tool_name, ev.tool_input, now);
          s.pendingTools.delete(ev.tool_use_id || `hook-${now}`);
        }
      } else {
        s.status = 'working';
        s.activity = describeTool(ev.tool_name, ev.tool_input);
      }
      break;
    case 'PermissionRequest':
      s.status = 'needs_you';
      s.waiting = {
        kind: 'permission',
        text: `Wants to: ${describeTool(ev.tool_name, ev.tool_input)}`,
        detail: permissionDetail(ev.tool_name, ev.tool_input),
      };
      break;
    case 'Notification': {
      const type = ev.notification_type || '';
      const msg = ev.message || '';
      if (type === 'permission_prompt' || /permission/i.test(msg)) {
        s.status = 'needs_you';
        if (!s.waiting) s.waiting = { kind: 'permission', text: clip(msg, 200) || 'Needs your permission' };
      } else if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) {
        if (s.status !== 'needs_you') {
          s.status = 'your_turn';
          s.activity = null;
        }
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (s.waiting && s.waiting.kind === 'permission') s.waiting = null;
      if (!s.waiting) s.status = 'working';
      break;
    case 'Stop':
      s.status = s.waiting && s.waiting.kind !== 'permission' ? 'needs_you' : 'your_turn';
      if (s.waiting && s.waiting.kind === 'permission') s.waiting = null;
      s.activity = null;
      if (ev.last_assistant_message) s.lastAssistant = clip(ev.last_assistant_message, 900);
      break;
    case 'SubagentStart': {
      const a = claimAgent(s, ev.agent_id, ev.agent_type);
      a.status = 'running';
      break;
    }
    case 'SubagentStop': {
      const a = findAgentByAgentId(s, ev.agent_id, ev.agent_type) || claimAgent(s, ev.agent_id, ev.agent_type);
      a.status = 'done';
      a.endedAt = now;
      a.activity = 'Reported back';
      break;
    }
    case 'TaskCompleted':
      break;
    case 'SessionEnd':
      s.ended = true;
      s.endedAt = now;
      s.status = 'ended';
      s.activity = null;
      s.waiting = null;
      break;
  }
}

function permissionDetail(tool, input) {
  const i = input || {};
  if (tool === 'Bash') return clip(i.command, 300);
  if (i.file_path) return i.file_path;
  if (i.url) return i.url;
  return clip(JSON.stringify(i), 300);
}

function findAgentByAgentId(s, agentId, agentType) {
  if (!agentId) return null;
  for (const a of s.agents.values()) if (a.agentId === agentId) return a;
  return claimAgent(s, agentId, agentType, true);
}

// Link a hook agent_id to the transcript's Agent tool call of the same type.
function claimAgent(s, agentId, agentType, noCreate) {
  const candidates = [...s.agents.values()]
    .filter((a) => !a.agentId && a.status === 'running' && (!agentType || a.type === agentType))
    .sort((x, y) => x.startedAt - y.startedAt);
  if (candidates[0]) {
    candidates[0].agentId = agentId;
    return candidates[0];
  }
  if (noCreate) return null;
  const a = {
    id: `hook-${agentId}`,
    agentId,
    type: agentType || 'agent',
    name: null,
    description: '',
    prompt: '',
    background: false,
    status: 'running',
    startedAt: Date.now(),
    endedAt: 0,
    activity: 'Reading the brief',
  };
  s.agents.set(a.id, a);
  return a;
}

// ── Discovery scan ─────────────────────────────────────────────────────────
// Roots are folders shaped like ~/.claude/projects (one subfolder per project,
// *.jsonl transcripts inside). Cowork roots are rediscovered every minute.
let coworkRoots = [];
let coworkRootsAt = 0;
const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'IndexedDB', 'Local Storage', 'Session Storage', 'Partitions', 'blob_storage', 'Crashpad', 'logs', 'node_modules', 'vm_bundles', 'Service Worker', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'shared_proto_db', 'WebStorage', 'Shared Dictionary', 'claude-code', 'claude-code-vm']);

function findProjectsDirs(dir, depth, out) {
  if (depth < 0 || out.length > 200) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.name === 'projects' && path.basename(dir) === '.claude') out.push(full);
    else findProjectsDirs(full, depth - 1, out);
  }
}

function coworkRootsCached() {
  const now = Date.now();
  if (now - coworkRootsAt > 60_000) {
    coworkRootsAt = now;
    const found = [];
    const lams = path.join(CLAUDE_APP_DIR, 'local-agent-mode-sessions');
    if (fs.existsSync(lams)) findProjectsDirs(lams, 9, found);
    else if (fs.existsSync(CLAUDE_APP_DIR)) findProjectsDirs(CLAUDE_APP_DIR, 7, found);
    coworkRoots = found;
  }
  return coworkRoots;
}

/** Every folder to watch, with the agent and parser that go with it. */
function transcriptRoots() {
  const out = [];
  for (const p of PROVIDERS) for (const dir of p.roots()) out.push({ dir, agent: p.agent, format: p.format, match: p.match });
  return out;
}

/**
 * The agents Agent Office knows how to read. Adding one means adding a row here
 * plus a parser — see CONTRIBUTING.md. Anything not listed can still get a desk
 * by writing a beacon.
 */
const PROVIDERS = [
  {
    id: 'claude-code',
    agent: 'Claude Code',
    format: 'claude',
    roots: () => [PROJECTS_DIR, ...EXTRA_TRANSCRIPT_ROOTS],
    match: (f) => f.endsWith('.jsonl'),
  },
  {
    id: 'cowork',
    agent: 'Cowork',
    format: 'claude',
    roots: () => coworkRootsCached(),
    match: (f) => f.endsWith('.jsonl'),
  },
];

/** Codex rollout files, newest day folders first: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
function codexFiles(now) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth < 0 || out.length > 200) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth - 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(CODEX_DIR, 4);
  return out;
}

function scan() {
  const now = Date.now();
  let changed = false;

  for (const file of codexFiles(now)) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const sid = `codex:${path.basename(file, '.jsonl')}`;
    const known = sessions.get(sid);
    if (!known && (now - st.mtimeMs > LOOKBACK_MS || st.size < 1024)) continue;
    const s = known || getSession(sid);
    if (!known) {
      s.agent = 'Codex';
      s.format = 'codex';
    }
    if (!s.transcriptPath) s.transcriptPath = file;
    if (syncTranscript(s)) changed = true;
  }

  for (const root of transcriptRoots()) {
    let dirs;
    try {
      dirs = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root.dir, d.name);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!root.match(f)) continue;
        const file = path.join(dir, f);
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        const sid = f.slice(0, -6);
        const known = sessions.get(sid);
        if (!known && (now - st.mtimeMs > LOOKBACK_MS || st.size < 2048)) continue;
        const s = known || getSession(sid);
        if (!known) {
          s.agent = root.agent;
          s.format = root.format;
        }
        if (!s.transcriptPath) s.transcriptPath = file;
        if (syncTranscript(s)) changed = true;
      }
    }
  }
  if (scanBeacons()) changed = true;
  // Time-based settling for sessions without live hooks
  for (const s of sessions.values()) {
    if (s.beacon) continue;
    if (s.hooked && now - s.lastHookAt < 10 * 60_000) continue;
    if (s.status === 'working' && now - s.lastActivity > 5 * 60_000) {
      s.status = 'your_turn';
      s.activity = null;
      changed = true;
    }
  }
  if (changed) broadcast();
}

// ── Reading a conversation back out of a transcript ────────────────────────
const CONVO_TAIL = 400 * 1024;

function tailLines(file, bytes) {
  let fd, st;
  try {
    st = fs.statSync(file);
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably a fragment
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/** The last `limit` turns of a session, for the conversation panel. */
function conversation(s, limit = 60) {
  if (!s || !s.transcriptPath) return [];
  const out = [];
  const push = (role, text, ts, extra) => {
    if (!text || !String(text).trim()) return;
    const last = out[out.length - 1];
    // fold consecutive tool lines from the same turn into one entry
    if (role === 'tool' && last && last.role === 'tool' && last.ts === ts) {
      last.text += `\n${text}`;
      return;
    }
    out.push({ role, text: clip(text, role === 'tool' ? 160 : 4000), ts: ts || 0, ...(extra || {}) });
  };

  for (const line of tailLines(s.transcriptPath, CONVO_TAIL)) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(r.timestamp) || 0;

    if (s.format === 'codex') {
      const p = r.payload || {};
      if (r.type === 'event_msg') {
        if (p.type === 'user_message') push('user', p.message || codexText(p.content), ts);
        else if (p.type === 'agent_message') push('assistant', p.message || codexText(p.content), ts);
      } else if (r.type === 'response_item') {
        if (p.type === 'message') push(p.role === 'user' ? 'user' : 'assistant', codexText(p.content), ts);
        else if (p.type === 'function_call' || p.type === 'local_shell_call') {
          let a = {};
          try {
            a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || {};
          } catch {
            a = {};
          }
          push('tool', describeCodexTool(p.name || 'shell', a), ts);
        }
      }
      continue;
    }

    if (r.isSidechain) continue;
    const content = r.message && r.message.content;
    if (r.type === 'user') {
      if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) continue;
      const text = textOf(content);
      if (isHumanPrompt(text, r)) push('user', text, ts);
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c) continue;
        if (c.type === 'text') push('assistant', c.text, ts);
        else if (c.type === 'tool_use') push('tool', describeTool(c.name, c.input), ts, { tool: c.name });
      }
    }
  }
  return out.slice(-limit);
}

// ── Replies (opt-in: --allow-replies) ──────────────────────────────────────
// A reply resumes an idle Claude Code session in the background with your
// message, through the supported `claude --bg --resume` command. A session that
// is open somewhere (a terminal, the desktop app) is never touched: you answer
// it there. A reply is not an approval — the resumed session still asks before
// anything that needs permission, and the board shows that as "needs you".
const CLAUDE_SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const REPLY_MAX_CHARS = 8000;
const replying = new Set(); // session ids with a reply on its way

/** Claude Code's own record of this session if it is running right now. */
function liveRegistryEntry(sessionId, dir = CLAUDE_SESSIONS_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (e.sessionId !== sessionId || !e.pid) continue;
      process.kill(e.pid, 0); // throws if that process is gone
      return e;
    } catch {
      /* gone or malformed */
    }
  }
  return null;
}

/** How a reply would reach this session: resume it, stop-then-resume, or refuse (and why). */
function replyPlan(s, live) {
  if (!s) return { action: 'refuse', reason: 'No such session.' };
  if (s.beacon || s.format !== 'claude' || s.agent !== 'Claude Code') {
    return { action: 'refuse', reason: 'Replies only reach Claude Code sessions on this Mac.' };
  }
  if (!s.cwd) return { action: 'refuse', reason: "This session's folder isn't known yet." };
  if (!live) return { action: 'resume' };
  if (live.kind === 'bg' || live.kind === 'background') {
    // An idle background session can be stopped (its conversation is kept) and resumed with the reply
    if (live.status === 'idle') return { action: 'stop-then-resume' };
    return { action: 'refuse', reason: "It's in the middle of a turn. Reply once it has finished." };
  }
  const where = live.entrypoint === 'claude-desktop' ? 'in the Claude app' : 'in a terminal';
  return { action: 'refuse', reason: `This session is open ${where}. Reply there.` };
}

function runClaude(argv, cwd) {
  return new Promise((resolve) => {
    execFile('claude', argv, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      const said = String(stderr || stdout || '').trim();
      if (err && err.code === 'ENOENT') return resolve({ ok: false, said: "Couldn't find the `claude` command on this server's PATH." });
      resolve({ ok: !err, said: said || (err ? err.message : '') });
    });
  });
}

async function sendReply(s, text) {
  if (s && replying.has(s.id)) return { ok: false, reason: 'A reply to this session is already on its way.' };
  const plan = replyPlan(s, s && liveRegistryEntry(s.id));
  if (plan.action === 'refuse') return { ok: false, reason: plan.reason };
  replying.add(s.id);
  try {
    if (plan.action === 'stop-then-resume') {
      const stop = await runClaude(['stop', s.id.slice(0, 8)], s.cwd); // `stop` takes the short id
      if (!stop.ok) return { ok: false, reason: clip(`Couldn't pause the background session: ${stop.said}`, 400) };
      for (let i = 0; i < 20 && liveRegistryEntry(s.id); i++) await new Promise((r) => setTimeout(r, 250));
      if (liveRegistryEntry(s.id)) return { ok: false, reason: "The background session didn't stop in time. Try again." };
    }
    // `--` so a message that starts with a dash is never read as an option
    const r = await runClaude(['--bg', '--resume', s.id, '--', text], s.cwd);
    return r.ok ? { ok: true } : { ok: false, reason: clip(r.said || 'claude exited with an error.', 400) };
  } finally {
    replying.delete(s.id);
  }
}

// ── Beacons from cloud sessions ────────────────────────────────────────────
const BEACON_STATUSES = new Set(['working', 'needs_you', 'your_turn', 'ended']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed']);

function scanBeacons() {
  let files;
  try {
    files = fs.readdirSync(BEACON_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
  const seen = new Set();
  let changed = false;
  for (const f of files) {
    const full = path.join(BEACON_DIR, f);
    let b, st;
    try {
      st = fs.statSync(full);
      if (st.size > 256 * 1024) continue;
      b = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (!b || typeof b !== 'object') continue;
    const key = `beacon:${String(b.id || f.slice(0, -5)).slice(0, 80)}`;
    seen.add(key);
    const s = getSession(key);
    s.beacon = true;
    s.kind = 'beacon';
    s.agent = clip(b.agent, 24) || 'Agent';
    s.surface = clip(b.surface, 20) || 'cloud';
    s.project = s.project || null;
    s.customTitle = clip(b.title, 80) || s.customTitle;
    s.goal = clip(b.goal, 400) || s.goal;
    s.lastPrompt = clip(b.lastPrompt, 400) || null;
    s.lastAssistant = clip(b.lastAssistant, 900) || null;
    s.activity = clip(b.activity, 140) || null;
    s.cwd = clip(b.where, 200) || null;
    s.branch = clip(b.branch, 80) || null;
    s.link = typeof b.link === 'string' && /^https:\/\//.test(b.link) ? b.link : null;
    s.waiting =
      b.waiting && b.waiting.text
        ? { kind: b.waiting.kind || 'question', text: clip(b.waiting.text, 300), detail: clip(b.waiting.detail, 600) || null }
        : null;
    s.status = BEACON_STATUSES.has(b.status) ? b.status : s.waiting ? 'needs_you' : 'your_turn';
    s.ended = s.status === 'ended';
    s.tasks = new Map(
      (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 40).map((t, i) => [
        String(i),
        {
          id: String(i),
          subject: clip(t.subject || t.content || '', 160),
          activeForm: clip(t.activeForm, 80) || null,
          status: TASK_STATUSES.has(t.status) ? t.status : 'pending',
        },
      ]),
    );
    s.agents = new Map(
      (Array.isArray(b.agents) ? b.agents : []).slice(0, 10).map((a, i) => [
        `b${i}`,
        {
          id: `b${i}`,
          agentId: null,
          type: clip(a.type, 30) || 'agent',
          name: clip(a.name, 30) || null,
          description: clip(a.description, 120) || '',
          prompt: '',
          background: false,
          status: a.status === 'done' || a.status === 'failed' ? a.status : 'running',
          activity: clip(a.activity, 100) || null,
          startedAt: Number(a.startedAt) || Date.now(),
          endedAt: Number(a.endedAt) || 0,
        },
      ]),
    );
    s.startedAt = Number(b.startedAt) || s.startedAt || st.mtimeMs;
    s.lastActivity = Number(b.updatedAt) || st.mtimeMs;
    if (s.status === 'ended' && !s.endedAt) s.endedAt = s.lastActivity;
    changed = true;
  }
  for (const key of [...sessions.keys()]) {
    if (key.startsWith('beacon:') && !seen.has(key)) {
      sessions.delete(key);
      changed = true;
    }
  }
  return changed;
}

// ── Issue backlog via glab / gh ────────────────────────────────────────────
const backlog = new Map(); // repoRoot -> { repo, root, forge, issues, error, fetchedAt }

function runJson(root, cmd, argsList) {
  return new Promise((resolve) => {
    execFile(cmd, argsList, { cwd: root, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().trim().split('\n')[0];
        return resolve({ error: /ENOENT/.test(msg) ? `${cmd} not found on PATH` : msg });
      }
      try {
        resolve({ data: JSON.parse(stdout) });
      } catch {
        resolve({ error: `Could not read ${cmd} output` });
      }
    });
  });
}

/** Which tracker this checkout belongs to, from its git remotes. */
function detectForge(root) {
  try {
    const cfg = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    if (/github\.com/i.test(cfg)) return 'github';
    if (/gitlab/i.test(cfg)) return 'gitlab';
  } catch {
    /* not a git checkout, or unreadable */
  }
  return null;
}

async function fetchGitlab(root) {
  let res = await runJson(root, 'glab', ['issue', 'list', '--output', 'json', '--per-page', '60']);
  if (res.error && /unknown flag|output/i.test(res.error)) {
    res = await runJson(root, 'glab', ['issue', 'list', '-F', 'json', '--per-page', '60']);
  }
  if (res.error) return res;
  const issues = (Array.isArray(res.data) ? res.data : []).map((i) => ({
    iid: i.iid,
    title: i.title,
    url: i.web_url,
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).slice(0, 4),
    assignees: (i.assignees || []).map((a) => a.username || a.name).filter(Boolean),
    updatedAt: Date.parse(i.updated_at) || 0,
  }));
  return { issues };
}

async function fetchGithub(root) {
  const res = await runJson(root, 'gh', [
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '60',
    '--json',
    'number,title,url,labels,assignees,updatedAt',
  ]);
  if (res.error) return res;
  const issues = (Array.isArray(res.data) ? res.data : []).map((i) => ({
    iid: i.number,
    title: i.title,
    url: i.url,
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).slice(0, 4),
    assignees: (i.assignees || []).map((a) => a.login || a.name).filter(Boolean),
    updatedAt: Date.parse(i.updatedAt) || 0,
  }));
  return { issues };
}

async function fetchIssues(root) {
  const forge = FORGE === 'auto' ? detectForge(root) : FORGE;
  if (forge === 'github') return { forge, ...(await fetchGithub(root)) };
  if (forge === 'gitlab') return { forge, ...(await fetchGitlab(root)) };
  // No remote we recognise: try both, quietly, and keep whichever answers
  const gl = await fetchGitlab(root);
  if (gl.issues) return { forge: 'gitlab', ...gl };
  const gh = await fetchGithub(root);
  if (gh.issues) return { forge: 'github', ...gh };
  return { forge: null, error: 'No GitLab or GitHub issues (is glab or gh set up in this repo?)' };
}

async function refreshBacklog() {
  if (FORGE === 'none') return;
  const roots = new Set(EXTRA_REPOS);
  for (const s of visibleSessions()) if (s.repoRoot) roots.add(s.repoRoot);
  for (const root of roots) {
    // Only ask inside an actual git checkout — a stray cwd like "/" isn't one
    if (!root || root === '/' || !fs.existsSync(path.join(root, '.git'))) continue;
    const res = await fetchIssues(root);
    const prev = backlog.get(root);
    backlog.set(root, {
      repo: path.basename(root),
      root,
      forge: res.forge || (prev && prev.forge) || null,
      issues: res.issues || (prev ? prev.issues : []),
      error: res.error || null,
      fetchedAt: Date.now(),
    });
  }
  broadcast();
}

// Which issues is a session working on? Branch, worktree, prompts, task cards.
function issueRefs(s) {
  const refs = new Set();
  const add = (n) => n && refs.add(Number(n));
  for (const src of [s.branch, s.worktree]) {
    if (!src) continue;
    add((src.match(/^(\d+)[-_]/) || [])[1]);
    add((src.match(/(?:issue|fle|gl)[-_]?(\d+)/i) || [])[1]);
  }
  const texts = [s.goal, s.lastPrompt, ...[...s.tasks.values()].map((t) => t.subject)];
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/(?:^|[\s(])#(\d{1,6})\b/g)) add(m[1]);
    for (const m of t.matchAll(/\/issues\/(\d+)/g)) add(m[1]);
    for (const m of t.matchAll(/\bFLE-(\d+)\b/gi)) add(m[1]);
    for (const m of t.matchAll(/\bissue\s+(\d+)\b/gi)) add(m[1]);
  }
  return [...refs];
}

// ── State for the UI ───────────────────────────────────────────────────────
function visibleSessions() {
  const now = Date.now();
  return [...sessions.values()].filter((s) => {
    if (s.beacon) return now - s.lastActivity < LOOKBACK_MS;
    if (!s.goal && !s.toolCount && !s.hooked) return false;
    if (s.ended) return now - s.endedAt < ENDED_VISIBLE_MS;
    return now - s.lastActivity < LOOKBACK_MS || (s.hooked && s.lastHookAt > STARTED_AT);
  });
}

function snapshot() {
  const now = Date.now();
  const list = visibleSessions()
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
    .map((s) => {
      const agents = [...s.agents.values()]
        .filter((a) => a.status === 'running' || now - (a.endedAt || a.startedAt) < 20 * 60_000)
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-10);
      const tasks = [...s.tasks.values()].filter((t) => t.status !== 'deleted');
      return {
        id: s.id,
        title:
          s.customTitle ||
          humanize(s.worktree) ||
          (s.summary && clip(s.summary, 60)) ||
          clip(s.goal, 60) ||
          s.project ||
          s.id.slice(0, 8),
        kind: s.kind,
        agent: s.agent,
        where: s.beacon ? s.surface || 'cloud' : s.project || null,
        beacon: !!s.beacon,
        surface: s.surface,
        link: s.link,
        stale: !!s.beacon && now - s.lastActivity > BEACON_STALE_MS,
        project: s.project,
        repoRoot: s.repoRoot,
        worktree: s.worktree,
        branch: s.branch,
        cwd: s.cwd,
        status: s.status,
        activity: s.activity,
        waiting: s.waiting,
        goal: s.goal,
        lastPrompt: s.lastPrompt,
        lastAssistant: s.lastAssistant,
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
        hooked: s.hooked && now - s.lastHookAt < 60 * 60_000,
        issues: issueRefs(s),
        tasks: tasks.map(({ id, subject, activeForm, status, owner }) => ({ id, subject, activeForm, status, owner })),
        agents: agents.map((a) => ({
          id: a.id,
          type: a.type,
          name: a.name,
          description: a.description,
          prompt: a.prompt,
          status: a.status,
          background: a.background,
          activity: a.activity,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
        })),
      };
    });
  return {
    now,
    sessions: list,
    backlog: [...backlog.values()],
    hooksLive: [...sessions.values()].some((s) => s.lastHookAt > STARTED_AT),
    demo: DEMO,
    replies: ALLOW_REPLIES,
  };
}

// ── Server-sent events ─────────────────────────────────────────────────────
const clients = new Set();
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, 250);
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/** A POST from the board: our own origin (if the browser says) and the page token. */
function pageActionAllowed(headers, port = PORT) {
  const origin = headers.origin;
  if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) return false;
  return headers['x-agent-office-token'] === PAGE_TOKEN;
}

const server = http.createServer((req, res) => {
  // Refuse anything not addressed to localhost (DNS-rebinding guard)
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname.startsWith('/api/hooks/')) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) tooBig = true;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      if (tooBig) return;
      try {
        handleHook(JSON.parse(body));
        broadcast();
      } catch (e) {
        /* ignore malformed */
      }
    });
    return;
  }

  // Every other POST is an action from the board itself, never from another site
  if (req.method === 'POST' && !pageActionAllowed(req.headers)) {
    res.writeHead(403).end();
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const convo = url.pathname.match(/^\/api\/session\/(.+)\/messages$/);
  if (convo) {
    const s = sessions.get(decodeURIComponent(convo[1]));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (!s) return res.end(JSON.stringify({ messages: [], note: 'No such session.' }));
    if (s.beacon)
      return res.end(
        JSON.stringify({
          messages: [],
          note: 'This session reports in with a beacon, so only its own summary is available here.',
        }),
      );
    return res.end(JSON.stringify({ messages: conversation(s), note: null }));
  }

  // Bring the session's own window to the front, so you can answer it there.
  const reveal = url.pathname.match(/^\/api\/session\/(.+)\/reveal$/);
  if (reveal && req.method === 'POST') {
    const s = sessions.get(decodeURIComponent(reveal[1]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!s || !s.cwd || process.platform !== 'darwin') {
      return res.end(JSON.stringify({ ok: false, reason: 'Only supported for local sessions on macOS.' }));
    }
    execFile('open', ['-a', 'Terminal', s.cwd], () => {});
    return res.end(JSON.stringify({ ok: true }));
  }

  const reply = url.pathname.match(/^\/api\/session\/(.+)\/reply$/);
  if (reply && req.method === 'POST') {
    const answer = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
    if (!ALLOW_REPLIES) return answer(403, { ok: false, reason: 'Replies are off. Start the server with --allow-replies.' });
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return answer(415, { ok: false, reason: 'Send JSON.' });
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let text = '';
      try {
        text = String(JSON.parse(body).text || '').trim();
      } catch {}
      if (!text) return answer(400, { ok: false, reason: 'Nothing to send.' });
      if (text.length > REPLY_MAX_CHARS) return answer(400, { ok: false, reason: `Keep it under ${REPLY_MAX_CHARS} characters.` });
      if (DEMO) return answer(200, { ok: false, reason: 'These are pretend sessions, so the reply goes nowhere.' });
      sendReply(sessions.get(decodeURIComponent(reply[1])), text).then((r) => answer(200, r));
    });
    return;
  }

  if (url.pathname === '/api/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          roots: transcriptRoots(),
          tracked: [...sessions.values()].map((s) => ({ id: s.id, kind: s.kind, file: s.transcriptPath, status: s.status, hooked: s.hooked, visible: visibleSessions().includes(s) })),
          backlog: [...backlog.values()].map((b) => ({ root: b.root, count: b.issues.length, error: b.error })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (url.pathname === '/api/refresh-backlog' && req.method === 'POST') {
    refreshBacklog();
    res.writeHead(202).end();
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(full === path.join(PUBLIC_DIR, 'index.html') ? data.toString('utf8').replace('__PAGE_TOKEN__', PAGE_TOKEN) : data);
  });
});

// ── Registry (so the Pixel Agents hook script sends us events too) ─────────
const registryFiles = [];
function register() {
  const entry = { port: PORT, pid: process.pid, token: TOKEN, startedAt: STARTED_AT, servesSpa: false, protocol: 1 };
  for (const dir of [REGISTRY_DIR, PIXEL_REGISTRY_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${process.pid}-${PORT}.json`);
      fs.writeFileSync(file + '.tmp', JSON.stringify(entry, null, 2), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      registryFiles.push(file);
    } catch {
      /* one registry failing just means fewer hook sources */
    }
  }
  if (!registryFiles.length) console.warn('Could not register for hook events — falling back to transcripts only.');
}
function unregister() {
  for (const f of registryFiles) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

// ── Hook install / uninstall ───────────────────────────────────────────────
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  const tmp = `${CLAUDE_SETTINGS}.agent-office-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CLAUDE_SETTINGS);
}

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes('agent-office');

function installHooks() {
  const settings = readSettings();
  const backup = `${CLAUDE_SETTINGS}.agent-office.backup`;
  if (fs.existsSync(CLAUDE_SETTINGS) && !fs.existsSync(backup)) fs.copyFileSync(CLAUDE_SETTINGS, backup);
  settings.hooks = settings.hooks || {};
  const command = `node ${JSON.stringify(HOOK_SCRIPT)}`;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks || []).length);
    kept.push({ matcher: '*', hooks: [{ type: 'command', command }] });
    settings.hooks[event] = kept;
  }
  writeSettings(settings);
  console.log(`Installed Agent Office hooks in ${CLAUDE_SETTINGS}`);
  console.log(`A copy of your previous settings is at ${backup}`);
  console.log('Restart any running Claude Code sessions to pick them up.');
}

function uninstallHooks() {
  const settings = readSettings();
  if (!settings.hooks) {
    console.log('No hooks to remove.');
    return;
  }
  for (const event of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks || []).length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeSettings(settings);
  console.log('Removed Agent Office hooks. Your other hooks were left alone.');
}
process.on('exit', unregister);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// ── Demo mode ──────────────────────────────────────────────────────────────
function startDemo() {
  require('./demo.js')({ sessions, newSession, backlog, broadcast });
}

// ── Boot ───────────────────────────────────────────────────────────────────
// ── Exports for tests ──────────────────────────────────────────────────────
module.exports = {
  newSession,
  getSession,
  sessions,
  applyRecord,
  applyCodexRecord,
  describeTool,
  describeCodexTool,
  issueRefs,
  detectForge,
  handleHook,
  snapshot,
  pageActionAllowed,
  PAGE_TOKEN,
  replyPlan,
  liveRegistryEntry,
  setCwd,
  humanize,
};

// ── Boot (only when run directly, so tests can import the parts) ───────────
if (require.main === module) {
  if (args['install-hooks']) {
    installHooks();
    process.exit(0);
  }
  if (args['uninstall-hooks']) {
    uninstallHooks();
    process.exit(0);
  }

  server.listen(PORT, HOST, () => {
    console.log(`\n  Agent Office  →  http://localhost:${PORT}\n`);
    if (DEMO) {
      console.log('  Demo mode: showing a pretend team.\n');
      startDemo();
      return;
    }
    register();
    try {
      fs.mkdirSync(BEACON_DIR, { recursive: true });
    } catch {}
    console.log(`  Cloud sessions can report in by writing JSON into ${BEACON_DIR}\n`);
    if (ALLOW_REPLIES) console.log('  Replies are ON: the board can resume idle Claude Code sessions with a message you type.\n');
    const settings = readSettings();
    const installed = JSON.stringify(settings.hooks || {}).includes('agent-office');
    if (!installed) {
      console.log('  Tip: run `node server.js --install-hooks` for live updates (permission prompts, tool activity).');
    }
    scan();
    setInterval(scan, SCAN_INTERVAL_MS);
    setTimeout(refreshBacklog, 1500);
    setInterval(refreshBacklog, GLAB_INTERVAL_MS);
    setInterval(broadcast, 15_000); // keep "x min ago" fresh
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy — try --port ${PORT + 1}` : e.message);
    process.exit(1);
  });
}
