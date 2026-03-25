import type { ActiveScreen } from "../App";

interface HeaderProps {
  unreadCount: number;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  activeScreen: ActiveScreen;
  onScreenChange: (screen: ActiveScreen) => void;
  onToggleHelp?: () => void;
}

export function Header({ unreadCount, onMarkAllRead, onClearAll, activeScreen, onScreenChange, onToggleHelp }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface" data-tauri-drag-region>
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <h1 className="text-sm font-semibold text-text-primary" data-tauri-drag-region>
          Dispatch
        </h1>
        {unreadCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-[11px] font-medium rounded-full bg-accent text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onScreenChange(activeScreen === "sessions" ? "feed" : "sessions")}
          className={`p-1.5 rounded-md hover:bg-surface-overlay transition-colors ${
            activeScreen === "sessions" ? "text-accent" : "text-text-tertiary hover:text-text-primary"
          }`}
          title="Sessions"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        </button>
        <button
          onClick={() => onScreenChange(activeScreen === "telemetry" ? "feed" : "telemetry")}
          className={`p-1.5 rounded-md hover:bg-surface-overlay transition-colors ${
            activeScreen === "telemetry" ? "text-accent" : "text-text-tertiary hover:text-text-primary"
          }`}
          title="Analytics"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </button>
        <button
          onClick={() => onScreenChange(activeScreen === "expander" ? "feed" : "expander")}
          className={`p-1.5 rounded-md hover:bg-surface-overlay transition-colors ${
            activeScreen === "expander" ? "text-accent" : "text-text-tertiary hover:text-text-primary"
          }`}
          title="Text Expander"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </button>
        <button
          onClick={() => onScreenChange(activeScreen === "settings" ? "feed" : "settings")}
          className={`p-1.5 rounded-md hover:bg-surface-overlay transition-colors ${
            activeScreen === "settings" ? "text-accent" : "text-text-tertiary hover:text-text-primary"
          }`}
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {onToggleHelp && (
          <button
            onClick={onToggleHelp}
            className="p-1.5 text-text-tertiary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors"
            title="Keyboard shortcuts"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <line x1="6" y1="10" x2="6" y2="10" />
              <line x1="10" y1="10" x2="10" y2="10" />
              <line x1="14" y1="10" x2="14" y2="10" />
              <line x1="18" y1="10" x2="18" y2="10" />
              <line x1="8" y1="14" x2="16" y2="14" />
            </svg>
          </button>
        )}
        <button
          onClick={onMarkAllRead}
          className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors"
          title="Mark all as read"
        >
          Read All
        </button>
        <button
          onClick={onClearAll}
          className="px-2.5 py-1 text-xs text-text-tertiary hover:text-error rounded-md hover:bg-surface-overlay transition-colors"
          title="Clear all notifications"
        >
          Clear
        </button>
      </div>
    </header>
  );
}
