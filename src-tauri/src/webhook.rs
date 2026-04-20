//! Webhook delivery module for Dispatch routing pipelines.
//!
//! Provides preset formats for common webhook targets (Discord, Slack, generic JSON)
//! and handles HTTP delivery with configurable methods, headers, and retry logic.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// --- Webhook Presets ---

/// Known webhook format presets.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum WebhookPreset {
    /// Discord webhook: `{ "content": "...", "username": "Dispatch" }`
    Discord,
    /// Slack webhook: `{ "text": "..." }`
    Slack,
    /// Generic JSON: `{ "notification": { ... } }`
    Generic,
    /// Ntfy.sh: POST body as plain text, title in header
    Ntfy,
    /// Custom: user-defined format
    Custom,
}

impl WebhookPreset {
    pub fn label(&self) -> &str {
        match self {
            Self::Discord => "Discord Webhook",
            Self::Slack => "Slack Incoming Webhook",
            Self::Generic => "Generic JSON",
            Self::Ntfy => "Ntfy.sh",
            Self::Custom => "Custom",
        }
    }

    pub fn example_url(&self) -> &str {
        match self {
            Self::Discord => "https://discord.com/api/webhooks/{id}/{token}",
            Self::Slack => "https://hooks.slack.com/services/T.../B.../xxx",
            Self::Generic => "https://your-api.example.com/webhook",
            Self::Ntfy => "https://ntfy.sh/your-topic",
            Self::Custom => "https://...",
        }
    }
}

// --- Webhook Payload ---

/// Notification data included in webhook payloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookNotificationPayload {
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    pub source: String,
    pub event_type: String,
    pub provider: Option<String>,
    pub project: Option<String>,
    pub author: Option<String>,
    pub channel: Option<String>,
    pub created_at: String,
}

/// Build a webhook payload body based on the preset format.
pub fn build_payload(
    preset: WebhookPreset,
    rendered_message: &str,
    notification: &WebhookNotificationPayload,
) -> serde_json::Value {
    match preset {
        WebhookPreset::Discord => {
            serde_json::json!({
                "content": rendered_message,
                "username": "Dispatch",
            })
        }
        WebhookPreset::Slack => {
            serde_json::json!({
                "text": rendered_message,
            })
        }
        WebhookPreset::Generic => {
            serde_json::json!({
                "message": rendered_message,
                "notification": notification,
            })
        }
        WebhookPreset::Ntfy => {
            // Ntfy uses headers for title, body is plain text
            serde_json::json!({
                "topic": "dispatch",
                "title": notification.title,
                "message": rendered_message,
                "priority": match notification.event_type.as_str() {
                    "error" => 5,
                    "warning" => 4,
                    _ => 3,
                },
            })
        }
        WebhookPreset::Custom => {
            serde_json::json!({
                "content": rendered_message,
                "text": rendered_message,
                "notification": notification,
            })
        }
    }
}

/// Detect which preset a webhook URL likely uses based on the URL pattern.
pub fn detect_preset(url: &str) -> WebhookPreset {
    if url.contains("discord.com/api/webhooks") {
        WebhookPreset::Discord
    } else if url.contains("hooks.slack.com") {
        WebhookPreset::Slack
    } else if url.contains("ntfy.sh") || url.contains("ntfy.") {
        WebhookPreset::Ntfy
    } else {
        WebhookPreset::Generic
    }
}

// --- Webhook Delivery ---

/// Configuration for a webhook delivery attempt.
#[derive(Debug, Clone)]
pub struct WebhookDeliveryConfig {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub preset: WebhookPreset,
    pub timeout_ms: u64,
}

impl WebhookDeliveryConfig {
    pub fn new(url: &str) -> Self {
        let preset = detect_preset(url);
        Self {
            url: url.to_string(),
            method: "POST".to_string(),
            headers: HashMap::new(),
            preset,
            timeout_ms: 10_000,
        }
    }

    pub fn with_method(mut self, method: &str) -> Self {
        self.method = method.to_string();
        self
    }

    pub fn with_header(mut self, key: &str, value: &str) -> Self {
        self.headers.insert(key.to_string(), value.to_string());
        self
    }

    pub fn with_headers(mut self, headers: HashMap<String, String>) -> Self {
        self.headers = headers;
        self
    }

    pub fn with_preset(mut self, preset: WebhookPreset) -> Self {
        self.preset = preset;
        self
    }

    pub fn with_timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }
}

/// Result of a webhook delivery attempt.
#[derive(Debug, Clone, Serialize)]
pub struct WebhookDeliveryResult {
    pub success: bool,
    pub status_code: Option<u16>,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub response_body: Option<String>,
}

