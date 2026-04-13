use std::path::{Path, PathBuf};

use crate::file_parser;

pub const KAOMOJI_PACK_MANAGED_KEY: &str = "builtin:kaomoji-pack";
pub const KAOMOJI_PACK_NAME: &str = "Kaomoji Pack";
pub const KAOMOJI_PACK_VERSION: &str = "1.0.0";
pub const KAOMOJI_PACK_FILE_NAME: &str = "kaomoji-pack.toml";
pub const KAOMOJI_PACK_TEMPLATE: &str = include_str!("../templates/kaomoji-pack.toml");

pub fn kaomoji_pack_path(expansions_dir: &Path) -> PathBuf {
    expansions_dir.join(KAOMOJI_PACK_FILE_NAME)
}

pub fn kaomoji_pack_count() -> Result<usize, String> {
    let config: file_parser::ExpansionConfig =
        toml::from_str(KAOMOJI_PACK_TEMPLATE).map_err(|e| e.to_string())?;
    Ok(config.snippets.len())
}

pub fn write_kaomoji_pack_file(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create kaomoji pack dir: {}", e))?;
    }
    std::fs::write(path, KAOMOJI_PACK_TEMPLATE)
        .map_err(|e| format!("Failed to write kaomoji pack file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kaomoji_pack_template_parses_and_contains_kaomoji() {
        let path = std::env::temp_dir()
            .join(format!("dispatch-kaomoji-pack-{}.toml", uuid::Uuid::new_v4()));
        std::fs::write(&path, KAOMOJI_PACK_TEMPLATE).expect("write kaomoji pack temp file");

        let config = crate::file_parser::parse_expansion_file(&path)
            .expect("kaomoji pack template must parse through file parser");
        let _ = std::fs::remove_file(&path);

        assert!(config.snippets.len() >= 80);
        assert!(config
            .snippets
            .iter()
            .any(|snippet| snippet.trigger == ":shrug:"));
        assert!(config
            .snippets
            .iter()
            .any(|snippet| snippet.tags.iter().any(|tag| tag == "kaomoji")));
    }
}
