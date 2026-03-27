use sqlx::SqlitePool;
use uuid::Uuid;

use crate::models::{CreateNotificationRequest, Notification, QueryParams};

pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/002_telemetry.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/003_project_sessions.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/004_snippets.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/005_live_expansion.sql"))
        .execute(pool)
        .await?;

    // Migration 006: ALTER TABLE ADD COLUMN is not idempotent in SQLite.
    // Run each statement individually and ignore "duplicate column" errors.
    for stmt in ["ALTER TABLE project_sessions ADD COLUMN directory TEXT",
                 "ALTER TABLE project_sessions ADD COLUMN git_remote TEXT"] {
        if let Err(e) = sqlx::query(stmt).execute(pool).await {
            if !e.to_string().contains("duplicate column") {
                return Err(e);
            }
        }
    }

    sqlx::raw_sql(include_str!("../migrations/007_yapture_settings.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/008_yapture_oauth.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/009_hotkey_config.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/010_update_hotkey_defaults.sql"))
        .execute(pool)
        .await?;

    // Migration 011: yapture_task_id + sync setting
    for stmt in ["ALTER TABLE notifications ADD COLUMN yapture_task_id TEXT"] {
        if let Err(e) = sqlx::query(stmt).execute(pool).await {
            if !e.to_string().contains("duplicate column") {
                return Err(e);
            }
        }
    }
    sqlx::raw_sql("INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_bidirectional_sync', 'true')")
        .execute(pool)
        .await?;

    // Migration 012: snippet_sources table + source_id/source_type/is_favorite on snippets
    sqlx::raw_sql(include_str!("../migrations/012_snippet_sources_and_favorites.sql"))
        .execute(pool)
        .await?;
    for stmt in [
        "ALTER TABLE snippets ADD COLUMN source_id TEXT REFERENCES snippet_sources(id) ON DELETE CASCADE",
        "ALTER TABLE snippets ADD COLUMN source_type TEXT NOT NULL DEFAULT 'builtin'",
        "ALTER TABLE snippets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
    ] {
        if let Err(e) = sqlx::query(stmt).execute(pool).await {
            if !e.to_string().contains("duplicate column") {
                return Err(e);
            }
        }
    }
    // Indexes must be created after ALTER TABLE adds the columns
    for stmt in [
        "CREATE INDEX IF NOT EXISTS idx_snippets_source ON snippets(source_id)",
        "CREATE INDEX IF NOT EXISTS idx_snippets_favorite ON snippets(is_favorite)",
        "CREATE INDEX IF NOT EXISTS idx_snippets_source_trigger ON snippets(source_id, trigger)",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    Ok(())
}

pub async fn insert_notification(
    pool: &SqlitePool,
    req: &CreateNotificationRequest,
) -> Result<Notification, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let source = req.source.as_deref().unwrap_or("unknown");
    let event_type = req.event_type.as_deref().unwrap_or("notification");
    let metadata = req.metadata.as_ref().map(|m| m.to_string());

    sqlx::query(
        "INSERT INTO notifications (id, source, event_type, title, body, metadata, project, tmux_session, tmux_window, tmux_pane, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
    )
    .bind(&id)
    .bind(source)
    .bind(event_type)
    .bind(&req.title)
    .bind(&req.body)
    .bind(&metadata)
    .bind(&req.project)
    .bind(&req.tmux_session)
    .bind(&req.tmux_window)
    .bind(&req.tmux_pane)
    .bind(&now)
    .execute(pool)
    .await?;

    let notification = sqlx::query_as::<_, Notification>("SELECT * FROM notifications WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await?;

    Ok(notification)
}

pub async fn query_notifications(
    pool: &SqlitePool,
    params: &QueryParams,
) -> Result<(Vec<Notification>, i64), sqlx::Error> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let mut conditions = vec!["1=1".to_string()];
    let mut bind_values: Vec<String> = vec![];

    if let Some(ref source) = params.source {
        conditions.push(format!("source = ${}", bind_values.len() + 1));
        bind_values.push(source.clone());
    }
    if let Some(ref project) = params.project {
        conditions.push(format!("project = ${}", bind_values.len() + 1));
        bind_values.push(project.clone());
    }
    if let Some(is_read) = params.is_read {
        conditions.push(format!("is_read = ${}", bind_values.len() + 1));
        bind_values.push(is_read.to_string());
    }
    if let Some(ref search) = params.search {
        conditions.push(format!(
            "(title LIKE ${0} OR body LIKE ${0})",
            bind_values.len() + 1
        ));
        bind_values.push(format!("%{search}%"));
    }

    let where_clause = conditions.join(" AND ");

    // For SQLite with dynamic queries, we'll use raw SQL with manual binding
    let count_sql = format!("SELECT COUNT(*) as count FROM notifications WHERE {where_clause}");
    let query_sql = format!(
        "SELECT * FROM notifications WHERE {where_clause} ORDER BY created_at DESC LIMIT {limit} OFFSET {offset}"
    );

    // Build count query
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for val in &bind_values {
        count_query = count_query.bind(val);
    }
    let total = count_query.fetch_one(pool).await.unwrap_or(0);

    // Build data query
    let mut data_query = sqlx::query_as::<_, Notification>(&query_sql);
    for val in &bind_values {
        data_query = data_query.bind(val);
    }
    let notifications = data_query.fetch_all(pool).await?;

    Ok((notifications, total))
}

