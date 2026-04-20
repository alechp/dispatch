import { useState, useEffect, useCallback } from "react";
import { useToast } from "../hooks/useToast";
import {
  listRoutingRules,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
  toggleRoutingRule,
  testRoutingRule,
  getRoutingLog,
  validateRoutingChain,
  listNotificationAccounts,
} from "../lib/api";
import type {
  RoutingRule,
  RoutingLogEntry,
  RoutingDestinationConfig,
  NotificationAccount,
  RoutingSourceType,
  RoutingDestinationType,
} from "../lib/types";

interface RoutingPipelinesProps {
  onBack?: () => void;
}

// ── Constants ───────────────────────────────────────────────────────

const SOURCE_TYPE_OPTIONS: { value: RoutingSourceType; label: string }[] = [
  { value: "any", label: "Any source" },
  { value: "provider", label: "Provider" },
  { value: "account", label: "Account" },
  { value: "event_type", label: "Event type" },
  { value: "project", label: "Project" },
];

const DESTINATION_TYPE_OPTIONS: { value: RoutingDestinationType; label: string }[] = [
  { value: "webhook", label: "Webhook" },
  { value: "account", label: "Account" },
  { value: "macos_push", label: "macOS Push" },
  { value: "routing_rule", label: "Chain to rule" },
];

const TEMPLATE_VARIABLES = [
  "{{title}}", "{{body}}", "{{source}}", "{{event_type}}",
  "{{project}}", "{{provider}}", "{{channel}}", "{{author}}", "{{created_at}}",
];

// ── Helpers ─────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sourceLabel(rule: RoutingRule): string {
  switch (rule.source_type) {
    case "any": return "Any notification";
    case "provider": return `Provider: ${rule.source_value ?? "any"}`;
    case "account": return `Account: ${rule.source_value ?? "any"}`;
    case "event_type": return `Event: ${rule.source_value ?? "any"}`;
    case "project": return `Project: ${rule.source_value ?? "any"}`;
    default: return rule.source_type;
  }
}

function destinationLabel(rule: RoutingRule): string {
  switch (rule.destination_type) {
    case "webhook": return `Webhook: ${rule.destination_config.url ?? "..."}`;
    case "account": return `Account: ${rule.destination_config.account_id ?? "..."}`;
    case "macos_push": return "macOS Push";
    case "routing_rule": return `Chain: ${rule.destination_config.rule_id ?? "..."}`;
    default: return rule.destination_type;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "success": return "text-success";
    case "failed": return "text-error";
    case "skipped": return "text-warning";
    default: return "text-text-tertiary";
  }
}

function statusDotColor(status: string): string {
  switch (status) {
    case "success": return "bg-success";
    case "failed": return "bg-error";
    case "skipped": return "bg-warning";
    default: return "bg-text-tertiary";
  }
}

// ── Default form state ──────────────────────────────────────────────

interface RuleFormState {
  name: string;
  source_type: RoutingSourceType;
  source_value: string;
  destination_type: RoutingDestinationType;
  destination_config: RoutingDestinationConfig;
  template: string;
  filter_event_types: string;
  filter_keywords: string;
  priority: number;
  stop_on_match: boolean;
  chain_rule_id: string;
}

function emptyForm(): RuleFormState {
  return {
    name: "",
    source_type: "any",
    source_value: "",
    destination_type: "webhook",
    destination_config: {},
    template: "",
    filter_event_types: "",
    filter_keywords: "",
    priority: 100,
    stop_on_match: false,
    chain_rule_id: "",
  };
}

function ruleToForm(rule: RoutingRule): RuleFormState {
  return {
    name: rule.name,
    source_type: rule.source_type,
    source_value: rule.source_value ?? "",
    destination_type: rule.destination_type,
    destination_config: { ...rule.destination_config },
    template: rule.template ?? "",
    filter_event_types: rule.filter_event_types?.join(", ") ?? "",
    filter_keywords: rule.filter_keywords?.join(", ") ?? "",
    priority: rule.priority,
    stop_on_match: rule.stop_on_match,
    chain_rule_id: rule.chain_rule_id ?? "",
  };
}

// ── Component ───────────────────────────────────────────────────────

