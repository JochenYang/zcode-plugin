#!/usr/bin/env node
// codegraph MCP server entry. Checks the Node floor and the V8 wasm flag before
// importing anything that needs node:sqlite or the grammar runtime, so an old or
// mis-flagged runtime gets an actionable message instead of a crash.
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { enforceNodeFloor, ensureLiftoffOnly } from '../src/bootstrap.mjs';

// bootstrap.mjs only imports node:child_process, so this is safe before the floor check.
enforceNodeFloor();
if (!(await ensureLiftoffOnly(fileURLToPath(import.meta.url)))) process.exit(0);

// A corrupted server is worse than a dead one: the host restarts MCP servers per session,
// so log and exit instead of limping on with half-initialised state.
process.on('uncaughtException', (err) => {
  process.stderr.write(`codegraph: uncaught ${err?.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`codegraph: unhandled rejection ${err?.stack ?? err}\n`);
  process.exit(1);
});

const { serve } = await import('../src/mcp/server.mjs');
serve();
