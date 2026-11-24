// Plugin configuration (CONTRACTS.md §12). Precedence per field:
// codegraph.json -> environment variable (only when the file leaves the field
// unset) -> DEFAULT_CONFIG. The file is user-owned, so a missing, unreadable or
// malformed file must never stop the MCP server: every problem degrades to the
// default and is reported as a single stderr line (stdout is protocol-only).
import fs from 'node:fs';
import path from 'node:path';
import { configPath } from './paths.mjs';

// `liftoffOnly` is the runtime safety switch of CONTRACTS.md §0, surfaced here so
// one object describes the whole runtime configuration; bin/server.mjs still
// reads the environment directly because it acts before any config is loaded.
export const DEFAULT_CONFIG = deepFreeze({
  autoIndex: true,
  minFilesToAutoIndex: 30,
  maxFiles: 30000,
  exclude: [],
  languages: null,
  defaultBudgetTokens: { lookup: 1500, map: 1200 },
  frontload: false,
  liftoffOnly: false,
  // The index store (src/index/storage.mjs): an index that last served a session more than
  // `maxIdleDays` ago is deleted (0 keeps every index); while the store is over `maxTotalMB`
  // the least recently used indexes go (0 is no limit). Indexes of projects whose directory
  // no longer exists are always deleted.
  maxIdleDays: 90,
  maxTotalMB: 0,
});

// Budget range of the MCP tools (CONTRACTS.md §10); a default outside it could
// never be used, so it is treated like any other invalid value.
export const BUDGET_TOKENS_MIN = 200;
export const BUDGET_TOKENS_MAX = 4000;

