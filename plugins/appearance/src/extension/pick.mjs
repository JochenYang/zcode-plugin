// The system's own "open a file" dialog, so nobody has to type a path to add a background.
// The promise settles when the dialog closes: nothing is chosen on the user's behalf, and an
// empty list means the dialog was cancelled.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PICTURE_EXTENSIONS, VIDEO_EXTENSIONS } from '../config.mjs';
import { powershellExe, shellEnvironment } from '../system.mjs';

// `-STA` is what lets Windows Forms show a dialog; the script travels base64-encoded so a
// title in any language and the filter's semicolons need no quoting. It answers in base64 too:
// written as text, the paths came out in the console's code page (GBK on a Chinese Windows),
// and a folder named in Chinese arrived as replacement characters. The dialog opens where the
// files already listed are, when there are any.
const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $true
$dialog.Title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TITLE__'))
$dialog.Filter = '__FILTER__'
$initial = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INITIAL__'))
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.InitialDirectory = $initial }
$result = $dialog.ShowDialog($owner)
$owner.Close()
$json = ConvertTo-Json -InputObject @($dialog.FileNames) -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

// The answer is the picture of the JSON in UTF-8, in base64: letters and digits only, whatever
// the console's code page is.
const fromDialog = (out) => JSON.parse(Buffer.from(String(out).trim(), 'base64').toString('utf8'));

// Started from the user's own folder, with the variables Windows expects: the process this
// code runs in sits in whatever folder the app was started in, which was the plugin's own.
const run = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: os.homedir(), env: shellEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  child.once('error', reject);
  child.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
});

const unique = (files) => [...new Set(files.map((file) => file.replace(/\\/g, '/')).filter(Boolean))];

/**
 * Files the user chose, or an empty list. Rejects where this system has no dialog to show.
 *
 * @param {{ platform?: string, title?: string, initial?: string | null, run?: (command: string, args: string[], options?: object) => Promise<string> }} [options]
 *   `initial` is the folder the dialog opens in; `run` starts the program the dialog needs, and
 *   the tests give one that answers without a window
 * @returns {Promise<string[]>}
 */
export async function pickFiles({ platform = process.platform, title = 'Choose pictures or videos', initial = null, run: start = run } = {}) {
  if (platform === 'win32') {
    const pictures = PICTURE_EXTENSIONS.map((extension) => `*${extension}`).join(';');
    const videos = VIDEO_EXTENSIONS.map((extension) => `*${extension}`).join(';');
    const filter = `Pictures and videos|${pictures};${videos}|Pictures|${pictures}|Videos|${videos}|All files|*.*`;
    const script = WINDOWS_SCRIPT
      .replace('__TITLE__', Buffer.from(title, 'utf8').toString('base64'))
      .replace('__FILTER__', filter)
      .replace('__INITIAL__', Buffer.from(initial && path.isAbsolute(initial) ? initial : '', 'utf8').toString('base64'));
    const out = await start(powershellExe(), ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    try {
      const parsed = fromDialog(out);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error(`the file dialog answered something else: ${out.trim().slice(0, 80)}`);
    }
  }
  if (platform === 'darwin') {
    const out = await start('osascript', ['-e', `set chosen to (choose file with prompt ${JSON.stringify(title)} of type {"public.image", "public.movie"} with multiple selections allowed)`, '-e', 'set out to ""', '-e', 'repeat with f in chosen', '-e', 'set out to out & POSIX path of f & linefeed', '-e', 'end repeat', '-e', 'return out']);
    return unique(out.split(/\r?\n/));
  }
  if (platform === 'linux') {
    const patterns = [...PICTURE_EXTENSIONS, ...VIDEO_EXTENSIONS].map((extension) => `*${extension}`).join(' ');
    const out = await start('zenity', ['--file-selection', '--multiple', '--title', title, `--file-filter=Pictures and videos | ${patterns}`]);
    return unique(out.split('|'));
  }
  throw new Error(`no file dialog on ${platform}`);
}
