#!/usr/bin/env node
/*
 * Agent Office hook. Claude Code runs this for each hook event; it forwards the
 * event to every Agent Office server registered in ~/.agent-office/servers/.
 *
 * Every failure is silent on purpose: a monitoring tool must never break, slow
 * or fail the session it is watching.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REGISTRY_DIR = path.join(os.homedir(), '.agent-office', 'servers');

function liveServers() {
  let files;
  try {
    files = fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const live = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, f), 'utf8'));
      if (!entry || !entry.port || !entry.token || !entry.pid) continue;
      process.kill(entry.pid, 0); // throws if that process is gone
      live.push(entry);
    } catch {
      /* stale or malformed: the owning server prunes its own file */
    }
  }
  return live;
}

function post(server, body) {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/api/hooks/claude',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('error', () => resolve());
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch {
      resolve();
    }
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const servers = liveServers();
  if (!servers.length || !input) return;
  try {
    JSON.parse(input); // forward only well-formed events
  } catch {
    return;
  }
  await Promise.all(servers.map((s) => post(s, input)));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
