import type { Snippet, SnippetSource } from "./types";

export const EMOJI_PACK_MANAGED_KEY = "builtin:emoji-pack";

export function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

export function isEmojiSnippet(
  snippet: Pick<Snippet, "body" | "source_name" | "source_type" | "tags">
): boolean {
  const tags = parseTags(snippet.tags);
  return (
    tags.includes("emoji") ||
    snippet.source_type === "managed" ||
    snippet.source_name === "Emoji Pack" ||
    snippet.source_name?.toLowerCase().includes("emoji") === true
  );
}

export function isEmojiPackSource(
  source: Pick<
    SnippetSource,
    "name" | "path" | "managed_key" | "source_kind"
  >
): boolean {
  return (
    source.managed_key === EMOJI_PACK_MANAGED_KEY ||
    source.source_kind === "emoji_pack" ||
    source.name === "Emoji Pack" ||
    source.path.toLowerCase().includes("emoji-pack")
  );
}