/// Send a webhook request.
pub async fn deliver(
    http: &reqwest::Client,
    config: &WebhookDeliveryConfig,
    rendered_message: &str,
    notification: &WebhookNotificationPayload,
) -> WebhookDeliveryResult {
    let start = std::time::Instant::now();

    let payload = build_payload(config.preset, rendered_message, notification);

    let mut request = match config.method.as_str() {
        "PUT" => http.put(&config.url),
        "PATCH" => http.patch(&config.url),
        _ => http.post(&config.url),
    };

    // Apply custom headers
    for (key, value) in &config.headers {
        request = request.header(key, value);
    }

    // Set timeout
    request = request.timeout(std::time::Duration::from_millis(config.timeout_ms));

    // Special handling for ntfy: send as plain text with title header
    if config.preset == WebhookPreset::Ntfy {
        request = request
            .header("Title", &notification.title)
            .header("Priority", match notification.event_type.as_str() {
                "error" => "5",
                "warning" => "4",
                _ => "3",
            })
            .body(rendered_message.to_string());
    } else {
        request = request.json(&payload);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let status_code = status.as_u16();
            let body = response.text().await.ok();

            if status.is_success() {
                WebhookDeliveryResult {
                    success: true,
                    status_code: Some(status_code),
                    error: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                    response_body: body,
                }
            } else {
                WebhookDeliveryResult {
                    success: false,
                    status_code: Some(status_code),
                    error: Some(format!(
                        "HTTP {}: {}",
                        status_code,
                        body.as_deref().unwrap_or("no body")
                    )),
                    duration_ms: start.elapsed().as_millis() as u64,
                    response_body: body,
                }
            }
        }
        Err(e) => WebhookDeliveryResult {
            success: false,
            status_code: None,
            error: Some(format!("Request failed: {}", e)),
            duration_ms: start.elapsed().as_millis() as u64,
            response_body: None,
        },
    }
}

/// Send a webhook with retry logic.
pub async fn deliver_with_retry(
    http: &reqwest::Client,
    config: &WebhookDeliveryConfig,
    rendered_message: &str,
    notification: &WebhookNotificationPayload,
    max_retries: u32,
) -> WebhookDeliveryResult {
    let mut last_result = deliver(http, config, rendered_message, notification).await;

    if last_result.success || max_retries == 0 {
        return last_result;
    }

    // Retry with exponential backoff: 1s, 5s, 25s
    let backoff_ms = [1000u64, 5000, 25000];

    for attempt in 0..max_retries.min(3) {
        let delay = backoff_ms.get(attempt as usize).copied().unwrap_or(25000);

        // Only retry on server errors (5xx) or timeouts
        let should_retry = match last_result.status_code {
            Some(code) => code >= 500,
            None => true, // Connection error / timeout
        };

        if !should_retry {
            return last_result;
        }

        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;

        last_result = deliver(http, config, rendered_message, notification).await;

        if last_result.success {
            return last_result;
        }
    }

    last_result
}

// --- URL Validation ---

/// Basic webhook URL validation.
pub fn validate_webhook_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("Webhook URL cannot be empty".to_string());
    }

    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Webhook URL must start with http:// or https://".to_string());
    }

    // Block obviously internal/dangerous URLs
    let blocked_patterns = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "169.254.",  // Link-local
        "10.",       // Private
        "192.168.",  // Private
    ];

    let url_lower = url.to_lowercase();
    for pattern in &blocked_patterns {
        if url_lower.contains(pattern) {
            // Allow localhost in debug builds
            #[cfg(not(debug_assertions))]
            return Err(format!("Webhook URL cannot target internal addresses ({})", pattern));
            #[cfg(debug_assertions)]
            { let _ = pattern; } // Allow in debug
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_preset() {
        assert_eq!(
            detect_preset("https://discord.com/api/webhooks/123/abc"),
            WebhookPreset::Discord
        );
        assert_eq!(
            detect_preset("https://hooks.slack.com/services/T123/B456/xxx"),
            WebhookPreset::Slack
        );
        assert_eq!(
            detect_preset("https://ntfy.sh/dispatch-alerts"),
            WebhookPreset::Ntfy
        );
        assert_eq!(
            detect_preset("https://example.com/webhook"),
            WebhookPreset::Generic
        );
    }

    #[test]
    fn test_build_discord_payload() {
        let notification = WebhookNotificationPayload {
            id: "n1".to_string(),
            title: "Build failed".to_string(),
            body: Some("Exit code 1".to_string()),
            source: "slack:Acme".to_string(),
            event_type: "error".to_string(),
            provider: Some("slack".to_string()),
            project: None,
            author: None,
            channel: None,
            created_at: "2024-01-15T10:00:00Z".to_string(),
        };

        let payload = build_payload(WebhookPreset::Discord, "Test message", &notification);
        assert_eq!(payload["content"], "Test message");
        assert_eq!(payload["username"], "Dispatch");
    }

    #[test]
    fn test_build_slack_payload() {
        let notification = WebhookNotificationPayload {
            id: "n1".to_string(),
            title: "Test".to_string(),
            body: None,
            source: "test".to_string(),
            event_type: "notification".to_string(),
            provider: None,
            project: None,
            author: None,
            channel: None,
            created_at: "2024-01-15T10:00:00Z".to_string(),
        };

        let payload = build_payload(WebhookPreset::Slack, "Hello", &notification);
        assert_eq!(payload["text"], "Hello");
    }

    #[test]
    fn test_validate_webhook_url() {
        assert!(validate_webhook_url("https://example.com/hook").is_ok());
        assert!(validate_webhook_url("").is_err());
        assert!(validate_webhook_url("ftp://example.com").is_err());
    }

    #[test]
    fn test_delivery_config_builder() {
        let config = WebhookDeliveryConfig::new("https://discord.com/api/webhooks/1/abc")
            .with_header("X-Custom", "value")
            .with_timeout(5000);

        assert_eq!(config.preset, WebhookPreset::Discord);
        assert_eq!(config.headers.get("X-Custom"), Some(&"value".to_string()));
        assert_eq!(config.timeout_ms, 5000);
    }
}