pub async fn mark_read(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let result =
        sqlx::query("UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND is_read = 0")
            .bind(&now)
            .bind(id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn mark_all_read(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let result =
        sqlx::query("UPDATE notifications SET is_read = 1, read_at = ? WHERE is_read = 0")
            .bind(&now)
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

pub async fn delete_notification(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM notifications WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn clear_all_notifications(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM notifications")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

pub async fn record_telemetry(
    pool: &SqlitePool,
    event_type: &str,
    target_id: Option<&str>,
    source: Option<&str>,
    project: Option<&str>,
    metadata: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO telemetry_events (event_type, target_id, source, project, metadata) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(event_type)
    .bind(target_id)
    .bind(source)
    .bind(project)
    .bind(metadata)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn query_telemetry(
    pool: &SqlitePool,
    event_type: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<crate::models::TelemetryEvent>, sqlx::Error> {
    let mut sql = String::from("SELECT id, event_type, target_id, source, project, metadata, created_at FROM telemetry_events WHERE 1=1");
    let mut args: Vec<String> = Vec::new();

    if let Some(et) = event_type {
        sql.push_str(" AND event_type = ?");
        args.push(et.to_string());
    }
    if let Some(f) = from {
        sql.push_str(" AND created_at >= ?");
        args.push(f.to_string());
    }
    if let Some(t) = to {
        sql.push_str(" AND created_at <= ?");
        args.push(t.to_string());
    }
    sql.push_str(" ORDER BY created_at DESC");
    let lim = limit.unwrap_or(100).min(500);
    sql.push_str(&format!(" LIMIT {}", lim));

    let mut query = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<String>, Option<String>, String)>(&sql);
    for arg in &args {
        query = query.bind(arg);
    }

    let rows = query.fetch_all(pool).await?;
    Ok(rows.into_iter().map(|r| crate::models::TelemetryEvent {
        id: r.0,
        event_type: r.1,
        target_id: r.2,
        source: r.3,
        project: r.4,
        metadata: r.5,
        created_at: r.6,
    }).collect())
}

pub async fn get_telemetry_summary(
    pool: &SqlitePool,
    from: &str,
    to: &str,
) -> Result<crate::models::TelemetrySummary, sqlx::Error> {
    // Count by event type
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT event_type, COUNT(*) as count FROM telemetry_events WHERE created_at BETWEEN ? AND ? GROUP BY event_type"
    )
    .bind(from).bind(to)
    .fetch_all(pool).await?;

    let count_of = |et: &str| -> i64 {
        counts.iter().find(|(t, _)| t == et).map(|(_, c)| *c).unwrap_or(0)
    };

    // Avg time to read
    let avg_row: Option<(Option<f64>,)> = sqlx::query_as(
        "SELECT AVG((julianday(read_at) - julianday(created_at)) * 86400) FROM notifications WHERE read_at IS NOT NULL AND created_at BETWEEN ? AND ?"
    )
    .bind(from).bind(to)
    .fetch_optional(pool).await?;
    let avg_time_to_read_seconds = avg_row.and_then(|r| r.0);

    // Busiest hour
    let busiest: Option<(i32,)> = sqlx::query_as(
        "SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour FROM telemetry_events WHERE event_type = 'notification_received' AND created_at BETWEEN ? AND ? GROUP BY hour ORDER BY COUNT(*) DESC LIMIT 1"
    )
    .bind(from).bind(to)
    .fetch_optional(pool).await?;
    let busiest_hour = busiest.map(|r| r.0);

    // Top sources
    let top_sources: Vec<(String, i64)> = sqlx::query_as(
        "SELECT source, COUNT(*) as count FROM telemetry_events WHERE source IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY source ORDER BY count DESC LIMIT 10"
    )
    .bind(from).bind(to)
    .fetch_all(pool).await?;

    // Events by day
    let events_by_day: Vec<(String, i64)> = sqlx::query_as(
        "SELECT date(created_at) as day, COUNT(*) as count FROM telemetry_events WHERE created_at BETWEEN ? AND ? GROUP BY day ORDER BY day"
    )
    .bind(from).bind(to)
    .fetch_all(pool).await?;

    // Reads by method
    let reads_by_method: Vec<(String, i64)> = sqlx::query_as(
        "SELECT json_extract(metadata, '$.method') as method, COUNT(*) as count FROM telemetry_events WHERE event_type = 'notification_read' AND created_at BETWEEN ? AND ? GROUP BY method"
    )
    .bind(from).bind(to)
    .fetch_all(pool).await?;

    Ok(crate::models::TelemetrySummary {
        total_received: count_of("notification_received"),
        total_read: count_of("notification_read"),
        total_deleted: count_of("notification_deleted"),
        total_terminal_focuses: count_of("terminal_focused"),
        total_app_opens: count_of("app_shown"),
        avg_time_to_read_seconds,
        busiest_hour,
        top_sources,
        events_by_day,
        reads_by_method,
    })
}

// --- Project Session functions ---

pub async fn upsert_project_session(
    pool: &SqlitePool,
    notification: &crate::models::Notification,
) -> Result<(), sqlx::Error> {
    let project = notification.project.as_deref().unwrap_or(&notification.source);
    let error_inc: i32 = if notification.event_type == "error" { 1 } else { 0 };

    // Parse metadata for directory/git_remote
    let (directory, git_remote) = notification.metadata.as_deref()
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .map(|v| (
            v.get("directory").and_then(|d| d.as_str()).map(String::from),
            v.get("git_remote").and_then(|g| g.as_str()).map(String::from),
        ))
        .unwrap_or((None, None));

    sqlx::query(
        "INSERT INTO project_sessions (project, source, last_event_type, last_title, last_body, last_metadata, last_tmux_session, last_tmux_window, last_tmux_pane, notification_count, unread_count, error_count, first_seen_at, last_seen_at, directory, git_remote)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(project, source) DO UPDATE SET
           last_event_type = excluded.last_event_type,
           last_title = excluded.last_title,
           last_body = excluded.last_body,
           last_metadata = excluded.last_metadata,
           last_tmux_session = excluded.last_tmux_session,
           last_tmux_window = excluded.last_tmux_window,
           last_tmux_pane = excluded.last_tmux_pane,
           notification_count = project_sessions.notification_count + 1,
           unread_count = project_sessions.unread_count + 1,
           error_count = project_sessions.error_count + excluded.error_count,
           last_seen_at = excluded.last_seen_at,
           directory = COALESCE(project_sessions.directory, excluded.directory),
           git_remote = COALESCE(project_sessions.git_remote, excluded.git_remote)"
    )
    .bind(project)
    .bind(&notification.source)
    .bind(&notification.event_type)
    .bind(&notification.title)
    .bind(&notification.body)
    .bind(&notification.metadata)
    .bind(&notification.tmux_session)
    .bind(&notification.tmux_window)
    .bind(&notification.tmux_pane)
    .bind(error_inc)
    .bind(&notification.created_at)
    .bind(&notification.created_at)
    .bind(&directory)
    .bind(&git_remote)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn decrement_session_unread(
    pool: &SqlitePool,
    project: &str,
    source: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE project_sessions SET unread_count = MAX(0, unread_count - 1) WHERE project = ? AND source = ?"
    )
    .bind(project)
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn reset_all_session_unread(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE project_sessions SET unread_count = 0")
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_project_sessions(
    pool: &SqlitePool,
    search: Option<&str>,
) -> Result<Vec<crate::models::ProjectSession>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64, i64, String, String, Option<String>, Option<String>)> = if let Some(s) = search {
        let pattern = format!("%{}%", s);
        sqlx::query_as(
            "SELECT project, source, last_event_type, last_title, last_body, last_metadata, last_tmux_session, last_tmux_window, last_tmux_pane, notification_count, unread_count, error_count, first_seen_at, last_seen_at, directory, git_remote FROM project_sessions WHERE project LIKE ? ORDER BY last_seen_at DESC"
        )
        .bind(pattern)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT project, source, last_event_type, last_title, last_body, last_metadata, last_tmux_session, last_tmux_window, last_tmux_pane, notification_count, unread_count, error_count, first_seen_at, last_seen_at, directory, git_remote FROM project_sessions ORDER BY last_seen_at DESC"
        )
        .fetch_all(pool)
        .await?
    };

    Ok(rows.into_iter().map(|r| crate::models::ProjectSession {
        project: r.0,
        source: r.1,
        last_event_type: r.2,
        last_title: r.3,
        last_body: r.4,
        last_metadata: r.5,
        last_tmux_session: r.6,
        last_tmux_window: r.7,
        last_tmux_pane: r.8,
        notification_count: r.9,
        unread_count: r.10,
        error_count: r.11,
        first_seen_at: r.12,
        last_seen_at: r.13,
        directory: r.14,
        git_remote: r.15,
    }).collect())
}

pub async fn update_project_metadata(
    pool: &SqlitePool,
    project: &str,
    source: &str,
    directory: Option<&str>,
    git_remote: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<String> = Vec::new();

    if let Some(d) = directory {
        sets.push("directory = ?".to_string());
        args.push(d.to_string());
    }
    if let Some(g) = git_remote {
        sets.push("git_remote = ?".to_string());
        args.push(g.to_string());
    }

    if sets.is_empty() {
        return Ok(());
    }

    let sql = format!(
        "UPDATE project_sessions SET {} WHERE project = ? AND source = ?",
        sets.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for arg in &args {
        query = query.bind(arg);
    }
    query = query.bind(project).bind(source);
    query.execute(pool).await?;
    Ok(())
}

pub async fn get_notification_by_id(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<crate::models::Notification>, sqlx::Error> {
    let row: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i32, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, source, event_type, title, body, metadata, project, tmux_session, tmux_window, tmux_pane, is_read, created_at, read_at, yapture_task_id FROM notifications WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| crate::models::Notification {
        id: r.0,
        source: r.1,
        event_type: r.2,
        title: r.3,
        body: r.4,
        metadata: r.5,
        project: r.6,
        tmux_session: r.7,
        tmux_window: r.8,
        tmux_pane: r.9,
        is_read: r.10,
        created_at: r.11,
        read_at: r.12,
        yapture_task_id: r.13,
    }))
}

pub async fn set_yapture_task_id(pool: &SqlitePool, notification_id: &str, yapture_task_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE notifications SET yapture_task_id = ? WHERE id = ?")
        .bind(yapture_task_id)
        .bind(notification_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_all_notification_yapture_ids(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT yapture_task_id FROM notifications WHERE yapture_task_id IS NOT NULL AND yapture_task_id != ''"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

// --- Snippet functions ---

pub async fn create_snippet(
    pool: &SqlitePool,
    trigger: &str,
    label: Option<&str>,
    body: &str,
    tags: Option<&str>,
    variables: Option<&str>,
) -> Result<crate::models::Snippet, sqlx::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO snippets (id, trigger, label, body, tags, variables, is_enabled, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)"
    )
    .bind(&id).bind(trigger).bind(label).bind(body).bind(tags).bind(variables).bind(&now).bind(&now)
    .execute(pool).await?;

    // Return the created snippet
    get_snippet(pool, &id).await.map(|opt| opt.unwrap())
}

pub async fn update_snippet(
    pool: &SqlitePool,
    id: &str,
    trigger: Option<&str>,
    label: Option<&str>,
    body: Option<&str>,
    tags: Option<&str>,
    variables: Option<&str>,
    is_enabled: Option<i32>,
) -> Result<crate::models::Snippet, sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut sets = vec!["updated_at = ?".to_string()];
    let mut args: Vec<String> = vec![now];

    if let Some(v) = trigger { sets.push("trigger = ?".into()); args.push(v.to_string()); }
    if let Some(v) = label { sets.push("label = ?".into()); args.push(v.to_string()); }
    if let Some(v) = body { sets.push("body = ?".into()); args.push(v.to_string()); }
    if let Some(v) = tags { sets.push("tags = ?".into()); args.push(v.to_string()); }
    if let Some(v) = variables { sets.push("variables = ?".into()); args.push(v.to_string()); }
    if let Some(v) = is_enabled { sets.push("is_enabled = ?".into()); args.push(v.to_string()); }

    let sql = format!("UPDATE snippets SET {} WHERE id = ?", sets.join(", "));
    let mut query = sqlx::query(&sql);
    for arg in &args {
        query = query.bind(arg);
    }
    query = query.bind(id);
    query.execute(pool).await?;

    get_snippet(pool, id).await.map(|opt| opt.unwrap())
}

pub async fn delete_snippet(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM snippets WHERE id = ?")
        .bind(id).execute(pool).await?;
    Ok(result.rows_affected() > 0)
}

type SnippetRow = (String, String, Option<String>, String, Option<String>, Option<String>, i32, i64, Option<String>, String, String, Option<String>, Option<String>, Option<i32>);

fn row_to_snippet(r: SnippetRow) -> crate::models::Snippet {
    crate::models::Snippet {
        id: r.0, trigger: r.1, label: r.2, body: r.3, tags: r.4, variables: r.5,
        is_enabled: r.6, use_count: r.7, last_used_at: r.8, created_at: r.9, updated_at: r.10,
        source_id: r.11, source_type: r.12, is_favorite: r.13, source_name: None,
    }
}

type SnippetRowWithSource = (String, String, Option<String>, String, Option<String>, Option<String>, i32, i64, Option<String>, String, String, Option<String>, Option<String>, Option<i32>, Option<String>);

fn row_to_snippet_with_source(r: SnippetRowWithSource) -> crate::models::Snippet {
    crate::models::Snippet {
        id: r.0, trigger: r.1, label: r.2, body: r.3, tags: r.4, variables: r.5,
        is_enabled: r.6, use_count: r.7, last_used_at: r.8, created_at: r.9, updated_at: r.10,
        source_id: r.11, source_type: r.12, is_favorite: r.13, source_name: r.14,
    }
}

const SNIPPET_COLS: &str = "s.id, s.trigger, s.label, s.body, s.tags, s.variables, s.is_enabled, s.use_count, s.last_used_at, s.created_at, s.updated_at, s.source_id, s.source_type, s.is_favorite";
const SNIPPET_COLS_WITH_SOURCE: &str = "s.id, s.trigger, s.label, s.body, s.tags, s.variables, s.is_enabled, s.use_count, s.last_used_at, s.created_at, s.updated_at, s.source_id, s.source_type, s.is_favorite, COALESCE(ss.name, 'Defaults') as source_name";

pub async fn get_snippet(pool: &SqlitePool, id: &str) -> Result<Option<crate::models::Snippet>, sqlx::Error> {
    let row: Option<SnippetRow> = sqlx::query_as(
        &format!("SELECT {} FROM snippets s WHERE s.id = ?", SNIPPET_COLS)
    ).bind(id).fetch_optional(pool).await?;

    Ok(row.map(row_to_snippet))
}

pub async fn list_snippets(
    pool: &SqlitePool,
    search: Option<&str>,
    tag: Option<&str>,
    source_id: Option<&str>,
) -> Result<Vec<crate::models::Snippet>, sqlx::Error> {
    let mut sql = format!("SELECT {} FROM snippets s LEFT JOIN snippet_sources ss ON s.source_id = ss.id WHERE s.is_enabled = 1 AND (s.source_id IS NULL OR ss.is_enabled = 1 OR ss.is_enabled IS NULL)", SNIPPET_COLS_WITH_SOURCE);
    let mut args: Vec<String> = Vec::new();

    if let Some(sid) = source_id {
        sql.push_str(" AND s.source_id = ?");
        args.push(sid.to_string());
    }
    if let Some(s) = search {
        sql.push_str(" AND (s.trigger LIKE ? OR s.label LIKE ? OR s.body LIKE ? OR s.tags LIKE ?)");
        let pattern = format!("%{}%", s);
        args.push(pattern.clone());
        args.push(pattern.clone());
        args.push(pattern.clone());
        args.push(pattern);
    }
    if let Some(t) = tag {
        sql.push_str(" AND s.tags LIKE ?");
        args.push(format!("%\"{}\"%" , t));
    }
    sql.push_str(" ORDER BY s.use_count DESC, s.updated_at DESC");

    let mut query = sqlx::query_as::<_, SnippetRowWithSource>(&sql);
    for arg in &args {
        query = query.bind(arg);
    }
    let rows = query.fetch_all(pool).await?;

    Ok(rows.into_iter().map(row_to_snippet_with_source).collect())
}

pub async fn list_all_snippets(pool: &SqlitePool) -> Result<Vec<crate::models::Snippet>, sqlx::Error> {
    let rows: Vec<SnippetRowWithSource> = sqlx::query_as(
        &format!("SELECT {} FROM snippets s LEFT JOIN snippet_sources ss ON s.source_id = ss.id ORDER BY s.updated_at DESC", SNIPPET_COLS_WITH_SOURCE)
    ).fetch_all(pool).await?;

    Ok(rows.into_iter().map(row_to_snippet_with_source).collect())
}

pub async fn increment_snippet_use(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE snippets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
        .bind(&now).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn list_recent_snippets(pool: &SqlitePool, limit: i64) -> Result<Vec<crate::models::Snippet>, sqlx::Error> {
    let sql = format!(
        "SELECT {} FROM snippets s LEFT JOIN snippet_sources ss ON s.source_id = ss.id WHERE s.is_enabled = 1 AND (s.source_id IS NULL OR ss.is_enabled = 1 OR ss.is_enabled IS NULL) AND s.last_used_at IS NOT NULL ORDER BY s.last_used_at DESC LIMIT ?",
        SNIPPET_COLS_WITH_SOURCE
    );
    let rows: Vec<SnippetRowWithSource> = sqlx::query_as(&sql).bind(limit).fetch_all(pool).await?;
    Ok(rows.into_iter().map(row_to_snippet_with_source).collect())
}

pub async fn list_favorite_snippets(pool: &SqlitePool) -> Result<Vec<crate::models::Snippet>, sqlx::Error> {
    let sql = format!(
        "SELECT {} FROM snippets s LEFT JOIN snippet_sources ss ON s.source_id = ss.id WHERE s.is_enabled = 1 AND (s.source_id IS NULL OR ss.is_enabled = 1 OR ss.is_enabled IS NULL) AND s.is_favorite = 1 ORDER BY s.use_count DESC",
        SNIPPET_COLS_WITH_SOURCE
    );
    let rows: Vec<SnippetRowWithSource> = sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(row_to_snippet_with_source).collect())
}

pub async fn toggle_snippet_favorite(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as("SELECT COALESCE(is_favorite, 0) FROM snippets WHERE id = ?")
        .bind(id).fetch_optional(pool).await?;
    let current = row.map(|r| r.0).unwrap_or(0);
    let new_val = if current == 0 { 1 } else { 0 };
    sqlx::query("UPDATE snippets SET is_favorite = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(new_val).bind(id).execute(pool).await?;
    Ok(new_val == 1)
}

pub async fn get_expand_prefix(pool: &SqlitePool) -> Result<String, String> {
    get_setting(pool, "expand_prefix")
        .await
        .map_err(|e| e.to_string())
        .map(|v| v.unwrap_or_else(|| ":".to_string()))
}

pub async fn set_expand_prefix(pool: &SqlitePool, prefix: &str) -> Result<(), String> {
    set_setting(pool, "expand_prefix", prefix)
        .await
        .map_err(|e| e.to_string())
}

// --- Snippet Source functions ---

pub async fn create_snippet_source(
    pool: &SqlitePool,
    name: &str,
    path: &str,
    is_folder: bool,
) -> Result<crate::models::SnippetSource, sqlx::Error> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let is_folder_val: i32 = if is_folder { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO snippet_sources (id, name, path, is_folder, is_enabled, auto_reload, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)"
    )
    .bind(&id).bind(name).bind(path).bind(is_folder_val).bind(&now).bind(&now)
    .execute(pool).await?;

    get_snippet_source(pool, &id).await.map(|opt| opt.unwrap())
}

pub async fn get_snippet_source(pool: &SqlitePool, id: &str) -> Result<Option<crate::models::SnippetSource>, sqlx::Error> {
    let row: Option<(String, String, String, i32, i32, i32, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, name, path, is_folder, is_enabled, auto_reload, last_synced_at, created_at, updated_at FROM snippet_sources WHERE id = ?"
    ).bind(id).fetch_optional(pool).await?;

    Ok(row.map(|r| crate::models::SnippetSource {
        id: r.0, name: r.1, path: r.2, is_folder: r.3, is_enabled: r.4, auto_reload: r.5,
        last_synced_at: r.6, created_at: r.7, updated_at: r.8,
    }))
}

pub async fn list_snippet_sources(pool: &SqlitePool) -> Result<Vec<crate::models::SnippetSource>, sqlx::Error> {
    let rows: Vec<(String, String, String, i32, i32, i32, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, name, path, is_folder, is_enabled, auto_reload, last_synced_at, created_at, updated_at FROM snippet_sources ORDER BY created_at ASC"
    ).fetch_all(pool).await?;

    Ok(rows.into_iter().map(|r| crate::models::SnippetSource {
        id: r.0, name: r.1, path: r.2, is_folder: r.3, is_enabled: r.4, auto_reload: r.5,
        last_synced_at: r.6, created_at: r.7, updated_at: r.8,
    }).collect())
}

pub async fn update_snippet_source(
    pool: &SqlitePool,
    id: &str,
    name: Option<&str>,
    is_enabled: Option<bool>,
    auto_reload: Option<bool>,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut sets = vec!["updated_at = ?".to_string()];
    let mut args: Vec<String> = vec![now];

    if let Some(v) = name { sets.push("name = ?".into()); args.push(v.to_string()); }
    if let Some(v) = is_enabled { sets.push("is_enabled = ?".into()); args.push(if v { "1" } else { "0" }.to_string()); }
    if let Some(v) = auto_reload { sets.push("auto_reload = ?".into()); args.push(if v { "1" } else { "0" }.to_string()); }

    let sql = format!("UPDATE snippet_sources SET {} WHERE id = ?", sets.join(", "));
    let mut query = sqlx::query(&sql);
    for arg in &args {
        query = query.bind(arg);
    }
    query = query.bind(id);
    query.execute(pool).await?;
    Ok(())
}

pub async fn delete_snippet_source(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    // Cascade: delete snippets from this source first
    sqlx::query("DELETE FROM snippets WHERE source_id = ?").bind(id).execute(pool).await?;
    let result = sqlx::query("DELETE FROM snippet_sources WHERE id = ?").bind(id).execute(pool).await?;
    Ok(result.rows_affected() > 0)
}

pub async fn update_snippet_source_synced(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE snippet_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?")
        .bind(&now).bind(&now).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn upsert_source_snippet(
    pool: &SqlitePool,
    source_id: &str,
    trigger: &str,
    label: Option<&str>,
    body: &str,
    tags: Option<&str>,
    variables: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    // Try to find existing snippet from this source with same trigger
    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM snippets WHERE source_id = ? AND trigger = ?"
    ).bind(source_id).bind(trigger).fetch_optional(pool).await?;

    if let Some((id,)) = existing {
        sqlx::query("UPDATE snippets SET label = ?, body = ?, tags = ?, variables = ?, updated_at = ? WHERE id = ?")
            .bind(label).bind(body).bind(tags).bind(variables).bind(&now).bind(&id)
            .execute(pool).await?;
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO snippets (id, trigger, label, body, tags, variables, is_enabled, use_count, source_id, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, 'file', ?, ?)"
        )
        .bind(&id).bind(trigger).bind(label).bind(body).bind(tags).bind(variables)
        .bind(source_id).bind(&now).bind(&now)
        .execute(pool).await?;
    }
    Ok(())
}

pub async fn remove_stale_source_snippets(
    pool: &SqlitePool,
    source_id: &str,
    active_triggers: &[String],
) -> Result<usize, sqlx::Error> {
    if active_triggers.is_empty() {
        let result = sqlx::query("DELETE FROM snippets WHERE source_id = ?")
            .bind(source_id).execute(pool).await?;
        return Ok(result.rows_affected() as usize);
    }

    // Build placeholders
    let placeholders: Vec<&str> = active_triggers.iter().map(|_| "?").collect();
    let sql = format!(
        "DELETE FROM snippets WHERE source_id = ? AND trigger NOT IN ({})",
        placeholders.join(", ")
    );
    let mut query = sqlx::query(&sql).bind(source_id);
    for trigger in active_triggers {
        query = query.bind(trigger);
    }
    let result = query.execute(pool).await?;
    Ok(result.rows_affected() as usize)
}

// --- Settings functions ---

pub async fn get_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|r| r.0))
}

