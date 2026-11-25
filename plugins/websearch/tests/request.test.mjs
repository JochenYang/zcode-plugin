// Regression matrix for the network layer of bin/server.mjs.
//
// The real module is imported and driven through handleSearch / handleFetch /
// handleMessage. Only the two edges it cannot control offline are replaced:
// name resolution (so the private-address guard sees public answers for the
// test hosts) and fetch (a scripted responder that honours the abort signal
// the way undici does). A redirect that carries the user's key to another
// host, a deadline that restarts on every hop or stops at the headers, a page
// in GBK or Shift_JIS that comes back garbled, a config file whose contents
// leak into an error, or a tool description that stops deferring to the
// built-in tools fails here instead of in a live session.
//
//   node --test plugins/websearch/tests/*.test.mjs

import dns from "node:dns/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

// Hosts the guard is told are public. Every other name keeps real resolution;
// the private-address cases use literals, which never reach the resolver.
const PUBLIC_HOSTS = new Set(["api.anysearch.com", "mcp.parallel.ai", "www.bing.com", "example.org"]);
const realLookup = dns.lookup;
let lookups = 0;
dns.lookup = (hostname, options) => {
  lookups += 1;
  return PUBLIC_HOSTS.has(hostname)
    ? Promise.resolve([{ address: "93.184.216.34", family: 4 }])
    : realLookup(hostname, options);
};
syncBuiltinESMExports();

const { TOOLS, handleFetch, handleMessage, handleSearch, readConfig, sanitizeConfig } = await import("../bin/server.mjs");

const realFetch = globalThis.fetch;
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

// A deadline case must fail, not hang, if someone removes the deadline again.
const DEADLINE = { timeout: 5000 };

function abortError() {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Replace fetch with `respond(url, init)`, recording every call's headers. */
function scriptedFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), headers: { ...init.headers } };
    calls.push(call);
    return respond(call.url, init, calls.length);
  };
  return calls;
}

const textResponse = (body, headers = { "content-type": "text/html; charset=utf-8" }, status = 200) =>
  new Response(body, { status, headers });

const redirect = (location) => new Response(null, { status: 302, headers: { location } });

const anysearchHit = () => textResponse(
  JSON.stringify({ code: 0, data: { results: [{ url: "https://r.example", title: "T" }] } }),
  { "content-type": "application/json" }
);

/** Headers arrive at once, the body only after `delayMs` — and never if aborted first. */
function delayedBody(body, delayMs, signal) {
  const stream = new ReadableStream({
    start(controller) {
      const timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.error(abortError());
      }, { once: true });
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Not even the headers arrive before the request is aborted. */
function pendingUntilAborted(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/** Point the module at `dir` as its data folder for the rest of the test. */
function useConfigDir(t, dir) {
  const previous = process.env.ZCODE_PLUGIN_DATA;
  process.env.ZCODE_PLUGIN_DATA = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.ZCODE_PLUGIN_DATA;
    else process.env.ZCODE_PLUGIN_DATA = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

const configDir = () => mkdtempSync(join(tmpdir(), "websearch-test-"));

/* --------------------------------------------------------- credentials */

test("a cross-origin redirect does not carry the engine key", async (t) => {
  const calls = scriptedFetch((url) => (url.startsWith("https://api.anysearch.com/")
    ? redirect("https://example.org/collect")
    : anysearchHit()));
  t.after(restoreFetch);

  const out = await handleSearch({ query: "q" }, "", sanitizeConfig({ order: "anysearch", anysearchKey: "SECRET-KEY" }));

  assert.equal(out.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, "Bearer SECRET-KEY");
  assert.equal(calls[1].headers.authorization, undefined, "the redirect target must not see the key");
  assert.equal(typeof calls[1].headers["user-agent"], "string", "ordinary headers still travel");
  assert.equal(calls[1].headers["content-type"], "application/json");
});

test("a same-origin redirect keeps the key", async (t) => {
  const calls = scriptedFetch((url) => (url === "https://api.anysearch.com/v1/search"
    ? redirect("https://api.anysearch.com/v2/search")
    : anysearchHit()));
  t.after(restoreFetch);

  await handleSearch({ query: "q" }, "", sanitizeConfig({ order: "anysearch", anysearchKey: "SECRET-KEY" }));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, "Bearer SECRET-KEY");
});

test("the key comes back once the chain returns to the configured origin", async (t) => {
  const calls = scriptedFetch((url, _init, nth) => {
    if (nth === 1) return redirect("https://example.org/collect");
    if (nth === 2) return redirect("https://api.anysearch.com/v1/search");
    return anysearchHit();
  });
  t.after(restoreFetch);

  await handleSearch({ query: "q" }, "", sanitizeConfig({ order: "anysearch", anysearchKey: "SECRET-KEY" }));

  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.authorization, "Bearer SECRET-KEY");
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[2].headers.authorization, "Bearer SECRET-KEY");
});

test("a downgrade to http on the same host is another origin", async (t) => {
  const calls = scriptedFetch((url) => (url.startsWith("https://api.anysearch.com/")
    ? redirect("http://api.anysearch.com/v1/search")
    : anysearchHit()));
  t.after(restoreFetch);

  await handleSearch({ query: "q" }, "", sanitizeConfig({ order: "anysearch", anysearchKey: "SECRET-KEY" }));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, undefined);
});

