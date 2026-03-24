import type { Notification } from "../lib/types";
import { NotificationCard } from "./NotificationCard";
import { EmptyState } from "./EmptyState";

interface NotificationFeedProps {
  notifications: Notification[];
  loading: boolean;
  onMarkRead: (id: string) => void;
  onDelete: (id: string) => void;
  onFocusTerminal: (session: string, window: string | null, pane: string | null) => void;
}

export function NotificationFeed({
  notifications,
  loading,
  onMarkRead,
  onDelete,
  onFocusTerminal,
}: NotificationFeedProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-border-subtle border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (notifications.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-y-auto flex-1">
      {notifications.map((n) => (
        <NotificationCard
          key={n.id}
          notification={n}
          onMarkRead={onMarkRead}
          onDelete={onDelete}
          onFocusTerminal={onFocusTerminal}
        />
      ))}
    </div>
  );
}
