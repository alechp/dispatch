//! Notification routing engine for Dispatch.
//!
//! Evaluates routing rules against incoming notifications and executes
//! configured destinations (webhooks, account sends, macOS push, chaining).
//! Supports template rendering and cycle detection for chained rules.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// --- Template Rendering ---

/// Available template variables for routing rule message templates.
pub const TEMPLATE_VARIABLES: &[&str] = &[
    "{{title}}",
    "{{body}}",
    "{{source}}",
    "{{event_type}}",
    "{{provider}}",
    "{{project}}",
    "{{author}}",
    "{{channel}}",
    "{{timestamp}}",
];

/// Context for template rendering — extracted from a notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateContext {
    pub title: String,
    pub body: String,
    pub source: String,
    pub event_type: String,
    pub provider: String,
    pub project: String,
    pub author: String,
    pub channel: String,
    pub timestamp: String,
}

impl TemplateContext {
    /// Create a context from notification fields.
    pub fn from_notification(
        title: &str,
        body: Option<&str>,
        source: &str,
        event_type: &str,
        provider: Option<&str>,
        project: Option<&str>,
        author: Option<&str>,
        channel: Option<&str>,
        timestamp: &str,
    ) -> Self {
        Self {
            title: title.to_string(),
            body: body.unwrap_or("").to_string(),
            source: source.to_string(),
            event_type: event_type.to_string(),
            provider: provider.unwrap_or("unknown").to_string(),
            project: project.unwrap_or("").to_string(),
            author: author.unwrap_or("").to_string(),
            channel: channel.unwrap_or("").to_string(),
            timestamp: timestamp.to_string(),
        }
    }
}

/// Render a template string by replacing {{variable}} placeholders.
pub fn render_template(template: Option<&str>, ctx: &TemplateContext) -> String {
    match template {
        None => {
            // Default format when no template is specified
            if ctx.body.is_empty() {
                format!("[{}] {}", ctx.source, ctx.title)
            } else {
                format!("[{}] {}: {}", ctx.source, ctx.title, ctx.body)
            }
        }
        Some(tpl) => tpl
            .replace("{{title}}", &ctx.title)
            .replace("{{body}}", &ctx.body)
            .replace("{{source}}", &ctx.source)
            .replace("{{event_type}}", &ctx.event_type)
            .replace("{{provider}}", &ctx.provider)
            .replace("{{project}}", &ctx.project)
            .replace("{{author}}", &ctx.author)
            .replace("{{channel}}", &ctx.channel)
            .replace("{{timestamp}}", &ctx.timestamp),
    }
}

// --- Source Matching ---

/// Check if a routing rule's source filter matches a notification.
pub fn matches_source_filter(
    source_type: &str,
    source_value: Option<&str>,
    notification_provider: Option<&str>,
    notification_account_id: Option<&str>,
    notification_event_type: &str,
    notification_project: Option<&str>,
) -> bool {
    match source_type {
        "any" => true,
        "provider" => {
            source_value
                .map(|sv| notification_provider == Some(sv))
                .unwrap_or(false)
        }
        "account" => {
            source_value
                .map(|sv| notification_account_id == Some(sv))
                .unwrap_or(false)
        }
        "event_type" => {
            source_value
                .map(|sv| notification_event_type == sv)
                .unwrap_or(false)
        }
        "project" => {
            source_value
                .map(|sv| notification_project == Some(sv))
                .unwrap_or(false)
        }
        _ => false,
    }
}

/// Check if a notification's event_type matches the rule's event type filter.
pub fn matches_event_filter(
    filter_event_types: Option<&str>,
    notification_event_type: &str,
) -> bool {
    match filter_event_types {
        None => true, // No filter = match all
        Some(json) => {
            if let Ok(types) = serde_json::from_str::<Vec<String>>(json) {
                if types.is_empty() {
                    return true;
                }
                types.iter().any(|t| t == notification_event_type)
            } else {
                true // Invalid JSON = match all (fail open)
            }
        }
    }
}

/// Check if a notification's title/body contains any of the filter keywords.
pub fn matches_keyword_filter(
    filter_keywords: Option<&str>,
    notification_title: &str,
    notification_body: Option<&str>,
) -> bool {
    match filter_keywords {
        None => true, // No filter = match all
        Some(json) => {
            if let Ok(keywords) = serde_json::from_str::<Vec<String>>(json) {
                if keywords.is_empty() {
                    return true;
                }
                let title_lower = notification_title.to_lowercase();
                let body_lower = notification_body
                    .map(|b| b.to_lowercase())
                    .unwrap_or_default();

                keywords.iter().any(|kw| {
                    let kw_lower = kw.to_lowercase();
                    title_lower.contains(&kw_lower) || body_lower.contains(&kw_lower)
                })
            } else {
                true // Invalid JSON = match all
            }
        }
    }
}

