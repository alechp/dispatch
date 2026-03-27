-- External snippet sources
CREATE TABLE IF NOT EXISTS snippet_sources (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    is_folder   INTEGER NOT NULL DEFAULT 0,
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    auto_reload INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snippets_source ON snippets(source_id);
CREATE INDEX IF NOT EXISTS idx_snippets_favorite ON snippets(is_favorite);
CREATE INDEX IF NOT EXISTS idx_snippets_source_trigger ON snippets(source_id, trigger);
