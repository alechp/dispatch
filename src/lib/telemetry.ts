import { invoke } from "@tauri-apps/api/core";

export type TelemetryEventType =
  | "notification_received"
  | "notification_read"
  | "notification_deleted"
  | "terminal_focused"
  | "app_shown"
  | "app_hidden"
  | "search_performed"
  | "filter_changed"
  | "clear_all";

export async function trackEvent(
  eventType: TelemetryEventType,
  opts?: {
    targetId?: string;
    source?: string;
    project?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  return invoke("record_telemetry_event", {
    eventType,
    targetId: opts?.targetId ?? null,
    source: opts?.source ?? null,
    project: opts?.project ?? null,
    metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
  });
}

export interface TelemetrySummary {
  total_received: number;
  total_read: number;
  total_deleted: number;
  total_terminal_focuses: number;
  total_app_opens: number;
  avg_time_to_read_seconds: number | null;
  busiest_hour: number | null;
  top_sources: [string, number][];
  events_by_day: [string, number][];
  reads_by_method: [string, number][];
}

export interface TelemetryEvent {
  id: number;
  event_type: string;
  target_id: string | null;
  source: string | null;
  project: string | null;
  metadata: string | null;
  created_at: string;
}

export async function getTelemetrySummary(from: string, to: string): Promise<TelemetrySummary> {
  return invoke("get_telemetry_summary", { from, to });
}

export async function getTelemetryEvents(
  opts?: { eventType?: string; from?: string; to?: string; limit?: number }
): Promise<TelemetryEvent[]> {
  return invoke("get_telemetry", {
    eventType: opts?.eventType ?? null,
    from: opts?.from ?? null,
    to: opts?.to ?? null,
    limit: opts?.limit ?? null,
  });
}
