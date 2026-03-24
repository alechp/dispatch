use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Notification {
    pub id: String,
    pub source: String,
    pub event_type: String,
    pub title: String,
    pub body: Option<String>,
    pub metadata: Option<String>,
    pub project: Option<String>,
    pub tmux_session: Option<String>,
    pub tmux_window: Option<String>,
    pub tmux_pane: Option<String>,
    pub is_read: i32,
    pub created_at: String,
    pub read_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateNotificationRequest {
    pub title: String,
    pub body: Option<String>,
    pub source: Option<String>,
    pub event_type: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub project: Option<String>,
    pub tmux_session: Option<String>,
    pub tmux_window: Option<String>,
    pub tmux_pane: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct QueryParams {
    pub source: Option<String>,
    pub project: Option<String>,
    pub is_read: Option<i32>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct NotificationResponse {
    pub notifications: Vec<Notification>,
    pub total: i64,
}
