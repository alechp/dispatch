import { useEffect, useState, useCallback, useRef } from "react";
import type { Notification } from "../lib/types";

interface NotificationBannerProps {
  /** Queue of notifications to display, newest first. */
  queue: Notification[];
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
  onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
  onViewInFeed: () => void;
}

export function NotificationBanner({
  queue,
  onDismiss,
  onDismissAll,
  onFocusTerminal,
  onViewInFeed,
}: NotificationBannerProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const focusedRef = useRef(document.hasFocus());

  const current = queue[0] ?? null;
  const remaining = queue.length - 1;

  // Track window focus
  useEffect(() => {
    const onFocus = () => { focusedRef.current = true; };
    const onBlur = () => { focusedRef.current = false; };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Show/hide and start auto-dismiss timer only when window is focused
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    if (!current) {
      setVisible(false);
      return;
    }

    setVisible(true);

    const startTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setVisible(false);
        setTimeout(() => onDismiss(current.id), 200);
      }, 3000);
    };

    // Start timer immediately if focused, otherwise wait for focus
    if (focusedRef.current) {
      startTimer();
    }

    const onFocusStart = () => {
      // Only start if this notification is still current
      if (!timerRef.current) {
        startTimer();
      }
    };

    window.addEventListener("focus", onFocusStart);
    return () => {
      window.removeEventListener("focus", onFocusStart);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [current, onDismiss]);

  const handleDismissCurrent = useCallback(() => {
    if (!current) return;
    setVisible(false);
    setTimeout(() => onDismiss(current.id), 200);
  }, [current, onDismiss]);

  const handleFocus = useCallback(() => {
    if (!current?.tmux_session) return;
    onFocusTerminal(
      current.id,
      current.tmux_session,
      current.tmux_window,
      current.tmux_pane
    );
    setVisible(false);
    setTimeout(() => onDismiss(current.id), 200);
  }, [current, onFocusTerminal, onDismiss]);

  const handleView = useCallback(() => {
    onViewInFeed();
    onDismissAll();
    setVisible(false);
  }, [onViewInFeed, onDismissAll]);

  if (!current) return null;

  const eventColor =
    current.event_type === "error"
      ? "border-error/30"
      : current.event_type === "warning"
        ? "border-warning/30"
        : "border-accent/30";

  return (
    <div
      className={`fixed bottom-14 left-2 right-2 z-[90] transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
      }`}
    >
      <div
        className={`bg-surface-raised border ${eventColor} rounded-lg shadow-xl px-3 py-2.5`}
      >
        {/* Header: source + queue count + close */}
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {current.project && (
              <span className="text-[10px] font-medium text-accent truncate">
                {current.project}
              </span>
            )}
            <span className="inline-flex items-center px-1 py-0.5 text-[9px] font-medium rounded bg-surface-overlay text-text-tertiary shrink-0">
              {current.source}
            </span>
            {remaining > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium rounded-full bg-accent/20 text-accent shrink-0">
                +{remaining} more
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {queue.length > 1 && (
              <button
                onClick={onDismissAll}
                className="px-1.5 py-0.5 text-[9px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                Clear all
              </button>
            )}
            <button
              onClick={handleDismissCurrent}
              className="p-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Title */}
        <p className="text-xs text-text-primary truncate">{current.title}</p>

        {/* Body preview */}
        {current.body && (
          <p className="text-[11px] text-text-secondary truncate mt-0.5">
            {current.body}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-2">
          {current.tmux_session && (
            <button
              onClick={handleFocus}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-accent bg-accent/10 rounded hover:bg-accent/20 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              Focus Terminal
            </button>
          )}
          <button
            onClick={handleView}
            className="px-2 py-1 text-[10px] font-medium text-text-secondary hover:text-text-primary rounded border border-border-subtle hover:border-accent/30 transition-colors"
          >
            View in Feed
          </button>
        </div>
      </div>
    </div>
  );
}
