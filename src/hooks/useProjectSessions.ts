import { useState, useEffect, useCallback } from "react";
import { getProjectSessions } from "../lib/api";
import type { ProjectSession } from "../lib/types";

export function useProjectSessions(search?: string) {
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProjectSessions(search);
      setSessions(data);
    } catch (err) {
      console.error("Failed to fetch project sessions:", err);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { sessions, loading, refresh };
}
