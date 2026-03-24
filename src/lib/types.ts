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
}
