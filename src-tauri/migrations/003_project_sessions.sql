CREATE TABLE IF NOT EXISTS project_sessions (
    project         TEXT NOT NULL,
    source          TEXT NOT NULL,
    last_event_type TEXT NOT NULL DEFAULT 'notification',
    last_title      TEXT NOT NULL,
    last_body       TEXT,
    last_metadata   TEXT,
    last_tmux_session TEXT,
    last_tmux_window  TEXT,
    last_tmux_pane    TEXT,
    notification_count INTEGER NOT NULL DEFAULT 1,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    PRIMARY KEY (project, source)
);

CREATE INDEX IF NOT EXISTS idx_project_sessions_last_seen ON project_sessions(last_seen_at DESC);

-- Backfill from existing notifications
INSERT OR REPLACE INTO project_sessions (
    project, source, last_event_type, last_title, last_body, last_metadata,
    last_tmux_session, last_tmux_window, last_tmux_pane,
    notification_count, unread_count, error_count,
    first_seen_at, last_seen_at
)
SELECT
    agg.project,
    agg.source,
    latest.event_type,
    latest.title,
    latest.body,
    latest.metadata,
    latest.tmux_session,
    latest.tmux_window,
    latest.tmux_pane,
    agg.notification_count,
    agg.unread_count,
    agg.error_count,
    agg.first_seen_at,
    agg.last_seen_at
FROM (
    SELECT
        COALESCE(project, source) as project,
        source,
        COUNT(*) as notification_count,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count,
        SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as error_count,
        MIN(created_at) as first_seen_at,
        MAX(created_at) as last_seen_at
    FROM notifications
    GROUP BY COALESCE(project, source), source
) agg
JOIN notifications latest ON latest.created_at = agg.last_seen_at
    AND COALESCE(latest.project, latest.source) = agg.project
    AND latest.source = agg.source;
