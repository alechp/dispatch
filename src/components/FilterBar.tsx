import { useState, useEffect } from "react";

interface FilterBarProps {
  onSearchChange: (search: string) => void;
  onFilterChange: (filter: "all" | "unread" | "read") => void;
  activeFilter: "all" | "unread" | "read";
}

export function FilterBar({ onSearchChange, onFilterChange, activeFilter }: FilterBarProps) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(search), 200);
    return () => clearTimeout(timer);
  }, [search, onSearchChange]);

  const filters: { key: "all" | "unread" | "read"; label: string }[] = [
    { key: "all", label: "All" },
    { key: "unread", label: "Unread" },
    { key: "read", label: "Read" },
  ];

  return (
    <div className="px-4 py-2 border-b border-border-subtle space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search notifications..."
        className="w-full px-3 py-1.5 text-xs bg-surface-overlay border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
      />
      <div className="flex gap-1">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => onFilterChange(f.key)}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
              activeFilter === f.key
                ? "bg-accent/15 text-accent"
                : "text-text-tertiary hover:text-text-secondary hover:bg-surface-overlay"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