pub const DEFAULT_HOTKEY_CONFIG: &str = r#"{"bindings":[{"action":"toggle_window","keys":["CommandOrControl+Shift+D"],"enabled":true,"scope":"global","category":"Global","description":"Toggle window"},{"action":"show_command_palette","keys":["CommandOrControl+Shift+K"],"enabled":true,"scope":"global","category":"Global","description":"Command palette"},{"action":"select_next","keys":["j","ArrowDown"],"enabled":true,"scope":"app","category":"Navigation","description":"Next notification"},{"action":"select_prev","keys":["k","ArrowUp"],"enabled":true,"scope":"app","category":"Navigation","description":"Previous notification"},{"action":"focus_search","keys":["f"],"enabled":true,"scope":"app","category":"Navigation","description":"Focus search"},{"action":"clear_selection","keys":["Escape"],"enabled":true,"scope":"app","category":"Navigation","description":"Clear selection"},{"action":"mark_selected_read","keys":["Enter","r"],"enabled":true,"scope":"app","category":"Actions","description":"Mark read"},{"action":"delete_selected","keys":["d","Backspace"],"enabled":true,"scope":"app","category":"Actions","description":"Delete"},{"action":"focus_terminal","keys":["t"],"enabled":true,"scope":"app","category":"Actions","description":"Focus terminal"},{"action":"mark_all_read","keys":["R"],"enabled":true,"scope":"app","category":"Actions","description":"Mark all read"},{"action":"clear_all","keys":["D"],"enabled":true,"scope":"app","category":"Actions","description":"Clear all"},{"action":"filter_all","keys":["1"],"enabled":true,"scope":"app","category":"Filters","description":"All"},{"action":"filter_unread","keys":["2"],"enabled":true,"scope":"app","category":"Filters","description":"Unread"},{"action":"filter_read","keys":["3"],"enabled":true,"scope":"app","category":"Filters","description":"Read"},{"action":"toggle_help","keys":["?"],"enabled":true,"scope":"app","category":"Help","description":"Toggle help"},{"action":"toggle_visual_mode","keys":["v"],"enabled":true,"scope":"app","category":"Visual","description":"Toggle visual mode"},{"action":"visual_toggle_item","keys":[" "],"enabled":true,"scope":"app","category":"Visual","description":"Toggle item selection"}]}"#;

