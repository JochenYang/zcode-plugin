// Indexer configuration (CONTRACTS.md §12). The indexer only ever receives a
// config object; reading codegraph.json and the environment overrides is the
// config lane's job (src/config.mjs). applyDefaults fills missing fields and
// rejects values of the wrong type, so a typo in the file surfaces as an
// actionable error instead of a silently misbehaving index.

export const DEFAULT_CONFIG = Object.freeze({
  autoIndex: true,
  minFilesToAutoIndex: 30,
  maxFiles: 30000,
  exclude: [],
  languages: null, // null = every language pack
  defaultBudgetTokens: Object.freeze({ lookup: 1500, map: 1200 }),
  frontload: false,
  // Not part of the §12 file schema yet (see contract-requests.md); files above
  // this size are skipped by the walker instead of being parsed.
  maxFileBytes: 4194304,
});

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isMissing(value) {
  return value === undefined || value === null;
}

function boolField(name, value, fallback) {
  if (isMissing(value)) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`applyDefaults: "${name}" must be a boolean (got ${describe(value)})`);
  return value;
}

function intField(name, value, fallback, min) {
  if (isMissing(value)) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new TypeError(`applyDefaults: "${name}" must be an integer >= ${min} (got ${describe(value)})`);
  }
  return value;
}

function stringArrayField(name, value, fallback) {
  if (isMissing(value)) return fallback;
  if (!Array.isArray(value)) throw new TypeError(`applyDefaults: "${name}" must be an array of strings (got ${describe(value)})`);
  return value.map((item, i) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new TypeError(`applyDefaults: "${name}[${i}]" must be a non-empty string (got ${describe(item)})`);
    }
    return item.trim();
  });
}

function objectField(name, value) {
  if (isMissing(value)) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`applyDefaults: "${name}" must be an object (got ${describe(value)})`);
  }
  return value;
}

/**
 * Merge a (possibly partial) config over DEFAULT_CONFIG. Always returns a new
 * object with fresh arrays, so callers can never mutate the shared defaults.
 *
 * @param {object} [config]
 * @returns {object}
 */
export function applyDefaults(config = {}) {
  const raw = objectField('config', config);
  const budget = objectField('defaultBudgetTokens', raw.defaultBudgetTokens);
  const defaults = DEFAULT_CONFIG;
  return {
    autoIndex: boolField('autoIndex', raw.autoIndex, defaults.autoIndex),
    minFilesToAutoIndex: intField('minFilesToAutoIndex', raw.minFilesToAutoIndex, defaults.minFilesToAutoIndex, 0),
    maxFiles: intField('maxFiles', raw.maxFiles, defaults.maxFiles, 1),
    exclude: stringArrayField('exclude', raw.exclude, [...defaults.exclude]),
    languages: isMissing(raw.languages) ? null : stringArrayField('languages', raw.languages, null),
    defaultBudgetTokens: {
      lookup: intField('defaultBudgetTokens.lookup', budget.lookup, defaults.defaultBudgetTokens.lookup, 1),
      map: intField('defaultBudgetTokens.map', budget.map, defaults.defaultBudgetTokens.map, 1),
    },
    frontload: boolField('frontload', raw.frontload, defaults.frontload),
    maxFileBytes: intField('maxFileBytes', raw.maxFileBytes, defaults.maxFileBytes, 1),
  };
}
