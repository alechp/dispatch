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
