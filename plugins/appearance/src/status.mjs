// The one file through which the launcher and the MCP server talk about the launcher: it says
// which process applies the appearance, on which port. Written when the launcher starts and
// removed when it stops; a file left behind by a crashed launcher says so through its pid.
import fs from 'node:fs';

export function readStatus(file) {
  try {
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(status.launcherPid) && Number.isInteger(status.port) ? status : null;
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // A process that exists but belongs to someone else answers EPERM, not ESRCH.
    return err.code === 'EPERM';
  }
}

export function launcherState(file) {
  const status = readStatus(file);
  if (!status) return { running: false, port: null };
  return { running: isAlive(status.launcherPid), port: status.port };
}
