import { useState, useEffect, useCallback } from "react";
import { listSnippets } from "../lib/snippets";
import type { Snippet } from "../lib/types";

export function useSnippets(search?: string, tag?: string, sourceId?: string) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSnippets(search, tag, sourceId);
      setSnippets(data);
    } catch (err) {
      console.error("Failed to fetch snippets:", err);
    } finally {
      setLoading(false);
    }
  }, [search, tag, sourceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { snippets, loading, refresh };
}
