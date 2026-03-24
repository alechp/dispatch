mod commands;
mod db;
mod models;
mod server;
mod state;
mod tray;

use std::sync::Arc;

use sqlx::sqlite::SqlitePoolOptions;
use tauri::{Emitter, Manager};

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Resolve database path
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("dispatch.db");
            let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

            // Block on async init during setup
            let state = tauri::async_runtime::block_on(async {
                let pool = SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect(&db_url)
                    .await
                    .expect("Failed to connect to SQLite");

                db::init_db(&pool).await.expect("Failed to run migrations");

                Arc::new(AppState::new(pool))
            });

            // Manage state
            app.manage(state.clone());

            // Spawn the axum HTTP server
            let server_state = state.clone();
            let event_state = state.clone();
            let event_handle = app_handle.clone();

            tauri::async_runtime::spawn(async move {
                let router = server::create_router(server_state);
                let listener = tokio::net::TcpListener::bind("127.0.0.1:9394")
                    .await
                    .expect("Failed to bind port 9394");
                println!("Dispatch server listening on http://127.0.0.1:9394");
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
            tray::setup_tray(app.handle())?;

            // Global hotkey: Cmd+Shift+D to toggle window
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
            let shortcut: tauri_plugin_global_shortcut::Shortcut = "CommandOrControl+Shift+D".parse().unwrap();
            let shortcut_handle = app.handle().clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |_app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            if let Some(window) = shortcut_handle.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(shortcut)?;

            // Hide on close instead of quitting
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            });

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
