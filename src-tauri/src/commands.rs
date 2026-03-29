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
use crate::yapture;

const BOILERPLATE_TEMPLATE: &str = include_str!("../templates/dispatch-snippets.yml");
const DEFAULTS_TEMPLATE: &str = include_str!("../templates/dispatch-defaults.toml");

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
    // Check sync setting + get yapture_task_id before deleting
    let sync_enabled = db::get_setting(&state.db, "yapture_bidirectional_sync")
        .await.ok().flatten().unwrap_or_else(|| "true".into()) == "true";

    if sync_enabled {
        if let Ok(Some(n)) = db::get_notification_by_id(&state.db, &id).await {
            if let Some(yapture_id) = n.yapture_task_id {
                if !yapture_id.is_empty() {
                    let db = state.db.clone();
                    let token = state.yapture_tokens.lock().ok().and_then(|t| t.service_token.clone());
                    tokio::spawn(async move {
                        if let Some(config) = yapture::load_config(&db, token).await {
                            if let Err(e) = yapture::complete_yapture_task(&config, &yapture_id).await {
                                crate::log::log(&format!("[yapture-sync] delete: failed to complete {}: {}", yapture_id, e));
                            }
                        }
                    });
                }
            }
        }
    }

    db::delete_notification(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_all_notifications(
    state: State<'_, Arc<AppState>>,
) -> Result<u64, String> {
    // Sync all yapture tasks before clearing
    let sync_enabled = db::get_setting(&state.db, "yapture_bidirectional_sync")
        .await.ok().flatten().unwrap_or_else(|| "true".into()) == "true";

    if sync_enabled {
        if let Ok(yapture_ids) = db::get_all_notification_yapture_ids(&state.db).await {
            if !yapture_ids.is_empty() {
                let db = state.db.clone();
                let token = state.yapture_tokens.lock().ok().and_then(|t| t.service_token.clone());
                tokio::spawn(async move {
                    if let Some(config) = yapture::load_config(&db, token).await {
                        for yapture_id in yapture_ids {
                            let config = config.clone();
                            let yid = yapture_id.clone();
                            tokio::spawn(async move {
                                if let Err(e) = yapture::complete_yapture_task(&config, &yid).await {
                                    crate::log::log(&format!("[yapture-sync] clear_all: failed {}: {}", yid, e));
                                }
                            });
                        }
                    }
                });
            }
        }
    }

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

/// Shared logic: focus a tmux terminal session. Used by both the Tauri command and deep link handler.
pub async fn do_focus_terminal(
    db: &sqlx::SqlitePool,
    session: &str,
    window: Option<&str>,
    pane: Option<&str>,
) -> Result<(), String> {
    // Detect terminal app: DB setting > $TERM_PROGRAM > fallback to kitty
    let terminal = crate::db::get_setting(db, "terminal_app")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            std::env::var("TERM_PROGRAM").unwrap_or_else(|_| "kitty".into())
        });

    // Bring terminal to foreground
    std::process::Command::new("open")
        .args(&["-a", &terminal])
        .output()
        .map_err(|e| format!("Failed to open {}: {}", terminal, e))?;

    // Wait for terminal to activate
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Switch tmux session
    std::process::Command::new("tmux")
        .args(&["switch-client", "-t", session])
        .output()
        .map_err(|e| format!("tmux switch-client failed: {}", e))?;

    // Select specific window if provided
    if let Some(w) = window {
        let win_target = format!("{}:{}", session, w);
        let _ = std::process::Command::new("tmux")
            .args(&["select-window", "-t", &win_target])
            .output();

        // Select specific pane if provided
        if let Some(p) = pane {
            let pane_target = format!("{}:{}.{}", session, w, p);
            let _ = std::process::Command::new("tmux")
                .args(&["select-pane", "-t", &pane_target])
                .output();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn focus_terminal(
    state: State<'_, Arc<AppState>>,
    session: String,
    window: Option<String>,
    pane: Option<String>,
    notification_id: Option<String>,
) -> Result<(), String> {
    do_focus_terminal(&state.db, &session, window.as_deref(), pane.as_deref()).await?;

    // Sync to Yapture: complete the task when terminal is focused
    if let Some(nid) = notification_id {
        let sync_enabled = db::get_setting(&state.db, "yapture_bidirectional_sync")
            .await.ok().flatten().unwrap_or_else(|| "true".into()) == "true";
        if sync_enabled {
            if let Ok(Some(n)) = db::get_notification_by_id(&state.db, &nid).await {
                if let Some(yapture_id) = n.yapture_task_id {
                    if !yapture_id.is_empty() {
                        let db = state.db.clone();
                        let token = state.yapture_tokens.lock().ok().and_then(|t| t.service_token.clone());
                        tokio::spawn(async move {
                            if let Some(config) = yapture::load_config(&db, token).await {
                                if let Err(e) = yapture::complete_yapture_task(&config, &yapture_id).await {
                                    crate::log::log(&format!("[yapture-sync] focus_terminal: failed {}: {}", yapture_id, e));
                                }
                            }
                        });
                    }
                }
            }
        }
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
    source_id: Option<String>,
) -> Result<Vec<models::Snippet>, String> {
    let search_ref = search.as_deref();
    let tag_ref = tag.as_deref();
    let source_id_ref = source_id.as_deref();
    db::list_snippets(&state.db, search_ref, tag_ref, source_id_ref)
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

/// Check Accessibility permission (needed for NSEvent keyboard listener + text injection).
#[tauri::command]
pub async fn check_accessibility_permission() -> Result<bool, String> {
    Ok(macos_accessibility::check_accessibility())
}

/// Request Accessibility permission (shows macOS system prompt if not granted).
#[tauri::command]
pub async fn request_accessibility_permission() -> Result<bool, String> {
    Ok(macos_accessibility::request_accessibility())
}

/// Alias for check_accessibility_permission (kept for backward compatibility).
#[tauri::command]
pub async fn check_accessibility_trusted() -> Result<bool, String> {
    Ok(macos_accessibility::check_accessibility())
}

// --- Hotkey Config commands ---

#[tauri::command]
pub async fn get_hotkey_config(
    state: State<'_, Arc<AppState>>,
) -> Result<models::HotkeyConfig, String> {
    db::get_hotkey_config(&state.db).await
}

#[tauri::command]
pub async fn set_hotkey_config(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    config: models::HotkeyConfig,
) -> Result<(), String> {
    // Save to DB
    db::set_hotkey_config(&state.db, &config).await?;

    // Re-register global shortcuts
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Unregister all existing global shortcuts
    let _ = app.global_shortcut().unregister_all();

    // Build new shortcut map and register enabled global shortcuts
    let mut new_map = HashMap::new();
    for binding in &config.bindings {
        if binding.scope == "global" && binding.enabled {
            for key_str in &binding.keys {
                if let Ok(shortcut) = key_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                    if let Err(e) = app.global_shortcut().register(shortcut) {
                        eprintln!("[hotkeys] failed to register {}: {}", key_str, e);
                    } else {
                        new_map.insert(key_str.clone(), binding.action.clone());
                    }
                }
            }
        }
    }

    // Update the shared map so the existing handler picks up the new bindings
    let mut map = state.global_shortcut_map.write();
    *map = new_map;

    Ok(())
}

// --- Yapture Integration commands ---

#[tauri::command]
pub async fn get_yapture_config(
    state: State<'_, Arc<AppState>>,
) -> Result<yapture::YaptureConfigResponse, String> {
    let enabled = db::get_setting(&state.db, "yapture_enabled")
        .await
        .map_err(|e| e.to_string())?
        .map(|v| v == "1")
        .unwrap_or(false);
    let api_url = db::get_setting(&state.db, "yapture_api_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "https://api.yapture.app".to_string());
    let user_id = db::get_setting(&state.db, "yapture_user_id")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let has_token = state.yapture_tokens.lock()
        .map(|t| t.access_token.as_ref().map(|s| !s.is_empty()).unwrap_or(false))
        .unwrap_or(false);

    Ok(yapture::YaptureConfigResponse {
        enabled,
        api_url,
        user_id,
        has_token,
    })
}

#[tauri::command]
pub async fn set_yapture_config(
    state: State<'_, Arc<AppState>>,
    enabled: Option<bool>,
    api_url: Option<String>,
    user_id: Option<String>,
    service_token: Option<String>,
) -> Result<(), String> {
    if let Some(e) = enabled {
        db::set_setting(&state.db, "yapture_enabled", if e { "1" } else { "0" })
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(url) = api_url {
        db::set_setting(&state.db, "yapture_api_url", &url)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(uid) = user_id {
        db::set_setting(&state.db, "yapture_user_id", &uid)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(token) = service_token {
        let mut tokens = state.yapture_tokens.lock().map_err(|e| e.to_string())?;
        tokens.service_token = Some(token);
    }
    Ok(())
}

#[tauri::command]
pub async fn test_yapture_connection(
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let api_url = db::get_setting(&state.db, "yapture_api_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "https://api.yapture.app".to_string());
    let access_token = state.yapture_tokens.lock()
        .map(|t| t.access_token.clone().unwrap_or_default())
        .unwrap_or_default();
    Ok(yapture::test_connection(&api_url, &access_token).await)
}

// --- OAuth commands ---

#[tauri::command]
pub async fn yapture_start_oauth(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let api_url = db::get_setting(&state.db, "yapture_api_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "https://api.yapture.app".to_string());

    let (auth_url, oauth_state) = yapture::start_oauth_flow(&api_url);

    // Store pending OAuth state
    let mut pending = state.oauth_pending.lock().map_err(|e| e.to_string())?;
    *pending = Some(crate::state::PendingOAuth {
        version: "v1".to_string(),
        state: oauth_state,
    });

    Ok(auth_url)
}

/// Refresh the Yapture access token using the stored refresh token.
/// Returns true if refresh succeeded, false if no refresh token or refresh failed.
#[tauri::command]
pub async fn yapture_refresh(
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let api_url = db::get_setting(&state.db, "yapture_api_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "https://api.yapture.app".to_string());

    let refresh_token = state.yapture_tokens.lock()
        .map(|t| t.refresh_token.clone())
        .unwrap_or(None);

    let refresh_token = match refresh_token {
        Some(rt) if !rt.is_empty() => rt,
        _ => {
            eprintln!("[yapture] no refresh token available");
            return Ok(false);
        }
    };

    match yapture::refresh_access_token(&api_url, &refresh_token).await {
        Ok(tokens) => {
            eprintln!("[yapture] token refreshed successfully");
            // Update in-memory
            if let Ok(mut t) = state.yapture_tokens.lock() {
                t.access_token = Some(tokens.access_token.clone());
                t.service_token = Some(tokens.access_token.clone());
                if let Some(ref rt) = tokens.refresh_token {
                    t.refresh_token = Some(rt.clone());
                }
            }
            // Persist to DB
            let _ = db::set_setting(&state.db, "yapture_access_token", &tokens.access_token).await;
            if let Some(ref rt) = tokens.refresh_token {
                let _ = db::set_setting(&state.db, "yapture_refresh_token", rt).await;
            }
            Ok(true)
        }
        Err(e) => {
            eprintln!("[yapture] token refresh failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn yapture_detect_version(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let api_url = crate::db::get_setting(&state.db, "yapture_api_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "https://api.yapture.app".to_string());

    let version = crate::yapture::detect_version(&api_url).await;
    let version_str = version.to_string();

    // Persist detected version
    let _ = crate::db::set_setting(&state.db, "yapture_version", &version_str).await;

    Ok(version_str)
}

#[tauri::command]
pub async fn yapture_disconnect(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    db::set_setting(&state.db, "yapture_enabled", "0")
        .await
        .map_err(|e| e.to_string())?;
    db::set_setting(&state.db, "yapture_user_id", "")
        .await
        .map_err(|e| e.to_string())?;
    db::set_setting(&state.db, "yapture_user_name", "")
        .await
        .map_err(|e| e.to_string())?;
    db::set_setting(&state.db, "yapture_user_email", "")
        .await
        .map_err(|e| e.to_string())?;
    // Clear persisted tokens from DB
    db::set_setting(&state.db, "yapture_access_token", "")
        .await
        .map_err(|e| e.to_string())?;
    db::set_setting(&state.db, "yapture_refresh_token", "")
        .await
        .map_err(|e| e.to_string())?;
    // Clear in-memory tokens
    if let Ok(mut tokens) = state.yapture_tokens.lock() {
        *tokens = crate::state::YaptureTokens::default();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_yapture_connection_status(
    state: State<'_, Arc<AppState>>,
) -> Result<yapture::YaptureConnectionStatus, String> {
    let enabled = db::get_setting(&state.db, "yapture_enabled")
        .await
        .map_err(|e| e.to_string())?
        .map(|v| v == "1")
        .unwrap_or(false);
    let user_name = db::get_setting(&state.db, "yapture_user_name")
        .await
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());
    let user_email = db::get_setting(&state.db, "yapture_user_email")
        .await
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());

    let connected = enabled && user_name.is_some();

    Ok(yapture::YaptureConnectionStatus {
        connected,
        user_name,
        user_email,
    })
}

// --- Yapture V2 commands ---

#[tauri::command]
pub async fn yapture_v2_start_oauth(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let auth_url = db::get_setting(&state.db, "yapture_v2_auth_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "http://localhost:4800".to_string());

    let (url, oauth_state) = yapture::start_oauth_flow_v2(&auth_url);

    let mut pending = state.oauth_pending.lock().map_err(|e| e.to_string())?;
    *pending = Some(crate::state::PendingOAuth {
        version: "v2".to_string(),
        state: oauth_state,
    });

    Ok(url)
}

#[tauri::command]
pub async fn yapture_v2_disconnect(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let keys = [
        "yapture_v2_enabled", "yapture_v2_user_id", "yapture_v2_user_name",
        "yapture_v2_user_email", "yapture_v2_access_token", "yapture_v2_refresh_token",
    ];
    for key in &keys {
        db::set_setting(&state.db, key, "").await.map_err(|e| e.to_string())?;
    }
    if let Ok(mut tokens) = state.yapture_v2_tokens.lock() {
        *tokens = crate::state::YaptureTokens::default();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_yapture_v2_status(
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    let enabled = db::get_setting(&state.db, "yapture_v2_enabled").await
        .map_err(|e| e.to_string())?.unwrap_or_default() == "1";
    let user_name = db::get_setting(&state.db, "yapture_v2_user_name").await
        .map_err(|e| e.to_string())?.unwrap_or_default();
    let user_email = db::get_setting(&state.db, "yapture_v2_user_email").await
        .map_err(|e| e.to_string())?.unwrap_or_default();
    let api_url = db::get_setting(&state.db, "yapture_v2_api_url").await
        .map_err(|e| e.to_string())?.unwrap_or_default();
    let auth_url = db::get_setting(&state.db, "yapture_v2_auth_url").await
        .map_err(|e| e.to_string())?.unwrap_or_default();
    let has_token = state.yapture_v2_tokens.lock()
        .map(|t| t.access_token.is_some()).unwrap_or(false);

    Ok(serde_json::json!({
        "connected": has_token && !user_name.is_empty(),
        "enabled": enabled,
        "userName": if user_name.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(user_name) },
        "userEmail": if user_email.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(user_email) },
        "apiUrl": api_url,
        "authUrl": auth_url,
    }))
}

#[tauri::command]
pub async fn set_yapture_v2_config(
    state: State<'_, Arc<AppState>>,
    api_url: Option<String>,
    auth_url: Option<String>,
    enabled: Option<bool>,
) -> Result<(), String> {
    if let Some(url) = api_url {
        db::set_setting(&state.db, "yapture_v2_api_url", &url).await.map_err(|e| e.to_string())?;
    }
    if let Some(url) = auth_url {
        db::set_setting(&state.db, "yapture_v2_auth_url", &url).await.map_err(|e| e.to_string())?;
    }
    if let Some(en) = enabled {
        db::set_setting(&state.db, "yapture_v2_enabled", if en { "1" } else { "0" }).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn test_yapture_v2_connection(
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let auth_url = db::get_setting(&state.db, "yapture_v2_auth_url")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "http://localhost:4800".to_string());
    let client = reqwest::Client::new();
    match client.get(&format!("{}/health", auth_url)).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// Diagnostic: returns detailed permission + listener state for the text expander.
/// Now only checks Accessibility (NSEvent-based listener doesn't need Input Monitoring).
#[tauri::command]
pub async fn get_expansion_diagnostics(
    state: State<'_, Arc<AppState>>,
) -> Result<ExpansionDiagnostics, String> {
    let has_accessibility = tokio::task::spawn_blocking(|| {
        macos_accessibility::check_permissions_robust()
    })
    .await
    .unwrap_or(false);

    #[cfg(target_os = "macos")]
    let listener_active = crate::macos_listener::is_monitoring();
    #[cfg(not(target_os = "macos"))]
    let listener_active = true;

    #[cfg(target_os = "macos")]
    let event_count = crate::macos_listener::event_count();
    #[cfg(not(target_os = "macos"))]
    let event_count = 0u64;

    let enabled = state.live_expansion_enabled.load(Ordering::Relaxed);
    let trigger_count = state.trigger_cache.read().len();

    Ok(ExpansionDiagnostics {
        accessibility: has_accessibility,
        listener_active,
        event_count,
        enabled,
        trigger_count,
    })
}

#[derive(serde::Serialize)]
pub struct ExpansionDiagnostics {
    pub accessibility: bool,
    pub listener_active: bool,
    pub event_count: u64,
    pub enabled: bool,
    pub trigger_count: usize,
}

/// Open macOS System Settings Accessibility pane.
#[tauri::command]
pub async fn open_privacy_settings(pane: String) -> Result<(), String> {
    let url = match pane.as_str() {
        "Accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        // Keep ListenEvent for backward compatibility, but redirect to Accessibility
        "ListenEvent" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        _ => return Err(format!("Unknown pane: {}", pane)),
    };

    std::process::Command::new("open")
        .arg(url)
        .output()
        .map_err(|e| format!("Failed to open settings: {}", e))?;

    Ok(())
}

/// Copy text to the system clipboard using arboard (reliable in Tauri WebView).
#[tauri::command]
pub async fn copy_to_clipboard(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
        clipboard.set_text(&text).map_err(|e| format!("Clipboard set failed: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
}

// --- Notification Banner Config commands ---

#[tauri::command]
pub async fn get_notification_banner_config(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let val = db::get_setting(&state.db, "notification_banner_config")
        .await
        .map_err(|e| e.to_string())?;
    match val {
        Some(json) => Ok(json),
        None => Ok(r#"{"globalEnabled":true,"screens":{"feed/notifications":true,"feed/sessions":true,"telemetry":true,"expander":true,"settings":true}}"#.to_string()),
    }
}

#[tauri::command]
pub async fn set_notification_banner_config(
    state: State<'_, Arc<AppState>>,
    config_json: String,
) -> Result<(), String> {
    // Validate that it's valid JSON
    let _: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    db::set_setting(&state.db, "notification_banner_config", &config_json)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_yapture_sync_enabled(
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let val = db::get_setting(&state.db, "yapture_bidirectional_sync")
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "true".to_string());
    Ok(val == "true")
}

#[tauri::command]
pub async fn set_yapture_sync_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    db::set_setting(&state.db, "yapture_bidirectional_sync", if enabled { "true" } else { "false" })
        .await
        .map_err(|e| e.to_string())
}

// --- Expander V2 commands: recents, favorites, prefix, sources ---

#[tauri::command]
pub async fn list_recent_snippets(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<models::Snippet>, String> {
    db::list_recent_snippets(&state.db, limit.unwrap_or(5))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_favorite_snippets(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<models::Snippet>, String> {
    db::list_favorite_snippets(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_snippet_favorite(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    db::toggle_snippet_favorite(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_expand_prefix(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    db::get_expand_prefix(&state.db).await
}

#[tauri::command]
pub async fn set_expand_prefix(
    state: State<'_, Arc<AppState>>,
    prefix: String,
) -> Result<(), String> {
    if prefix.is_empty() || prefix.len() > 3 || prefix.contains(' ') {
        return Err("Prefix must be 1-3 non-whitespace characters".to_string());
    }
    db::set_expand_prefix(&state.db, &prefix).await
}

// --- Snippet Source commands ---

#[tauri::command]
pub async fn add_snippet_source(
    state: State<'_, Arc<AppState>>,
    name: String,
    path: String,
    is_folder: bool,
) -> Result<models::SnippetSource, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    let source = db::create_snippet_source(&state.db, &name, &path, is_folder)
        .await
        .map_err(|e| e.to_string())?;

    // Run initial sync
    let _ = sync_source_internal(&state.db, &source).await;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;

    Ok(source)
}

#[tauri::command]
pub async fn list_snippet_sources(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<models::SnippetSource>, String> {
    db::list_snippet_sources(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_snippet_source(
    state: State<'_, Arc<AppState>>,
    id: String,
    name: Option<String>,
    is_enabled: Option<bool>,
    auto_reload: Option<bool>,
) -> Result<(), String> {
    db::update_snippet_source(&state.db, &id, name.as_deref(), is_enabled, auto_reload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_snippet_source(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    db::delete_snippet_source(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_snippet_source(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<models::SyncResult, String> {
    let source = db::get_snippet_source(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Source not found".to_string())?;
    let result = sync_source_internal(&state.db, &source).await?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(result)
}

#[tauri::command]
pub async fn sync_all_sources(
    state: State<'_, Arc<AppState>>,
) -> Result<models::SyncResult, String> {
    let sources = db::list_snippet_sources(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let mut total = models::SyncResult { added: 0, updated: 0, removed: 0, errors: vec![] };
    for source in &sources {
        if source.is_enabled == 0 { continue; }
        match sync_source_internal(&state.db, source).await {
            Ok(r) => {
                total.added += r.added;
                total.updated += r.updated;
                total.removed += r.removed;
                total.errors.extend(r.errors);
            }
            Err(e) => total.errors.push(e),
        }
    }
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(total)
}

/// Internal sync: parse file(s) and upsert/remove snippets.
async fn sync_source_internal(
    pool: &sqlx::SqlitePool,
    source: &models::SnippetSource,
) -> Result<models::SyncResult, String> {
    use crate::file_parser;

    let mut result = models::SyncResult { added: 0, updated: 0, removed: 0, errors: vec![] };
    let path = std::path::Path::new(&source.path);

    let configs = if source.is_folder == 1 {
        file_parser::parse_expansion_folder(path)?
    } else {
        let config = file_parser::parse_expansion_file(path)?;
        vec![(source.name.clone(), config)]
    };

    let mut active_triggers = Vec::new();

    for (_filename, config) in &configs {
        for snippet in &config.snippets {
            active_triggers.push(snippet.trigger.clone());
            let tags = file_parser::tags_to_json(&snippet.tags);
            let vars = file_parser::variables_to_json(&snippet.variables);

            // Check if it already exists to count adds vs updates
            let existing: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM snippets WHERE source_id = ? AND trigger = ?"
            )
            .bind(&source.id).bind(&snippet.trigger)
            .fetch_optional(pool).await.map_err(|e| e.to_string())?;

            if existing.is_some() {
                result.updated += 1;
            } else {
                result.added += 1;
            }

            db::upsert_source_snippet(
                pool, &source.id, &snippet.trigger, snippet.label.as_deref(),
                &snippet.body, tags.as_deref(), vars.as_deref(),
            ).await.map_err(|e| {
                result.errors.push(format!("Failed to upsert {}: {}", snippet.trigger, e));
                e.to_string()
            }).ok();
        }
    }

    // Remove snippets that no longer exist in the source files
    let removed = db::remove_stale_source_snippets(pool, &source.id, &active_triggers)
        .await
        .map_err(|e| e.to_string())?;
    result.removed = removed;

    // Update last_synced_at
    let _ = db::update_snippet_source_synced(pool, &source.id).await;

    Ok(result)
}

// --- Boilerplate generator ---

#[tauri::command]
pub async fn create_boilerplate_config(
    state: State<'_, Arc<AppState>>,
    folder_path: String,
    package_name: String,
) -> Result<models::SnippetSource, String> {
    let dir = std::path::Path::new(&folder_path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", folder_path));
    }

    let file_path = dir.join("dispatch-snippets.yml");
    if file_path.exists() {
        return Err("dispatch-snippets.yml already exists in this folder. Import it instead.".to_string());
    }

    let template = BOILERPLATE_TEMPLATE.replace("{PACKAGE_NAME}", &package_name);

    std::fs::write(&file_path, &template)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    let source = db::create_snippet_source(
        &state.db,
        &package_name,
        &file_path.to_string_lossy(),
        false,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Initial sync
    let _ = sync_source_internal(&state.db, &source).await;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;

    Ok(source)
}

/// Ensure the built-in "Defaults" snippet source exists.
/// Writes the template to app data dir if the file is missing, creates the DB source if needed, and syncs.
#[tauri::command]
pub async fn ensure_default_source(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<models::SnippetSource, String> {
    use tauri::Manager;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let defaults_path = app_data_dir.join("dispatch-defaults.toml");

    // Migrate: remove old .yml file and its DB source entry
    let old_yml_path = app_data_dir.join("dispatch-defaults.yml");
    if old_yml_path.exists() {
        let _ = std::fs::remove_file(&old_yml_path);
    }
    // Clean up any old .yml DB source entries
    let old_yml_str = old_yml_path.to_string_lossy().to_string();
    let sources = db::list_snippet_sources(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    for s in sources.iter().filter(|s| s.path == old_yml_str) {
        let _ = db::delete_snippet_source(&state.db, &s.id).await;
    }

    // Write fresh TOML template if missing or if existing content is invalid TOML
    // (handles the case where a .yml was renamed to .toml without content conversion)
    let needs_write = if defaults_path.exists() {
        let content = std::fs::read_to_string(&defaults_path).unwrap_or_default();
        toml::from_str::<crate::file_parser::ExpansionConfig>(&content).is_err()
    } else {
        true
    };
    if needs_write {
        std::fs::write(&defaults_path, DEFAULTS_TEMPLATE)
            .map_err(|e| format!("Failed to write defaults: {}", e))?;
    }

    let path_str = defaults_path.to_string_lossy().to_string();

    // Re-fetch sources after cleanup
    let sources = db::list_snippet_sources(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    let existing = sources.iter().find(|s| s.path == path_str);

    let source = if let Some(s) = existing {
        s.clone()
    } else {
        db::create_snippet_source(&state.db, "Defaults", &path_str, false)
            .await
            .map_err(|e| e.to_string())?
    };

    // Sync it
    let _ = sync_source_internal(&state.db, &source).await;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;

    Ok(source)
}

#[tauri::command]
pub async fn refresh_triggers(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_trigger_cache_count(
    state: State<'_, Arc<AppState>>,
) -> Result<usize, String> {
    Ok(state.trigger_cache.read().len())
}

#[tauri::command]
pub async fn read_source_file(
    state: State<'_, Arc<AppState>>,
    source_id: String,
) -> Result<String, String> {
    let source = db::get_snippet_source(&state.db, &source_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Source not found".to_string())?;
    std::fs::read_to_string(&source.path)
        .map_err(|e| format!("Failed to read {}: {}", source.path, e))
}

#[tauri::command]
pub async fn write_source_file(
    state: State<'_, Arc<AppState>>,
    source_id: String,
    content: String,
) -> Result<models::SyncResult, String> {
    let source = db::get_snippet_source(&state.db, &source_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Source not found".to_string())?;

    // Validate content before writing (auto-detect TOML vs YAML by file extension)
    let _config = crate::file_parser::validate_config_content(&content, &source.path)?;

    std::fs::write(&source.path, &content)
        .map_err(|e| format!("Failed to write {}: {}", source.path, e))?;

    // Re-sync after writing
    let result = sync_source_internal(&state.db, &source).await?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(result)
}

/// Test text injection by simulating a small paste. Returns a diagnostic message.
#[tauri::command]
pub async fn test_text_injection() -> Result<String, String> {
    let result = tokio::task::spawn_blocking(|| {
        // Test 1: Can we create an enigo instance?
        let enigo = match enigo::Enigo::new(&enigo::Settings::default()) {
            Ok(e) => e,
            Err(e) => return format!("FAIL: Cannot create enigo: {:?}. Ensure Accessibility is enabled in System Settings > Privacy & Security > Accessibility.", e),
        };
        drop(enigo);

        // Test 2: Can we access the clipboard?
        match arboard::Clipboard::new() {
            Ok(_) => {},
            Err(e) => return format!("FAIL: Clipboard access failed: {:?}", e),
        }

        // Test 3: Report event count if on macOS
        #[cfg(target_os = "macos")]
        {
            let count = crate::macos_listener::event_count();
            let monitoring = crate::macos_listener::is_monitoring();
            return format!("OK: Text injection working. Listener: {} (events: {})",
                if monitoring { "active" } else { "inactive" }, count);
        }

        #[cfg(not(target_os = "macos"))]
        "OK: Text injection is working.".to_string()
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?;

    Ok(result)
}
