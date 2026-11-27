// A headless Chromium with its debugging port open, plus the pages the launcher is pointed at:
// `shell.html` mounts the app in #root the way the real entry page does, `other.html` does not.
// Both are files loaded from a file:// URL, as the real entry page is, behind the same CSP
// (carried in a meta tag instead of a response header). One page is served from the web with the
// app's root in it all the same: the launcher has to leave it alone, and a test says so.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchJson, waitForEndpoint } from '../../src/cdp.mjs';

// Deliberately stricter than the real shell, which is loaded from a file:// URL inside app.asar
// and carries no CSP at all: this is the policy the app's custom protocol sends (inline styles
// yes, pictures from its own origin or data: URLs, no connections), with data: media added for
// the video tests. What gets through here gets through there.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src data:; connect-src 'none'";
export const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// A 16x16, one-second VP8 video (633 bytes): the smallest file that is still a video the
// browser will decode and play. It is kept as base64 text (tests/fixtures/tiny.webm.base64),
// written with `ffmpeg -f lavfi -i color=c=0x3366cc:s=16x16:d=1:r=4 -c:v libvpx -b:v 8k -an`,
// so that no binary sits in the repository and nothing is copied by hand.
const CLIP = fs.readFileSync(new URL('../fixtures/tiny.webm.base64', import.meta.url), 'utf8').trim();
export const VIDEO = `data:video/webm;base64,${CLIP}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findBrowser() {
  return [
    process.env.ZCODE_APPEARANCE_TEST_BROWSER,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate)) ?? null;
}

export async function until(read, accept, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`gave up waiting; last value: ${JSON.stringify(value)}`);
    await sleep(intervalMs);
  }
}

export async function startTestBrowser(browserPath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-test-'));
  const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="content-security-policy" content="${CSP}"><style>
    :root { --color-background: #fafafa; --color-surface: #ffffff; --color-background-win-alt: #e4e4e7; --color-sidebar: #f4f4f5; }
    .theme-zai-dark { --color-background: #0a0a0a; }
    body { margin: 0; } .bg-background { background-color: var(--color-background); }
    .bg-background-win-alt { background-color: var(--color-background-win-alt); min-height: 100vh; } .bg-sidebar { background-color: var(--color-sidebar); }
  </style></head><body>${body}</body></html>`;
  const SHELL = page('<div id="root"><div class="bg-background-win-alt">'
    + '<aside class="bg-sidebar" style="width: 40px; height: 30px">side</aside>'
    + '<section class="bg-background" style="margin: 4px; border-radius: 6px; overflow: hidden"><div data-testid="conversation" style="height: 50px; background-color: var(--color-surface)">chat</div></section>'
    + '</div></div>');
  // The app's own pages, loaded the way the real entry page is: from a file.
  fs.writeFileSync(path.join(profile, 'shell.html'), SHELL);
  fs.writeFileSync(path.join(profile, 'other.html'), page('<h1>not the shell</h1>'));
  const server = http.createServer((request, response) => {
    // A page from the web that mounts the app's root all the same.
    if (request.url === '/remote') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
      response.end(SHELL);
    } else {
      response.writeHead(404).end();
    }
  });
  const base = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

  const stop = async () => {
    const exited = new Promise((resolve) => {
      if (browser.exitCode !== null || browser.signalCode !== null) resolve();
      else browser.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    browser.kill();
    await exited;
    server.close();
    // The profile stays locked until the process is really gone; rmSync retries what is left.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };

  try {
    // Port 0 makes the browser pick one and write it down once it is listening. The file can
    // still be held open for writing when it first shows up (EBUSY on Windows), and it is empty
    // for a moment before the port is in it: read again until it says a port.
    const portFile = path.join(profile, 'DevToolsActivePort');
    const port = await until(() => {
      let text = '';
      try {
        text = fs.readFileSync(portFile, 'utf8');
      } catch (err) {
        if (!['EBUSY', 'ENOENT', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      }
      return Number(text.split('\n')[0]);
    }, (value) => Number.isInteger(value) && value > 0, { timeoutMs: 15000 });
    await waitForEndpoint(port);
    const openPage = async (url) => {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      return response.json();
    };
    // What the browser lists, before the launcher's own filter: to wait for a page the launcher
    // is meant to ignore.
    const rawTargets = async () => fetchJson(`http://127.0.0.1:${port}/json/list`);
    return {
      port,
      pages: {
        shell: pathToFileURL(path.join(profile, 'shell.html')).href,
        other: pathToFileURL(path.join(profile, 'other.html')).href,
        remote: `${base}/remote`,
      },
      openPage,
      rawTargets,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
