// Pretend team for `node server.js --demo` — lets you see the office without live sessions.
'use strict';

module.exports = function startDemo({ sessions, newSession, backlog, broadcast }) {
  const now = Date.now();
  const min = 60_000;

  function make(id, o) {
    const s = Object.assign(newSession(id), o);
    s.tasks = new Map((o.tasks || []).map((t, i) => [String(i + 1), { id: String(i + 1), ...t }]));
    s.agents = new Map((o.agents || []).map((a, i) => [`a${id}${i}`, { id: `a${id}${i}`, startedAt: now - (10 - i) * min, endedAt: a.status === 'done' ? now - 2 * min : 0, ...a }]));
    s.toolCount = 10;
    s.hooked = true;
    s.lastHookAt = now;
    sessions.set(id, s);
    return s;
  }

  make('demo-1', {
    cwd: '/home/dev/acme-api/.claude/worktrees/top-bugs-2347e2',
    repoRoot: '/home/dev/acme-api',
    project: 'acme-api',
    worktree: 'top-bugs-2347e2',
    branch: 'fix/top-bugs',
    startedAt: now - 95 * min,
    lastActivity: now,
    status: 'working',
    activity: 'Run the progress tests',
    goal: 'Work through the top 10 active bugs from GitLab (#212, #215, #219 first). One commit per fix, tests for each.',
    lastPrompt: 'Carry on with #215 next, then #219.',
    lastAssistant: '#212 is fixed — the progress bar bar was dividing by stops including cancelled ones. Moving on to #215.',
    tasks: [
      { subject: 'Fix progress bar % counting cancelled stops (#212)', status: 'completed' },
      { subject: 'Reproduce card assignment 500 (#215)', status: 'completed' },
      { subject: 'Fix card assignment on inactive vehicles (#215)', status: 'in_progress', activeForm: 'Fixing card assignment' },
      { subject: 'Walkaround photos rotate on iOS (#219)', status: 'in_progress', activeForm: 'Investigating EXIF rotation' },
      { subject: 'Status badge colour wrong for holiday (#221)', status: 'pending' },
      { subject: 'Payout export rounding (#224)', status: 'pending' },
      { subject: 'Wiki search ignores postcodes (#226)', status: 'pending' },
      { subject: 'Run full test suite and open MR', status: 'pending' },
    ],
    agents: [
      { type: 'Explore', description: 'Find where card assignment validates vehicle state', status: 'running', activity: 'Searching code for “assign_fuel_card”' },
      { type: 'Explore', description: 'Trace photo upload photo upload pipeline', status: 'running', activity: 'Reading photo_upload.py' },
      { type: 'general-purpose', description: 'Write regression test for progress bar', status: 'done', activity: 'Reported back' },
    ],
  });

  make('demo-2', {
    cwd: '/home/dev/acme-api/.claude/worktrees/map-pin-override-45677c',
    repoRoot: '/home/dev/acme-api',
    project: 'acme-api',
    worktree: 'map-pin-override-45677c',
    branch: '198-map-pin-override',
    startedAt: now - 60 * min,
    lastActivity: now - 3 * min,
    status: 'needs_you',
    activity: 'Waiting for your permission',
    waiting: { kind: 'permission', text: 'Wants to: Apply the new address_pins migration', detail: 'python manage.py migrate addresses 0014_address_pin_latlng' },
    goal: 'Let admins drop a Google Maps pin on an address when the geocode is wrong (#198).',
    lastPrompt: 'Yes, store lat/lng on the address, not the stop.',
    lastAssistant: 'Migration is written. I need to run it against your local database to test the pin picker.',
    tasks: [
      { subject: 'Add lat/lng override fields to Address', status: 'completed' },
      { subject: 'Pin picker component with Google Maps', status: 'completed' },
      { subject: 'Run migration and test locally', status: 'in_progress', activeForm: 'Running migration' },
      { subject: 'Use override in route optimiser', status: 'pending' },
      { subject: 'Open MR', status: 'pending' },
    ],
    agents: [{ type: 'Explore', description: 'Check how route optimiser reads coordinates', status: 'done', activity: 'Reported back' }],
  });

  make('demo-3', {
    cwd: '/home/dev/acme-site/.claude/worktrees/design-system-handover-518e40',
    repoRoot: '/home/dev/acme-site',
    project: 'acme-site',
    worktree: 'design-system-handover-518e40',
    branch: 'design-system-handover',
    startedAt: now - 180 * min,
    lastActivity: now - 140 * min,
    status: 'your_turn',
    activity: null,
    goal: 'Hand over the UX/UI redesign: tidy the component library and write the handover doc.',
    lastPrompt: 'Finish the handover doc.',
    lastAssistant: 'The handover doc is done and the MR is open. Do you want the pricing page redesign in this MR too, or a separate one?',
    tasks: [
      { subject: 'Audit component library', status: 'completed' },
      { subject: 'Consolidate button variants', status: 'completed' },
      { subject: 'Write HANDOVER.md', status: 'completed' },
      { subject: 'Open MR', status: 'completed' },
    ],
    agents: [],
  });

  make('demo-4', {
    cwd: '/home/dev/acme-api/.claude/worktrees/payouts-export-9c1d2e',
    repoRoot: '/home/dev/acme-api',
    project: 'acme-api',
    worktree: 'payouts-export-9c1d2e',
    branch: 'payouts-export',
    startedAt: now - 30 * min,
    lastActivity: now - 1 * min,
    status: 'needs_you',
    activity: 'Asking you a question',
    waiting: { kind: 'question', text: 'Should tax on supplier invoices be shown per line or as a single total in the payout export?' },
    goal: 'Add a bulk payout CSV export to the payout run (ACME-231).',
    lastPrompt: 'Add the payout export to payout runs.',
    lastAssistant: null,
    tasks: [
      { subject: 'Map payout run lines to payout CSV columns', status: 'completed' },
      { subject: 'Decide VAT presentation', status: 'in_progress', activeForm: 'Checking VAT presentation with you' },
      { subject: 'Export button on payout run page', status: 'pending' },
      { subject: 'Tests', status: 'pending' },
    ],
    agents: [{ type: 'general-purpose', description: 'Read bulk payout CSV spec', status: 'done', activity: 'Reported back' }],
  });

  make('demo-5', {
    cwd: '/home/dev/acme-api/.claude/worktrees/status-badge-colours-7b31aa',
    repoRoot: '/home/dev/acme-api',
    project: 'acme-api',
    worktree: 'status-badge-colours-7b31aa',
    branch: '221-status-badge-colours',
    startedAt: now - 300 * min,
    lastActivity: now - 210 * min,
    status: 'ended',
    ended: true,
    endedAt: now - 8 * min,
    goal: 'Fix the rota badge colour for holiday (#221).',
    lastAssistant: 'Pushed the fix and opened MR !412.',
    tasks: [
      { subject: 'Fix holiday badge colour', status: 'completed' },
      { subject: 'Open MR', status: 'completed' },
    ],
    agents: [],
  });

  make('demo-6', {
    cwd: '/home/dev/notes',
    agent: 'Cowork',
    project: null,
    startedAt: now - 400 * min,
    lastActivity: now - 190 * min,
    status: 'your_turn',
    goal: 'Sort the launch mock-ups into one folder and rename them.',
    lastAssistant: 'All 24 files renamed and filed under Launch/2026. Anything else?',
    tasks: [{ subject: 'Rename and file mock-ups', status: 'completed' }],
    agents: [],
  });

  make('demo-7', {
    cwd: '/home/dev/acme-api',
    repoRoot: '/home/dev/acme-api',
    project: 'acme-api',
    agent: 'Codex',
    format: 'codex',
    branch: 'codex/flaky-tests',
    startedAt: now - 22 * min,
    lastActivity: now - 20 * 1000,
    status: 'working',
    activity: 'Running: pytest -q tests/api',
    goal: 'Track down the flaky API tests and fix them.',
    lastAssistant: 'Two of the three failures share a fixture. Looking at that first.',
    tasks: [
      { subject: 'Reproduce the flakiness', status: 'completed' },
      { subject: 'Fix the shared fixture', status: 'in_progress' },
      { subject: 'Re-run the suite ten times', status: 'pending' },
    ],
    agents: [],
  });

  backlog.set('/home/dev/acme-api', {
    repo: 'acme-api',
    root: '/home/dev/acme-api',
    error: null,
    fetchedAt: now,
    issues: [
      [212, 'Progress bar counts cancelled items', ['bug', 'routes']],
      [215, 'Assigning a card 500s on an archived record', ['bug', 'fuel-cards']],
      [219, 'Uploaded photos rotate on iOS', ['bug', 'photo upload']],
      [198, 'Let admins drop a map pin to fix a bad geocode', ['feature', 'routes']],
      [231, 'Bulk payout CSV export', ['feature', 'wages']],
      [221, 'Status badge colour wrong for holiday', ['bug', 'rota']],
      [224, 'Payout export rounding', ['bug', 'wages']],
      [226, 'Wiki search ignores postcodes', ['bug', 'wiki']],
      [233, 'Interview reminders by SMS', ['feature', 'recruitment']],
      [236, 'Quota reset each April', ['feature', 'uniform']],
      [240, 'Live map: journey detection jitter', ['bug', 'live-map']],
    ].map(([iid, title, labels], i) => ({ iid, title, labels, url: `https://gitlab.com/acme/api/-/issues/${iid}`, assignees: [], updatedAt: now - i * 3600_000 })),
  });
  backlog.set('/home/dev/acme-site', {
    repo: 'acme-site',
    root: '/home/dev/acme-site',
    error: null,
    fetchedAt: now,
    issues: [
      [41, 'Pricing page redesign', ['design']],
      [44, 'Cookie banner copy', ['content']],
      [47, 'Add ODF case study', ['content']],
    ].map(([iid, title, labels], i) => ({ iid, title, labels, url: `https://gitlab.com/acme/site/-/issues/${iid}`, assignees: [], updatedAt: now - i * 3600_000 })),
  });

  // Keep things moving
  const activities = [
    'Run the progress tests',
    'Editing cards/services.py',
    'Reading vehicles/models.py',
    'Searching code for “is_active”',
    'Thinking',
  ];
  const subActs = ['Searching code for “assign_fuel_card”', 'Reading photo_upload.py', 'Reading exif.py', 'Finding files **/*photo upload*'];
  let tick = 0;
  setInterval(() => {
    tick++;
    const s1 = sessions.get('demo-1');
    s1.activity = activities[tick % activities.length];
    s1.lastActivity = Date.now();
    let k = 0;
    for (const a of s1.agents.values()) if (a.status === 'running') a.activity = subActs[(tick + k++) % subActs.length];
    if (tick % 12 === 0) {
      // someone new joins, someone leaves
      const running = [...s1.agents.values()].filter((a) => a.status === 'running');
      if (running.length > 3) {
        running[0].status = 'done';
        running[0].endedAt = Date.now();
        running[0].activity = 'Reported back';
      } else {
        const id = `demo-sub-${tick}`;
        s1.agents.set(id, { id, type: tick % 24 ? 'code-reviewer' : 'Explore', description: 'Review the fix for #215', status: 'running', startedAt: Date.now(), endedAt: 0, activity: 'Reading the brief' });
      }
    }
    broadcast();
  }, 2500);
  broadcast();
};
