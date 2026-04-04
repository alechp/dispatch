import { invoke } from "@tauri-apps/api/core";
import type { Snippet } from "./types";

export async function listSnippets(search?: string, tag?: string, sourceId?: string): Promise<Snippet[]> {
  return invoke("list_snippets", { search: search ?? null, tag: tag ?? null, sourceId: sourceId ?? null });
}

export async function createSnippet(data: {
  trigger: string;
  label?: string;
  body: string;
  tags?: string;
  variables?: string;
}): Promise<Snippet> {
  return invoke("create_snippet", {
    trigger: data.trigger,
    label: data.label ?? null,
    body: data.body,
    tags: data.tags ?? null,
    variables: data.variables ?? null,
  });
}

export async function updateSnippet(
  id: string,
  data: {
    trigger?: string;
    label?: string;
    body?: string;
    tags?: string;
    variables?: string;
    is_enabled?: number;
  }
): Promise<Snippet> {
  return invoke("update_snippet", {
    id,
    trigger: data.trigger ?? null,
    label: data.label ?? null,
    body: data.body ?? null,
    tags: data.tags ?? null,
    variables: data.variables ?? null,
    isEnabled: data.is_enabled ?? null,
  });
}

export async function deleteSnippet(id: string): Promise<boolean> {
  return invoke("delete_snippet", { id });
}

export async function expandSnippet(id: string, formValues?: Record<string, string>): Promise<string> {
  return invoke("expand_snippet", { id, formValues: formValues ?? null });
}

export async function importSnippets(json: string): Promise<number> {
  return invoke("import_snippets", { snippetsJson: json });
}

export async function exportSnippets(): Promise<Snippet[]> {
  return invoke("export_snippets");
}

// --- Expander V2: recents, favorites, prefix, sources ---

export async function listRecentSnippets(limit?: number): Promise<Snippet[]> {
  return invoke("list_recent_snippets", { limit: limit ?? 5 });
}

export async function listFavoriteSnippets(): Promise<Snippet[]> {
  return invoke("list_favorite_snippets");
}

export async function toggleSnippetFavorite(id: string): Promise<boolean> {
  return invoke("toggle_snippet_favorite", { id });
}

export async function getExpandPrefix(): Promise<string> {
  return invoke("get_expand_prefix");
}

export async function setExpandPrefix(prefix: string): Promise<void> {
  return invoke("set_expand_prefix", { prefix });
}

export async function addSnippetSource(name: string, path: string, isFolder: boolean): Promise<SnippetSource> {
  return invoke("add_snippet_source", { name, path, isFolder });
}

export async function listSnippetSources(): Promise<SnippetSource[]> {
  return invoke("list_snippet_sources");
}

export async function updateSnippetSource(id: string, data: { name?: string; isEnabled?: boolean; autoReload?: boolean }): Promise<void> {
  return invoke("update_snippet_source", { id, name: data.name ?? null, isEnabled: data.isEnabled ?? null, autoReload: data.autoReload ?? null });
}

export async function removeSnippetSource(id: string): Promise<void> {
  return invoke("remove_snippet_source", { id });
}

export async function syncSnippetSource(id: string): Promise<SyncResult> {
  return invoke("sync_snippet_source", { id });
}

export async function syncAllSources(): Promise<SyncResult> {
  return invoke("sync_all_sources");
}

export async function createBoilerplateConfig(folderPath: string, packageName: string): Promise<SnippetSource> {
  return invoke("create_boilerplate_config", { folderPath, packageName });
}

export async function ensureDefaultSource(): Promise<SnippetSource> {
  return invoke("ensure_default_source");
}

export async function getExpansionsDirectory(): Promise<string> {
  return invoke<string>("get_expansions_directory");
}

export async function refreshTriggers(): Promise<void> {
  return invoke("refresh_triggers");
}

export async function getTriggerCacheCount(): Promise<number> {
  return invoke<number>("get_trigger_cache_count");
}

export async function readSourceFile(sourceId: string): Promise<string> {
  return invoke<string>("read_source_file", { sourceId });
}

export async function writeSourceFile(sourceId: string, content: string): Promise<SyncResult> {
  return invoke<SyncResult>("write_source_file", { sourceId, content });
}

import type { SnippetSource, SyncResult } from "./types";
