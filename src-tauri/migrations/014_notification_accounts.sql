-- notification_accounts: stores connected external accounts (Discord, Slack, future providers)
CREATE TABLE IF NOT EXISTS notification_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account_label TEXT NOT NULL,
    provider_user_id TEXT,
    provider_username TEXT,
    provider_avatar_url TEXT,
    provider_team_id TEXT,
    provider_team_name TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at TEXT,
    scopes TEXT,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    sync_channels TEXT,
    last_sync_at TEXT,
    sync_cursor TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_accounts_provider ON notification_accounts(provider);

-- Per-account, per-screen visibility toggles
CREATE TABLE IF NOT EXISTS notification_account_screen_toggles (
    account_id TEXT NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE,
    screen_key TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, screen_key)
);

-- Notification routing rules
CREATE TABLE IF NOT EXISTS notification_routing_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    source_type TEXT NOT NULL,
    source_value TEXT,
    destination_type TEXT NOT NULL,
    destination_config TEXT NOT NULL,
    template TEXT,
    filter_event_types TEXT,
    filter_keywords TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    stop_on_match INTEGER NOT NULL DEFAULT 0,
    chain_rule_id TEXT REFERENCES notification_routing_rules(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_source ON notification_routing_rules(source_type, source_value);
CREATE INDEX IF NOT EXISTS idx_routing_rules_enabled ON notification_routing_rules(is_enabled);

-- Routing execution log
CREATE TABLE IF NOT EXISTS notification_routing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL REFERENCES notification_routing_rules(id) ON DELETE CASCADE,
    notification_id TEXT NOT NULL,
    destination_type TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_log_rule ON notification_routing_log(rule_id);
CREATE INDEX IF NOT EXISTS idx_routing_log_notification ON notification_routing_log(notification_id);
