-- codegraph index schema (node:sqlite). All DDL is idempotent.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per indexed source file. path is relative to the project root, forward slashes.
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  lang        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  parse_ok    INTEGER NOT NULL DEFAULT 1,
  error_nodes INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL
);

-- Definitions. parent_id = enclosing definition (method -> class). block = embedded script block index.
CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  qual       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  start_col  INTEGER NOT NULL,
  signature  TEXT,
  doc        TEXT,
  exported   INTEGER,
  block      INTEGER
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_qual ON symbols(qual);
-- FK cascades (ON DELETE) scan these columns for every deleted parent row.
CREATE INDEX IF NOT EXISTS symbols_parent ON symbols(parent_id);

-- External-content FTS over symbols; rows are maintained by repo.replaceAllForFile.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, doc,
  content = 'symbols', content_rowid = 'id',
  tokenize = "unicode61 tokenchars '_'"
);

-- Occurrences: calls, identifier references, type uses, inheritance, decorators.
-- resolution: '=' import-resolved, '~' unique-name, '?' unresolved/dynamic, NULL not processed yet.
CREATE TABLE IF NOT EXISTS refs (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id     INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  receiver      TEXT,
  kind          TEXT NOT NULL,
  start_line    INTEGER NOT NULL,
  start_col     INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  scope         TEXT,
  local_def_id  INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_id     INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  resolution    TEXT
);
CREATE INDEX IF NOT EXISTS refs_name   ON refs(name);
CREATE INDEX IF NOT EXISTS refs_target ON refs(target_id);
CREATE INDEX IF NOT EXISTS refs_symbol ON refs(symbol_id);
CREATE INDEX IF NOT EXISTS refs_file   ON refs(file_id);
CREATE INDEX IF NOT EXISTS refs_local_def ON refs(local_def_id);

CREATE TABLE IF NOT EXISTS imports (
  id                INTEGER PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec              TEXT NOT NULL,
  names             TEXT,
  kind              TEXT NOT NULL,
  start_line        INTEGER NOT NULL,
  resolved_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);

CREATE TABLE IF NOT EXISTS dirty (
  path TEXT PRIMARY KEY,
  at   INTEGER NOT NULL
);
