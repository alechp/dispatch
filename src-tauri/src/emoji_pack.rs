use std::path::{Path, PathBuf};

use crate::file_parser;

pub const EMOJI_PACK_MANAGED_KEY: &str = "builtin:emoji-pack";
pub const EMOJI_PACK_NAME: &str = "Emoji Pack";
pub const EMOJI_PACK_VERSION: &str = "emoji-16.0";
pub const EMOJI_PACK_FILE_NAME: &str = "emoji-pack.toml";
pub const EMOJI_PACK_TEMPLATE: &str = include_str!("../templates/emoji-pack.toml");

pub fn emoji_pack_path(expansions_dir: &Path) -> PathBuf {
    expansions_dir.join(EMOJI_PACK_FILE_NAME)
}

pub fn emoji_pack_count() -> Result<usize, String> {
    let config: file_parser::ExpansionConfig =
        toml::from_str(EMOJI_PACK_TEMPLATE).map_err(|e| e.to_string())?;
    Ok(config.snippets.len())
}

pub fn write_emoji_pack_file(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create emoji pack dir: {}", e))?;
    }
    std::fs::write(path, EMOJI_PACK_TEMPLATE)
        .map_err(|e| format!("Failed to write emoji pack file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_pack_template_parses_and_contains_emojis() {
        let path = std::env::temp_dir()
            .join(format!("dispatch-emoji-pack-{}.toml", uuid::Uuid::new_v4()));
        std::fs::write(&path, EMOJI_PACK_TEMPLATE).expect("write emoji pack temp file");

        let config = crate::file_parser::parse_expansion_file(&path)
            .expect("emoji pack template must parse through file parser");
        let _ = std::fs::remove_file(&path);

        assert!(config.snippets.len() >= 10);
        assert!(config
            .snippets
            .iter()
            .any(|snippet| snippet.trigger == ":smile:"));
        assert!(config
            .snippets
            .iter()
            .any(|snippet| snippet.tags.iter().any(|tag| tag == "emoji")));
    }
}