export function RoutingPipelines({ onBack }: RoutingPipelinesProps) {
  const { showToast } = useToast();

  // Data state
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [logEntries, setLogEntries] = useState<RoutingLogEntry[]>([]);
  const [accounts, setAccounts] = useState<NotificationAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null); // null = not editing, "new" = creating
  const [form, setForm] = useState<RuleFormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const [testingRuleId, setTestingRuleId] = useState<string | null>(null);
  const [validatingRuleId, setValidatingRuleId] = useState<string | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  // ── Data loading ────────────────────────────────────────────────

  const loadRules = useCallback(async () => {
    try {
      const data = await listRoutingRules();
      setRules(data.sort((a, b) => a.priority - b.priority));
    } catch (e) {
      console.error("[routing] loadRules failed:", e);
      setError("Failed to load routing rules");
    }
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const data = await getRoutingLog(50);
      setLogEntries(data);
    } catch (e) {
      console.error("[routing] loadLog failed:", e);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await listNotificationAccounts();
      setAccounts(data);
    } catch (e) {
      console.error("[routing] loadAccounts failed:", e);
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      await Promise.all([loadRules(), loadLog(), loadAccounts()]);
      setLoading(false);
    }
    init();
  }, [loadRules, loadLog, loadAccounts]);

  // ── Handlers ────────────────────────────────────────────────────

  function handleNewRule() {
    setForm(emptyForm());
    setEditingRuleId("new");
  }

  function handleEditRule(rule: RoutingRule) {
    setForm(ruleToForm(rule));
    setEditingRuleId(rule.id);
  }

  function handleCancelEdit() {
    setEditingRuleId(null);
    setForm(emptyForm());
  }

  async function handleToggle(rule: RoutingRule) {
    try {
      await toggleRoutingRule(rule.id, !rule.is_enabled);
      await loadRules();
      showToast(`${rule.name} ${rule.is_enabled ? "disabled" : "enabled"}`);
    } catch (e) {
      showToast(`Toggle failed: ${e}`);
    }
  }

  async function handleDelete(rule: RoutingRule) {
    setDeletingRuleId(rule.id);
    try {
      await deleteRoutingRule(rule.id);
      if (editingRuleId === rule.id) {
        setEditingRuleId(null);
        setForm(emptyForm());
      }
      await loadRules();
      showToast(`Deleted "${rule.name}"`);
    } catch (e) {
      showToast(`Delete failed: ${e}`);
    } finally {
      setDeletingRuleId(null);
    }
  }

  async function handleTest(rule: RoutingRule) {
    setTestingRuleId(rule.id);
    try {
      const result = await testRoutingRule(rule.id);
      showToast(`Test result: ${result}`);
      await loadLog();
    } catch (e) {
      showToast(`Test failed: ${e}`);
    } finally {
      setTestingRuleId(null);
    }
  }

  async function handleValidateChain(ruleId: string) {
    setValidatingRuleId(ruleId);
    try {
      const result = await validateRoutingChain(ruleId);
      showToast(`Chain validation: ${result}`);
    } catch (e) {
      showToast(`Chain validation failed: ${e}`);
    } finally {
      setValidatingRuleId(null);
    }
  }

  async function handleSave() {
    if (!form.name.trim()) {
      showToast("Rule name is required");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        is_enabled: true,
        source_type: form.source_type,
        source_value: form.source_value.trim() || null,
        destination_type: form.destination_type,
        destination_config: form.destination_config,
        template: form.template.trim() || null,
        filter_event_types: form.filter_event_types.trim()
          ? form.filter_event_types.split(",").map((s) => s.trim()).filter(Boolean)
          : null,
        filter_keywords: form.filter_keywords.trim()
          ? form.filter_keywords.split(",").map((s) => s.trim()).filter(Boolean)
          : null,
        priority: form.priority,
        stop_on_match: form.stop_on_match,
        chain_rule_id: form.chain_rule_id.trim() || null,
      };

      if (editingRuleId === "new") {
        await createRoutingRule(payload);
        showToast(`Created rule "${form.name}"`);
      } else if (editingRuleId) {
        await updateRoutingRule(editingRuleId, payload);
        showToast(`Updated rule "${form.name}"`);
      }

      setEditingRuleId(null);
      setForm(emptyForm());
      await loadRules();
    } catch (e) {
      showToast(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Form updaters ───────────────────────────────────────────────

  function updateForm(patch: Partial<RuleFormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function updateConfig(patch: Partial<RoutingDestinationConfig>) {
    setForm((prev) => ({
      ...prev,
      destination_config: { ...prev.destination_config, ...patch },
    }));
  }

  // ── Helpers for looking up rule names ───────────────────────────

  function ruleNameById(id: string): string {
    const rule = rules.find((r) => r.id === id);
    return rule ? rule.name : id.slice(0, 8) + "...";
  }

  // ── Render ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-surface">
        <Header onBack={onBack} onNewRule={handleNewRule} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-tertiary">Loading routing rules...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-surface">
        <Header onBack={onBack} onNewRule={handleNewRule} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-error">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-surface">
      <Header onBack={onBack} onNewRule={handleNewRule} />

      <div className="flex-1 overflow-y-auto">
        {/* ── Rules List ─────────────────────────────────────────── */}
        <div className="px-4 pt-4 space-y-2">
          {rules.length === 0 && editingRuleId !== "new" && (
            <div className="rounded-lg bg-surface-raised border border-border-subtle p-6 text-center">
              <p className="text-sm text-text-secondary mb-1">No routing rules yet</p>
              <p className="text-xs text-text-tertiary">
                Create a rule to route notifications to webhooks, accounts, or macOS push.
              </p>
            </div>
          )}

          {rules.map((rule) => (
            <div key={rule.id}>
              <div
                className={`rounded-lg bg-surface-raised border transition-colors ${
                  editingRuleId === rule.id
                    ? "border-accent/40"
                    : "border-border-subtle"
                }`}
              >
                {/* Rule card */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(rule)}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                      rule.is_enabled
                        ? "bg-accent"
                        : "bg-surface-overlay border border-border-subtle"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        rule.is_enabled ? "translate-x-5" : ""
                      }`}
                    />
                  </button>

                  {/* Flow description */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => handleEditRule(rule)}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs font-medium text-text-primary truncate">
                        {rule.name}
                      </span>
                      {rule.chain_rule_id && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent/15 text-accent shrink-0">
                          chained
                        </span>
                      )}
                      <span className="text-[10px] text-text-tertiary shrink-0">
                        P{rule.priority}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-text-secondary truncate">
                      <span className="truncate">{sourceLabel(rule)}</span>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 text-text-tertiary"
                      >
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                      <span className="truncate">{destinationLabel(rule)}</span>
                      {rule.chain_rule_id && (
                        <>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="shrink-0 text-accent"
                          >
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                          </svg>
                          <span className="truncate text-accent">
                            {ruleNameById(rule.chain_rule_id)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {rule.chain_rule_id && (
                      <button
                        onClick={() => handleValidateChain(rule.id)}
                        disabled={validatingRuleId === rule.id}
                        className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors disabled:opacity-50"
                        title="Validate chain"
                      >
                        {validatingRuleId === rule.id ? "..." : "Validate"}
                      </button>
                    )}
                    <button
                      onClick={() => handleTest(rule)}
                      disabled={testingRuleId === rule.id}
                      className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors disabled:opacity-50"
                      title="Test rule"
                    >
                      {testingRuleId === rule.id ? "..." : "Test"}
                    </button>
                    <button
                      onClick={() => handleDelete(rule)}
                      disabled={deletingRuleId === rule.id}
                      className="px-2.5 py-1 text-xs text-text-secondary hover:text-error rounded-md hover:bg-surface-overlay transition-colors disabled:opacity-50"
                      title="Delete rule"
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
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Inline editor for this rule */}
                {editingRuleId === rule.id && (
                  <div className="border-t border-border-subtle">
                    <RuleEditor
                      form={form}
                      updateForm={updateForm}
                      updateConfig={updateConfig}
                      accounts={accounts}
                      rules={rules}
                      currentRuleId={rule.id}
                      saving={saving}
                      onSave={handleSave}
                      onCancel={handleCancelEdit}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Inline editor for new rule */}
          {editingRuleId === "new" && (
            <div className="rounded-lg bg-surface-raised border border-accent/40">
              <div className="px-3 py-2.5 border-b border-border-subtle">
                <span className="text-xs font-medium text-text-primary">New Routing Rule</span>
              </div>
              <RuleEditor
                form={form}
                updateForm={updateForm}
                updateConfig={updateConfig}
                accounts={accounts}
                rules={rules}
                currentRuleId={null}
                saving={saving}
                onSave={handleSave}
                onCancel={handleCancelEdit}
              />
            </div>
          )}
        </div>

        {/* ── Divider ────────────────────────────────────────────── */}
        <div className="mx-4 my-4 border-t border-border-subtle" />

        {/* ── Routing Log ────────────────────────────────────────── */}
        <div className="px-4 pb-4">
          <button
            onClick={() => {
              if (!logExpanded) loadLog();
              setLogExpanded((prev) => !prev);
            }}
            className="flex items-center gap-2 w-full text-left group"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`text-text-tertiary transition-transform ${
                logExpanded ? "rotate-90" : ""
              }`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <h2 className="text-xs font-semibold text-text-secondary group-hover:text-text-primary transition-colors">
              Routing Log
            </h2>
            {logEntries.length > 0 && (
              <span className="text-[10px] text-text-tertiary">
                ({logEntries.length} recent)
              </span>
            )}
          </button>

          {logExpanded && (
            <div className="mt-2 rounded-lg bg-surface-raised border border-border-subtle overflow-hidden">
              {logEntries.length === 0 ? (
                <div className="px-3 py-4 text-center">
                  <p className="text-xs text-text-tertiary">No routing log entries yet.</p>
                </div>
              ) : (
                logEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle last:border-b-0"
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotColor(entry.status)}`}
                    />
                    <span className={`text-xs font-medium shrink-0 ${statusColor(entry.status)}`}>
                      {entry.status}
                    </span>
                    <span className="text-xs text-text-primary truncate flex-1">
                      {ruleNameById(entry.rule_id)}
                    </span>
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary shrink-0">
                      {entry.destination_type}
                    </span>
                    {entry.error_message && (
                      <span
                        className="text-[10px] text-error truncate max-w-[120px]"
                        title={entry.error_message}
                      >
                        {entry.error_message}
                      </span>
                    )}
                    <span className="text-[10px] text-text-tertiary whitespace-nowrap shrink-0">
                      {timeAgo(entry.executed_at)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Bottom spacer */}
        <div className="h-4" />
      </div>
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────

function Header({
  onBack,
  onNewRule,
}: {
  onBack?: () => void;
  onNewRule: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
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
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </button>
        )}
        <h1 className="text-sm font-semibold text-text-primary">Routing Pipelines</h1>
      </div>
      <button
        onClick={onNewRule}
        className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors"
      >
        New Rule
      </button>
    </div>
  );
}

// ── Rule Editor ─────────────────────────────────────────────────────

function RuleEditor({
  form,
  updateForm,
  updateConfig,
  accounts,
  rules,
  currentRuleId,
  saving,
  onSave,
  onCancel,
}: {
  form: RuleFormState;
  updateForm: (patch: Partial<RuleFormState>) => void;
  updateConfig: (patch: Partial<RoutingDestinationConfig>) => void;
  accounts: NotificationAccount[];
  rules: RoutingRule[];
  currentRuleId: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const inputClass =
    "w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors";
  const selectClass =
    "bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors";
  const labelClass = "block text-[11px] font-medium text-text-secondary mb-1";

  // Exclude current rule from chain targets to prevent self-referencing
  const chainableRules = rules.filter((r) => r.id !== currentRuleId);

  return (
    <div className="p-3 space-y-3">
      {/* Row 1: Name + Priority */}
      <div className="grid grid-cols-[1fr_80px] gap-3">
        <div>
          <label className={labelClass}>Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm({ name: e.target.value })}
            placeholder="e.g., Critical alerts to Slack"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Priority</label>
          <input
            type="number"
            value={form.priority}
            onChange={(e) => updateForm({ priority: parseInt(e.target.value) || 0 })}
            className={inputClass}
          />
        </div>
      </div>

      {/* Row 2: Source */}
      <div>
        <label className={labelClass}>Source</label>
        <div className="grid grid-cols-[140px_1fr] gap-2">
          <select
            value={form.source_type}
            onChange={(e) => updateForm({ source_type: e.target.value as RoutingSourceType })}
            className={selectClass}
          >
            {SOURCE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {form.source_type !== "any" && (
            <input
              type="text"
              value={form.source_value}
              onChange={(e) => updateForm({ source_value: e.target.value })}
              placeholder={
                form.source_type === "provider"
                  ? "discord, slack, terminal..."
                  : form.source_type === "account"
                    ? "Account ID"
                    : form.source_type === "event_type"
                      ? "notification_received, ci_failed..."
                      : "Project name"
              }
              className={inputClass}
            />
          )}
        </div>
      </div>

      {/* Row 3: Destination */}
      <div>
        <label className={labelClass}>Destination</label>
        <div className="space-y-2">
          <select
            value={form.destination_type}
            onChange={(e) => {
              const dt = e.target.value as RoutingDestinationType;
              updateForm({ destination_type: dt, destination_config: {} });
            }}
            className={`${selectClass} w-full`}
          >
            {DESTINATION_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Destination-specific config */}
          {form.destination_type === "webhook" && (
            <div className="space-y-2 pl-3 border-l-2 border-border-subtle">
              <div>
                <label className={labelClass}>URL</label>
                <input
                  type="url"
                  value={form.destination_config.url ?? ""}
                  onChange={(e) => updateConfig({ url: e.target.value })}
                  placeholder="https://hooks.example.com/webhook"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Method</label>
                <select
                  value={form.destination_config.method ?? "POST"}
                  onChange={(e) => updateConfig({ method: e.target.value })}
                  className={`${selectClass} w-full`}
                >
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>
                  Headers <span className="text-text-tertiary font-normal">(JSON, optional)</span>
                </label>
                <input
                  type="text"
                  value={
                    form.destination_config.headers
                      ? JSON.stringify(form.destination_config.headers)
                      : ""
                  }
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    if (!val) {
                      updateConfig({ headers: undefined });
                      return;
                    }
                    try {
                      updateConfig({ headers: JSON.parse(val) });
                    } catch {
                      // Let user keep typing until valid JSON
                    }
                  }}
                  placeholder='{"Authorization": "Bearer ..."}'
                  className={inputClass}
                />
              </div>
            </div>
          )}

          {form.destination_type === "account" && (
            <div className="pl-3 border-l-2 border-border-subtle">
              <label className={labelClass}>Account</label>
              <select
                value={form.destination_config.account_id ?? ""}
                onChange={(e) => updateConfig({ account_id: e.target.value || undefined })}
                className={`${selectClass} w-full`}
              >
                <option value="">Select an account...</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.account_label} ({acc.provider})
                  </option>
                ))}
              </select>
            </div>
          )}

          {form.destination_type === "macos_push" && (
            <div className="pl-3 border-l-2 border-border-subtle">
              <p className="text-[11px] text-text-tertiary">
                macOS push notifications are configured in system settings. This rule will trigger a
                native push notification when matched.
              </p>
            </div>
          )}

          {form.destination_type === "routing_rule" && (
            <div className="pl-3 border-l-2 border-border-subtle">
              <label className={labelClass}>Target Rule</label>
              <select
                value={form.destination_config.rule_id ?? ""}
                onChange={(e) => updateConfig({ rule_id: e.target.value || undefined })}
                className={`${selectClass} w-full`}
              >
                <option value="">Select a rule to chain to...</option>
                {chainableRules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} (P{r.priority})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Row 4: Template */}
      <div>
        <label className={labelClass}>
          Template <span className="text-text-tertiary font-normal">(optional)</span>
        </label>
        <textarea
          value={form.template}
          onChange={(e) => updateForm({ template: e.target.value })}
          placeholder="Custom message template using variables..."
          rows={3}
          className={`${inputClass} resize-y`}
        />
        <div className="flex flex-wrap gap-1 mt-1">
          {TEMPLATE_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => updateForm({ template: form.template + v })}
              className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-accent bg-surface-overlay border border-border-subtle rounded hover:border-accent/30 transition-colors"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Row 5: Filters */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>
            Filter Event Types <span className="text-text-tertiary font-normal">(comma-separated)</span>
          </label>
          <input
            type="text"
            value={form.filter_event_types}
            onChange={(e) => updateForm({ filter_event_types: e.target.value })}
            placeholder="ci_failed, pr_merged, ..."
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>
            Filter Keywords <span className="text-text-tertiary font-normal">(comma-separated)</span>
          </label>
          <input
            type="text"
            value={form.filter_keywords}
            onChange={(e) => updateForm({ filter_keywords: e.target.value })}
            placeholder="error, deploy, urgent, ..."
            className={inputClass}
          />
        </div>
      </div>

      {/* Row 6: Toggles + Chain */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Stop on match */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => updateForm({ stop_on_match: !form.stop_on_match })}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              form.stop_on_match
                ? "bg-accent"
                : "bg-surface-overlay border border-border-subtle"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                form.stop_on_match ? "translate-x-5" : ""
              }`}
            />
          </button>
          <span className="text-xs text-text-secondary">Stop on match</span>
        </div>

        {/* Chain to rule */}
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <label className="text-xs text-text-secondary shrink-0">Chain to:</label>
          <select
            value={form.chain_rule_id}
            onChange={(e) => updateForm({ chain_rule_id: e.target.value })}
            className={`${selectClass} flex-1`}
          >
            <option value="">None</option>
            {chainableRules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} (P{r.priority})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : currentRuleId ? "Update Rule" : "Create Rule"}
        </button>
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
