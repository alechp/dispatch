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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    pub id: i64,
    pub event_type: String,
    pub target_id: Option<String>,
    pub source: Option<String>,
    pub project: Option<String>,
    pub metadata: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetrySummary {
    pub total_received: i64,
    pub total_read: i64,
    pub total_deleted: i64,
    pub total_terminal_focuses: i64,
    pub total_app_opens: i64,
    pub avg_time_to_read_seconds: Option<f64>,
    pub busiest_hour: Option<i32>,
    pub top_sources: Vec<(String, i64)>,
    pub events_by_day: Vec<(String, i64)>,
    pub reads_by_method: Vec<(String, i64)>,
}
