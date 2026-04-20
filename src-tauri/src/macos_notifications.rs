//! macOS native push notification support for Dispatch.
//!
//! Sends system notifications via Tauri's notification plugin or native APIs.
//! Supports grouping by provider/account, click-to-focus, quiet hours, and
//! sound configuration.

use serde::{Deserialize, Serialize};

// --- Configuration ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacOSPushConfig {
    pub enabled: bool,
    pub sound: String,              // "default" | "none" | system sound name
    pub show_body_preview: bool,
    pub group_by_provider: bool,
    pub suppress_when_focused: bool,
    pub quiet_hours: QuietHoursConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuietHoursConfig {
    pub enabled: bool,
    pub start: String,  // "22:00" format
    pub end: String,    // "08:00" format
}

impl Default for MacOSPushConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sound: "default".to_string(),
            show_body_preview: true,
            group_by_provider: true,
            suppress_when_focused: true,
            quiet_hours: QuietHoursConfig {
                enabled: false,
                start: "22:00".to_string(),
                end: "08:00".to_string(),
            },
        }
    }
}

// --- Push Notification Request ---

#[derive(Debug, Clone)]
pub struct PushNotificationRequest {
    pub title: String,
    pub body: Option<String>,
    pub subtitle: Option<String>,
    pub sound: String,
    pub group_id: Option<String>,
    pub action_url: Option<String>,
    pub notification_id: Option<String>,
}

impl PushNotificationRequest {
    pub fn new(title: &str) -> Self {
        Self {
            title: title.to_string(),
            body: None,
            subtitle: None,
            sound: "default".to_string(),
            group_id: None,
            action_url: None,
            notification_id: None,
        }
    }

    pub fn with_body(mut self, body: &str) -> Self {
        self.body = Some(body.to_string());
        self
    }

    pub fn with_subtitle(mut self, subtitle: &str) -> Self {
        self.subtitle = Some(subtitle.to_string());
        self
    }

    pub fn with_sound(mut self, sound: &str) -> Self {
        self.sound = sound.to_string();
        self
    }

    pub fn with_group(mut self, group_id: &str) -> Self {
        self.group_id = Some(group_id.to_string());
        self
    }

    pub fn with_action_url(mut self, url: &str) -> Self {
        self.action_url = Some(url.to_string());
        self
    }

    pub fn with_notification_id(mut self, id: &str) -> Self {
        self.notification_id = Some(id.to_string());
        self
    }
}

// --- Group ID Generation ---

/// Generate a notification group identifier for provider-based grouping.
pub fn provider_group_id(provider: &str, account_id: Option<&str>) -> String {
    match account_id {
        Some(aid) => format!("dispatch.{}.{}", provider, aid),
        None => format!("dispatch.{}", provider),
    }
}

/// Generate a thread-level group ID (for threading within Notification Center).
pub fn thread_group_id(provider: &str, channel_id: Option<&str>) -> String {
    match channel_id {
        Some(cid) => format!("dispatch.{}.channel.{}", provider, cid),
        None => format!("dispatch.{}", provider),
    }
}

// --- Quiet Hours Check ---

/// Check if the current time falls within quiet hours.
pub fn is_quiet_hours(config: &QuietHoursConfig) -> bool {
    if !config.enabled {
        return false;
    }

    let now = chrono::Local::now();
    let current_minutes = now.hour() as u32 * 60 + now.minute() as u32;

    let start_minutes = parse_time_to_minutes(&config.start).unwrap_or(22 * 60);
    let end_minutes = parse_time_to_minutes(&config.end).unwrap_or(8 * 60);

    if start_minutes <= end_minutes {
        // Same-day range: e.g., 09:00 - 17:00
        current_minutes >= start_minutes && current_minutes < end_minutes
    } else {
        // Overnight range: e.g., 22:00 - 08:00
        current_minutes >= start_minutes || current_minutes < end_minutes
    }
}

/// Parse "HH:MM" string to minutes since midnight.
fn parse_time_to_minutes(time: &str) -> Option<u32> {
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let hours: u32 = parts[0].parse().ok()?;
    let minutes: u32 = parts[1].parse().ok()?;
    if hours >= 24 || minutes >= 60 {
        return None;
    }
    Some(hours * 60 + minutes)
}

use chrono::Timelike;

// --- Push Decision Logic ---

/// Determine whether a push notification should be sent.
pub fn should_send_push(
    config: &MacOSPushConfig,
    window_focused: bool,
) -> bool {
    if !config.enabled {
        return false;
    }

    if config.suppress_when_focused && window_focused {
        return false;
    }

    if is_quiet_hours(&config.quiet_hours) {
        return false;
    }

    true
}

