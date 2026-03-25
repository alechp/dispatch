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
}

export interface SnippetVariable {
  name: string;
  type: "echo" | "date" | "clipboard" | "shell" | "form" | "choice" | "random";
  params: Record<string, unknown>;
}
