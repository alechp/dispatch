import { useState, useEffect } from "react";
import { useProjectSessions } from "../hooks/useProjectSessions";
import type { ProjectSession } from "../lib/types";

type ViewMode = "list" | "cards";

interface SessionTrackerProps {
  onBack: () => void;
  onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
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

function statusDotColor(eventType: string): string {
  if (eventType === "error") return "bg-error";
  if (eventType === "warning") return "bg-warning";
  if (eventType === "stop" || eventType.includes("success")) return "bg-success";
  return "bg-accent";
}

function formatGitRemote(remote: string): string {
  let cleaned = remote.replace(/\.git$/, "");
  cleaned = cleaned.replace(/^git@([^:]+):/, "$1/");
  cleaned = cleaned.replace(/^https?:\/\//, "");
  return cleaned;
}

function formatDirectory(dir: string): string {
  const home = "/Users/";
  let display = dir;
  if (display.startsWith(home)) {
    const afterHome = display.substring(home.length);
    const slashIdx = afterHome.indexOf("/");
    if (slashIdx >= 0) {
      display = "~" + afterHome.substring(slashIdx);
    }
  }
  const parts = display.split("/");
  if (parts.length > 4) {
    return ".../" + parts.slice(-3).join("/");
  }
  return display;
}

export function SessionTracker({ onBack, onFocusTerminal }: SessionTrackerProps) {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem("dispatch:session-view-mode") as ViewMode) || "cards"
  );
  const { sessions, loading } = useProjectSessions(search || undefined);

  useEffect(() => {
    localStorage.setItem("dispatch:session-view-mode", viewMode);
  }, [viewMode]);

  return (
    <div className="flex flex-col h-screen bg-surface">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors shrink-0"
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
        <div className="flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full text-xs bg-surface-overlay border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
        {/* View toggle */}
        <div className="flex rounded-md overflow-hidden border border-border-subtle shrink-0">
          <button
            onClick={() => setViewMode("list")}
            aria-pressed={viewMode === "list"}
            className={`p-1.5 transition-colors ${
              viewMode === "list"
                ? "bg-accent text-white"
                : "bg-surface-overlay text-text-secondary hover:text-text-primary"
            }`}
            title="List view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <button
            onClick={() => setViewMode("cards")}
            aria-pressed={viewMode === "cards"}
            className={`p-1.5 transition-colors ${
              viewMode === "cards"
                ? "bg-accent text-white"
                : "bg-surface-overlay text-text-secondary hover:text-text-primary"
            }`}
            title="Card view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-tertiary">Loading sessions...</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-surface-raised border border-border-subtle flex items-center justify-center">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-text-tertiary"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
            </div>
            <p className="text-sm text-text-secondary">No projects tracked yet.</p>
            <p className="text-xs text-text-tertiary mt-1">Sessions appear when notifications arrive.</p>
          </div>
        </div>
      ) : viewMode === "list" ? (
        <div className="flex-1 overflow-y-auto">
          {sessions.map((session) => (
            <SessionRow
              key={`${session.project}-${session.source}`}
              session={session}
              onFocusTerminal={onFocusTerminal}
            />
          ))}
          <div className="h-4" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sessions.map((session) => (
              <ProjectCard
                key={`${session.project}-${session.source}`}
                session={session}
                onFocusTerminal={onFocusTerminal}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onFocusTerminal,
}: {
  session: ProjectSession;
  onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
}) {
  const isClickable = session.last_tmux_session !== null;

  return (
    <div
      className={`px-4 py-3 border-b border-border-subtle transition-colors ${
        isClickable
          ? "cursor-pointer hover:bg-surface-overlay"
          : ""
      }`}
      onClick={() => {
        if (isClickable) {
          onFocusTerminal(
            "",
            session.last_tmux_session!,
            session.last_tmux_window,
            session.last_tmux_pane
          );
        }
      }}
    >
      {/* Row 1: project name + time */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary truncate">
          {session.project}
        </h3>
        <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
          {timeAgo(session.last_seen_at)}
        </span>
      </div>

      {/* Row 2: status dot + last title + source */}
      <div className="flex items-center gap-2 mt-1">
        <div className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor(session.last_event_type)}`} />
        <span className="text-xs text-text-secondary truncate flex-1">
          {session.last_title}
        </span>
        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary shrink-0">
          {session.source}
        </span>
      </div>

      {/* Row 3: stats */}
      <div className="flex items-center gap-1 mt-1.5">
        <span className="text-[11px] text-text-tertiary">
          {session.notification_count} total
        </span>
        <span className="text-[11px] text-text-tertiary">&middot;</span>
        <span className={`text-[11px] ${session.unread_count > 0 ? "text-accent font-medium" : "text-text-tertiary"}`}>
          {session.unread_count} unread
        </span>
        <span className="text-[11px] text-text-tertiary">&middot;</span>
        <span className={`text-[11px] ${session.error_count > 0 ? "text-error font-medium" : "text-text-tertiary"}`}>
          {session.error_count} errors
        </span>
      </div>
    </div>
  );
}

function ProjectCard({
  session,
  onFocusTerminal,
}: {
  session: ProjectSession;
  onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
}) {
  const isClickable = session.last_tmux_session !== null;
  const hasMetadata = session.directory !== null || session.git_remote !== null;

  return (
    <div
      className={`bg-surface-raised border border-border-subtle rounded-lg p-4 transition-colors ${
        isClickable ? "cursor-pointer hover:border-accent/30" : ""
      }`}
      onClick={() => {
        if (isClickable) {
          onFocusTerminal(
            "",
            session.last_tmux_session!,
            session.last_tmux_window,
            session.last_tmux_pane
          );
        }
      }}
    >
      {/* Header: status dot + name + time */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor(session.last_event_type)}`} />
          <h3 className="text-sm font-semibold text-text-primary truncate">
            {session.project}
          </h3>
        </div>
        <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
          {timeAgo(session.last_seen_at)}
        </span>
      </div>

      {/* Source badge */}
      <div className="mt-1">
        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary">
          {session.source}
        </span>
      </div>

      {/* Metadata section */}
      {hasMetadata && (
        <div className="mt-2 pt-2 border-t border-border-subtle space-y-1">
          {session.directory && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="truncate">{formatDirectory(session.directory)}</span>
            </div>
          )}
          {session.git_remote && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <circle cx="12" cy="12" r="4" />
                <line x1="1.05" y1="12" x2="7" y2="12" />
                <line x1="17.01" y1="12" x2="22.96" y2="12" />
              </svg>
              <span className="truncate text-accent/80">{formatGitRemote(session.git_remote)}</span>
            </div>
          )}
        </div>
      )}

      {/* Last title */}
      <div className={`${hasMetadata ? "mt-2 pt-2 border-t border-border-subtle" : "mt-2"}`}>
        <p className="text-xs text-text-secondary truncate">
          {session.last_title}
        </p>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border-subtle">
        <span className="text-[11px] text-text-tertiary">
          {session.notification_count} total
        </span>
        <span className="text-[11px] text-text-tertiary">&middot;</span>
        <span className={`text-[11px] ${session.unread_count > 0 ? "text-accent font-medium" : "text-text-tertiary"}`}>
          {session.unread_count} unread
        </span>
        <span className="text-[11px] text-text-tertiary">&middot;</span>
        <span className={`text-[11px] ${session.error_count > 0 ? "text-error font-medium" : "text-text-tertiary"}`}>
          {session.error_count} errors
        </span>
      </div>
    </div>
  );
}
