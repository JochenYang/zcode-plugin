// Shows a file with whatever the system opens that kind of file with. The process is left on
// its own: whether the editor starts is not this plugin's to know.
import { spawn } from 'node:child_process';

export function openWithDefaultApp(file, { env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', file] : [file];
  const child = spawnImpl(command, args, { env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