// --- Destination Configuration ---

/// Parsed destination configuration from a routing rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestinationConfig {
    // For "webhook"
    pub url: Option<String>,
    pub method: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,

    // For "account" — send to a connected account's channel
    pub account_id: Option<String>,
    pub channel_id: Option<String>,

    // For "macos_push"
    pub sound: Option<String>,
    pub subtitle: Option<String>,

    // For "routing_rule" — chaining
    pub rule_id: Option<String>,
}

impl DestinationConfig {
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("Invalid destination config: {}", e))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Create a webhook destination config.
    pub fn webhook(url: &str) -> Self {
        Self {
            url: Some(url.to_string()),
            method: Some("POST".to_string()),
            headers: None,
            account_id: None,
            channel_id: None,
            sound: None,
            subtitle: None,
            rule_id: None,
        }
    }

    /// Create a macOS push destination config.
    pub fn macos_push(sound: Option<&str>) -> Self {
        Self {
            url: None,
            method: None,
            headers: None,
            account_id: None,
            channel_id: None,
            sound: sound.map(|s| s.to_string()),
            subtitle: None,
            rule_id: None,
        }
    }

    /// Create an account-send destination config.
    pub fn account_send(account_id: &str, channel_id: &str) -> Self {
        Self {
            url: None,
            method: None,
            headers: None,
            account_id: Some(account_id.to_string()),
            channel_id: Some(channel_id.to_string()),
            sound: None,
            subtitle: None,
            rule_id: None,
        }
    }

    /// Create a chain destination config.
    pub fn chain(rule_id: &str) -> Self {
        Self {
            url: None,
            method: None,
            headers: None,
            account_id: None,
            channel_id: None,
            sound: None,
            subtitle: None,
            rule_id: Some(rule_id.to_string()),
        }
    }
}

// --- Chain Validation ---

/// Maximum depth for chained routing rules.
pub const MAX_CHAIN_DEPTH: usize = 10;

/// Validate that adding a chain link doesn't create a cycle.
/// Returns Err with a description if a cycle would be created.
pub fn validate_chain(
    rule_id: &str,
    proposed_chain_id: &str,
    // Function to look up a rule's chain_rule_id by its id
    get_chain_id: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    if rule_id == proposed_chain_id {
        return Err("Cannot chain a rule to itself".to_string());
    }

    let mut visited = HashSet::new();
    visited.insert(rule_id.to_string());
    visited.insert(proposed_chain_id.to_string());

    let mut current = proposed_chain_id.to_string();
    let mut depth = 0;

    loop {
        depth += 1;
        if depth > MAX_CHAIN_DEPTH {
            return Err(format!(
                "Chain would exceed maximum depth of {}",
                MAX_CHAIN_DEPTH
            ));
        }

        match get_chain_id(&current) {
            None => return Ok(()), // End of chain, no cycle
            Some(next_id) => {
                if visited.contains(&next_id) {
                    return Err(format!(
                        "Chain would create a cycle: rule '{}' already visited",
                        next_id
                    ));
                }
                visited.insert(next_id.clone());
                current = next_id;
            }
        }
    }
}

// --- Routing Execution Result ---

/// Result of executing a single routing rule destination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingExecutionResult {
    pub rule_id: String,
    pub rule_name: String,
    pub notification_id: String,
    pub destination_type: String,
    pub status: RoutingStatus,
    pub error_message: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RoutingStatus {
    Success,
    Failed,
    Skipped,
}

impl RoutingStatus {
    pub fn as_str(&self) -> &str {
        match self {
            RoutingStatus::Success => "success",
            RoutingStatus::Failed => "failed",
            RoutingStatus::Skipped => "skipped",
        }
    }
}

// --- Rule Evaluation Engine ---

/// A lightweight representation of a routing rule for evaluation.
/// This avoids coupling the engine to the database model directly.
#[derive(Debug, Clone)]
pub struct EvaluationRule {
    pub id: String,
    pub name: String,
    pub is_enabled: bool,
    pub source_type: String,
    pub source_value: Option<String>,
    pub destination_type: String,
    pub destination_config: String,
    pub template: Option<String>,
    pub filter_event_types: Option<String>,
    pub filter_keywords: Option<String>,
    pub priority: i32,
    pub stop_on_match: bool,
    pub chain_rule_id: Option<String>,
}

