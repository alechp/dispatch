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

    sqlx::query(
        "INSERT INTO project_sessions (project, source, last_event_type, last_title, last_body, last_metadata, last_tmux_session, last_tmux_window, last_tmux_pane, notification_count, unread_count, error_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
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
           last_seen_at = excluded.last_seen_at"
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
    let rows: Vec<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64, i64, String, String)> = if let Some(s) = search {
        let pattern = format!("%{}%", s);
        sqlx::query_as(
            "SELECT project, source, last_event_type, last_title, last_body, last_metadata, last_tmux_session, last_tmux_window, last_tmux_pane, notification_count, unread_count, error_count, first_seen_at, last_seen_at FROM project_sessions WHERE project LIKE ? ORDER BY last_seen_at DESC"
        )
        .bind(pattern)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT project, source, last_event_type, last_title, last_body, last_metadata, last_tmux_session, last_tmux_window, last_tmux_pane, notification_count, unread_count, error_count, first_seen_at, last_seen_at FROM project_sessions ORDER BY last_seen_at DESC"
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
    }).collect())
}

pub async fn get_notification_by_id(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<crate::models::Notification>, sqlx::Error> {
    let row: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, i32, String, Option<String>)> = sqlx::query_as(
        "SELECT id, source, event_type, title, body, metadata, project, tmux_session, tmux_window, tmux_pane, is_read, created_at, read_at FROM notifications WHERE id = ?"
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
    }))
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

pub async fn get_snippet(pool: &SqlitePool, id: &str) -> Result<Option<crate::models::Snippet>, sqlx::Error> {
    let row: Option<(String, String, Option<String>, String, Option<String>, Option<String>, i32, i64, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, trigger, label, body, tags, variables, is_enabled, use_count, last_used_at, created_at, updated_at FROM snippets WHERE id = ?"
    ).bind(id).fetch_optional(pool).await?;

    Ok(row.map(|r| crate::models::Snippet {
        id: r.0, trigger: r.1, label: r.2, body: r.3, tags: r.4, variables: r.5,
        is_enabled: r.6, use_count: r.7, last_used_at: r.8, created_at: r.9, updated_at: r.10,
    }))
}

pub async fn list_snippets(
    pool: &SqlitePool,
    search: Option<&str>,
    tag: Option<&str>,
) -> Result<Vec<crate::models::Snippet>, sqlx::Error> {
    let mut sql = String::from("SELECT id, trigger, label, body, tags, variables, is_enabled, use_count, last_used_at, created_at, updated_at FROM snippets WHERE is_enabled = 1");
    let mut args: Vec<String> = Vec::new();

    if let Some(s) = search {
        sql.push_str(" AND (trigger LIKE ? OR label LIKE ? OR body LIKE ? OR tags LIKE ?)");
        let pattern = format!("%{}%", s);
        args.push(pattern.clone());
        args.push(pattern.clone());
        args.push(pattern.clone());
        args.push(pattern);
    }
    if let Some(t) = tag {
        sql.push_str(" AND tags LIKE ?");
        args.push(format!("%\"{}\"%" , t));
    }
    sql.push_str(" ORDER BY use_count DESC, updated_at DESC");

    let mut query = sqlx::query_as::<_, (String, String, Option<String>, String, Option<String>, Option<String>, i32, i64, Option<String>, String, String)>(&sql);
    for arg in &args {
        query = query.bind(arg);
    }
    let rows = query.fetch_all(pool).await?;

    Ok(rows.into_iter().map(|r| crate::models::Snippet {
        id: r.0, trigger: r.1, label: r.2, body: r.3, tags: r.4, variables: r.5,
        is_enabled: r.6, use_count: r.7, last_used_at: r.8, created_at: r.9, updated_at: r.10,
    }).collect())
}

pub async fn list_all_snippets(pool: &SqlitePool) -> Result<Vec<crate::models::Snippet>, sqlx::Error> {
    let rows: Vec<(String, String, Option<String>, String, Option<String>, Option<String>, i32, i64, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, trigger, label, body, tags, variables, is_enabled, use_count, last_used_at, created_at, updated_at FROM snippets ORDER BY updated_at DESC"
    ).fetch_all(pool).await?;

    Ok(rows.into_iter().map(|r| crate::models::Snippet {
        id: r.0, trigger: r.1, label: r.2, body: r.3, tags: r.4, variables: r.5,
        is_enabled: r.6, use_count: r.7, last_used_at: r.8, created_at: r.9, updated_at: r.10,
    }).collect())
}

pub async fn increment_snippet_use(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE snippets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
        .bind(&now).bind(id).execute(pool).await?;
    Ok(())
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
