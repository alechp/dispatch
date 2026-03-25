import { invoke } from "@tauri-apps/api/core";
import type { Snippet } from "./types";

export async function listSnippets(search?: string, tag?: string): Promise<Snippet[]> {
  return invoke("list_snippets", { search: search ?? null, tag: tag ?? null });
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
