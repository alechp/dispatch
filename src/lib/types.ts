export interface Notification {
  id: string;
  source: string;
  event_type: string;
  title: string;
  body: string | null;
  metadata: string | null;
  project: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  is_read: number;
  created_at: string;
  read_at: string | null;
  yapture_task_id: string | null;
}

export interface NotificationResponse {
  notifications: Notification[];
  total: number;
}

export interface QueryFilters {
  source?: string;
  project?: string;
  is_read?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectSession {
  project: string;
  source: string;
  last_event_type: string;
  last_title: string;
  last_body: string | null;
  last_metadata: string | null;
  last_tmux_session: string | null;
  last_tmux_window: string | null;
  last_tmux_pane: string | null;
  notification_count: number;
  unread_count: number;
  error_count: number;
  first_seen_at: string;
  last_seen_at: string;
  directory: string | null;
  git_remote: string | null;
}

export interface Snippet {
  id: string;
  trigger: string;
  label: string | null;
  body: string;
  tags: string | null;
  variables: string | null;
  is_enabled: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  source_id: string | null;
  source_type: string | null;
  is_favorite: number | null;
  source_name: string | null;
}

export interface SnippetSource {
  id: string;
  name: string;
  path: string;
  is_folder: number;
  is_enabled: number;
  auto_reload: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

export interface SnippetVariable {
  name: string;
  type: "echo" | "date" | "clipboard" | "shell" | "form" | "choice" | "random";
  params: Record<string, unknown>;
}

export interface HotkeyBinding {
  action: string;
  keys: string[];
  enabled: boolean;
  scope: "global" | "app";
  category: string;
  description: string;
}

export interface HotkeyConfig {
  bindings: HotkeyBinding[];
}
