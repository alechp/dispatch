use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::State;

use crate::db;
use crate::expander;
use crate::macos_accessibility;
use crate::models;
use crate::models::{NotificationResponse, QueryParams};
use crate::state::AppState;
use crate::trigger_cache;

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
    // Get notification first for session tracking
    if let Ok(Some(n)) = db::get_notification_by_id(&state.db, &id).await {
        if n.is_read == 0 {
            let project = n.project.as_deref().unwrap_or(&n.source);
            let _ = db::decrement_session_unread(&state.db, project, &n.source).await;
        }
    }

    db::mark_read(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_all_notifications_read(
    state: State<'_, Arc<AppState>>,
) -> Result<u64, String> {
    let _ = db::reset_all_session_unread(&state.db).await;
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

// --- Session Tracker commands ---

#[tauri::command]
pub async fn get_project_sessions(
    state: State<'_, Arc<AppState>>,
    search: Option<String>,
) -> Result<Vec<models::ProjectSession>, String> {
    db::get_project_sessions(&state.db, search.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_project_metadata(
    state: State<'_, Arc<AppState>>,
    project: String,
    source: String,
    directory: Option<String>,
    git_remote: Option<String>,
) -> Result<(), String> {
    db::update_project_metadata(
        &state.db,
        &project,
        &source,
        directory.as_deref(),
        git_remote.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

// --- Text Expander commands ---

#[tauri::command]
pub async fn list_snippets(
    state: State<'_, Arc<AppState>>,
    search: Option<String>,
    tag: Option<String>,
) -> Result<Vec<models::Snippet>, String> {
    db::list_snippets(&state.db, search.as_deref(), tag.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_snippet(
    state: State<'_, Arc<AppState>>,
    trigger: String,
    label: Option<String>,
    body: String,
    tags: Option<String>,
    variables: Option<String>,
) -> Result<models::Snippet, String> {
    let result = db::create_snippet(&state.db, &trigger, label.as_deref(), &body, tags.as_deref(), variables.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(result)
}

#[tauri::command]
pub async fn update_snippet(
    state: State<'_, Arc<AppState>>,
    id: String,
    trigger: Option<String>,
    label: Option<String>,
    body: Option<String>,
    tags: Option<String>,
    variables: Option<String>,
    is_enabled: Option<i32>,
) -> Result<models::Snippet, String> {
    let result = db::update_snippet(&state.db, &id, trigger.as_deref(), label.as_deref(), body.as_deref(), tags.as_deref(), variables.as_deref(), is_enabled)
        .await
        .map_err(|e| e.to_string())?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(result)
}

#[tauri::command]
pub async fn delete_snippet(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    let result = db::delete_snippet(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(result)
}

#[tauri::command]
pub async fn expand_snippet(
    state: State<'_, Arc<AppState>>,
    id: String,
    form_values: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let snippet = db::get_snippet(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Snippet not found".to_string())?;

    let expanded = expander::expand_snippet(&snippet, form_values.as_ref()).await?;

    // Increment use count (fire-and-forget)
    let pool = state.db.clone();
    let sid = id.clone();
    tokio::spawn(async move { let _ = db::increment_snippet_use(&pool, &sid).await; });

    // Record telemetry
    let tpool = state.db.clone();
    let tid = id.clone();
    tokio::spawn(async move {
        let _ = db::record_telemetry(&tpool, "snippet_expanded", Some(&tid), None, None, None).await;
    });

    Ok(expanded)
}

#[tauri::command]
pub async fn import_snippets(
    state: State<'_, Arc<AppState>>,
    snippets_json: String,
) -> Result<u64, String> {
    let items: Vec<serde_json::Value> = serde_json::from_str(&snippets_json)
        .map_err(|e| e.to_string())?;

    let mut count: u64 = 0;
    for item in &items {
        let trigger = item.get("trigger").and_then(|v| v.as_str()).unwrap_or("");
        let label = item.get("label").and_then(|v| v.as_str());
        let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("");
        let tags = item.get("tags").map(|v| v.to_string());
        let variables = item.get("variables").map(|v| v.to_string());

        if !trigger.is_empty() && !body.is_empty() {
            let _ = db::create_snippet(&state.db, trigger, label, body, tags.as_deref(), variables.as_deref()).await;
            count += 1;
        }
    }
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(count)
}

#[tauri::command]
pub async fn export_snippets(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<models::Snippet>, String> {
    db::list_all_snippets(&state.db)
        .await
        .map_err(|e| e.to_string())
}

// --- Live Expansion commands ---

#[tauri::command]
pub async fn get_live_expansion_enabled(
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    Ok(state.live_expansion_enabled.load(Ordering::Relaxed))
}

#[tauri::command]
pub async fn set_live_expansion_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    state
        .live_expansion_enabled
        .store(enabled, Ordering::Relaxed);

    // Persist to DB
    let value = if enabled { "1" } else { "0" };
    db::set_setting(&state.db, "live_expansion_enabled", value)
        .await
        .map_err(|e| e.to_string())?;

    // Refresh trigger cache when enabling
    if enabled {
        let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn check_accessibility_permission() -> Result<bool, String> {
    Ok(macos_accessibility::check_permission())
}

#[tauri::command]
pub async fn request_accessibility_permission() -> Result<bool, String> {
    Ok(macos_accessibility::request_permission())
}
