'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { newSession, applyRecord, applyCodexRecord, describeTool, describeCodexTool, issueRefs, humanize } = require('../server.js');

const claude = (over) => ({
  timestamp: new Date().toISOString(),
  cwd: '/home/dev/acme/.claude/worktrees/212-progress-a1b2c3',
  gitBranch: '212-progress',
  ...over,
});

test('a Claude transcript yields goal, branch, project and worktree', () => {
  const s = newSession('s1');
  applyRecord(s, claude({ type: 'user', message: { role: 'user', content: 'Fix #212 and add a test' } }));
  assert.equal(s.goal, 'Fix #212 and add a test');
  assert.equal(s.project, 'acme');
  assert.equal(s.branch, '212-progress');
  assert.equal(s.status, 'working');
});

test('slash commands and system text are not treated as prompts', () => {
  const s = newSession('s2');
  applyRecord(s, claude({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }));
  assert.equal(s.goal, null);
});

test('task cards come from TaskCreate and TaskUpdate', () => {
  const s = newSession('s3');
  applyRecord(s, claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Write the test' } }] } }));
  applyRecord(s, claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Task #1 created successfully: Write the test' }] } }));
  applyRecord(s, claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } }));
  applyRecord(s, claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }));
  const tasks = [...s.tasks.values()];
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'completed');
});

test('TodoWrite replaces the whole board', () => {
  const s = newSession('s4');
  const todos = [
    { content: 'One', status: 'completed' },
    { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
  ];
  applyRecord(s, claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos } }] } }));
  assert.deepEqual([...s.tasks.values()].map((t) => t.status), ['completed', 'in_progress']);
});

test('a subagent gets a seat and is released when it reports back', () => {
  const s = newSession('s5');
  applyRecord(s, claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find the bug' } }] } }));
  assert.equal([...s.agents.values()][0].status, 'running');
  applyRecord(s, claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'found it' }] } }));
  assert.equal([...s.agents.values()][0].status, 'done');
});

test('a question to the user marks the session as needing you', () => {
  const s = newSession('s6');
  applyRecord(s, claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Per line or total?' }] } }] } }));
  assert.equal(s.status, 'needs_you');
  assert.match(s.waiting.text, /Per line or total\?/);
});

const codex = (type, payload) => ({ timestamp: new Date().toISOString(), type, payload });

test('a Codex rollout yields cwd, prompt and plan cards', () => {
  const s = newSession('c1');
  s.format = 'codex';
  applyCodexRecord(s, codex('session_meta', { cwd: '/home/dev/acme', git: { branch: 'codex/fix' } }));
  applyCodexRecord(s, codex('event_msg', { type: 'user_message', message: 'Fix the rota colours' }));
  applyCodexRecord(s, codex('response_item', {
    type: 'function_call',
    name: 'update_plan',
    call_id: 'p1',
    arguments: JSON.stringify({ plan: [{ step: 'Find it', status: 'completed' }, { step: 'Fix it', status: 'in_progress' }] }),
  }));
  assert.equal(s.project, 'acme');
  assert.equal(s.branch, 'codex/fix');
  assert.equal(s.goal, 'Fix the rota colours');
  assert.deepEqual([...s.tasks.values()].map((t) => t.status), ['completed', 'in_progress']);
});

test('Codex approval requests need you, and the output clears them', () => {
  const s = newSession('c2');
  s.format = 'codex';
  applyCodexRecord(s, codex('event_msg', { type: 'exec_approval_request', command: ['rm', '-rf', 'build'] }));
  assert.equal(s.status, 'needs_you');
  applyCodexRecord(s, codex('response_item', { type: 'function_call_output', call_id: 'x', output: 'done' }));
  assert.equal(s.status, 'working');
});

test('Codex task_complete ends the turn', () => {
  const s = newSession('c3');
  s.format = 'codex';
  applyCodexRecord(s, codex('event_msg', { type: 'task_complete', last_agent_message: 'All done.' }));
  assert.equal(s.status, 'your_turn');
  assert.equal(s.lastAssistant, 'All done.');
});

test('issue numbers are found in branches, worktrees and text', () => {
  const s = newSession('i1');
  s.branch = '212-progress';
  s.goal = 'Also look at #215 and FLE-231';
  s.tasks = new Map([['1', { subject: 'Close issue 99', status: 'pending' }]]);
  const refs = issueRefs(s).sort((a, b) => a - b);
  assert.deepEqual(refs, [99, 212, 215, 231]);
});

test('tool descriptions read like plain English', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b/c.py' }), 'Reading c.py');
  assert.equal(describeTool('Bash', { command: 'pytest', description: 'Run the tests' }), 'Run the tests');
  assert.equal(describeCodexTool('shell', { command: ['pytest', '-q'] }), 'Running: pytest -q');
});

test('worktree names become readable titles', () => {
  assert.equal(humanize('address-pin-google-maps-45677c'), 'address pin google maps');
});

test('board actions need our origin and the page token', () => {
  const { pageActionAllowed, PAGE_TOKEN } = require('../server.js');
  const token = { 'x-agent-office-token': PAGE_TOKEN };
  assert.equal(pageActionAllowed({ ...token, origin: 'http://localhost:3200' }, 3200), true);
  assert.equal(pageActionAllowed({ ...token, origin: 'http://127.0.0.1:3200' }, 3200), true);
  assert.equal(pageActionAllowed(token, 3200), true); // same-origin requests may omit Origin
  assert.equal(pageActionAllowed({ ...token, origin: 'https://evil.example' }, 3200), false);
  assert.equal(pageActionAllowed({ ...token, origin: 'http://localhost:9999' }, 3200), false);
  assert.equal(pageActionAllowed({ origin: 'http://localhost:3200' }, 3200), false);
  assert.equal(pageActionAllowed({ 'x-agent-office-token': 'guess', origin: 'http://localhost:3200' }, 3200), false);
});
