import { useState, useCallback, useEffect } from "react";
import { useSnippets } from "../hooks/useSnippets";
import {
  createSnippet,
  updateSnippet,
  deleteSnippet,
  importSnippets,
  exportSnippets,
} from "../lib/snippets";
import {
  getLiveExpansionEnabled,
  setLiveExpansionEnabled,
  checkAccessibilityPermission,
  requestAccessibilityPermission,
} from "../lib/liveExpansion";
import type { Snippet, SnippetVariable } from "../lib/types";

interface SnippetManagerProps {
  onBack: () => void;
}

type ViewMode = "list" | "edit";

const VARIABLE_TYPES: SnippetVariable["type"][] = [
  "echo",
  "date",
  "clipboard",
  "shell",
  "form",
  "choice",
  "random",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseVariables(json: string | null): SnippetVariable[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as SnippetVariable[];
  } catch {
    return [];
  }
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SnippetManager({ onBack }: SnippetManagerProps) {
  const [search, setSearch] = useState("");
  const { snippets, loading, refresh } = useSnippets(search || undefined);

  const [view, setView] = useState<ViewMode>("list");
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);

  const handleOpenCreate = useCallback(() => {
    setEditingSnippet(null);
    setView("edit");
  }, []);

  const handleOpenEdit = useCallback((snippet: Snippet) => {
    setEditingSnippet(snippet);
    setView("edit");
  }, []);

  const handleBackToList = useCallback(() => {
    setView("list");
    setEditingSnippet(null);
    refresh();
  }, [refresh]);

  const handleExport = useCallback(async () => {
    try {
      const data = await exportSnippets();
      const json = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(json);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }, []);

  const handleImportSubmit = useCallback(
    async (json: string) => {
      try {
        await importSnippets(json);
        setShowImportModal(false);
        refresh();
      } catch (err) {
        console.error("Import failed:", err);
      }
    },
    [refresh]
  );

  if (view === "edit") {
    return (
      <SnippetEditView
        snippet={editingSnippet}
        onBack={handleBackToList}
        onSaved={handleBackToList}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen bg-surface">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <ChevronLeftIcon />
          Back
        </button>
        <input
          type="text"
          placeholder="Search snippets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
        <button
          onClick={handleOpenCreate}
          className="flex items-center justify-center w-7 h-7 rounded-md bg-accent hover:bg-accent-hover text-white text-sm transition-colors"
          title="Add snippet"
        >
          +
        </button>
      </div>

      {/* Live Expansion Toggle */}
      <LiveExpansionToggle />

      {/* Snippet list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-text-tertiary">Loading snippets...</p>
          </div>
        ) : snippets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <p className="text-sm text-text-tertiary">No snippets found.</p>
            <button
              onClick={handleOpenCreate}
              className="text-xs text-accent hover:text-accent-hover transition-colors"
            >
              Create your first snippet
            </button>
          </div>
        ) : (
          <div>
            {snippets.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                onClick={() => handleOpenEdit(snippet)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle bg-surface shrink-0">
        <button
          onClick={() => setShowImportModal(true)}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle hover:border-border-default"
        >
          Import
        </button>
        <button
          onClick={handleExport}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle hover:border-border-default"
        >
          Export
        </button>
      </div>

      {/* Import modal */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onImport={handleImportSubmit}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnippetRow
// ---------------------------------------------------------------------------

function SnippetRow({
  snippet,
  onClick,
}: {
  snippet: Snippet;
  onClick: () => void;
}) {
  const tags = parseTags(snippet.tags);

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 border-b border-border-subtle hover:bg-surface-raised transition-colors"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-mono text-accent">{snippet.trigger}</span>
        {snippet.label && (
          <span className="text-xs text-text-secondary truncate">
            {snippet.label}
          </span>
        )}
      </div>
      <p className="text-xs font-mono text-text-tertiary line-clamp-2 mb-1">
        {snippet.body}
      </p>
      <div className="flex items-center gap-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary"
          >
            {tag}
          </span>
        ))}
        {snippet.use_count > 0 && (
          <span className="text-[10px] text-text-tertiary ml-auto">
            used {snippet.use_count}x
          </span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SnippetEditView
// ---------------------------------------------------------------------------

function SnippetEditView({
  snippet,
  onBack,
  onSaved,
}: {
  snippet: Snippet | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const isEdit = snippet !== null;

  const [trigger, setTrigger] = useState(snippet?.trigger ?? "");
  const [label, setLabel] = useState(snippet?.label ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [tagsInput, setTagsInput] = useState(
    parseTags(snippet?.tags ?? null).join(", ")
  );
  const [enabled, setEnabled] = useState(snippet?.is_enabled ?? 1);
  const [variables, setVariables] = useState<SnippetVariable[]>(
    parseVariables(snippet?.variables ?? null)
  );
  const [editingVarIndex, setEditingVarIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const tagsArr = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const tagsJson = tagsArr.length > 0 ? JSON.stringify(tagsArr) : undefined;
      const varsJson =
        variables.length > 0 ? JSON.stringify(variables) : undefined;

      if (isEdit) {
        await updateSnippet(snippet.id, {
          trigger,
          label: label || undefined,
          body,
          tags: tagsJson,
          variables: varsJson,
          is_enabled: enabled,
        });
      } else {
        await createSnippet({
          trigger,
          label: label || undefined,
          body,
          tags: tagsJson,
          variables: varsJson,
        });
      }
      onSaved();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [trigger, label, body, tagsInput, enabled, variables, isEdit, snippet, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!snippet) return;
    try {
      await deleteSnippet(snippet.id);
      onSaved();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }, [snippet, onSaved]);

  const handleAddVariable = useCallback(() => {
    const newVar: SnippetVariable = { name: "", type: "echo", params: {} };
    setVariables((prev) => [...prev, newVar]);
    setEditingVarIndex(variables.length);
  }, [variables.length]);

  const handleUpdateVariable = useCallback(
    (index: number, updated: SnippetVariable) => {
      setVariables((prev) => prev.map((v, i) => (i === index ? updated : v)));
    },
    []
  );

  const handleRemoveVariable = useCallback((index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
    setEditingVarIndex(null);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-surface">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <ChevronLeftIcon />
          Back to list
        </button>
        {isEdit && (
          <button
            onClick={handleDelete}
            className="text-xs text-error hover:text-red-400 transition-colors px-2 py-1 rounded-md"
          >
            Delete
          </button>
        )}
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Trigger */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">
            Trigger
          </label>
          <input
            type="text"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder=":trigger"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Label */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">
            Label
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional label"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Body */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">
            Body
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="Snippet content..."
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors resize-y"
          />
        </div>

        {/* Variables */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-2">
            Variables
          </label>
          {variables.length === 0 ? (
            <p className="text-xs text-text-tertiary mb-2">No variables defined.</p>
          ) : (
            <div className="space-y-2 mb-2">
              {variables.map((v, i) => (
                <div
                  key={i}
                  className="rounded-lg bg-surface-raised border border-border-subtle p-3"
                >
                  {editingVarIndex === i ? (
                    <VariableEditor
                      variable={v}
                      onChange={(updated) => handleUpdateVariable(i, updated)}
                      onDone={() => setEditingVarIndex(null)}
                      onRemove={() => handleRemoveVariable(i)}
                    />
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-accent">
                          {v.name || "(unnamed)"}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary">
                          {v.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditingVarIndex(i)}
                          className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRemoveVariable(i)}
                          className="text-[11px] text-error hover:text-red-400 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <button
            onClick={handleAddVariable}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            + Add Variable
          </button>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">
            Tags
          </label>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="Comma-separated tags"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="snippet-enabled"
            checked={enabled === 1}
            onChange={(e) => setEnabled(e.target.checked ? 1 : 0)}
            className="rounded border-border-subtle accent-accent"
          />
          <label
            htmlFor="snippet-enabled"
            className="text-xs text-text-secondary"
          >
            Enabled
          </label>
        </div>
      </div>

      {/* Save button */}
      <div className="px-4 py-3 border-t border-border-subtle bg-surface shrink-0">
        <button
          onClick={handleSave}
          disabled={saving || !trigger || !body}
          className="w-full py-2 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VariableEditor
// ---------------------------------------------------------------------------

function VariableEditor({
  variable,
  onChange,
  onDone,
  onRemove,
}: {
  variable: SnippetVariable;
  onChange: (v: SnippetVariable) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const updateParam = (key: string, value: unknown) => {
    onChange({ ...variable, params: { ...variable.params, [key]: value } });
  };

  return (
    <div className="space-y-3">
      {/* Name */}
      <div>
        <label className="block text-[11px] text-text-tertiary mb-1">Name</label>
        <input
          type="text"
          value={variable.name}
          onChange={(e) => onChange({ ...variable, name: e.target.value })}
          placeholder="variable_name"
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {/* Type */}
      <div>
        <label className="block text-[11px] text-text-tertiary mb-1">Type</label>
        <select
          value={variable.type}
          onChange={(e) =>
            onChange({
              ...variable,
              type: e.target.value as SnippetVariable["type"],
              params: {},
            })
          }
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
        >
          {VARIABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Type-specific params */}
      <VariableParamsEditor variable={variable} updateParam={updateParam} />

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onDone}
          className="text-[11px] text-accent hover:text-accent-hover transition-colors"
        >
          Done
        </button>
        <button
          onClick={onRemove}
          className="text-[11px] text-error hover:text-red-400 transition-colors"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VariableParamsEditor
// ---------------------------------------------------------------------------

function VariableParamsEditor({
  variable,
  updateParam,
}: {
  variable: SnippetVariable;
  updateParam: (key: string, value: unknown) => void;
}) {
  switch (variable.type) {
    case "echo":
      return (
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            Value
          </label>
          <input
            type="text"
            value={(variable.params.value as string) ?? ""}
            onChange={(e) => updateParam("value", e.target.value)}
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
      );

    case "date":
      return (
        <>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Format
            </label>
            <input
              type="text"
              value={(variable.params.format as string) ?? ""}
              onChange={(e) => updateParam("format", e.target.value)}
              placeholder="%Y-%m-%d"
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Offset
            </label>
            <input
              type="text"
              value={(variable.params.offset as string) ?? ""}
              onChange={(e) => updateParam("offset", e.target.value)}
              placeholder="e.g. -1d, +2h"
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
        </>
      );

    case "clipboard":
      return (
        <p className="text-[11px] text-text-tertiary">
          No parameters needed. Clipboard contents will be inserted.
        </p>
      );

    case "shell":
      return (
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            Command
          </label>
          <textarea
            value={(variable.params.cmd as string) ?? ""}
            onChange={(e) => updateParam("cmd", e.target.value)}
            rows={3}
            placeholder="echo 'hello'"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors resize-y"
          />
        </div>
      );

    case "form":
      return (
        <>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Label
            </label>
            <input
              type="text"
              value={(variable.params.label as string) ?? ""}
              onChange={(e) => updateParam("label", e.target.value)}
              placeholder="Field label"
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Default value
            </label>
            <input
              type="text"
              value={(variable.params.default as string) ?? ""}
              onChange={(e) => updateParam("default", e.target.value)}
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!variable.params.multiline}
              onChange={(e) => updateParam("multiline", e.target.checked)}
              className="rounded border-border-subtle accent-accent"
            />
            <span className="text-[11px] text-text-tertiary">Multiline</span>
          </div>
        </>
      );

    case "choice":
      return (
        <ListParamEditor
          label="Label"
          labelValue={(variable.params.label as string) ?? ""}
          onLabelChange={(v) => updateParam("label", v)}
          items={((variable.params.values as string[]) ?? []) as string[]}
          onItemsChange={(items) => updateParam("values", items)}
          itemPlaceholder="Choice value"
        />
      );

    case "random":
      return (
        <ListParamEditor
          items={((variable.params.values as string[]) ?? []) as string[]}
          onItemsChange={(items) => updateParam("values", items)}
          itemPlaceholder="Random value"
        />
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// ListParamEditor (for choice/random values lists)
// ---------------------------------------------------------------------------

function ListParamEditor({
  label,
  labelValue,
  onLabelChange,
  items,
  onItemsChange,
  itemPlaceholder,
}: {
  label?: string;
  labelValue?: string;
  onLabelChange?: (v: string) => void;
  items: string[];
  onItemsChange: (items: string[]) => void;
  itemPlaceholder: string;
}) {
  const [newItem, setNewItem] = useState("");

  const addItem = () => {
    const trimmed = newItem.trim();
    if (trimmed) {
      onItemsChange([...items, trimmed]);
      setNewItem("");
    }
  };

  return (
    <>
      {label && onLabelChange && (
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            {label}
          </label>
          <input
            type="text"
            value={labelValue ?? ""}
            onChange={(e) => onLabelChange(e.target.value)}
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
      )}
      <div>
        <label className="block text-[11px] text-text-tertiary mb-1">
          Values
        </label>
        {items.length > 0 && (
          <div className="space-y-1 mb-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-text-primary flex-1 truncate font-mono">
                  {item}
                </span>
                <button
                  onClick={() =>
                    onItemsChange(items.filter((_, idx) => idx !== i))
                  }
                  className="text-[10px] text-error hover:text-red-400 transition-colors shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
            placeholder={itemPlaceholder}
            className="flex-1 bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
          <button
            onClick={addItem}
            className="text-[11px] text-accent hover:text-accent-hover transition-colors shrink-0"
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ImportModal
// ---------------------------------------------------------------------------

function ImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (json: string) => void;
}) {
  const [json, setJson] = useState("");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[400px] bg-surface-raised border border-border-subtle rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">
            Import Snippets
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-secondary rounded transition-colors"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="p-4">
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={10}
            placeholder="Paste JSON here..."
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors resize-y"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle"
          >
            Cancel
          </button>
          <button
            onClick={() => onImport(json)}
            disabled={!json.trim()}
            className="text-xs text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors px-3 py-1.5 rounded-md"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiveExpansionToggle
// ---------------------------------------------------------------------------

function LiveExpansionToggle() {
  const [enabled, setEnabled] = useState(false);
  const [hasPermission, setHasPermission] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [isEnabled, hasPerm] = await Promise.all([
          getLiveExpansionEnabled(),
          checkAccessibilityPermission(),
        ]);
        setEnabled(isEnabled);
        setHasPermission(hasPerm);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleToggle = useCallback(async () => {
    if (!hasPermission) {
      const granted = await requestAccessibilityPermission();
      setHasPermission(granted);
      if (!granted) return;
    }
    const newValue = !enabled;
    setEnabled(newValue);
    await setLiveExpansionEnabled(newValue);
  }, [enabled, hasPermission]);

  if (loading) return null;

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-surface-raised/50">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-text-secondary">
          Live Expansion
        </span>
        {!hasPermission && (
          <span className="text-[10px] text-warning">
            Needs Input Monitoring permission
          </span>
        )}
      </div>
      <button
        onClick={handleToggle}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          enabled ? "bg-accent" : "bg-surface-overlay border border-border-subtle"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function ChevronLeftIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