function deepFreeze(value) {
  for (const v of Object.values(value)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const isInteger = (v) => typeof v === 'number' && Number.isInteger(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Each field: how to recognise a valid value from the file and from the
// environment, and the default to fall back to.
const FIELD_SPECS = {
  autoIndex: {
    check: (v) => (typeof v === 'boolean' ? ok(v) : bad('must be a boolean')),
    env: { name: 'CODEGRAPH_AUTO_INDEX', parse: parseBoolean },
  },
  minFilesToAutoIndex: {
    check: (v) => (isInteger(v) && v >= 0 ? ok(v) : bad('must be an integer >= 0')),
    env: { name: 'CODEGRAPH_MIN_FILES', parse: (t) => parseInteger(t, 0) },
  },
  maxFiles: {
    check: (v) => (isInteger(v) && v >= 1 ? ok(v) : bad('must be an integer >= 1')),
    env: { name: 'CODEGRAPH_MAX_FILES', parse: (t) => parseInteger(t, 1) },
  },
  exclude: {
    check: checkStringArray,
    env: { name: 'CODEGRAPH_EXCLUDE', parse: parseExclude },
  },
  languages: {
    check: (v) => (v === null ? ok(null) : checkStringArray(v)),
    env: null,
  },
  defaultBudgetTokens: {
    check: checkBudgets,
    env: null,
  },
  frontload: {
    check: (v) => (typeof v === 'boolean' ? ok(v) : bad('must be a boolean')),
    env: null,
  },
  liftoffOnly: {
    check: (v) => (typeof v === 'boolean' ? ok(v) : bad('must be a boolean')),
    env: { name: 'CODEGRAPH_LIFTOFF_ONLY', parse: parseBoolean },
  },
  maxIdleDays: {
    check: (v) => (isInteger(v) && v >= 0 ? ok(v) : bad('must be an integer >= 0')),
    env: { name: 'CODEGRAPH_MAX_IDLE_DAYS', parse: (t) => parseInteger(t, 0) },
  },
  maxTotalMB: {
    check: (v) => (isInteger(v) && v >= 0 ? ok(v) : bad('must be an integer >= 0')),
    env: { name: 'CODEGRAPH_MAX_TOTAL_MB', parse: (t) => parseInteger(t, 0) },
  },
};

// What a project may set in its own file (see `loadProjectConfig`). Output budgets and the
// store policy belong to the user and are not in this list.
const PROJECT_FIELDS = ['autoIndex', 'minFilesToAutoIndex', 'maxFiles', 'exclude', 'languages'];

function ok(value) {
  return { ok: true, value };
}

function bad(reason) {
  return { ok: false, reason };
}

function checkStringArray(v) {
  if (!Array.isArray(v) || !v.every(nonEmptyString)) return bad('must be an array of non-empty strings');
  return ok([...v]);
}

function checkBudgets(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('must be an object with lookup/map token budgets');
  const merged = { ...DEFAULT_CONFIG.defaultBudgetTokens };
  for (const key of ['lookup', 'map']) {
    if (v[key] === undefined) continue;
    const n = v[key];
    if (!isInteger(n) || n < BUDGET_TOKENS_MIN || n > BUDGET_TOKENS_MAX) {
      return bad(`"${key}" must be an integer between ${BUDGET_TOKENS_MIN} and ${BUDGET_TOKENS_MAX}`);
    }
    merged[key] = n;
  }
  return ok(merged);
}

function parseBoolean(text) {
  // userConfig renders booleans as "true"/"false" (zcode-facts.md §1.4); "1"/"0"
  // and an explicit empty string (userConfig default "") are accepted as well.
  const t = text.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return ok(true);
  if (['', '0', 'false', 'no', 'off'].includes(t)) return ok(false);
  return bad('must be a boolean (true/false, 1/0, yes/no, on/off)');
}

function parseInteger(text, min) {
  // An empty string (userConfig default "") means "not set".
  if (text.trim() === '') return UNSET;
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < min) return bad(`must be an integer >= ${min}`);
  return ok(n);
}

function parseExclude(text) {
  // Comma separated; an empty string (userConfig default "") means "not set".
  const items = text.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? ok(items) : UNSET;
}

const UNSET = Object.freeze({ unset: true });

// Returns the parsed JSON object, or null after reporting why the file cannot
// be used. A leading BOM (common for files edited in Notepad) is tolerated.
// A missing file is reported unless `missingIsNormal` says otherwise (the project file).
function readConfigFile(file, warn, { missingIsNormal = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (!missingIsNormal) warn(`no config file at ${file}; using defaults`);
    } else warn(`cannot read config file ${file} (${err?.message ?? err}); using defaults`);
    return null;
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`config file ${file} must contain a JSON object; using defaults`);
      return null;
    }
    return parsed;
  } catch (err) {
    warn(`config file ${file} is not valid JSON (${err?.message ?? err}); using defaults`);
    return null;
  }
}

/**
 * Load the configuration.
 *
 * @param {{ file?: string, project?: object|null, env?: NodeJS.ProcessEnv, stderr?: { write: (s: string) => unknown } }} [options]
 *   `file` defaults to configPath(); `project` is what `loadProjectConfig` read for the
 *   project at hand; `env` and `stderr` are injectable for tests.
 * @returns {{ autoIndex: boolean, minFilesToAutoIndex: number, maxFiles: number, exclude: string[],
 *   languages: string[]|null, defaultBudgetTokens: { lookup: number, map: number }, frontload: boolean,
 *   liftoffOnly: boolean, maxIdleDays: number, maxTotalMB: number }} a fresh object on every
 *   call; never DEFAULT_CONFIG itself
 */
