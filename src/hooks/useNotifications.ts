import { useState, useEffect, useCallback } from "react";
import type { Notification, QueryFilters } from "../lib/types";
import { getNotifications, markRead, markAllRead, clearAll } from "../lib/api";

export function useNotifications(filters: QueryFilters = {}) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await getNotifications(filters);
      setNotifications(res.notifications);
      setTotal(res.total);
    } catch (err) {
      console.error("Failed to fetch notifications:", err);
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleMarkRead = useCallback(
    async (id: string) => {
      await markRead(id);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === id
            ? { ...n, is_read: 1, read_at: new Date().toISOString() }
            : n
        )
      );
    },
    []
  );

  const handleMarkAllRead = useCallback(async () => {
    await markAllRead();
    setNotifications((prev) =>
      prev.map((n) => ({
        ...n,
        is_read: 1,
        read_at: n.read_at ?? new Date().toISOString(),
      }))
    );
  }, []);

  const handleClearAll = useCallback(async () => {
    await clearAll();
    setNotifications([]);
    setTotal(0);
  }, []);

  return {
    notifications,
    total,
    loading,
    refresh,
    markRead: handleMarkRead,
    markAllRead: handleMarkAllRead,
    clearAll: handleClearAll,
  };
}
