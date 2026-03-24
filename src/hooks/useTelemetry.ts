import { useState, useEffect, useCallback } from "react";
import { getTelemetrySummary, getTelemetryEvents } from "../lib/telemetry";
import type { TelemetrySummary, TelemetryEvent } from "../lib/telemetry";

export function useTelemetry(from: string, to: string) {
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [recentEvents, setRecentEvents] = useState<TelemetryEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryData, events] = await Promise.all([
        getTelemetrySummary(from, to),
        getTelemetryEvents({ from, to, limit: 20 }),
      ]);
      setSummary(summaryData);
      setRecentEvents(events);
    } catch (err) {
      console.error("Failed to fetch telemetry:", err);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { summary, recentEvents, loading, refresh };
}
