import { useEffect, useState } from "react";
import { useToast } from "../hooks/useToast";

export function Toast() {
  const { toast } = useToast();
  const [visible, setVisible] = useState(false);
  const [displayedMessage, setDisplayedMessage] = useState("");

  useEffect(() => {
    if (toast) {
      setDisplayedMessage(toast.message);
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [toast]);

  if (!visible && !toast) return null;

  return (
    <div
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] px-3 py-1.5 rounded-lg bg-surface-raised border border-border-subtle shadow-xl flex items-center gap-2 transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-success shrink-0"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span className="text-xs text-text-primary whitespace-nowrap">
        {displayedMessage}
      </span>
    </div>
  );
}
