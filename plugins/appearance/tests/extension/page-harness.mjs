// Opens the view in a headless browser with page-host.js standing in for ZCode's host, and
// returns what the checks reported. Used by page.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// APPEARANCE_PAGE opens another copy of the page instead: for checking that these checks fail
// when the page is broken on purpose.
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = process.env.APPEARANCE_PAGE ?? path.join(PLUGIN, 'ui', 'index.html');
const HOST = fs.readFileSync(path.join(PLUGIN, 'tests', 'extension', 'page-host.js'), 'utf8');

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/** Chrome or Edge when one is installed; `skip` says so when there is none. */
export const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
export const skip = browser ? false : 'no Chrome or Edge found (set BROWSER_PATH)';

// The view goes into an iframe of the asked size, as ZCode puts it into a side pane: a browser
// window does not get narrower than about 500px, an iframe does. This page runs the checks
// inside the iframe and leaves their report in the DOM for `--dump-dom`.
const wrapper = (width, height, withChecks = true) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{display:block;border:0}</style></head>
<body><iframe id="view" style="width:${width}px;height:${height}px" src="page.html"></iframe>
<script>
(async () => {
${withChecks ? `  const out = document.createElement('pre');
  out.id = 'appearance-checks';
  out.hidden = true;
  let text;
  try {
    const view = document.getElementById('view');
    if (!view.contentWindow.__appearanceChecks) await new Promise((resolve) => view.addEventListener('load', resolve, { once: true }));
    text = JSON.stringify(await view.contentWindow.__appearanceChecks());
  } catch (err) {
    text = JSON.stringify({ failures: ['the checks stopped: ' + ((err && err.stack) || err)], metrics: {} });
  }
  out.textContent = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  document.body.append(out);` : ''}
})();
</script>
</body></html>
`;

/**
 * Open the view once.
 *
 * @param {object} run  `window.__appearanceRun` (see page-host.js)
 * @param {{ width?: number, height?: number }} [size]  the frame in CSS pixels
 * @returns {{ failures: string[], metrics: object }}
 */
export function open(run, { width = 1280, height = 900 } = {}) {
  return launch(run, { width, height, withChecks: true });
}

/**
 * The view as it looks once its first answer is in, drawn to a PNG for a person to look at.
 * Nothing is pressed. Returns the file's size in bytes.
 */
export function still(run, { width, height, shot }) {
  return launch({ ...run, holdFirst: false }, { width, height, withChecks: false, shot });
}

function launch(run, { width, height, withChecks, shot = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-page-'));
  const file = path.join(dir, 'page.html');
  // The setting goes in first, then the stand-in host, so both are there before the page's own
  // script runs at the end of the body.
  const setting = JSON.stringify(run).replace(/</g, '\\u003c');
  fs.writeFileSync(
    file,
    fs.readFileSync(PAGE, 'utf8').replace('<head>', () => `<head>\n<script>window.__appearanceRun = ${setting};</script>\n<script>\n${HOST}\n</script>`),
  );
  const entry = path.join(dir, 'index.html');
  fs.writeFileSync(entry, wrapper(width, height, withChecks));
  const shotFile = shot ? path.resolve(shot) : null;
  const out = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--allow-file-access-from-files',
      `--window-size=${Math.max(width, 600)},${height + 40}`,
      '--virtual-time-budget=20000',
      ...(shotFile ? [`--screenshot=${shotFile}`] : []),
      ...(withChecks ? ['--dump-dom'] : []),
      pathToFileURL(entry).href,
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  let size = 0;
  if (shotFile && fs.existsSync(shotFile)) size = fs.statSync(shotFile).size;
  // APPEARANCE_KEEP=1 leaves the copy of the page in place, to look at what the checks ran against.
  if (process.env.APPEARANCE_KEEP) console.error(`page kept in ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  if (!withChecks) {
    if (!size) throw new Error(`no screenshot came out (exit ${out.status}): ${String(out.stderr || '').slice(-400)}`);
    return size;
  }

  const marked = /<pre id="appearance-checks"[^>]*>([A-Za-z0-9+/=]*)<\/pre>/.exec(out.stdout ?? '');
  if (!marked) {
    throw new Error(`the checks did not report (exit ${out.status}): ${String(out.stderr || out.stdout || '').slice(-800)}`);
  }
  const result = JSON.parse(Buffer.from(marked[1], 'base64').toString('utf8'));
  if (out.error) throw out.error;
  return result;
}
