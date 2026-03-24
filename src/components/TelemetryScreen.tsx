import { useState, useMemo } from "react";
import { useTelemetry } from "../hooks/useTelemetry";

interface TelemetryScreenProps {
  onBack: () => void;
}

type TimeRange = "today" | "7d" | "30d" | "all";

const TIME_RANGE_OPTIONS: { key: TimeRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "all", label: "All time" },
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatHour(hour: number): string {
  if (hour === 0) return "12:00 AM";
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return "12:00 PM";
  return `${hour - 12}:00 PM`;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getTimeRange(range: TimeRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();

  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case "7d": {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { from: start.toISOString(), to };
    }
    case "30d": {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { from: start.toISOString(), to };
    }
    case "all":
      return { from: "2000-01-01T00:00:00Z", to };
  }
}

function eventTypeLabel(eventType: string): string {
  return eventType.replace(/_/g, " ");
}

function eventTypeColor(eventType: string): string {
  switch (eventType) {
    case "notification_received":
      return "bg-accent";
    case "notification_read":
      return "bg-success";
    case "notification_deleted":
      return "bg-error";
    case "terminal_focused":
      return "bg-warning";
    case "app_shown":
    case "app_hidden":
      return "bg-text-tertiary";
    default:
      return "bg-accent";
  }
}

function formatDayLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}/${day}`;
}

export function TelemetryScreen({ onBack }: TelemetryScreenProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  const { from, to } = useMemo(() => getTimeRange(timeRange), [timeRange]);
  const { summary, recentEvents, loading } = useTelemetry(from, to);

  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-surface">
        <TopBar onBack={onBack} timeRange={timeRange} onTimeRangeChange={setTimeRange} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-tertiary">Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex flex-col h-screen bg-surface">
        <TopBar onBack={onBack} timeRange={timeRange} onTimeRangeChange={setTimeRange} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-tertiary">No telemetry data available.</p>
        </div>
      </div>
    );
  }

  const maxDayCount = Math.max(...summary.events_by_day.map(([, c]) => c), 1);
  const maxSourceCount = Math.max(...summary.top_sources.map(([, c]) => c), 1);
  const totalReads = summary.reads_by_method.reduce((sum, [, c]) => sum + c, 0) || 1;

  return (
    <div className="flex flex-col h-screen bg-surface">
      <TopBar onBack={onBack} timeRange={timeRange} onTimeRangeChange={setTimeRange} />

      <div className="flex-1 overflow-y-auto">
        {/* Stat Cards */}
        <div className="grid grid-cols-3 gap-2 p-4">
          <StatCard value={summary.total_received} label="Received" />
          <StatCard value={summary.total_read} label="Read" />
          <StatCard value={summary.total_terminal_focuses} label="Focused" />
        </div>

        {/* Secondary Stats */}
        <div className="grid grid-cols-2 gap-2 px-4 pb-4">
          <div className="rounded-lg bg-surface-raised border border-border-subtle p-3">
            <p className="text-lg font-semibold text-text-primary">
              {summary.avg_time_to_read_seconds != null
                ? formatDuration(summary.avg_time_to_read_seconds)
                : "--"}
            </p>
            <p className="text-[11px] text-text-tertiary mt-0.5">Avg. time to read</p>
          </div>
          <div className="rounded-lg bg-surface-raised border border-border-subtle p-3">
            <p className="text-lg font-semibold text-text-primary">
              {summary.busiest_hour != null ? formatHour(summary.busiest_hour) : "--"}
            </p>
            <p className="text-[11px] text-text-tertiary mt-0.5">Busiest hour</p>
          </div>
        </div>

        {/* Activity Chart */}
        {summary.events_by_day.length > 0 && (
          <div className="px-4 pb-4">
            <h2 className="text-xs font-semibold text-text-secondary mb-2">Activity</h2>
            <div className="rounded-lg bg-surface-raised border border-border-subtle p-3">
              <div className="flex items-end gap-[3px]" style={{ height: 120 }}>
                {summary.events_by_day.map(([day, count]) => {
                  const heightPct = (count / maxDayCount) * 100;
                  return (
                    <div key={day} className="flex-1 flex flex-col items-center justify-end h-full">
                      <div
                        className="w-full bg-accent rounded-t-sm min-h-[2px] transition-all"
                        style={{ height: `${heightPct}%` }}
                        title={`${day}: ${count}`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-[3px] mt-1">
                {summary.events_by_day.map(([day], i) => (
                  <div key={day} className="flex-1 text-center">
                    {i === 0 || i === summary.events_by_day.length - 1 || summary.events_by_day.length <= 7 ? (
                      <span className="text-[9px] text-text-tertiary">{formatDayLabel(day)}</span>
                    ) : i % Math.ceil(summary.events_by_day.length / 7) === 0 ? (
                      <span className="text-[9px] text-text-tertiary">{formatDayLabel(day)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Top Sources */}
        {summary.top_sources.length > 0 && (
          <div className="px-4 pb-4">
            <h2 className="text-xs font-semibold text-text-secondary mb-2">Top Sources</h2>
            <div className="rounded-lg bg-surface-raised border border-border-subtle p-3 space-y-2">
              {summary.top_sources.map(([source, count]) => {
                const widthPct = (count / maxSourceCount) * 100;
                return (
                  <div key={source}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-text-primary truncate">{source}</span>
                      <span className="text-[11px] text-text-tertiary ml-2 shrink-0">{count}</span>
                    </div>
                    <div className="w-full h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-r-full transition-all"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* How You Read */}
        {summary.reads_by_method.length > 0 && (
          <div className="px-4 pb-4">
            <h2 className="text-xs font-semibold text-text-secondary mb-2">How You Read</h2>
            <div className="rounded-lg bg-surface-raised border border-border-subtle p-3 space-y-1.5">
              {summary.reads_by_method.map(([method, count]) => {
                const pct = Math.round((count / totalReads) * 100);
                return (
                  <div key={method} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
                    <span className="text-xs text-text-primary flex-1 truncate">
                      {method.replace(/_/g, " ")}
                    </span>
                    <span className="text-[11px] text-text-tertiary shrink-0">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent Events */}
        {recentEvents.length > 0 && (
          <div className="px-4 pb-4">
            <h2 className="text-xs font-semibold text-text-secondary mb-2">Recent Events</h2>
            <div className="rounded-lg bg-surface-raised border border-border-subtle overflow-hidden">
              {recentEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle last:border-b-0"
                >
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${eventTypeColor(event.event_type)}`} />
                  <span className="text-xs text-text-primary truncate flex-1">
                    {eventTypeLabel(event.event_type)}
                  </span>
                  {event.source && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary shrink-0">
                      {event.source}
                    </span>
                  )}
                  <span className="text-[10px] text-text-tertiary whitespace-nowrap shrink-0">
                    {timeAgo(event.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bottom spacer */}
        <div className="h-4" />
      </div>
    </div>
  );
}

function TopBar({
  onBack,
  timeRange,
  onTimeRangeChange,
}: {
  onBack: () => void;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>
      <select
        value={timeRange}
        onChange={(e) => onTimeRangeChange(e.target.value as TimeRange)}
        className="text-[11px] bg-surface-overlay border border-border-subtle rounded-md px-2 py-1 text-text-secondary focus:outline-none focus:border-accent transition-colors cursor-pointer"
      >
        {TIME_RANGE_OPTIONS.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg bg-surface-raised border border-border-subtle p-3 text-center">
      <p className="text-xl font-bold text-text-primary">{value.toLocaleString()}</p>
      <p className="text-[11px] text-text-tertiary mt-0.5">{label}</p>
    </div>
  );
}
