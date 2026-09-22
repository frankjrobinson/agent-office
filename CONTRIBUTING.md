# Contributing

The useful contribution is **another agent**. Everything else is a bonus.

## How an agent gets on the board

There are two ways in, and the second is much less work:

1. **A reader.** The server watches folders of JSONL transcripts and turns them into sessions.
   `applyRecord` handles Claude Code's format and `applyCodexRecord` handles Codex CLI's. A new
   agent means one more `apply…Record`, a discovery function that finds its files, and a `format`
   on the session so the reader picks the right parser. Look at how `codexFiles()` and
   `applyCodexRecord()` fit together — that's the whole shape of it.
2. **A beacon.** Anything that can write a JSON file can have a desk without touching this code:
   write `beacons/<id>.json` and keep it fresh. The README documents the fields. This is the right
   route for agents with no local transcript, or for your own scripts and cron jobs.

Live status (permission prompts, current tool) needs hooks. Claude Code has them; where an agent
doesn't, the reader falls back to the transcript and the board is a little behind. That's fine —
say so in your PR rather than pretending otherwise.

## House rules

- **No dependencies.** Node's standard library only, in the server and in the page. It keeps
  `npx agent-office` instant and the security surface small.
- **Never interfere with the session being watched.** Read files, take hook events, and fail
  silently. A monitoring tool that breaks your agent is worse than no monitoring tool.
- **Local only.** The server binds to 127.0.0.1 and holds transcript content. Don't add anything
  that sends it elsewhere.
- **Plain English in the UI.** "Running the tests", not "Bash(pytest -q)". The point of the thing is
  glanceability.

## Running it

```bash
node server.js --demo   # a pretend team, no real sessions needed
npm test                # node:test, no runner to install
```

Please add a test for a new parser: a few synthetic records through your `apply…Record` is enough,
and `test/parse.test.js` shows the pattern.
