import { invoke } from "@tauri-apps/api/core";
import type { NotificationResponse, ProjectSession, QueryFilters, HotkeyConfig, NotificationBannerConfig, NotificationAccount, AccountScreenToggles, RoutingRule, RoutingLogEntry } from "./types";
import { DEFAULT_BANNER_CONFIG } from "./types";

export async function getNotifications(
  filters: QueryFilters = {}
): Promise<NotificationResponse> {
  return invoke("get_notifications", { ...filters });
}

export async function markRead(id: string): Promise<boolean> {
  return invoke("mark_notification_read", { id });
}

export async function markAllRead(): Promise<number> {
  return invoke("mark_all_notifications_read");
}

export async function deleteNotification(id: string): Promise<boolean> {
  return invoke("delete_notification", { id });
}

export async function clearAll(): Promise<number> {
  return invoke("clear_all_notifications");
}

export async function getUnreadCount(): Promise<number> {
  return invoke("get_unread_count");
}

export async function focusTerminal(session: string, window?: string, pane?: string, notificationId?: string): Promise<void> {
  return invoke("focus_terminal", { session, window: window ?? null, pane: pane ?? null, notificationId: notificationId ?? null });
}

export async function getProjectSessions(search?: string): Promise<ProjectSession[]> {
  return invoke("get_project_sessions", { search: search ?? null });
}

export async function updateProjectMetadata(
  project: string,
  source: string,
  directory?: string,
  gitRemote?: string,
): Promise<void> {
  return invoke("update_project_metadata", {
    project,
    source,
    directory: directory ?? null,
    gitRemote: gitRemote ?? null,
  });
}

export async function getHotkeyConfig(): Promise<HotkeyConfig> {
  return invoke("get_hotkey_config");
}

export async function setHotkeyConfig(config: HotkeyConfig): Promise<void> {
  return invoke("set_hotkey_config", { config });
}

export async function getYaptureSyncEnabled(): Promise<boolean> {
  return invoke("get_yapture_sync_enabled");
}

export async function setYaptureSyncEnabled(enabled: boolean): Promise<void> {
  return invoke("set_yapture_sync_enabled", { enabled });
}

export async function getNotificationBannerConfig(): Promise<NotificationBannerConfig> {
  try {
    const json: string = await invoke("get_notification_banner_config");
    return JSON.parse(json);
  } catch {
    return DEFAULT_BANNER_CONFIG;
  }
}

export async function setNotificationBannerConfig(config: NotificationBannerConfig): Promise<void> {
  return invoke("set_notification_banner_config", { configJson: JSON.stringify(config) });
}

export async function detectYaptureVersion(): Promise<string> {
  return invoke<string>("yapture_detect_version");
}

// ── Yapture v2 API ──────────────────────────────────────────────────

export interface YaptureV2Status {
  connected: boolean;
  enabled: boolean;
  userName: string | null;
  userEmail: string | null;
  apiUrl: string;
  authUrl: string;
}

export async function yaptureV2StartOAuth(): Promise<string> {
  return invoke<string>("yapture_v2_start_oauth");
}

export async function yaptureV2Disconnect(): Promise<void> {
  return invoke("yapture_v2_disconnect");
}

export async function getYaptureV2Status(): Promise<YaptureV2Status> {
  return invoke<YaptureV2Status>("get_yapture_v2_status");
}

export async function setYaptureV2Config(config: {
  apiUrl?: string;
  authUrl?: string;
  enabled?: boolean;
}): Promise<void> {
  return invoke("set_yapture_v2_config", config);
}

export async function testYaptureV2Connection(): Promise<boolean> {
  return invoke<boolean>("test_yapture_v2_connection");
}

// ── Notification Accounts API ───────────────────────────────────────

export async function listNotificationAccounts(): Promise<NotificationAccount[]> {
  return invoke("list_notification_accounts");
}

export async function getNotificationAccount(id: string): Promise<NotificationAccount> {
  return invoke("get_notification_account", { id });
}

export async function updateNotificationAccountLabel(id: string, label: string): Promise<void> {
  return invoke("update_notification_account_label", { id, label });
}

export async function toggleNotificationAccount(id: string, enabled: boolean): Promise<void> {
  return invoke("toggle_notification_account", { id, enabled });
}

export async function deleteNotificationAccount(id: string): Promise<void> {
  return invoke("delete_notification_account", { id });
}

export async function getAccountScreenToggles(accountId: string): Promise<AccountScreenToggles> {
  return invoke("get_account_screen_toggles", { accountId });
}

export async function setAccountScreenToggle(accountId: string, screen: string, visible: boolean): Promise<void> {
  return invoke("set_account_screen_toggle", { accountId, screen, visible });
}

export async function setMonitoredChannels(accountId: string, channels: string): Promise<void> {
  return invoke("set_monitored_channels", { accountId, channels });
}

export async function testAccountConnection(id: string): Promise<string> {
  return invoke("test_account_connection", { id });
}

// ── Discord API ─────────────────────────────────────────────────────

export async function discordStartOAuth(clientId: string): Promise<string> {
  return invoke("discord_start_oauth", { clientId });
}

export interface DiscordChannel {
  id: string;
  name: string;
  channel_type: number;
}

export async function discordFetchChannels(accountId: string): Promise<DiscordChannel[]> {
  return invoke("discord_fetch_channels", { accountId });
}

