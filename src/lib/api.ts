import { invoke } from "@tauri-apps/api/core";
import type { NotificationResponse, ProjectSession, QueryFilters, HotkeyConfig, NotificationBannerConfig } from "./types";
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
