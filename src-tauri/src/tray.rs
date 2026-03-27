use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

use crate::state::AppState;

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<Arc<AppState>>();
    let is_enabled = state.live_expansion_enabled.load(Ordering::Relaxed);
    let live_label = if is_enabled {
        "Live Expansion: On"
    } else {
        "Live Expansion: Off"
    };

    let show = MenuItem::with_id(app, "show", "Show Dispatch", true, None::<&str>)?;
    let live_toggle =
        MenuItem::with_id(app, "live_toggle", live_label, true, None::<&str>)?;
    let mark_read = MenuItem::with_id(app, "mark_read", "Mark All Read", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &live_toggle, &mark_read, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Dispatch — Notification Center")
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "live_toggle" => {
                    let state = app.state::<Arc<AppState>>();
                    let was_enabled = state.live_expansion_enabled.load(Ordering::Relaxed);
                    let now_enabled = !was_enabled;
                    state
                        .live_expansion_enabled
                        .store(now_enabled, Ordering::Relaxed);

                    // Update menu item text
                    let new_label = if now_enabled {
                        "Live Expansion: On"
                    } else {
                        "Live Expansion: Off"
                    };
                    if let Some(item) = app
                        .menu()
                        .and_then(|m| m.get("live_toggle"))
                        .and_then(|i| i.as_menuitem().cloned())
                    {
                        let _ = item.set_text(new_label);
                    }

                    // Persist + refresh cache
                    let db = state.db.clone();
                    let cache = state.trigger_cache.clone();
                    let value = if now_enabled { "1" } else { "0" };
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::db::set_setting(&db, "live_expansion_enabled", value).await;
                        if now_enabled {
                            let _ = crate::trigger_cache::refresh_trigger_cache(&db, &cache).await;
                        }
                    });

                    // Emit event so frontend can update
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("live-expansion-changed", now_enabled);
                    }
                }
                "mark_read" => {
                    let app = app.clone();
                    let state = app.state::<Arc<AppState>>();
                    let state = state.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::db::mark_all_read(&state.db).await;
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("notifications-changed", ());
                        }
                    });
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .show_menu_on_left_click(true)
        .build(app)?;

    Ok(())
}