test("x-api-key is treated the same way", async (t) => {
  const calls = scriptedFetch((url) => (url === "https://mcp.parallel.ai/mcp"
    ? redirect("https://example.org/collect")
    : textResponse(JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{\"results\":[]}" }] }
    }), { "content-type": "application/json" })));
  t.after(restoreFetch);

  await handleSearch({ query: "q" }, "", sanitizeConfig({ order: "parallel", parallelKey: "PARALLEL-KEY" }));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["x-api-key"], "PARALLEL-KEY");
  assert.equal(calls[1].headers["x-api-key"], undefined);
});

test("a redirect that carries credentials is refused without a second request", async (t) => {
  const spellings = [
    "https://user:pass@example.org/collect",
    "http://%75ser:pass@example.org/collect",
    "//user:pass@example.org/collect",
    "https://user@example.org/collect",
    "https://:pass@example.org/collect"
  ];
  t.after(restoreFetch);

  for (const location of spellings) {
    const calls = scriptedFetch(() => redirect(location));
    const out = await handleFetch({ url: "https://example.org/start" });

    assert.equal(calls.length, 1, location);
    assert.equal(out.errorCode, "FETCH_BLOCKED", location);
  }

  // An empty user and password carry nothing, so there is nothing to refuse.
  const calls = scriptedFetch((_url, _init, nth) => (nth === 1 ? redirect("https://@example.org/next") : textResponse("fine")));
  const empty = await handleFetch({ url: "https://example.org/start" });

  assert.equal(calls.length, 2);
  assert.equal(empty.ok, true);
});

/* -------------------------------------------------------------- guard */

test("fetch_page still refuses loopback before any request is made", async (t) => {
  const calls = scriptedFetch(() => textResponse("nope"));
  t.after(restoreFetch);

  for (const url of ["http://127.0.0.1:9/", "http://[::1]:9/", "http://10.0.0.1/"]) {
    const out = await handleFetch({ url });
    assert.equal(out.errorCode, "FETCH_BLOCKED", url);
  }
  assert.equal(calls.length, 0);
});

test("an IPv4-mapped loopback address is refused however it is spelled", async (t) => {
  const calls = scriptedFetch(() => textResponse("nope"));
  t.after(restoreFetch);

  const spellings = ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:7f00:1]/"];
  for (const url of spellings) {
    const out = await handleFetch({ url });
    assert.equal(out.errorCode, "FETCH_BLOCKED", url);
  }
  assert.equal(calls.length, 0);
});

test("a public IPv6 literal is let through without asking the resolver", async (t) => {
  const calls = scriptedFetch(() => textResponse("fine"));
  t.after(restoreFetch);

  const before = lookups;
  const out = await handleFetch({ url: "http://[2606:4700::1111]/" });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(lookups, before, "an IP literal is decided without a name lookup");
});

/* ----------------------------------------------------------- deadline */

test("the deadline covers the body, not just the headers", DEADLINE, async (t) => {
  const startedAt = Date.now();
  let abortedAt = 0;
  scriptedFetch((_url, init) => {
    init.signal.addEventListener("abort", () => {
      abortedAt = Date.now() - startedAt;
    }, { once: true });
    return delayedBody("<p>late</p>", 2000, init.signal);
  });
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/slow" }, { timeoutMs: 500 });

  assert.equal(out.ok, false, "a body that lands after the deadline is not a result");
  assert.equal(out.errorCode, "NETWORK_ERROR");
  assert.equal(out.message, "请求超时");
  assert.ok(abortedAt >= 450 && abortedAt < 1800, `aborted at ${abortedAt}ms`);
});

test("a body that arrives in time is still read", async (t) => {
  scriptedFetch((_url, init) => delayedBody("<p>fine</p>", 50, init.signal));
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/quick" }, { timeoutMs: 2000 });

  assert.equal(out.ok, true);
  assert.match(out.result.text, /fine/);
});

