use sqlx::SqlitePool;

/// Initialize the relay database schema.
pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            slack_user_id TEXT NOT NULL UNIQUE,
            api_key TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            event_type TEXT NOT NULL,
            channel_id TEXT,
            channel_name TEXT,
            sender_name TEXT,
            sender_avatar TEXT,
            message_text TEXT,
            message_ts TEXT,
            raw_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    // Index for polling: look up events by user_id, ordered by created_at
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id, created_at)",
    )
    .execute(pool)
    .await?;

    // Discord users table (separate from Slack's `users` table)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS discord_users (
            id TEXT PRIMARY KEY,
            discord_user_id TEXT NOT NULL UNIQUE,
            api_key TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Look up a user by API key. Returns (user_id, slack_user_id).
pub async fn get_user_by_api_key(
    pool: &SqlitePool,
    api_key: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT id, slack_user_id FROM users WHERE api_key = ?",
    )
    .bind(api_key)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Register a new user (or update existing by slack_user_id).
pub async fn register_user(
    pool: &SqlitePool,
    slack_user_id: &str,
    api_key: &str,
) -> Result<String, sqlx::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Upsert: if slack_user_id exists, update api_key
    sqlx::query(
        "INSERT INTO users (id, slack_user_id, api_key, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slack_user_id) DO UPDATE SET api_key = excluded.api_key",
    )
    .bind(&id)
    .bind(slack_user_id)
    .bind(api_key)
    .bind(&now)
    .execute(pool)
    .await?;

    // Return the actual id (might be existing)
    let row: (String,) = sqlx::query_as(
        "SELECT id FROM users WHERE slack_user_id = ?",
    )
    .bind(slack_user_id)
    .fetch_one(pool)
    .await?;

    Ok(row.0)
}

/// Insert an event for a specific user.
pub async fn insert_event(
    pool: &SqlitePool,
    user_id: &str,
    event_type: &str,
    channel_id: Option<&str>,
    channel_name: Option<&str>,
    sender_name: Option<&str>,
    sender_avatar: Option<&str>,
    message_text: Option<&str>,
    message_ts: Option<&str>,
    raw_json: &str,
) -> Result<String, sqlx::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO events (id, user_id, event_type, channel_id, channel_name, sender_name, sender_avatar, message_text, message_ts, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(event_type)
    .bind(channel_id)
    .bind(channel_name)
    .bind(sender_name)
    .bind(sender_avatar)
    .bind(message_text)
    .bind(message_ts)
    .bind(raw_json)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(id)
}

/// Fetch and delete all queued events for a user (atomic poll).
pub async fn poll_events(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<Vec<EventRow>, sqlx::Error> {
    // Fetch events
    let events: Vec<EventRow> = sqlx::query_as(
        "SELECT id, user_id, event_type, channel_id, channel_name, sender_name, sender_avatar, message_text, message_ts, raw_json, created_at
         FROM events WHERE user_id = ? ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    if !events.is_empty() {
        // Delete the fetched events
        sqlx::query("DELETE FROM events WHERE user_id = ?")
            .bind(user_id)
            .execute(pool)
            .await?;
    }

    Ok(events)
}

/// Get all registered user IDs (for broadcasting events to all users).
pub async fn get_all_user_ids(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT id FROM users")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct EventRow {
    pub id: String,
    pub user_id: String,
    pub event_type: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
    pub message_text: Option<String>,
    pub message_ts: Option<String>,
    pub raw_json: String,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Discord user management
// ---------------------------------------------------------------------------

/// Register a Discord user (or update existing by discord_user_id).
pub async fn register_discord_user(
    pool: &SqlitePool,
    discord_user_id: &str,
    api_key: &str,
) -> Result<String, sqlx::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO discord_users (id, discord_user_id, api_key, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET api_key = excluded.api_key",
    )
    .bind(&id)
    .bind(discord_user_id)
    .bind(api_key)
    .bind(&now)
    .execute(pool)
    .await?;

    let row: (String,) = sqlx::query_as(
        "SELECT id FROM discord_users WHERE discord_user_id = ?",
    )
    .bind(discord_user_id)
    .fetch_one(pool)
    .await?;

    Ok(row.0)
}

/// Look up a Discord user by API key. Returns (user_id, discord_user_id).
pub async fn get_discord_user_by_api_key(
    pool: &SqlitePool,
    api_key: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT id, discord_user_id FROM discord_users WHERE api_key = ?",
    )
    .bind(api_key)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Get all registered Discord user IDs (internal IDs for event insertion).
pub async fn get_all_discord_user_ids(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT id FROM discord_users")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Unified lookup: find a user by API key across both Slack and Discord tables.
/// Returns (user_id, provider_user_id, provider).
pub async fn get_user_by_api_key_any(
    pool: &SqlitePool,
    api_key: &str,
) -> Result<Option<(String, String, String)>, sqlx::Error> {
    // Try Slack first
    if let Some((id, slack_id)) = get_user_by_api_key(pool, api_key).await? {
        return Ok(Some((id, slack_id, "slack".to_string())));
    }
    // Try Discord
    if let Some((id, discord_id)) = get_discord_user_by_api_key(pool, api_key).await? {
        return Ok(Some((id, discord_id, "discord".to_string())));
    }
    Ok(None)
}
