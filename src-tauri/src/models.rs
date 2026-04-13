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
    pub yapture_task_id: Option<String>,
    // Provider integration fields
    pub account_id: Option<String>,
    pub provider: Option<String>,
    pub provider_message_id: Option<String>,
    pub provider_channel_name: Option<String>,
    pub provider_channel_id: Option<String>,
    pub provider_avatar_url: Option<String>,
    pub provider_author: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSession {
    pub project: String,
    pub source: String,
    pub last_event_type: String,
    pub last_title: String,
    pub last_body: Option<String>,
    pub last_metadata: Option<String>,
    pub last_tmux_session: Option<String>,
    pub last_tmux_window: Option<String>,
    pub last_tmux_pane: Option<String>,
    pub notification_count: i64,
    pub unread_count: i64,
    pub error_count: i64,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub directory: Option<String>,
    pub git_remote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub trigger: String,
    pub label: Option<String>,
    pub body: String,
    pub tags: Option<String>,
    pub variables: Option<String>,
    pub is_enabled: i32,
    pub use_count: i64,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub is_favorite: Option<i32>,
    /// Populated by JOIN, not a real column
    #[serde(default)]
    pub source_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetSource {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_folder: i32,
    pub is_enabled: i32,
    pub auto_reload: i32,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub source_kind: Option<String>,
    pub source_version: Option<String>,
    pub item_count: Option<i64>,
    pub managed_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmojiPackStatus {
    pub managed_key: String,
    pub name: String,
    pub path: String,
    pub version: String,
    pub expected_count: i64,
    pub installed_count: i64,
    pub installed: bool,
    pub enabled: bool,
    pub file_exists: bool,
    pub source: Option<SnippetSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariableDef {
    pub name: String,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(default)]
    pub params: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyBinding {
    pub action: String,
    pub keys: Vec<String>,
    pub enabled: bool,
    pub scope: String,
    pub category: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    pub bindings: Vec<HotkeyBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct NotificationAccount {
    pub id: String,
    pub provider: String,
    pub account_label: String,
    pub provider_user_id: Option<String>,
    pub provider_username: Option<String>,
    pub provider_avatar_url: Option<String>,
    pub provider_team_id: Option<String>,
    pub provider_team_name: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<String>,
    pub scopes: Option<String>,
    pub is_enabled: i32,
    pub sync_channels: Option<String>,
    pub last_sync_at: Option<String>,
    pub sync_cursor: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountScreenToggle {
    pub account_id: String,
    pub screen_key: String,
    pub is_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct RoutingRule {
    pub id: String,
    pub name: String,
    pub is_enabled: i32,
    pub source_type: String,
    pub source_value: Option<String>,
    pub destination_type: String,
    pub destination_config: String,
    pub template: Option<String>,
    pub filter_event_types: Option<String>,
    pub filter_keywords: Option<String>,
    pub priority: i32,
    pub stop_on_match: i32,
    pub chain_rule_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct RoutingLogEntry {
    pub id: i64,
    pub rule_id: String,
    pub notification_id: String,
    pub destination_type: String,
    pub status: String,
    pub error_message: Option<String>,
    pub executed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingDestinationConfig {
    pub url: Option<String>,
    pub method: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub account_id: Option<String>,
    pub channel_id: Option<String>,
    pub sound: Option<String>,
    pub subtitle: Option<String>,
    pub rule_id: Option<String>,
}
