export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full py-20 px-4">
      <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center mb-4">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-text-tertiary"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </div>
      <p className="text-sm text-text-secondary font-medium">
        No notifications yet
      </p>
      <p className="text-xs text-text-tertiary mt-1 text-center max-w-[240px]">
        Notifications from Claude Code sessions will appear here
      </p>
    </div>
  );
}