/// Build a push request from notification data.
pub fn build_push_request(
    config: &MacOSPushConfig,
    title: &str,
    body: Option<&str>,
    provider: Option<&str>,
    account_id: Option<&str>,
    channel_name: Option<&str>,
    notification_id: Option<&str>,
) -> PushNotificationRequest {
    let subtitle = match (provider, channel_name) {
        (Some(p), Some(ch)) => Some(format!("{} · {}", p, ch)),
        (Some(p), None) => Some(p.to_string()),
        (None, Some(ch)) => Some(ch.to_string()),
        (None, None) => None,
    };

    let group_id = if config.group_by_provider {
        provider.map(|p| provider_group_id(p, account_id))
    } else {
        Some("dispatch".to_string())
    };

    let display_body = if config.show_body_preview {
        body.map(|b| {
            // Truncate long bodies for push display
            if b.len() > 200 {
                format!("{}...", &b[..197])
            } else {
                b.to_string()
            }
        })
    } else {
        None
    };

    let mut req = PushNotificationRequest::new(title)
        .with_sound(&config.sound);

    if let Some(b) = display_body {
        req = req.with_body(&b);
    }
    if let Some(s) = subtitle {
        req = req.with_subtitle(&s);
    }
    if let Some(g) = group_id {
        req = req.with_group(&g);
    }
    if let Some(id) = notification_id {
        req = req.with_notification_id(id);
    }

    req
}

// --- Tauri Notification Integration ---
//
// The actual sending is done via Tauri's notification API.
// This function signature matches what the routing engine will call.
// The AppHandle parameter is required for Tauri plugin access.

/// Send a push notification using Tauri's notification plugin.
///
/// This function needs a `tauri::AppHandle` to send notifications.
/// It is called by the routing engine when a rule's destination is "macos_push".
///
/// Implementation note: The caller (in commands.rs or routing.rs) should call:
/// ```ignore
/// use tauri::plugin::notification::NotificationExt;
/// app.notification().builder()
///     .title(&req.title)
///     .body(req.body.as_deref().unwrap_or(""))
///     .show();
/// ```
///
/// We keep this as a data-preparation layer to avoid coupling to Tauri types
/// in this module, making it testable independently.
pub fn prepare_push(
    config: &MacOSPushConfig,
    title: &str,
    body: Option<&str>,
    provider: Option<&str>,
    account_id: Option<&str>,
    channel_name: Option<&str>,
    notification_id: Option<&str>,
    window_focused: bool,
) -> Option<PushNotificationRequest> {
    if !should_send_push(config, window_focused) {
        return None;
    }

    Some(build_push_request(
        config,
        title,
        body,
        provider,
        account_id,
        channel_name,
        notification_id,
    ))
}

// --- Settings Persistence ---

/// Default config as JSON string for DB storage.
pub fn default_config_json() -> String {
    serde_json::to_string(&MacOSPushConfig::default()).unwrap_or_else(|_| "{}".to_string())
}

/// Parse config from JSON string (from DB settings).
pub fn parse_config(json: &str) -> MacOSPushConfig {
    serde_json::from_str(json).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_time_to_minutes() {
        assert_eq!(parse_time_to_minutes("00:00"), Some(0));
        assert_eq!(parse_time_to_minutes("08:00"), Some(480));
        assert_eq!(parse_time_to_minutes("22:00"), Some(1320));
        assert_eq!(parse_time_to_minutes("23:59"), Some(1439));
        assert_eq!(parse_time_to_minutes("invalid"), None);
        assert_eq!(parse_time_to_minutes("25:00"), None);
    }

    #[test]
    fn test_quiet_hours_disabled() {
        let config = QuietHoursConfig {
            enabled: false,
            start: "22:00".to_string(),
            end: "08:00".to_string(),
        };
        assert!(!is_quiet_hours(&config));
    }

    #[test]
    fn test_provider_group_id() {
        assert_eq!(provider_group_id("discord", Some("abc123")), "dispatch.discord.abc123");
        assert_eq!(provider_group_id("slack", None), "dispatch.slack");
    }

    #[test]
    fn test_should_not_send_when_disabled() {
        let config = MacOSPushConfig {
            enabled: false,
            ..Default::default()
        };
        assert!(!should_send_push(&config, false));
    }

    #[test]
    fn test_should_not_send_when_focused() {
        let config = MacOSPushConfig {
            enabled: true,
            suppress_when_focused: true,
            ..Default::default()
        };
        assert!(!should_send_push(&config, true));
    }

    #[test]
    fn test_should_send_when_not_focused() {
        let config = MacOSPushConfig {
            enabled: true,
            suppress_when_focused: true,
            quiet_hours: QuietHoursConfig {
                enabled: false,
                start: "22:00".to_string(),
                end: "08:00".to_string(),
            },
            ..Default::default()
        };
        assert!(should_send_push(&config, false));
    }

    #[test]
    fn test_build_push_request() {
        let config = MacOSPushConfig::default();
        let req = build_push_request(
            &config,
            "Build failed",
            Some("Exit code 1 on main"),
            Some("discord"),
            Some("acc123"),
            Some("#alerts"),
            Some("notif-456"),
        );
        assert_eq!(req.title, "Build failed");
        assert_eq!(req.body, Some("Exit code 1 on main".to_string()));
        assert_eq!(req.subtitle, Some("discord · #alerts".to_string()));
        assert_eq!(req.group_id, Some("dispatch.discord.acc123".to_string()));
    }

    #[test]
    fn test_default_config_json_roundtrip() {
        let json = default_config_json();
        let parsed = parse_config(&json);
        assert_eq!(parsed.enabled, false);
        assert_eq!(parsed.sound, "default");
    }
}