test("a body broken by the deadline is a timeout whatever the error is called", DEADLINE, async (t) => {
  // Not every client reports an interrupted body as AbortError, so the deadline
  // is recognised by the aborted signal rather than by the error's name.
  scriptedFetch((_url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
  });
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/stream" }, { timeoutMs: 500 });

  assert.equal(out.ok, false);
  assert.equal(out.message, "请求超时");
});

test("headers slower than the deadline still time out", DEADLINE, async (t) => {
  scriptedFetch((_url, init) => pendingUntilAborted(init.signal));
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/hang" }, { timeoutMs: 500 });

  assert.equal(out.ok, false);
  assert.equal(out.message, "请求超时");
});

test("redirect hops share one deadline", DEADLINE, async (t) => {
  const startedAt = Date.now();
  const HOP_MS = 500;
  const calls = scriptedFetch((url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(url.endsWith("/a") ? redirect("https://example.org/b") : textResponse("done"));
    }, HOP_MS);
    init.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  }));
  t.after(restoreFetch);

  // The first hop uses 500 of 900 ms; the second needs 500 more and has 400.
  const out = await handleFetch({ url: "https://example.org/a" }, { timeoutMs: HOP_MS + 400 });

  assert.equal(calls.length, 2);
  assert.equal(out.ok, false, "the second hop must not get a fresh window");
  assert.equal(out.message, "请求超时");
  assert.ok(Date.now() - startedAt < 2500, "the whole chain ended near the deadline");
});

/* ------------------------------------------------------------ bodies */

// GBK bytes for "中文页面", and Shift_JIS bytes for "あいう".
const GBK_TEXT = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd2, 0xb3, 0xc3, 0xe6]);
const KANA_TEXT = Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]);
const GBK_PAGE = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body><p>'), GBK_TEXT,
  Buffer.from("</p></body></html>")]);

test("a GBK page comes back readable", async (t) => {
  scriptedFetch(() => textResponse(GBK_PAGE, { "content-type": "text/html; charset=gbk" }));
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/gbk" });

  assert.equal(out.ok, true);
  assert.match(out.result.text, /中文页面/);
});

test("a GBK page that declares its charset only in <meta> is readable too", async (t) => {
  scriptedFetch(() => textResponse(GBK_PAGE, { "content-type": "text/html" }));
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/gbk-meta" });

  assert.equal(out.ok, true);
  assert.match(out.result.text, /中文页面/);
});

test("the http-equiv form is honoured, quoted or not", async (t) => {
  const forms = [
    '<meta http-equiv="Content-Type" content="text/html;charset=Shift_JIS" />',
    "<meta http-equiv=content-type content=text/html;charset=Shift_JIS>"
  ];
  t.after(restoreFetch);

  for (const head of forms) {
    scriptedFetch(() => textResponse(Buffer.concat([Buffer.from(`<p>${head}</p><p>`), KANA_TEXT, Buffer.from("</p>")]),
      { "content-type": "text/html" }));
    const out = await handleFetch({ url: "https://example.org/shift-jis" });

    assert.equal(out.ok, true);
    assert.match(out.result.text, /あいう/, head);
  }
});

test("a UTF-8 page that merely mentions another charset stays UTF-8", async (t) => {
  const decoys = [
    '<meta property="og:description" content="how to set charset=gbk"><meta charset="utf-8">',
    "<!-- <meta charset=\"big5\"> --><meta charset=\"utf-8\">",
    "<script>document.write('<meta charset=\"gbk\">')</script><meta charset=\"utf-8\">",
    "<template><meta charset=\"big5\"></template><meta charset=\"utf-8\">",
    "<noscript><meta charset=\"big5\"></noscript><meta charset=\"utf-8\">"
  ];
  t.after(restoreFetch);

  for (const head of decoys) {
    scriptedFetch(() => textResponse(Buffer.from(`${head}<p>中文页面</p>`), { "content-type": "text/html" }));
    const out = await handleFetch({ url: "https://example.org/decoy" });

    assert.equal(out.ok, true);
    assert.match(out.result.text, /中文页面/, head.slice(0, 48));
  }
});