/// A lightweight representation of a notification for evaluation.
#[derive(Debug, Clone)]
pub struct EvaluationNotification {
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    pub source: String,
    pub event_type: String,
    pub provider: Option<String>,
    pub account_id: Option<String>,
    pub project: Option<String>,
    pub provider_author: Option<String>,
    pub provider_channel_name: Option<String>,
    pub created_at: String,
}

/// Evaluate which rules match a notification (does NOT execute destinations).
/// Returns the matching rules in priority order.
pub fn evaluate_matching_rules<'a>(
    rules: &'a [EvaluationRule],
    notification: &'a EvaluationNotification,
) -> Vec<&'a EvaluationRule> {
    let mut matching = Vec::new();

    // Rules are assumed to be sorted by priority DESC already
    for rule in rules {
        if !rule.is_enabled {
            continue;
        }

        if !matches_source_filter(
            &rule.source_type,
            rule.source_value.as_deref(),
            notification.provider.as_deref(),
            notification.account_id.as_deref(),
            &notification.event_type,
            notification.project.as_deref(),
        ) {
            continue;
        }

        if !matches_event_filter(
            rule.filter_event_types.as_deref(),
            &notification.event_type,
        ) {
            continue;
        }

        if !matches_keyword_filter(
            rule.filter_keywords.as_deref(),
            &notification.title,
            notification.body.as_deref(),
        ) {
            continue;
        }

        matching.push(rule);

        if rule.stop_on_match {
            break;
        }
    }

    matching
}

