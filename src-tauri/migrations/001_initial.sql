CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    metadata     TEXT,
    project      TEXT,
    tmux_session TEXT,
    tmux_window  TEXT,
    tmux_pane    TEXT,
    is_read      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    read_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(source);
CREATE INDEX IF NOT EXISTS idx_notifications_project ON notifications(project);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
