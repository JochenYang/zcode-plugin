// The Chrome DevTools Protocol client the launcher uses. ZCode opens this channel only when it
// is started with `--remote-debugging-port=<port>`; everything here talks to 127.0.0.1 only.
//
// Built on Node's own WebSocket (Node 22 and newer), so the launcher has no dependencies. The
// protocol is used in its smallest form: list the windows, evaluate a script in each, and
// register the script so a reload gets it again before any page code runs.
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 10000;

export class CdpError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CdpError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url, { timeoutMs = 2000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new CdpError(`${url} answered ${response.status}`);
  return response.json();
}

// Not one of the app's own pages: DevTools, and anything loaded from the web. The app's pages
// come from its own files and its own protocols; a page from the web (a sign-in window, an
// OAuth page) must never be handed the stylesheet, which carries the user's pictures.
const NOT_APP_PAGE = /^(https?|devtools):/i;

// Every window of the running app that has a debugging WebSocket.
export async function listTargets(port, { timeoutMs, fetchImpl } = {}) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, { timeoutMs, fetchImpl });
  return targets.filter((target) => target && target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string' && !NOT_APP_PAGE.test(target.url ?? ''));
}

// The port answers a moment after the process starts; on a cold start that can take seconds.
export async function waitForEndpoint(port, { timeoutMs = 30000, intervalMs = 250, fetchImpl, shouldStop = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1000, fetchImpl });
    } catch (err) {
      if (shouldStop?.()) throw new CdpError(`ZCode closed before it opened the debugging channel on port ${port}`, { cause: err });
      if (Date.now() > deadline) throw new CdpError(`nothing answered on port ${port} within ${Math.round(timeoutMs / 1000)} s`, { cause: err });
      await sleep(intervalMs);
    }
  }
}

// The first port from `start` that nothing listens on. Trying to listen is the only reliable
// test: a port that is taken may answer to something that is not a debugging channel at all.
export function findFreePort(start, { host = '127.0.0.1', tries = 20 } = {}) {
  const attempt = (port) => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => (err.code === 'EADDRINUSE' || err.code === 'EACCES' ? resolve(null) : reject(err)));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(port)));
  });
  return (async () => {
    for (let offset = 0; offset < tries; offset += 1) {
      const port = start + offset;
      if (port > 65535) break;
      if (await attempt(port)) return port;
    }
    throw new CdpError(`no free port from ${start} to ${start + tries - 1}; set launcher.port in the config`);
  })();
}

export class CdpSession {
  static connect(url, { timeoutMs = 8000, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!WebSocketImpl) {
      return Promise.reject(new CdpError('the launcher needs Node 22 or newer: no built-in WebSocket client in this Node'));
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      // Whichever of the three ways this ends comes first settles it; a socket that opens after
      // the timeout is closed, not adopted.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new CdpError(`connecting timed out: ${url}`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpSession(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CdpError(`cannot connect to ${url}`));
      }, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.addEventListener('message', (event) => this.#receive(event));
    socket.addEventListener('close', () => this.#settle());
    // A failed send or a dropped connection is followed by 'close'; that is where it is reported.
    socket.addEventListener('error', () => {});
  }

  #receive(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
  }

  #settle() {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CdpError(`${entry.method}: the connection closed`));
    }
    this.pending.clear();
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new CdpError(`${method}: the connection closed`));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  // Runs `expression` and returns its value. A script that throws is reported, not swallowed:
  // the launcher's whole job is this one call. `awaitPromise` waits for a promise result.
  async evaluate(expression, { awaitPromise = false, timeoutMs } = {}) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { timeoutMs });
    if (exceptionDetails) {
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new CdpError(`the injected script failed: ${detail}`);
    }
    return result?.value;
  }

  close() {
    if (!this.closed) this.socket.close();
  }
}
