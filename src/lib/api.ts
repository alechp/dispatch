import { invoke } from "@tauri-apps/api/core";
import type { NotificationResponse, ProjectSession, QueryFilters } from "./types";

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

export async function focusTerminal(session: string, window?: string, pane?: string): Promise<void> {
  return invoke("focus_terminal", { session, window: window ?? null, pane: pane ?? null });
}

export async function getProjectSessions(search?: string): Promise<ProjectSession[]> {
  return invoke("get_project_sessions", { search: search ?? null });
}
