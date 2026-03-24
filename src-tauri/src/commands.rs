use std::sync::Arc;

use tauri::State;

use crate::db;
use crate::models;
use crate::models::{NotificationResponse, QueryParams};
use crate::state::AppState;

#[tauri::command]
pub async fn get_notifications(
    state: State<'_, Arc<AppState>>,
    source: Option<String>,
    project: Option<String>,
    is_read: Option<i32>,
    search: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<NotificationResponse, String> {
    let params = QueryParams {
        source,
        project,
        is_read,
        search,
        limit,
        offset,
    };

    let (notifications, total) = db::query_notifications(&state.db, &params)
        .await
        .map_err(|e| e.to_string())?;

    Ok(NotificationResponse {
        notifications,
        total,
    })
}

#[tauri::command]
pub async fn mark_notification_read(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    db::mark_read(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_all_notifications_read(
    state: State<'_, Arc<AppState>>,
) -> Result<u64, String> {
    db::mark_all_read(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_notification(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    db::delete_notification(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_all_notifications(
    state: State<'_, Arc<AppState>>,
) -> Result<u64, String> {
    db::clear_all_notifications(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_unread_count(
    state: State<'_, Arc<AppState>>,
) -> Result<i64, String> {
    let params = QueryParams {
        source: None,
        project: None,
        is_read: Some(0),
        search: None,
        limit: Some(0),
        offset: None,
    };

    let (_, total) = db::query_notifications(&state.db, &params)
        .await
        .map_err(|e| e.to_string())?;

    Ok(total)
}

#[tauri::command]
pub async fn focus_terminal(
    session: String,
    window: Option<String>,
    pane: Option<String>,
) -> Result<(), String> {
    // Bring Kitty to foreground
    std::process::Command::new("open")
        .args(&["-a", "kitty"])
        .output()
        .map_err(|e| e.to_string())?;

    // Build tmux target: session:window.pane
    let mut target = session.clone();
    if let Some(w) = &window {
        target.push_str(&format!(":{}", w));
        if let Some(p) = &pane {
            target.push_str(&format!(".{}", p));
        }
    }

    // Switch tmux client
    let output = std::process::Command::new("tmux")
        .args(&["switch-client", "-t", &target])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn record_telemetry_event(
    state: State<'_, Arc<AppState>>,
    event_type: String,
    target_id: Option<String>,
    source: Option<String>,
    project: Option<String>,
    metadata: Option<String>,
) -> Result<(), String> {
    db::record_telemetry(
        &state.db,
        &event_type,
        target_id.as_deref(),
        source.as_deref(),
        project.as_deref(),
        metadata.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_telemetry(
    state: State<'_, Arc<AppState>>,
    event_type: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<models::TelemetryEvent>, String> {
    db::query_telemetry(
        &state.db,
        event_type.as_deref(),
        from.as_deref(),
        to.as_deref(),
        limit,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_telemetry_summary(
    state: State<'_, Arc<AppState>>,
    from: String,
    to: String,
) -> Result<models::TelemetrySummary, String> {
    db::get_telemetry_summary(&state.db, &from, &to)
        .await
        .map_err(|e| e.to_string())
}
