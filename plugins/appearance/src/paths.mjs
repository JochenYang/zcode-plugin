// Where the launcher, the MCP server and the tests find their files. The environment override
// exists for tests and for anyone who keeps their ZCode data elsewhere.
import os from 'node:os';
import path from 'node:path';

export function paths() {
  const base = process.env.ZCODE_APPEARANCE_HOME
    ? path.resolve(process.env.ZCODE_APPEARANCE_HOME)
    : path.join(os.homedir(), '.zcode');
  return {
    dir: base,
    config: path.join(base, 'appearance.json'),
    log: path.join(base, 'appearance.log'),
    status: path.join(base, 'appearance.status.json'),
  };
}