export function loadConfig({ file = configPath(), project = null, env = process.env, stderr = process.stderr } = {}) {
  const warn = (message) => stderr.write(`codegraph: ${message}\n`);
  const fromFile = readConfigFile(file, warn);
  const config = {
    ...DEFAULT_CONFIG,
    exclude: [...DEFAULT_CONFIG.exclude],
    defaultBudgetTokens: { ...DEFAULT_CONFIG.defaultBudgetTokens },
  };

  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    const inFile = fromFile ? fromFile[field] : undefined;
    if (inFile !== undefined && inFile !== null) {
      const checked = spec.check(inFile);
      if (checked.ok) {
        config[field] = checked.value;
        continue;
      }
      warn(`config: ignoring "${field}" in ${file}: ${checked.reason} (got ${describe(inFile)})`);
    }
    // Environment only fills a field the file left unset ("字段为空才回落").
    // The variable itself may be present but empty (userConfig renders every
    // key); each parser decides whether "" means false or "not set".
    if (!spec.env) continue;
    const raw = env[spec.env.name];
    if (raw === undefined || typeof raw !== 'string') continue;
    const parsed = spec.env.parse(raw);
    if (parsed.unset) continue;
    if (parsed.ok) config[field] = parsed.value;
    else warn(`config: ignoring ${spec.env.name}=${JSON.stringify(raw)}: ${parsed.reason}`);
  }
  return project ? applyProjectConfig(config, project) : config;
}

/** The project's own settings: `<project root>/.zcode/codegraph.json`, the directory the other plugins of this marketplace read project settings from. */
export function projectConfigPath(root) {
  if (typeof root !== 'string' || root.trim().length === 0) throw new TypeError('projectConfigPath: "root" must be a non-empty string');
  return path.join(path.resolve(root), '.zcode', 'codegraph.json');
}

/**
 * Read the project's settings. A project without the file is the normal case and says nothing.
 * Only `PROJECT_FIELDS` are read; anything else in the file is reported and dropped.
 *
 * @param {string} root  project root
 * @param {{ file?: string, stderr?: { write: (s: string) => unknown } }} [options]
 * @returns {object|null} the recognised fields with their values, or null without a file
 */
export function loadProjectConfig(root, { file = projectConfigPath(root), stderr = process.stderr } = {}) {
  const warn = (message) => stderr.write(`codegraph: ${message}\n`);
  const fromFile = readConfigFile(file, warn, { missingIsNormal: true });
  if (!fromFile) return null;
  const out = {};
  for (const field of PROJECT_FIELDS) {
    const value = fromFile[field];
    if (value === undefined || value === null) continue;
    const checked = FIELD_SPECS[field].check(value);
    if (checked.ok) out[field] = checked.value;
    else warn(`config: ignoring "${field}" in ${file}: ${checked.reason} (got ${describe(value)})`);
  }
  for (const field of Object.keys(fromFile)) {
    if (!PROJECT_FIELDS.includes(field)) warn(`config: ignoring "${field}" in ${file}: not a project setting`);
  }
  return out;
}

/**
 * A project's file can only tighten the user's configuration: it may switch indexing off,
 * exclude more, ask for more files before an automatic build, lower the file limit and narrow
 * the languages. A repository can never make the plugin index where the user switched it off,
 * nor spend more than the user allowed. Output budgets and the store policy are not its to set.
 * When the project switches indexing off, `autoIndexOffBy: 'project'` says where to tell the user.
 *
 * @param {object} config  result of the user's configuration
 * @param {object|null} project  result of `loadProjectConfig`
 * @returns {object} a new object; `config` is not modified
 */
export function applyProjectConfig(config, project) {
  const out = { ...config, exclude: [...config.exclude], defaultBudgetTokens: { ...config.defaultBudgetTokens } };
  if (!project) return out;
  if (project.autoIndex === false && out.autoIndex !== false) {
    out.autoIndex = false;
    out.autoIndexOffBy = 'project';
  }
  for (const pattern of project.exclude ?? []) if (!out.exclude.includes(pattern)) out.exclude.push(pattern);
  if (project.minFilesToAutoIndex !== undefined) out.minFilesToAutoIndex = Math.max(out.minFilesToAutoIndex, project.minFilesToAutoIndex);
  if (project.maxFiles !== undefined) out.maxFiles = Math.min(out.maxFiles, project.maxFiles);
  if (project.languages) {
    out.languages = out.languages ? out.languages.filter((lang) => project.languages.includes(lang)) : [...project.languages];
  }
  return out;
}
