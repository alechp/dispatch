mod commands;
mod db;
mod expander;
mod file_parser;
mod live_listener;
mod log;
mod macos_accessibility;
#[cfg(target_os = "macos")]
mod macos_listener;
mod models;
mod server;
mod state;
mod text_injector;
mod trigger_cache;
mod tray;
mod yapture;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use sqlx::sqlite::SqlitePoolOptions;
use tauri::{Emitter, Listener, Manager};

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install panic hook so silent panics are logged to file
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {}", info);
        crate::log::log(&msg);
        eprintln!("[dispatch] {}", msg);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Resolve database path
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            // Initialize file logging ASAP
            crate::log::init(&app_data_dir);
            dlog!("setup: app_data_dir = {}", app_data_dir.display());

            let db_path = app_data_dir.join("dispatch.db");
            let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
            dlog!("setup: db_url = {}", db_url);

            // Block on async init during setup
            dlog!("setup: starting async init (db + state)");
            let state = tauri::async_runtime::block_on(async {
                let pool = SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect(&db_url)
                    .await
                    .expect("Failed to connect to SQLite");
                dlog!("setup: SQLite connected");

                db::init_db(&pool).await.expect("Failed to run migrations");
                dlog!("setup: migrations complete");

                let state = Arc::new(AppState::new(pool));

                // Load persisted live expansion setting
                if let Ok(Some(val)) = db::get_setting(&state.db, "live_expansion_enabled").await {
                    if val == "1" {
                        state.live_expansion_enabled.store(true, Ordering::Relaxed);
                    }
                }

                // Refresh trigger cache
                let _ =
                    trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;

                // Load persisted Yapture tokens from DB
                {
                    let access_token = db::get_setting(&state.db, "yapture_access_token").await.ok().flatten();
                    let refresh_token = db::get_setting(&state.db, "yapture_refresh_token").await.ok().flatten();
                    if access_token.is_some() || refresh_token.is_some() {
                        if let Ok(mut tokens) = state.yapture_tokens.lock() {
                            tokens.access_token = access_token.clone();
                            tokens.refresh_token = refresh_token;
                            tokens.service_token = access_token; // service_token = access_token for push_notification compat
                        }
                        dlog!("setup: yapture tokens loaded from DB");
                    }
                }

                dlog!("setup: state initialized, trigger cache loaded");

                state
            });

            // Manage state
            app.manage(state.clone());
            dlog!("setup: state managed");

            // Log permission state at startup for diagnostics
            {
                let has_accessibility = macos_accessibility::check_accessibility();
                eprintln!(
                    "[live-expansion] permissions at startup: accessibility={}",
                    has_accessibility
                );
                if !has_accessibility {
                    eprintln!("[live-expansion] WARNING: Accessibility not granted — keyboard listener and text injection will fail. Will retry automatically.");
                }
            }

            // Start live expansion listener + match handler
            //
            // macOS: Uses CGEventTap directly (macos_listener) to avoid rdev's TSM crash.
            // Other platforms: Uses rdev::listen (live_listener).
            {
                let (match_tx, match_rx) = crossbeam_channel::unbounded::<live_listener::TriggerMatch>();

                #[cfg(target_os = "macos")]
                macos_listener::start_listener(
                    state.live_expansion_enabled.clone(),
                    state.trigger_cache.clone(),
                    match_tx,
                );

                #[cfg(not(target_os = "macos"))]
                live_listener::start_listener(
                    state.live_expansion_enabled.clone(),
                    state.trigger_cache.clone(),
                    match_tx,
                );

                // Spawn tokio task to handle matches
                let handler_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    eprintln!("[live-expansion] match handler task started");
                    loop {
                        let trigger_match = match tokio::task::spawn_blocking({
                            let rx = match_rx.clone();
                            move || rx.recv()
                        })
                        .await
                        {
                            Ok(Ok(m)) => m,
                            Ok(Err(e)) => {
                                // Sender dropped — rdev thread died
                                eprintln!(
                                    "[live-expansion] channel closed (listener thread exited): {}",
                                    e
                                );
                                break;
                            }
                            Err(e) => {
                                // spawn_blocking was cancelled
                                eprintln!("[live-expansion] spawn_blocking error: {}", e);
                                break;
                            }
                        };

                        eprintln!(
                            "[live-expansion] trigger matched: snippet_id={}, trigger_len={}",
                            trigger_match.snippet_id, trigger_match.trigger_len
                        );

                        // Expand the snippet
                        let snippet = match db::get_snippet(
                            &handler_state.db,
                            &trigger_match.snippet_id,
                        )
                        .await
                        {
                            Ok(Some(s)) => s,
                            Ok(None) => {
                                eprintln!(
                                    "[live-expansion] snippet not found: {}",
                                    trigger_match.snippet_id
                                );
                                continue;
                            }
                            Err(e) => {
                                eprintln!("[live-expansion] db error fetching snippet: {}", e);
                                continue;
                            }
                        };

                        let expanded = match expander::expand_snippet(&snippet, None).await {
                            Ok(text) => text,
                            Err(e) => {
                                eprintln!(
                                    "[live-expansion] expansion error for {}: {}",
                                    snippet.trigger, e
                                );
                                continue;
                            }
                        };

                        // Inject on a blocking thread (enigo uses OS APIs)
                        let trigger_len = trigger_match.trigger_len;
                        let inject_result = tokio::task::spawn_blocking(move || {
                            text_injector::inject_text(trigger_len, &expanded);
                        })
                        .await;

                        if let Err(e) = inject_result {
                            eprintln!("[live-expansion] inject task panicked: {}", e);
                            continue;
                        }

                        // Increment use count (fire-and-forget)
                        let pool = handler_state.db.clone();
                        let sid = trigger_match.snippet_id.clone();
                        tokio::spawn(async move {
                            let _ = db::increment_snippet_use(&pool, &sid).await;
                        });

                        // Record telemetry (fire-and-forget)
                        let tpool = handler_state.db.clone();
                        let tid = trigger_match.snippet_id;
                        tokio::spawn(async move {
                            let _ = db::record_telemetry(
                                &tpool,
                                "snippet_live_expanded",
                                Some(&tid),
                                None,
                                None,
                                None,
                            )
                            .await;
                        });
                    }
                    eprintln!("[live-expansion] match handler task exiting");
                });
            }

            // Spawn the axum HTTP server
            dlog!("setup: spawning HTTP server");
            let server_state = state.clone();
            let event_state = state.clone();
            let event_handle = app_handle.clone();

            tauri::async_runtime::spawn(async move {
                let router = server::create_router(server_state);
                let listener = tokio::net::TcpListener::bind("127.0.0.1:9394")
                    .await
                    .expect("Failed to bind port 9394");
                dlog!("server: listening on http://127.0.0.1:9394");
                axum::serve(listener, router).await.unwrap();
            });

            // Spawn broadcast → Tauri event bridge
            tauri::async_runtime::spawn(async move {
                let mut rx = event_state.tx.subscribe();
                while let Ok(notification) = rx.recv().await {
                    if let Some(window) = event_handle.get_webview_window("main") {
                        let _ = window.emit("new-notification", &notification);
                    }
                }
            });

            // Setup system tray
            dlog!("setup: creating system tray");
            tray::setup_tray(app.handle())?;
            dlog!("setup: system tray created");

            // Deep link handler for OAuth callback
            {
                let deep_link_state = state.clone();
                let deep_link_handle = app.handle().clone();
                app.listen("deep-link://new-url", move |event| {
                    let urls: Vec<String> = match serde_json::from_str(event.payload()) {
                        Ok(u) => u,
                        Err(e) => {
                            eprintln!("[oauth] failed to parse deep link payload: {}", e);
                            return;
                        }
                    };

                    let url_str = match urls.first() {
                        Some(u) => u.clone(),
                        None => return,
                    };

                    // Handle dispatch://notifications?nid=X
                    if url_str.starts_with("dispatch://notifications") {
                        dlog!("[deep-link] notifications: {}", url_str);
                        if let Some(window) = deep_link_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("navigate-notifications", ());
                        }
                        return;
                    }

                    // Handle dispatch://focus-terminal?session=X&window=Y&pane=Z
                    if url_str.starts_with("dispatch://focus-terminal") {
                        dlog!("[deep-link] focus-terminal: {}", url_str);
                        let parsed = match url::Url::parse(&url_str) {
                            Ok(u) => u,
                            Err(e) => {
                                dlog!("[deep-link] failed to parse URL: {}", e);
                                return;
                            }
                        };
                        let params: std::collections::HashMap<String, String> = parsed
                            .query_pairs()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect();

                        let session = match params.get("session") {
                            Some(s) if !s.is_empty() => s.clone(),
                            _ => {
                                dlog!("[deep-link] focus-terminal: missing session param");
                                return;
                            }
                        };
                        let window = params.get("window").cloned();
                        let pane = params.get("pane").cloned();
                        let nid = params.get("nid").cloned();
                        let db = deep_link_state.db.clone();
                        let token = deep_link_state.yapture_tokens.lock().ok().and_then(|t| t.service_token.clone());

                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = commands::do_focus_terminal(
                                &db,
                                &session,
                                window.as_deref(),
                                pane.as_deref(),
                            ).await {
                                dlog!("[deep-link] focus-terminal failed: {}", e);
                            }

                            // Bidirectional sync: complete Yapture task
                            if let Some(nid) = nid {
                                let sync_enabled = crate::db::get_setting(&db, "yapture_bidirectional_sync")
                                    .await.ok().flatten().unwrap_or_else(|| "true".into()) == "true";
                                if sync_enabled {
                                    if let Ok(Some(n)) = crate::db::get_notification_by_id(&db, &nid).await {
                                        if let Some(yapture_id) = n.yapture_task_id {
                                            if !yapture_id.is_empty() {
                                                if let Some(config) = crate::yapture::load_config(&db, token).await {
                                                    if let Err(e) = crate::yapture::complete_yapture_task(&config, &yapture_id).await {
                                                        dlog!("[deep-link] yapture sync failed: {}", e);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        });
                        return;
                    }

                    if !url_str.starts_with("dispatch://oauth/callback") {
                        return;
                    }

                    eprintln!("[oauth] received callback: {}", url_str);

                    // Parse URL params
                    let url = match url::Url::parse(&url_str) {
                        Ok(u) => u,
                        Err(e) => {
                            eprintln!("[oauth] failed to parse URL: {}", e);
                            return;
                        }
                    };

                    let params: std::collections::HashMap<String, String> = url
                        .query_pairs()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect();

                    let code = match params.get("code") {
                        Some(c) => c.clone(),
                        None => {
                            eprintln!("[oauth] no code in callback");
                            return;
                        }
                    };

                    let callback_state = match params.get("state") {
                        Some(s) => s.clone(),
                        None => {
                            eprintln!("[oauth] no state in callback");
                            return;
                        }
                    };

                    // Validate state and get verifier
                    let oauth_state = {
                        let mut pending = deep_link_state.oauth_pending.lock().unwrap();
                        match pending.take() {
                            Some(os) if os.state == callback_state => os,
                            Some(_) => {
                                eprintln!("[oauth] state mismatch");
                                return;
                            }
                            None => {
                                eprintln!("[oauth] no pending OAuth flow");
                                return;
                            }
                        }
                    };

                    let state_for_async = deep_link_state.clone();
                    let handle_for_async = deep_link_handle.clone();

                    tauri::async_runtime::spawn(async move {
                        let api_url = crate::db::get_setting(
                            &state_for_async.db,
                            "yapture_api_url",
                        )
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "https://api.yapture.app".to_string());

                        // Exchange code for tokens
                        let tokens =
                            match yapture::exchange_code(&api_url, &code, &oauth_state).await {
                                Ok(t) => t,
                                Err(e) => {
                                    eprintln!("[oauth] token exchange failed: {}", e);
                                    return;
                                }
                            };

                        eprintln!("[oauth] tokens received");

                        // Store tokens in AppState (in-memory)
                        if let Ok(mut t) = state_for_async.yapture_tokens.lock() {
                            t.access_token = Some(tokens.access_token.clone());
                            t.refresh_token = tokens.refresh_token.clone();
                            t.service_token = Some(tokens.access_token.clone());
                        }

                        // Persist tokens to DB for survival across restarts
                        let _ = crate::db::set_setting(
                            &state_for_async.db,
                            "yapture_access_token",
                            &tokens.access_token,
                        ).await;
                        if let Some(ref rt) = tokens.refresh_token {
                            let _ = crate::db::set_setting(
                                &state_for_async.db,
                                "yapture_refresh_token",
                                rt,
                            ).await;
                        }

                        // Fetch user info
                        match yapture::fetch_userinfo(&api_url, &tokens.access_token).await {
                            Ok(info) => {
                                eprintln!("[oauth] user: {:?}", info);
                                let _ = crate::db::set_setting(
                                    &state_for_async.db,
                                    "yapture_user_id",
                                    &info.sub,
                                )
                                .await;
                                if let Some(name) = &info.name {
                                    let _ = crate::db::set_setting(
                                        &state_for_async.db,
                                        "yapture_user_name",
                                        name,
                                    )
                                    .await;
                                }
                                if let Some(email) = &info.email {
                                    let _ = crate::db::set_setting(
                                        &state_for_async.db,
                                        "yapture_user_email",
                                        email,
                                    )
                                    .await;
                                }
                                let _ = crate::db::set_setting(
                                    &state_for_async.db,
                                    "yapture_enabled",
                                    "1",
                                )
                                .await;

                                // Emit event to frontend
                                if let Some(window) =
                                    handle_for_async.get_webview_window("main")
                                {
                                    let _ = window.emit(
                                        "yapture-connected",
                                        &yapture::YaptureConnectionStatus {
                                            connected: true,
                                            user_name: info.name,
                                            user_email: info.email,
                                        },
                                    );
                                }
                            }
                            Err(e) => {
                                eprintln!("[oauth] userinfo fetch failed: {}", e);
                            }
                        }
                    });
                });
            }

            // Global hotkeys: config-driven from DB
            dlog!("setup: registering global shortcuts");
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

            // Load hotkey config from DB and build the shortcut map
            let hotkey_config = tauri::async_runtime::block_on(async {
                db::get_hotkey_config(&state.db).await.unwrap_or_else(|e| {
                    eprintln!("[hotkeys] failed to load config, using defaults: {}", e);
                    serde_json::from_str(db::DEFAULT_HOTKEY_CONFIG).unwrap()
                })
            });

            {
                let mut map = state.global_shortcut_map.write();
                for binding in &hotkey_config.bindings {
                    if binding.scope == "global" && binding.enabled {
                        for key_str in &binding.keys {
                            map.insert(key_str.clone(), binding.action.clone());
                        }
                    }
                }
            }

            let shortcut_map = state.global_shortcut_map.clone();
            let shortcut_handle = app.handle().clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |_app, shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            let shortcut_str = shortcut.to_string();
                            // Look up action in the shared map
                            let action = {
                                let map = shortcut_map.read();
                                // Try exact match first, then try matching by key code
                                map.iter()
                                    .find(|(registered, _)| {
                                        if let (Ok(a), Ok(b)) = (
                                            registered.parse::<tauri_plugin_global_shortcut::Shortcut>(),
                                            shortcut_str.parse::<tauri_plugin_global_shortcut::Shortcut>(),
                                        ) {
                                            a == b
                                        } else {
                                            false
                                        }
                                    })
                                    .map(|(_, action)| action.clone())
                            };

                            if let Some(action) = action {
                                if let Some(window) = shortcut_handle.get_webview_window("main") {
                                    match action.as_str() {
                                        "toggle_window" => {
                                            if window.is_visible().unwrap_or(false) {
                                                let _ = window.hide();
                                            } else {
                                                let _ = window.show();
                                                let _ = window.set_focus();
                                                let _ = window.emit("auto-select-first", ());
                                            }
                                        }
                                        "show_command_palette" => {
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                            let _ = window.emit("show-command-palette", ());
                                        }
                                        // Keep backwards compat for old saved configs
                                        "show_expander" => {
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                            let _ = window.emit("show-command-palette", ());
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    })
                    .build(),
            )?;

            // Register only enabled global shortcuts from config
            for binding in &hotkey_config.bindings {
                if binding.scope == "global" && binding.enabled {
                    for key_str in &binding.keys {
                        if let Ok(s) = key_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                            if let Err(e) = app.global_shortcut().register(s) {
                                eprintln!("[hotkeys] failed to register {}: {}", key_str, e);
                            } else {
                                eprintln!("[hotkeys] registered global shortcut: {} -> {}", key_str, binding.action);
                            }
                        } else {
                            eprintln!("[hotkeys] failed to parse shortcut string: {}", key_str);
                        }
                    }
                }
            }

            dlog!("setup: shortcuts registered");

            // Hide on close instead of quitting
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        eprintln!("[dispatch] on_window_event: CloseRequested — hiding window");
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    tauri::WindowEvent::Destroyed => {
                        eprintln!("[dispatch] on_window_event: Destroyed");
                    }
                    _ => {}
                }
            });

            dlog!("setup: COMPLETE — app ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_notifications,
            commands::mark_notification_read,
            commands::mark_all_notifications_read,
            commands::delete_notification,
            commands::clear_all_notifications,
            commands::get_unread_count,
            commands::focus_terminal,
            commands::record_telemetry_event,
            commands::get_telemetry,
            commands::get_telemetry_summary,
            commands::get_project_sessions,
            commands::update_project_metadata,
            commands::list_snippets,
            commands::create_snippet,
            commands::update_snippet,
            commands::delete_snippet,
            commands::expand_snippet,
            commands::import_snippets,
            commands::export_snippets,
            commands::get_live_expansion_enabled,
            commands::set_live_expansion_enabled,
            commands::check_accessibility_permission,
            commands::request_accessibility_permission,
            commands::get_hotkey_config,
            commands::set_hotkey_config,
            commands::get_yapture_config,
            commands::set_yapture_config,
            commands::test_yapture_connection,
            commands::yapture_start_oauth,
            commands::yapture_refresh,
            commands::yapture_disconnect,
            commands::yapture_detect_version,
            commands::get_yapture_connection_status,
            commands::check_accessibility_trusted,
            commands::get_expansion_diagnostics,
            commands::open_privacy_settings,
            commands::test_text_injection,
            commands::copy_to_clipboard,
            commands::get_notification_banner_config,
            commands::set_notification_banner_config,
            commands::get_yapture_sync_enabled,
            commands::set_yapture_sync_enabled,
            commands::list_recent_snippets,
            commands::list_favorite_snippets,
            commands::toggle_snippet_favorite,
            commands::get_expand_prefix,
            commands::set_expand_prefix,
            commands::add_snippet_source,
            commands::list_snippet_sources,
            commands::update_snippet_source,
            commands::remove_snippet_source,
            commands::sync_snippet_source,
            commands::sync_all_sources,
            commands::create_boilerplate_config,
            commands::ensure_default_source,
            commands::refresh_triggers,
            commands::get_trigger_cache_count,
            commands::read_source_file,
            commands::write_source_file,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    // Prevent the app from exiting when all windows close.
                    // This is a tray app — it should keep running in the background.
                    dlog!("RunEvent::ExitRequested — preventing exit (tray app)");
                    api.prevent_exit();
                }
                // macOS: show window when user CMD+TABs to app or clicks dock icon
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    dlog!("RunEvent::Reopen has_visible_windows={}", has_visible_windows);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if !has_visible_windows {
                            let _ = window.show();
                        }
                        let _ = window.set_focus();
                    }
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: ref window_event,
                    ..
                } => {
                    match window_event {
                        tauri::WindowEvent::Destroyed => {
                            dlog!("window '{}' destroyed", label);
                        }
                        tauri::WindowEvent::CloseRequested { .. } => {
                            dlog!("window '{}' CloseRequested via RunEvent", label);
                        }
                        tauri::WindowEvent::Focused(focused) => {
                            dlog!("window '{}' focused={}", label, focused);
                        }
                        _ => {}
                    }
                }
                tauri::RunEvent::Exit => {
                    dlog!("RunEvent::Exit — app exiting");
                }
                _ => {
                    let _ = &app_handle; // suppress unused warning
                }
            }
        });

    // If we reach here, the event loop has ended
    dlog!("event loop ended — run() returning");
}
