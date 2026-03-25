import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSnippets } from "../hooks/useSnippets";
import { expandSnippet } from "../lib/snippets";
import type { SnippetVariable } from "../lib/types";

interface ExpanderPaletteProps {
  onClose: () => void;
  onExpand: (text: string) => void;
}

function parseVariables(json: string | null): SnippetVariable[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as SnippetVariable[];
  } catch {
    return [];
  }
}

function hasFormVariables(variables: SnippetVariable[]): boolean {
  return variables.some((v) => v.type === "form" || v.type === "choice");
}

export function ExpanderPalette({ onClose, onExpand }: ExpanderPaletteProps) {
  const [search, setSearch] = useState("");
  const { snippets } = useSnippets(search || undefined);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [formSnippetId, setFormSnippetId] = useState<string | null>(null);
  const [formVariables, setFormVariables] = useState<SnippetVariable[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-snippet-item]");
    const item = items[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const formVarsForForm = useMemo(
    () => formVariables.filter((v) => v.type === "form" || v.type === "choice"),
    [formVariables]
  );

  const handleSelect = useCallback(
    async (index: number) => {
      const snippet = snippets[index];
      if (!snippet) return;

      const vars = parseVariables(snippet.variables);
      if (hasFormVariables(vars)) {
        setFormSnippetId(snippet.id);
        setFormVariables(vars);
        const defaults: Record<string, string> = {};
        for (const v of vars) {
          if (v.type === "form") {
            defaults[v.name] = (v.params.default as string) ?? "";
          } else if (v.type === "choice") {
            const values = (v.params.values as string[]) ?? [];
            defaults[v.name] = values[0] ?? "";
          }
        }
        setFormValues(defaults);
      } else {
        try {
          const expanded = await expandSnippet(snippet.id);
          onExpand(expanded);
          onClose();
        } catch (err) {
          console.error("Expand failed:", err);
        }
      }
    },
    [snippets, onExpand, onClose]
  );

  const handleFormExpand = useCallback(async () => {
    if (!formSnippetId) return;
    try {
      const expanded = await expandSnippet(formSnippetId, formValues);
      onExpand(expanded);
      onClose();
    } catch (err) {
      console.error("Expand failed:", err);
    }
  }, [formSnippetId, formValues, onExpand, onClose]);

  const handleCancelForm = useCallback(() => {
    setFormSnippetId(null);
    setFormVariables([]);
    setFormValues({});
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (formSnippetId) {
        if (e.key === "Escape") {
          e.preventDefault();
          handleCancelForm();
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
        case "j":
          if (e.key === "j" && e.target instanceof HTMLInputElement) break;
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, snippets.length - 1));
          break;
        case "ArrowUp":
        case "k":
          if (e.key === "k" && e.target instanceof HTMLInputElement) break;
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          handleSelect(selectedIndex);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [formSnippetId, snippets.length, selectedIndex, handleSelect, onClose, handleCancelForm]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-[400px] bg-surface-raised border border-border-subtle rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="border-b border-border-subtle">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search snippets..."
            className="w-full bg-surface border-0 px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>

        {/* Results or Form */}
        {formSnippetId ? (
          <FormView
            variables={formVarsForForm}
            values={formValues}
            onValuesChange={setFormValues}
            onExpand={handleFormExpand}
            onCancel={handleCancelForm}
          />
        ) : (
          <div
            ref={listRef}
            className="max-h-[300px] overflow-y-auto"
          >
            {snippets.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-text-tertiary">
                  {search ? "No matching snippets." : "No snippets available."}
                </p>
              </div>
            ) : (
              snippets.map((snippet, i) => (
                <button
                  key={snippet.id}
                  data-snippet-item
                  onClick={() => handleSelect(i)}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-2 transition-colors ${
                    i === selectedIndex
                      ? "bg-surface-overlay"
                      : "hover:bg-surface-overlay/50"
                  }`}
                >
                  <span className="text-sm font-mono text-accent shrink-0">
                    {snippet.trigger}
                  </span>
                  {snippet.label && (
                    <span className="text-xs text-text-secondary truncate">
                      {snippet.label}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormView (inline variable form for form/choice variables)
// ---------------------------------------------------------------------------

function FormView({
  variables,
  values,
  onValuesChange,
  onExpand,
  onCancel,
}: {
  variables: SnippetVariable[];
  values: Record<string, string>;
  onValuesChange: (values: Record<string, string>) => void;
  onExpand: () => void;
  onCancel: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const updateValue = (name: string, value: string) => {
    onValuesChange({ ...values, [name]: value });
  };

  return (
    <div className="px-4 py-3 space-y-3">
      {variables.map((v, i) => {
        if (v.type === "form") {
          return (
            <div key={v.name}>
              <label className="block text-[11px] text-text-tertiary mb-1">
                {(v.params.label as string) || v.name}
              </label>
              <input
                ref={i === 0 ? firstInputRef as React.RefObject<HTMLInputElement> : undefined}
                type="text"
                value={values[v.name] ?? ""}
                onChange={(e) => updateValue(v.name, e.target.value)}
                placeholder={(v.params.default as string) || ""}
                className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          );
        }
        if (v.type === "choice") {
          const choiceValues = ((v.params.values as string[]) ?? []) as string[];
          return (
            <div key={v.name}>
              <label className="block text-[11px] text-text-tertiary mb-1">
                {(v.params.label as string) || v.name}
              </label>
              <select
                ref={i === 0 ? firstInputRef as React.RefObject<HTMLSelectElement> : undefined}
                value={values[v.name] ?? ""}
                onChange={(e) => updateValue(v.name, e.target.value)}
                className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
              >
                {choiceValues.map((cv) => (
                  <option key={cv} value={cv}>
                    {cv}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        return null;
      })}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle"
        >
          Cancel
        </button>
        <button
          onClick={onExpand}
          className="text-xs text-white bg-accent hover:bg-accent-hover transition-colors px-3 py-1.5 rounded-md"
        >
          Expand
        </button>
      </div>
    </div>
  );
}
