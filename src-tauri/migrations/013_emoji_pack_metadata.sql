-- Managed snippet source metadata index for built-in packs such as Emoji Pack.
CREATE UNIQUE INDEX IF NOT EXISTS idx_snippet_sources_managed_key
    ON snippet_sources(managed_key);
