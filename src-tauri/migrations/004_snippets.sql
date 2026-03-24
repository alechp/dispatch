CREATE TABLE IF NOT EXISTS snippets (
    id          TEXT PRIMARY KEY,
    trigger     TEXT NOT NULL,
    label       TEXT,
    body        TEXT NOT NULL,
    tags        TEXT,
    variables   TEXT,
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    use_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snippets_trigger ON snippets(trigger);
CREATE INDEX IF NOT EXISTS idx_snippets_use_count ON snippets(use_count DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_unique ON snippets(trigger);

-- Seed example snippets
INSERT OR IGNORE INTO snippets (id, trigger, label, body, tags, variables, is_enabled, use_count, created_at, updated_at) VALUES
('seed-1', ':date', 'Current date', '{{date}}', '["utility"]', '[{"name":"date","type":"date","params":{"format":"%Y-%m-%d"}}]', 1, 0, datetime('now'), datetime('now')),
('seed-2', ':time', 'Current time', '{{time}}', '["utility"]', '[{"name":"time","type":"date","params":{"format":"%H:%M"}}]', 1, 0, datetime('now'), datetime('now')),
('seed-3', ':sig', 'Email signature', 'Best regards,' || char(10) || '{{name}}', '["email"]', '[{"name":"name","type":"form","params":{"label":"Your name","default":""}}]', 1, 0, datetime('now'), datetime('now')),
('seed-4', ':shrug', 'Shrug emoji', '¯\_(ツ)_/¯', '["emoji"]', '[]', 1, 0, datetime('now'), datetime('now')),
('seed-5', ':clip', 'Clipboard contents', '{{clipboard}}', '["utility"]', '[{"name":"clipboard","type":"clipboard"}]', 1, 0, datetime('now'), datetime('now'));