test("a <meta> cut by the 1 KB prescan limit is read to its end, one beyond it is not", async (t) => {
  // "<!-- x…x -->" of exactly `length` bytes, to place the tag where it is wanted.
  const filler = (length) => `<!-- ${"x".repeat(length - 9)} -->`;
  assert.equal(filler(1018).length, 1018);
  const page = (length) => Buffer.concat([Buffer.from(`${filler(length)}<meta charset="gbk"><p>`), GBK_TEXT, Buffer.from("</p>")]);
  t.after(restoreFetch);

  // The tag opens at byte 1018 and closes at 1036, straddling the limit.
  scriptedFetch(() => textResponse(page(1018), { "content-type": "text/html" }));
  const straddling = await handleFetch({ url: "https://example.org/edge" });

  assert.equal(straddling.ok, true);
  assert.match(straddling.result.text, /中文页面/);

  scriptedFetch(() => textResponse(page(1030), { "content-type": "text/html" }));
  const beyond = await handleFetch({ url: "https://example.org/edge" });

  assert.equal(beyond.ok, true);
  assert.doesNotMatch(beyond.result.text, /中文页面/);
});

test("an XML declaration counts as XML, as nothing-typed, and never as HTML", async (t) => {
  const declaration = '<?xml version="1.0" encoding="gbk"?>';
  const body = Buffer.concat([Buffer.from(`${declaration}<a>`), GBK_TEXT, Buffer.from("</a>")]);
  t.after(restoreFetch);

  for (const type of ["application/xml", ""]) {
    scriptedFetch(() => textResponse(body, type ? { "content-type": type } : {}));
    const out = await handleFetch({ url: "https://example.org/feed" });

    assert.equal(out.ok, true);
    assert.match(out.result.text, /中文页面/, type || "(no content-type)");
  }

  // A browser reading HTML treats <?xml …?> as a comment, so the page stays UTF-8.
  const decoy = Buffer.concat([Buffer.from(`${declaration}<a>中文页面</a>`)]);
  scriptedFetch(() => textResponse(decoy, { "content-type": "text/html" }));
  const html = await handleFetch({ url: "https://example.org/page" });

  assert.equal(html.ok, true);
  assert.match(html.result.text, /中文页面/);
});

test("the size ceiling reports itself unchanged", async (t) => {
  scriptedFetch(() => textResponse(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)));
  t.after(restoreFetch);

  const out = await handleFetch({ url: "https://example.org/big" });

  assert.equal(out.ok, false);
  assert.equal(out.message, "响应超过 2 MB 上限");
});

/* ------------------------------------------------------------ engines */

// The shape of a bing result page: three result blocks, one of them a duplicate.
const BING_PAGE = [
  '<ol id="b_results">',
  '<li class="b_algo"><h2><a href="https://r.example/a">A</a></h2><p>first</p></li>',
  '<li class="b_algo"><h2><a href="https://r.example/b">B</a></h2><p>second</p></li>',
  "</ol>"
].join("");

test("a bing answer of 200 with an empty body is retried once", async (t) => {
  const calls = scriptedFetch((_url, _init, nth) => (nth === 1
    ? textResponse("", { "content-type": "text/html" })
    : textResponse(BING_PAGE, { "content-type": "text/html" })));
  t.after(restoreFetch);

  const out = await handleSearch({ query: "q" }, "zh", sanitizeConfig({ order: "bing" }));

  assert.equal(calls.length, 2);
  assert.equal(out.ok, true);
  assert.equal(out.result.results.length, 2);
});

test("two empty bing answers in a row still end as an empty engine", async (t) => {
  const calls = scriptedFetch(() => textResponse("", { "content-type": "text/html" }));
  t.after(restoreFetch);

  const out = await handleSearch({ query: "q" }, "zh", sanitizeConfig({ order: "bing" }));

  assert.equal(calls.length, 2, "exactly one retry");
  assert.equal(out.ok, false);
  assert.equal(out.result.attempts[0].count, 0);
});

test("a bing answer with a body is not asked for twice", async (t) => {
  const calls = scriptedFetch(() => textResponse(BING_PAGE, { "content-type": "text/html; charset=utf-8" }));
  t.after(restoreFetch);

  const out = await handleSearch({ query: "q" }, "zh", sanitizeConfig({ order: "bing" }));

  assert.equal(calls.length, 1);
  assert.equal(out.ok, true);
});

test("a bing error status is not retried either", async (t) => {
  const calls = scriptedFetch(() => textResponse("later", { "content-type": "text/html" }, 503));
  t.after(restoreFetch);

  const out = await handleSearch({ query: "q" }, "zh", sanitizeConfig({ order: "bing" }));

  assert.equal(calls.length, 1);
  assert.equal(out.ok, false);
  assert.match(out.result.attempts[0].error, /HTTP 503/);
});