/// Build the template context from a notification.
pub fn build_template_context(notification: &EvaluationNotification) -> TemplateContext {
    TemplateContext::from_notification(
        &notification.title,
        notification.body.as_deref(),
        &notification.source,
        &notification.event_type,
        notification.provider.as_deref(),
        notification.project.as_deref(),
        notification.provider_author.as_deref(),
        notification.provider_channel_name.as_deref(),
        &notification.created_at,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_template_default() {
        let ctx = TemplateContext {
            title: "Build failed".to_string(),
            body: "Exit code 1".to_string(),
            source: "slack:Acme".to_string(),
            event_type: "error".to_string(),
            provider: "slack".to_string(),
            project: "dispatch".to_string(),
            author: "deploy-bot".to_string(),
            channel: "#deploys".to_string(),
            timestamp: "2024-01-15T10:00:00Z".to_string(),
        };

        let result = render_template(None, &ctx);
        assert_eq!(result, "[slack:Acme] Build failed: Exit code 1");
    }

    #[test]
    fn test_render_template_custom() {
        let ctx = TemplateContext {
            title: "Build failed".to_string(),
            body: "Exit code 1".to_string(),
            source: "slack:Acme".to_string(),
            event_type: "error".to_string(),
            provider: "slack".to_string(),
            project: "dispatch".to_string(),
            author: "deploy-bot".to_string(),
            channel: "#deploys".to_string(),
            timestamp: "2024-01-15T10:00:00Z".to_string(),
        };

        let template = "**{{source}}** — {{title}}\n{{body}}\n_Channel: {{channel}}_";
        let result = render_template(Some(template), &ctx);
        assert_eq!(
            result,
            "**slack:Acme** — Build failed\nExit code 1\n_Channel: #deploys_"
        );
    }

    #[test]
    fn test_matches_source_any() {
        assert!(matches_source_filter("any", None, Some("discord"), None, "notification", None));
    }

    #[test]
    fn test_matches_source_provider() {
        assert!(matches_source_filter("provider", Some("discord"), Some("discord"), None, "notification", None));
        assert!(!matches_source_filter("provider", Some("discord"), Some("slack"), None, "notification", None));
    }

    #[test]
    fn test_matches_source_account() {
        assert!(matches_source_filter("account", Some("acc-123"), None, Some("acc-123"), "notification", None));
        assert!(!matches_source_filter("account", Some("acc-123"), None, Some("acc-456"), "notification", None));
    }

    #[test]
    fn test_matches_event_filter_none() {
        assert!(matches_event_filter(None, "error"));
    }

    #[test]
    fn test_matches_event_filter_match() {
        let filter = r#"["error","warning"]"#;
        assert!(matches_event_filter(Some(filter), "error"));
        assert!(matches_event_filter(Some(filter), "warning"));
        assert!(!matches_event_filter(Some(filter), "notification"));
    }

    #[test]
    fn test_matches_keyword_filter_none() {
        assert!(matches_keyword_filter(None, "anything", None));
    }

    #[test]
    fn test_matches_keyword_filter_match_title() {
        let filter = r#"["deploy","build"]"#;
        assert!(matches_keyword_filter(Some(filter), "Build failed on main", None));
        assert!(!matches_keyword_filter(Some(filter), "Tests passed", None));
    }

    #[test]
    fn test_matches_keyword_filter_match_body() {
        let filter = r#"["deploy"]"#;
        assert!(matches_keyword_filter(
            Some(filter),
            "CI Update",
            Some("Production deploy completed")
        ));
    }

    #[test]
    fn test_matches_keyword_case_insensitive() {
        let filter = r#"["Deploy"]"#;
        assert!(matches_keyword_filter(Some(filter), "deploy started", None));
    }

    #[test]
    fn test_validate_chain_no_cycle() {
        let get_chain = |id: &str| -> Option<String> {
            match id {
                "rule-b" => Some("rule-c".to_string()),
                "rule-c" => None,
                _ => None,
            }
        };
        assert!(validate_chain("rule-a", "rule-b", &get_chain).is_ok());
    }

    #[test]
    fn test_validate_chain_self_reference() {
        let get_chain = |_: &str| -> Option<String> { None };
        assert!(validate_chain("rule-a", "rule-a", &get_chain).is_err());
    }

    #[test]
    fn test_validate_chain_cycle() {
        let get_chain = |id: &str| -> Option<String> {
            match id {
                "rule-b" => Some("rule-c".to_string()),
                "rule-c" => Some("rule-a".to_string()), // Cycle back to a
                _ => None,
            }
        };
        assert!(validate_chain("rule-a", "rule-b", &get_chain).is_err());
    }

    #[test]
    fn test_evaluate_matching_rules() {
        let rules = vec![
            EvaluationRule {
                id: "r1".to_string(),
                name: "High priority".to_string(),
                is_enabled: true,
                source_type: "provider".to_string(),
                source_value: Some("slack".to_string()),
                destination_type: "webhook".to_string(),
                destination_config: "{}".to_string(),
                template: None,
                filter_event_types: Some(r#"["error"]"#.to_string()),
                filter_keywords: None,
                priority: 10,
                stop_on_match: false,
                chain_rule_id: None,
            },
            EvaluationRule {
                id: "r2".to_string(),
                name: "Catch all".to_string(),
                is_enabled: true,
                source_type: "any".to_string(),
                source_value: None,
                destination_type: "macos_push".to_string(),
                destination_config: "{}".to_string(),
                template: None,
                filter_event_types: None,
                filter_keywords: None,
                priority: 0,
                stop_on_match: false,
                chain_rule_id: None,
            },
        ];

        let notification = EvaluationNotification {
            id: "n1".to_string(),
            title: "Build failed".to_string(),
            body: Some("Exit code 1".to_string()),
            source: "slack:Acme".to_string(),
            event_type: "error".to_string(),
            provider: Some("slack".to_string()),
            account_id: Some("acc-1".to_string()),
            project: None,
            provider_author: None,
            provider_channel_name: None,
            created_at: "2024-01-15T10:00:00Z".to_string(),
        };

        let matches = evaluate_matching_rules(&rules, &notification);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].id, "r1");
        assert_eq!(matches[1].id, "r2");
    }

    #[test]
    fn test_evaluate_stop_on_match() {
        let rules = vec![
            EvaluationRule {
                id: "r1".to_string(),
                name: "Stopper".to_string(),
                is_enabled: true,
                source_type: "any".to_string(),
                source_value: None,
                destination_type: "webhook".to_string(),
                destination_config: "{}".to_string(),
                template: None,
                filter_event_types: None,
                filter_keywords: None,
                priority: 10,
                stop_on_match: true,
                chain_rule_id: None,
            },
            EvaluationRule {
                id: "r2".to_string(),
                name: "Should not match".to_string(),
                is_enabled: true,
                source_type: "any".to_string(),
                source_value: None,
                destination_type: "macos_push".to_string(),
                destination_config: "{}".to_string(),
                template: None,
                filter_event_types: None,
                filter_keywords: None,
                priority: 0,
                stop_on_match: false,
                chain_rule_id: None,
            },
        ];

        let notification = EvaluationNotification {
            id: "n1".to_string(),
            title: "Test".to_string(),
            body: None,
            source: "test".to_string(),
            event_type: "notification".to_string(),
            provider: None,
            account_id: None,
            project: None,
            provider_author: None,
            provider_channel_name: None,
            created_at: "2024-01-15T10:00:00Z".to_string(),
        };

        let matches = evaluate_matching_rules(&rules, &notification);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].id, "r1");
    }

    #[test]
    fn test_destination_config_roundtrip() {
        let config = DestinationConfig::webhook("https://example.com/hook");
        let json = config.to_json();
        let parsed = DestinationConfig::from_json(&json).unwrap();
        assert_eq!(parsed.url, Some("https://example.com/hook".to_string()));
        assert_eq!(parsed.method, Some("POST".to_string()));
    }
}
