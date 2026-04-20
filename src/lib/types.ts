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
  // Provider integration fields
  account_id: string | null;
  provider: NotificationProvider | null;
  provider_message_id: string | null;
  provider_channel_name: string | null;
  provider_channel_id: string | null;
  provider_avatar_url: string | null;
  provider_author: string | null;
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
  provider?: NotificationProvider;
  account_id?: string;
  exclude_accounts?: string[];
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
  source_kind?: string | null;
  source_version?: string | null;
  item_count?: number | null;
  managed_key?: string | null;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

export interface EmojiPackStatus {
  managed_key: string;
  name: string;
  path: string;
  version: string;
  expected_count: number;
  installed_count: number;
  installed: boolean;
  enabled: boolean;
  file_exists: boolean;
  source: SnippetSource | null;
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

// --- Notification Banner Config ---

export type BannerScreenKey =
  | "feed/notifications"
  | "feed/sessions"
  | "telemetry"
  | "expander"
  | "settings";

export interface NotificationBannerConfig {
  globalEnabled: boolean;
  screens: Record<BannerScreenKey, boolean>;
}

export const DEFAULT_BANNER_CONFIG: NotificationBannerConfig = {
  globalEnabled: true,
  screens: {
    "feed/notifications": true,
    "feed/sessions": true,
    "telemetry": true,
    "expander": true,
    "settings": true,
  },
};

export const BANNER_SCREEN_LABELS: Record<BannerScreenKey, string> = {
  "feed/notifications": "Notifications",
  "feed/sessions": "Projects",
  "telemetry": "Analytics",
  "expander": "Text Expander",
  "settings": "Settings",
};

// --- Notification Provider Types ---

export type NotificationProvider = "discord" | "slack" | "yapture" | "terminal";

export interface NotificationAccount {
  id: string;
  provider: NotificationProvider;
  account_label: string;
  provider_user_id: string | null;
  provider_username: string | null;
  provider_avatar_url: string | null;
  provider_team_id: string | null;
  provider_team_name: string | null;
  is_enabled: boolean;
  sync_channels: string[] | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountScreenToggles {
  account_id: string;
  screens: Record<BannerScreenKey, boolean>;
}

// --- Routing Rule Types ---

export type RoutingSourceType = "account" | "provider" | "any" | "event_type" | "project";
export type RoutingDestinationType = "account" | "webhook" | "macos_push" | "routing_rule";

export interface RoutingRule {
  id: string;
  name: string;
  is_enabled: boolean;
  source_type: RoutingSourceType;
  source_value: string | null;
  destination_type: RoutingDestinationType;
  destination_config: RoutingDestinationConfig;
  template: string | null;
  filter_event_types: string[] | null;
  filter_keywords: string[] | null;
  priority: number;
  stop_on_match: boolean;
  chain_rule_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutingDestinationConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  account_id?: string;
  channel_id?: string;
  sound?: string;
  subtitle?: string;
  rule_id?: string;
}

export interface RoutingLogEntry {
  id: number;
  rule_id: string;
  notification_id: string;
  destination_type: RoutingDestinationType;
  status: "success" | "failed" | "skipped";
  error_message: string | null;
  executed_at: string;
}

// Provider-specific colors for UI
export const PROVIDER_COLORS: Record<NotificationProvider, { border: string; badge: string; text: string }> = {
  discord: { border: "border-l-indigo-500", badge: "bg-indigo-900", text: "text-indigo-400" },
  slack: { border: "border-l-emerald-500", badge: "bg-emerald-900", text: "text-emerald-400" },
  yapture: { border: "border-l-violet-500", badge: "bg-violet-900", text: "text-violet-400" },
  terminal: { border: "border-l-zinc-500", badge: "bg-zinc-700", text: "text-zinc-400" },
};