test("an empty bing answer is not retried when the budget is nearly spent", DEADLINE, async (t) => {
  // The first answer eats all but 1.3 s of a 1.6 s budget; a retry needs 1.5 s.
  const calls = scriptedFetch(() => new Promise((resolve) => {
    setTimeout(() => resolve(textResponse("", { "content-type": "text/html" })), 300);
  }));
  t.after(restoreFetch);

  const config = { ...sanitizeConfig({ order: "bing" }), timeoutMs: 1600 };
  const out = await handleSearch({ query: "q" }, "zh", config);

  assert.equal(calls.length, 1, "a retry that cannot finish is not worth starting");
  assert.equal(out.ok, false);
  assert.equal(out.result.attempts[0].count, 0);
});

/* --------------------------------------------------------- config file */

test("a broken config file is reported in both outcomes", async (t) => {
  scriptedFetch(() => anysearchHit());
  t.after(restoreFetch);
  const config = sanitizeConfig({ order: "anysearch" });
  config.configWarning = "config file is broken";

  const succeeded = await handleSearch({ query: "q" }, "", config);
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.result.configWarning, "config file is broken");

  scriptedFetch(() => textResponse(JSON.stringify({ code: 0, data: { results: [] } }),
    { "content-type": "application/json" }));
  const failed = await handleSearch({ query: "q" }, "", config);
  assert.equal(failed.ok, false);
  assert.equal(failed.result.configWarning, "config file is broken");
});

test("an absent or readable config file raises no warning", async (t) => {
  const dir = configDir();
  useConfigDir(t, dir);

  assert.equal(readConfig().configWarning, undefined, "no file yet");

  // PowerShell's Out-File writes a byte-order mark in front of the JSON.
  writeFileSync(join(dir, "websearch.json"), "\uFEFF{\"order\":\"bing\"}");
  const withBom = readConfig();
  assert.equal(withBom.configWarning, undefined);
  assert.deepEqual(withBom.order, ["bing"]);
});

test("the warning reaches the MCP payload without quoting the file", async (t) => {
  const dir = configDir();
  writeFileSync(join(dir, "websearch.json"), '{ "anysearchKey": "TEST-SECRET-VALUE", "order": }');
  useConfigDir(t, dir);
  scriptedFetch(() => anysearchHit());
  t.after(restoreFetch);

  const reply = await handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { query: "q" } }
  });
  const payload = JSON.parse(reply.result.content[0].text);

  assert.equal(payload.ok, true);
  assert.match(String(payload.configWarning), /不是合法 JSON/);
  assert.doesNotMatch(JSON.stringify(payload), /TEST-SECRET-VALUE/);
});

test("a setup that relied on a retired engine is told; the old stock template is not", async (t) => {
  scriptedFetch(() => anysearchHit());
  t.after(restoreFetch);
  const dir = configDir();
  const configFile = join(dir, "websearch.json");
  useConfigDir(t, dir);

  const search = async () => {
    const reply = await handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { query: "q" } }
    });
    return JSON.parse(reply.result.content[0].text);
  };

  // What the 0.1.x template wrote for everyone: the id last in its default order.
  writeFileSync(configFile, JSON.stringify({ order: "anysearch,exa,parallel,bing,searxng", searxngInstances: "" }));
  assert.equal((await search()).configWarning, undefined);

  // A user who pointed the plugin at their own instance is rerouted, and told.
  writeFileSync(configFile, JSON.stringify({ order: "searxng", searxngInstances: "http://127.0.0.1:8080" }));
  const rerouted = await search();

  assert.equal(rerouted.ok, true);
  assert.match(String(rerouted.configWarning), /searxng 引擎自 0\.2\.0 起已移除/);
  assert.match(String(rerouted.configWarning), /anysearch \/ exa \/ parallel \/ bing/);

  // The same configuration as a hand edit leaves it: a stray comma, no instance.
  writeFileSync(configFile, JSON.stringify({ order: "searxng, " }));
  const handEdited = await search();

  assert.match(String(handEdited.configWarning), /已移除/);

  // With every other engine disabled the warning says so instead of naming an order.
  writeFileSync(configFile, JSON.stringify({ order: "searxng", disabled: "anysearch,exa,parallel,bing" }));
  const nothingLeft = await search();

  assert.equal(nothingLeft.ok, false);
  assert.match(String(nothingLeft.configWarning), /没有可用的引擎/);
});

/* ------------------------------------------------------- descriptions */

test("the tool descriptions defer to the built-in tools", () => {
  const [search, page] = TOOLS;
  assert.match(search.description, /内置的 WebSearch 工具可用，优先用它/);
  assert.doesNotMatch(search.description, /随后用 fetch_page/, "searching must not route into fetch_page");
  assert.match(page.description, /内置的 WebFetch 工具可用，优先用它/);
});
