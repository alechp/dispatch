use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct ExpansionConfig {
    pub name: Option<String>,
    pub snippets: Vec<ParsedSnippet>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParsedSnippet {
    pub trigger: String,
    pub label: Option<String>,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub variables: Vec<ParsedVariable>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParsedVariable {
    pub name: String,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(default)]
    pub params: std::collections::HashMap<String, serde_json::Value>,
}

/// Parse a single YAML expansion config file.
pub fn parse_expansion_file(path: &Path) -> Result<ExpansionConfig, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let config: ExpansionConfig = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
    Ok(config)
}

/// Parse all YAML files in a folder.
pub fn parse_expansion_folder(path: &Path) -> Result<Vec<(String, ExpansionConfig)>, String> {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }

    let mut results = Vec::new();
    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory {}: {}", path.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_path = entry.path();
        if let Some(ext) = file_path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ext_str == "yml" || ext_str == "yaml" {
                match parse_expansion_file(&file_path) {
                    Ok(config) => {
                        let filename = file_path.file_name()
                            .map(|f| f.to_string_lossy().to_string())
                            .unwrap_or_default();
                        results.push((filename, config));
                    }
                    Err(e) => {
                        eprintln!("[file_parser] skipping {}: {}", file_path.display(), e);
                    }
                }
            }
        }
    }

    Ok(results)
}

/// Convert parsed variables to JSON string for storage.
pub fn variables_to_json(vars: &[ParsedVariable]) -> Option<String> {
    if vars.is_empty() {
        return None;
    }
    // Convert to the format expected by the DB (matching VariableDef)
    let json_vars: Vec<serde_json::Value> = vars.iter().map(|v| {
        serde_json::json!({
            "name": v.name,
            "type": v.var_type,
            "params": v.params,
        })
    }).collect();
    Some(serde_json::to_string(&json_vars).unwrap_or_else(|_| "[]".to_string()))
}

/// Convert tags to JSON string for storage.
pub fn tags_to_json(tags: &[String]) -> Option<String> {
    if tags.is_empty() {
        return None;
    }
    Some(serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string()))
}
