#!/usr/bin/env node
// Dispatch statistics from this machine's ZCode session database: how often each agent type
// was really dispatched, how small those dispatches were, how much of the traffic went to the
// built-in general-purpose agent instead of a specialist, and how often a finished subagent was
// continued with SendMessage instead of being started again.
//
//   node scripts/dispatch-stats.mjs [since YYYY-MM-DD]
//
// Read-only. Prints counts, tokens and durations — never prompts, commands or paths.
// A child session is linked to its dispatch by its parent plus its creation time falling inside
// the Agent tool call's time window, so the linked count is a little lower than the dispatch
// count: a window holding dispatches of more than one type is ambiguous and is skipped, and a
// child outside every window is usually a continuation of an earlier agent. Token totals are
// cumulative over every request of the child session, mostly cache reads, and are only recorded
// for recent sessions; a continued agent's tokens and seconds cover all of its runs.
// Needs Node 22.13+ (node:sqlite) and ~/.zcode/cli/db/db.sqlite.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SMALL_TOOL_CALLS = 3;
const arg = process.argv[2];
const since = arg ? Date.parse(`${arg}T00:00:00`) : NaN;
if (arg && Number.isNaN(since)) {
  console.error('usage: node scripts/dispatch-stats.mjs [since YYYY-MM-DD]');
  process.exit(2);
}
const dbPath = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error('no ZCode session database under the home directory');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const parse = (row) => { try { return JSON.parse(row.data); } catch { return null; } };
const typeOf = (call) => call.state?.input?.subagent_type ?? 'general-purpose';
const positive = (xs) => xs.filter((x) => x > 0).sort((a, b) => a - b);
const median = (xs) => { const s = positive(xs); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const share = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const n = (x) => x.toLocaleString('en-US');

const tokensOf = new Map(db.prepare('SELECT session_id, SUM(COALESCE(computed_total_tokens, 0)) AS tokens FROM model_usage GROUP BY session_id').all().map((r) => [r.session_id, r.tokens]));
const partsOf = db.prepare('SELECT data FROM part WHERE session_id = ?');
const agentCallsOf = db.prepare("SELECT data FROM part WHERE session_id = ? AND data LIKE '%\"tool\":\"Agent\"%'");

const byType = new Map();
const stat = (type) => {
  if (!byType.has(type)) byType.set(type, { dispatches: 0, linked: 0, small: 0, tokens: [], seconds: [], calls: [] });
  return byType.get(type);
};
let dispatches = 0;
let linked = 0;
let small = 0;
let ambiguous = 0;
let outside = 0;

for (const parent of db.prepare('SELECT id FROM session WHERE parent_id IS NULL').all()) {
  const calls = agentCallsOf.all(parent.id).map(parse)
    .filter((d) => d?.type === 'tool' && d.tool === 'Agent' && typeof d.state?.time?.start === 'number' && (!arg || d.state.time.start >= since))
    // A call still running has no end: treat it as a zero-length window rather than one without an upper bound.
    .map((d) => ({ type: typeOf(d), start: d.state.time.start, end: d.state.time.end ?? d.state.time.start }));
  for (const call of calls) {
    dispatches += 1;
    stat(call.type).dispatches += 1;
  }
  const children = db.prepare('SELECT id, time_created, time_updated FROM session WHERE parent_id = ?').all(parent.id)
    .filter((k) => !arg || k.time_created >= since);
  for (const child of children) {
    const inside = calls.filter((c) => c.start - 1500 <= child.time_created && child.time_created <= c.end + 1500);
    if (inside.length === 0) { outside += 1; continue; }
    const types = new Set(inside.map((c) => c.type));
    if (types.size !== 1) { ambiguous += 1; continue; }
    const toolCalls = partsOf.all(child.id).map(parse).filter((d) => d?.type === 'tool' && d.tool).length;
    const t = stat([...types][0]);
    t.linked += 1;
    linked += 1;
    if (toolCalls <= SMALL_TOOL_CALLS) { t.small += 1; small += 1; }
    t.tokens.push(tokensOf.get(child.id) ?? 0);
    t.seconds.push(Math.max(0, Math.round((child.time_updated - child.time_created) / 1000)));
    t.calls.push(toolCalls);
  }
}

const continuations = db.prepare("SELECT data FROM part WHERE data LIKE '%\"tool\":\"SendMessage\"%' AND time_created >= ?").all(since || 0)
  .map(parse).filter((d) => d?.type === 'tool' && d.tool === 'SendMessage').length;
db.close();

if (dispatches === 0) {
  console.log(arg ? `no Agent dispatches since ${arg}.` : 'no Agent dispatches found — if this machine has dispatched subagents, the stored record format may have changed.');
  process.exit(0);
}
console.log(`dispatches ${arg ? `since ${arg}` : 'on this machine'}: ${dispatches} (${linked} linked to their child session, ${ambiguous} inside ambiguous windows skipped, ${outside} child sessions outside every dispatch window — continuations and other child kinds)`);
const gp = byType.get('general-purpose');
console.log(`general-purpose share: ${gp?.dispatches ?? 0} of ${dispatches} (${share(gp?.dispatches ?? 0, dispatches)}) — omitted subagent_type counts as general-purpose`);
console.log(`small dispatches (at most ${SMALL_TOOL_CALLS} tool calls): ${small} of ${linked} linked (${share(small, linked)})`);
console.log(`continuations: SendMessage used ${continuations} time(s)`);
console.log('');
console.log('type | dispatches | linked | small | tokens (median) | seconds (median) | tool calls (median)');
for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].dispatches - a[1].dispatches)) {
  console.log(`${type} | ${t.dispatches} | ${t.linked} | ${t.small} | ${n(median(t.tokens))} | ${median(t.seconds)} | ${median(t.calls)}`);
}
