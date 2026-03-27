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

#[cfg(test)]
mod tests {
    use super::*;

    const BOILERPLATE_TEMPLATE: &str = include_str!("../templates/dispatch-snippets.yml");

    #[test]
    fn boilerplate_template_parses() {
        // Substitute placeholder so YAML is valid
        let yaml = BOILERPLATE_TEMPLATE.replace("{PACKAGE_NAME}", "test-package");
        let config: ExpansionConfig = serde_yaml::from_str(&yaml)
            .expect("Boilerplate template must parse as valid YAML");

        assert!(config.snippets.len() >= 5, "Template should have at least 5 example snippets");
        assert_eq!(config.name.as_deref(), Some("test-package"));

        // Verify each snippet has required fields
        for snippet in &config.snippets {
            assert!(!snippet.trigger.is_empty(), "Trigger must not be empty: {:?}", snippet);
            assert!(!snippet.body.is_empty(), "Body must not be empty: {:?}", snippet);
        }

        // Verify variable types are represented
        let var_types: Vec<&str> = config.snippets.iter()
            .flat_map(|s| s.variables.iter().map(|v| v.var_type.as_str()))
            .collect();
        assert!(var_types.contains(&"date"), "Should have date variable example");
        assert!(var_types.contains(&"shell"), "Should have shell variable example");
        assert!(var_types.contains(&"form"), "Should have form variable example");
        assert!(var_types.contains(&"choice"), "Should have choice variable example");
        assert!(var_types.contains(&"clipboard"), "Should have clipboard variable example");
    }

    #[test]
    fn variables_to_json_round_trip() {
        let vars = vec![
            ParsedVariable {
                name: "test".to_string(),
                var_type: "echo".to_string(),
                params: {
                    let mut m = std::collections::HashMap::new();
                    m.insert("value".to_string(), serde_json::json!("hello"));
                    m
                },
            },
        ];
        let json = variables_to_json(&vars).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["name"], "test");
        assert_eq!(parsed[0]["type"], "echo");
    }
}
