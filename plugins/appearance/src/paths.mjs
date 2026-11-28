// Where the launcher, the MCP server and the tests find their files: one folder of the plugin's
// own under the ZCode data directory. The environment override exists for tests and for anyone
// who keeps their ZCode data elsewhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function paths() {
  const base = process.env.ZCODE_APPEARANCE_HOME
    ? path.resolve(process.env.ZCODE_APPEARANCE_HOME)
    : path.join(os.homedir(), '.zcode');
  const dir = path.join(base, 'appearance');
  return {
    dir,
    config: path.join(dir, 'config.json'),
    log: path.join(dir, 'launcher.log'),
    status: path.join(dir, 'status.json'),
  };
}

// The three files used to sit loose next to that folder (`appearance.json`, `appearance.log`,
// `appearance.status.json`). The first time anything of the plugin runs after the move, they are
// brought into it; a file already there is left alone.
export function bringAlong(files = paths()) {
  const base = path.dirname(files.dir);
  for (const [name, target] of [['appearance.json', files.config], ['appearance.log', files.log], ['appearance.status.json', files.status]]) {
    const from = path.join(base, name);
    if (!fs.existsSync(from) || fs.existsSync(target)) continue;
    fs.mkdirSync(files.dir, { recursive: true });
    fs.renameSync(from, target);
  }
}