// ── Slack API ───────────────────────────────────────────────────────

export async function slackStartOAuth(clientId: string, relayUrl: string): Promise<string> {
  return invoke("slack_start_oauth", { clientId, relayUrl });
}

export interface SlackConversation {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
}

export async function slackFetchConversations(accountId: string): Promise<SlackConversation[]> {
  return invoke("slack_fetch_conversations", { accountId });
}

// ── Slack Relay API ─────────────────────────────────────────────────

export interface SlackRelayStatus {
  is_running: boolean;
  last_poll: string | null;
  relay_url: string | null;
  poll_interval: number;
}

export async function slackRelaySaveConfig(relayUrl: string, apiKey: string, pollInterval?: number): Promise<void> {
  return invoke("slack_relay_save_config", { relayUrl, apiKey, pollInterval: pollInterval ?? null });
}

export async function slackRelayTestConnection(relayUrl: string): Promise<string> {
  return invoke("slack_relay_test_connection", { relayUrl });
}

export async function slackRelayStartPolling(): Promise<void> {
  return invoke("slack_relay_start_polling");
}

export async function slackRelayStopPolling(): Promise<void> {
  return invoke("slack_relay_stop_polling");
}

export async function slackRelayStatus(): Promise<SlackRelayStatus> {
  return invoke("slack_relay_status");
}

// ── Discord Relay API ───────────────────────────────────────────────

export interface DiscordRelayStatus {
  is_running: boolean;
  last_poll: string | null;
  relay_url: string | null;
  poll_interval: number;
}

export async function discordRelaySaveConfig(relayUrl: string, apiKey: string, pollInterval?: number): Promise<void> {
  return invoke("discord_relay_save_config", { relayUrl, apiKey, pollInterval: pollInterval ?? null });
}

export async function discordRelayTestConnection(relayUrl: string): Promise<string> {
  return invoke("discord_relay_test_connection", { relayUrl });
}

export async function discordRelayStartPolling(): Promise<void> {
  return invoke("discord_relay_start_polling");
}

export async function discordRelayStopPolling(): Promise<void> {
  return invoke("discord_relay_stop_polling");
}

export async function discordRelayStatus(): Promise<DiscordRelayStatus> {
  return invoke("discord_relay_status");
}

// ── Routing Rules API ───────────────────────────────────────────────

export async function listRoutingRules(): Promise<RoutingRule[]> {
  return invoke("list_routing_rules");
}

export async function getRoutingRule(id: string): Promise<RoutingRule> {
  return invoke("get_routing_rule", { id });
}

export async function createRoutingRule(rule: Omit<RoutingRule, "id" | "created_at" | "updated_at">): Promise<string> {
  return invoke("create_routing_rule", {
    name: rule.name,
    sourceType: rule.source_type,
    sourceValue: rule.source_value ?? null,
    destinationType: rule.destination_type,
    destinationConfig: JSON.stringify(rule.destination_config),
    template: rule.template ?? null,
    filterEventTypes: rule.filter_event_types ? JSON.stringify(rule.filter_event_types) : null,
    filterKeywords: rule.filter_keywords ? JSON.stringify(rule.filter_keywords) : null,
    priority: rule.priority,
    stopOnMatch: rule.stop_on_match,
    chainRuleId: rule.chain_rule_id ?? null,
  });
}

export async function updateRoutingRule(id: string, updates: Partial<RoutingRule>): Promise<void> {
  return invoke("update_routing_rule", {
    id,
    name: updates.name ?? null,
    sourceType: updates.source_type ?? null,
    sourceValue: updates.source_value ?? null,
    destinationType: updates.destination_type ?? null,
    destinationConfig: updates.destination_config ? JSON.stringify(updates.destination_config) : null,
    template: updates.template ?? null,
    filterEventTypes: updates.filter_event_types ? JSON.stringify(updates.filter_event_types) : null,
    filterKeywords: updates.filter_keywords ? JSON.stringify(updates.filter_keywords) : null,
    priority: updates.priority ?? null,
    stopOnMatch: updates.stop_on_match ?? null,
    chainRuleId: updates.chain_rule_id ?? null,
  });
}

export async function deleteRoutingRule(id: string): Promise<void> {
  return invoke("delete_routing_rule", { id });
}

export async function toggleRoutingRule(id: string, enabled: boolean): Promise<void> {
  return invoke("toggle_routing_rule", { id, enabled });
}

export async function testRoutingRule(id: string): Promise<string> {
  return invoke("test_routing_rule", { id });
}

export async function getRoutingLog(limit?: number): Promise<RoutingLogEntry[]> {
  return invoke("get_routing_log", { limit: limit ?? 50 });
}

export async function validateRoutingChain(ruleId: string): Promise<string> {
  return invoke("validate_routing_chain", { ruleId });
}

// ── macOS Push Notifications API ────────────────────────────────────

export interface MacOSPushConfig {
  enabled: boolean;
  sound: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  suppress_when_focused: boolean;
}

export async function getMacosPushConfig(): Promise<MacOSPushConfig> {
  const json: string = await invoke("get_macos_push_config");
  return JSON.parse(json);
}

export async function setMacosPushConfig(config: MacOSPushConfig): Promise<void> {
  return invoke("set_macos_push_config", { configJson: JSON.stringify(config) });
}

export async function sendTestPush(): Promise<void> {
  return invoke("send_test_push");
}
