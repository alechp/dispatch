import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Notification } from "../lib/types";

export function useNotificationListener(
  onNew: (notification: Notification) => void,
  onChanged?: () => void
) {
  useEffect(() => {
    const unlistenNew = listen<Notification>("new-notification", (event) => {
      onNew(event.payload);
    });

    const unlistenChanged = listen("notifications-changed", () => {
      onChanged?.();
    });

    return () => {
      unlistenNew.then((fn) => fn());
      unlistenChanged.then((fn) => fn());
    };
  }, [onNew, onChanged]);
}
