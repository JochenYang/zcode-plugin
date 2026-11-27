// Where Windows keeps the system tools this plugin runs, by full path. A program started by its
// bare name is looked for in the current folder before the system folders (how CreateProcess
// searches), and the launcher and its setup command are run from all kinds of folders, some of
// them writable by others (a shared tools folder, the folder of a project). Where this Windows
// does not keep the tool, the bare name is what is left.
import fs from 'node:fs';
import path from 'node:path';

const system32 = (env) => path.join(env.SystemRoot ?? 'C:\\Windows', 'System32');

export function powershellExe(env = process.env) {
  const full = path.join(system32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell';
}

export function commandPrompt(env = process.env) {
  const full = typeof env.ComSpec === 'string' && path.isAbsolute(env.ComSpec) ? env.ComSpec : path.join(system32(env), 'cmd.exe');
  return fs.existsSync(full) ? full : 'cmd';
}
