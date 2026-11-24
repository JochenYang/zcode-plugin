// V8 wasm tiering bootstrap shared by the bin/ entry points.
//
// One bundled grammar (the tree-sitter-wasms build of swift, ABI 13) made V8's
// TurboFan tier-up abort the whole process ("Fatal process out of memory: Zone")
// on Node 24.21; it was replaced by a build that survives the same stress, so the
// default is a normal V8 configuration (TurboFan tier-up is ~1.6x faster than
// Liftoff-only for our workloads). CODEGRAPH_LIFTOFF_ONLY=1 re-executes with
// --liftoff-only as a safety net for other runtimes that hit the crash.
import { spawn } from 'node:child_process';

export const NODE_FLOOR = '22.13';

// node:sqlite needs Node >= 22.13 (unflagged). Returns the message to print, or null when fine.
export function nodeFloorError(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return null;
  return (
    `codegraph: Node >= ${NODE_FLOOR} is required (node:sqlite), found ${version} at ${process.execPath}. ` +
    'Install a current Node LTS or make sure it is first on PATH.\n'
  );
}

export function enforceNodeFloor(version, out = process.stderr, exit = process.exit) {
  const message = nodeFloorError(version);
  if (!message) return false;
  out.write(message);
  exit(1);
  return true;
}

export function hasLiftoffOnly() {
  return (
    process.execArgv.some((a) => a === '--liftoff-only' || a.startsWith('--liftoff-only=')) ||
    (process.env.NODE_OPTIONS ?? '').includes('--liftoff-only')
  );
}

// Returns true when the caller may continue in this process; otherwise the
// process is a supervisor that exits with the child's code once it finishes.
export async function ensureLiftoffOnly(scriptPath) {
  // userConfig renders booleans as "true"/"false"; env-style callers use "1".
  const optIn = ['1', 'true', 'yes'].includes(String(process.env.CODEGRAPH_LIFTOFF_ONLY ?? '').toLowerCase());
  if (hasLiftoffOnly() || !optIn || process.env.CODEGRAPH_NO_REEXEC === '1') return true;
  const child = spawn(process.execPath, ['--liftoff-only', scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`codegraph: could not re-exec with --liftoff-only (${err.message}); continuing in-process\n`);
      resolve(null);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (code === null) return true;
  process.exit(code);
  return false;
}
