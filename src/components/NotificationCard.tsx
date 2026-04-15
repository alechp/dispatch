import { useEffect, useRef } from "react";
import type { Notification, NotificationProvider } from "../lib/types";
import { PROVIDER_COLORS } from "../lib/types";

interface NotificationCardProps {
  notification: Notification;
  onMarkRead: (id: string) => void;
  onDelete: (id: string) => void;
  onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
  isSelected?: boolean;
  isVisualSelected?: boolean;
  index: number;
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

function displayTitle(n: Notification): string {
  if (n.tmux_window) {
    const action = n.title.includes(" — ") ? n.title.split(" — ").slice(1).join(" — ") : n.title;
    // Use project as pane name (more meaningful than numeric pane id)
    const paneName = n.project || n.tmux_pane;
    const location = paneName ? `${n.tmux_window} > ${paneName}` : n.tmux_window;
    return `${location} : ${action}`;
  }
  return n.title;
}

function eventColor(eventType: string): string {
  switch (eventType) {
    case "error":
      return "bg-error";
    case "stop":
      return "bg-success";
    case "warning":
      return "bg-warning";
    default:
      return "bg-accent";
  }
}

export function NotificationCard({
  notification: n,
  onMarkRead,
  onDelete,
  onFocusTerminal,
  isSelected = false,
  isVisualSelected = false,
  index,
}: NotificationCardProps) {
  const isUnread = n.is_read === 0;
  const cardRef = useRef<HTMLDivElement>(null);
  const providerColors = n.provider ? PROVIDER_COLORS[n.provider as NotificationProvider] : null;

  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isSelected]);

  // Provider-colored left border when not in visual/selected mode
  const borderClass = isVisualSelected
    ? "bg-accent/20 border-l-2 border-l-warning"
    : isSelected
      ? "bg-accent/10 border-l-2 border-l-accent"
      : providerColors
        ? `${isUnread ? "bg-surface-raised" : "bg-surface"} border-l-2 ${providerColors.border}`
        : isUnread
          ? "bg-surface-raised"
          : "bg-surface";

  return (
    <div
      ref={cardRef}
      className={`group relative px-4 py-3 border-b border-border-subtle transition-colors ${borderClass} hover:bg-surface-overlay`}
      onClick={() => isUnread && onMarkRead(n.id)}
    >
      <div className="flex items-start gap-3">
        {/* Index + unread indicator or provider avatar */}
        <div className="flex flex-col items-center shrink-0 pt-0.5" style={{ minWidth: 20 }}>
          {isVisualSelected ? (
            <div className="w-3.5 h-3.5 rounded border border-accent bg-accent flex items-center justify-center">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          ) : n.provider_avatar_url ? (
            <img
              src={n.provider_avatar_url}
              alt=""
              className="w-5 h-5 rounded-full"
            />
          ) : (
            <div
              className={`w-2 h-2 rounded-full ${
                isUnread ? eventColor(n.event_type) : "bg-transparent"
              }`}
            />
          )}
          <span className="text-[9px] text-text-tertiary mt-0.5 leading-none">{index + 1}</span>
        </div>

        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-center justify-between gap-2">
            <h3
              className={`text-sm truncate ${
                isUnread
                  ? "font-semibold text-text-primary"
                  : "font-normal text-text-secondary"
              }`}
            >
              {displayTitle(n)}
            </h3>
            <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
              {timeAgo(n.created_at)}
            </span>
          </div>

          {/* Body */}
          {n.body && (
            <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">
              {n.body}
            </p>
          )}

          {/* Provider author line */}
          {n.provider_author && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className={`text-[10px] font-medium ${providerColors?.text ?? "text-text-tertiary"}`}>
                {n.provider_author}
              </span>
              {n.provider_channel_name && (
                <>
                  <span className="text-[10px] text-text-tertiary">in</span>
                  <span className="text-[10px] text-text-secondary">{n.provider_channel_name}</span>
                </>
              )}
            </div>
          )}

          {/* Tags */}
          <div className="flex items-center gap-1.5 mt-1.5">
            {/* Provider badge (styled) or source badge */}
            {n.provider && providerColors ? (
              <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${providerColors.badge} ${providerColors.text}`}>
                {n.provider}
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary">
                {n.source}
              </span>
            )}
            {n.event_type !== "notification" && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary">
                {n.event_type}
              </span>
            )}
            {n.project && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary truncate max-w-[120px]">
                {n.project}
              </span>
            )}
            {n.tmux_session && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary truncate max-w-[200px]">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                {n.tmux_session}
                {n.tmux_window && (
                  <>
                    <span className="opacity-40">›</span>
                    {n.tmux_window}
                  </>
                )}
                {n.tmux_pane && (
                  <>
                    <span className="opacity-40">›</span>
                    {n.tmux_pane}
                  </>
                )}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          {n.tmux_session && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFocusTerminal(n.id, n.tmux_session!, n.tmux_window, n.tmux_pane);
              }}
              className="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-accent rounded transition-all"
              title="Focus terminal"
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
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(n.id);
            }}
            className="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-error rounded transition-all"
            title="Delete"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
