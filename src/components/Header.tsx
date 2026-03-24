interface HeaderProps {
  unreadCount: number;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  onToggleTelemetry?: () => void;
}

export function Header({ unreadCount, onMarkAllRead, onClearAll, onToggleTelemetry }: HeaderProps) {
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
        {onToggleTelemetry && (
          <button
            onClick={onToggleTelemetry}
            className="p-1.5 text-text-tertiary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors"
            title="Analytics"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
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
