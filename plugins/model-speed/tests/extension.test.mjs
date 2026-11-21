#!/usr/bin/env node
/**
 * Offline tests for plugins/model-speed/bin/extension.mjs.
 *
 * The extension gets everything through activate(ctx), so tests drive it with
 * a mock ctx — no ZCode instance required.
 *
 *   node tests/extension.test.mjs
 */
import assert from "node:assert/strict";
import { activate } from "../bin/extension.mjs";

function harness(locale = "en-US") {
  const calls = [];
  const listeners = { generate: [], env: [] };
  const commands = new Map();
  let envValue = { locale };
  const ctx = {
    env: {
      get: () => envValue,
      onDidChange: (fn) => {
        listeners.env.push(fn);
        return { dispose() {} };
      },
    },
    models: {
      onDidGenerate: (fn) => {
        listeners.generate.push(fn);
        return { dispose() {} };
      },
    },
    slots: {
      update: (id, patch, scope) => calls.push({ id, patch, scope }),
    },
    commands: {
      register: (id, run) => {
        commands.set(id, run);
        return { dispose() {} };
      },
    },
  };
  activate(ctx);
  return {
    calls,
    commands,
    fire: (m) => listeners.generate.forEach((fn) => fn(m)),
    setLocale: (next) => {
      envValue = { locale: next };
      listeners.env.forEach((fn) => fn(envValue));
    },
  };
}

const metric = (over = {}) => ({
  sessionId: "sess_a",
  workspace: undefined,
  requestId: "req_1",
  model: { providerId: "p", modelId: "m" },
  phase: "final",
  outputTokensPerSecond: 120,
  outputTokens: 600,
  timeToFirstTokenMs: 2000,
  ...over,
});

// 1. final sample updates the slot in its own session scope
{
  const h = harness();
  h.fire(metric());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].id, "tps");
  assert.equal(h.calls[0].patch.text, "120 tok/s");
  assert.deepEqual(h.calls[0].scope, { sessionId: "sess_a" });
  assert.match(h.calls[0].patch.tooltip, /Model: m\n/);
  assert.match(h.calls[0].patch.tooltip, /Output: 600 tok/);
  assert.match(h.calls[0].patch.tooltip, /TTFT: 2\.0 s/);
}

// 2. streaming estimates are ignored entirely
{
  const h = harness();
  h.fire(metric({ phase: "streaming", outputTokensPerSecond: 999 }));
  assert.equal(h.calls.length, 0);
}

// 3. implausible artifact values (tiny generation window) are ignored
{
  const h = harness();
  h.fire(metric({ outputTokens: 74, outputTokensPerSecond: 7483.9 }));
  h.fire(metric({ outputTokens: 232, outputTokensPerSecond: 58000 }));
  h.fire(metric({ outputTokens: 10, outputTokensPerSecond: 200 }));
  assert.equal(h.calls.length, 0);
  // the previous accurate value remains — a later good sample still works
  h.fire(metric());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].patch.text, "120 tok/s");
}

// 4. per-session isolation and locale switching
{
  const h = harness("zh-CN");
  h.fire(metric({ sessionId: "sess_a" }));
  h.fire(metric({ sessionId: "sess_b", outputTokensPerSecond: 95 }));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].scope, { sessionId: "sess_a" });
  assert.deepEqual(h.calls[1].scope, { sessionId: "sess_b" });
  assert.match(h.calls[0].patch.tooltip, /模型：m\n/);
  assert.match(h.calls[0].patch.tooltip, /首 token 用时：2\.0 秒/);
  h.setLocale("en-US");
  h.fire(metric({ sessionId: "sess_a", outputTokensPerSecond: 130 }));
  assert.match(h.calls[2].patch.tooltip, /Model: m\n/);
}

// 5. the command reports the last value without touching the slot
{
  const h = harness();
  const before = h.calls.length;
  h.fire(metric());
  const cmd = h.commands.get("model-speed.show");
  assert.ok(cmd, "command registered");
  const empty = cmd({ scope: { kind: "session", sessionId: "sess_other" } });
  assert.match(empty.message, /No completed generation/);
  const ok = cmd({ scope: { kind: "session", sessionId: "sess_a" } });
  assert.match(ok.message, /Last request: 120 tok\/s/);
  assert.equal(h.calls.length, before + 1, "command must not update the slot");
}

console.log("OK: 5 model-speed extension tests");
