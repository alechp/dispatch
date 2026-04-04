import { useEffect, useRef } from "react";
import type { SnippetVariable } from "../lib/types";

export function parseVariables(json: string | null): SnippetVariable[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as SnippetVariable[];
  } catch {
    return [];
  }
}

export function hasFormVariables(variables: SnippetVariable[]): boolean {
  return variables.some((v) => v.type === "form" || v.type === "choice");
}

export function FormView({
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