pub async fn get_hotkey_config(
    pool: &SqlitePool,
) -> Result<crate::models::HotkeyConfig, String> {
    let defaults: crate::models::HotkeyConfig = serde_json::from_str(DEFAULT_HOTKEY_CONFIG)
        .map_err(|e| format!("Bad default config: {}", e))?;

    let saved_json = get_setting(pool, "hotkey_config")
        .await
        .map_err(|e| e.to_string())?;

    match saved_json {
        None => Ok(defaults),
        Some(json) => {
            let mut config: crate::models::HotkeyConfig = serde_json::from_str(&json)
                .map_err(|e| format!("Failed to parse hotkey config: {}", e))?;
            // Add any actions from defaults that are missing in saved config
            let existing: std::collections::HashSet<String> =
                config.bindings.iter().map(|b| b.action.clone()).collect();
            for binding in &defaults.bindings {
                if !existing.contains(&binding.action) {
                    config.bindings.push(binding.clone());
                }
            }
            Ok(config)
        }
    }
}

pub async fn set_hotkey_config(
    pool: &SqlitePool,
    config: &crate::models::HotkeyConfig,
) -> Result<(), String> {
    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
    set_setting(pool, "hotkey_config", &json)
        .await
        .map_err(|e| e.to_string())
}

pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn test_insert_and_query() {
        let pool = test_pool().await;
        let req = CreateNotificationRequest {
            title: "Test".to_string(),
            body: Some("Hello".to_string()),
            source: Some("test".to_string()),
            event_type: Some("stop".to_string()),
            metadata: None,
            project: Some("my-project".to_string()),
            tmux_session: None,
            tmux_window: None,
            tmux_pane: None,
        };

        let n = insert_notification(&pool, &req).await.unwrap();
        assert_eq!(n.title, "Test");
        assert_eq!(n.source, "test");
        assert_eq!(n.is_read, 0);

        let params = QueryParams {
            source: None,
            project: None,
            is_read: None,
            search: None,
            limit: None,
            offset: None,
        };
        let (results, total) = query_notifications(&pool, &params).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(results[0].title, "Test");
    }

    #[tokio::test]
    async fn test_mark_read() {
        let pool = test_pool().await;
        let req = CreateNotificationRequest {
            title: "Read me".to_string(),
            body: None,
            source: None,
            event_type: None,
            metadata: None,
            project: None,
            tmux_session: None,
            tmux_window: None,
            tmux_pane: None,
        };

        let n = insert_notification(&pool, &req).await.unwrap();
        assert!(mark_read(&pool, &n.id).await.unwrap());

        let params = QueryParams {
            source: None,
            project: None,
            is_read: Some(1),
            search: None,
            limit: None,
            offset: None,
        };
        let (results, _) = query_notifications(&pool, &params).await.unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].read_at.is_some());
    }

    #[tokio::test]
    async fn test_mark_all_read() {
        let pool = test_pool().await;
        for i in 0..3 {
            let req = CreateNotificationRequest {
                title: format!("N{i}"),
                body: None,
                source: None,
                event_type: None,
                metadata: None,
                project: None,
                tmux_session: None,
                tmux_window: None,
                tmux_pane: None,
            };
            insert_notification(&pool, &req).await.unwrap();
        }

        let count = mark_all_read(&pool).await.unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn test_search() {
        let pool = test_pool().await;
        let req = CreateNotificationRequest {
            title: "Build failed".to_string(),
            body: Some("Error in module X".to_string()),
            source: None,
            event_type: None,
            metadata: None,
            project: None,
            tmux_session: None,
            tmux_window: None,
            tmux_pane: None,
        };
        insert_notification(&pool, &req).await.unwrap();

        let params = QueryParams {
            source: None,
            project: None,
            is_read: None,
            search: Some("module".to_string()),
            limit: None,
            offset: None,
        };
        let (results, total) = query_notifications(&pool, &params).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(results[0].title, "Build failed");
    }
}
