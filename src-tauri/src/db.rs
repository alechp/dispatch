use sqlx::SqlitePool;
use uuid::Uuid;

use crate::models::{CreateNotificationRequest, Notification, QueryParams};

pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
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
