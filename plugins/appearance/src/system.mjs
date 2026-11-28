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

export function tasklistExe(env = process.env) {
  const full = path.join(system32(env), 'tasklist.exe');
  return fs.existsSync(full) ? full : 'tasklist';
}

// The environment a Windows tool is given when this plugin starts it. The process the app starts
// this code in may lack a variable Windows itself expects: with `SystemDrive` missing, the
// shell behind the file dialog wrote its caches into a folder literally called `%SystemDrive%`
// in whatever folder it was started in. What is there already is left as it is.
export function shellEnvironment(env = process.env) {
  const out = { ...env };
  const root = out.SystemRoot ?? out.WINDIR;
  if (!out.SystemDrive && typeof root === 'string' && path.isAbsolute(root)) out.SystemDrive = root.slice(0, 2);
  if (!out.ProgramData && out.SystemDrive) out.ProgramData = `${out.SystemDrive}\\ProgramData`;
  return out;
}
