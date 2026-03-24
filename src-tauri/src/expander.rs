use std::collections::HashMap;
use crate::models::{Snippet, VariableDef};

pub async fn expand_snippet(
    snippet: &Snippet,
    form_values: Option<&HashMap<String, String>>,
) -> Result<String, String> {
    let variables: Vec<VariableDef> = serde_json::from_str(
        snippet.variables.as_deref().unwrap_or("[]")
    ).map_err(|e| e.to_string())?;

    let mut resolved: HashMap<String, String> = HashMap::new();

    for var in &variables {
        let value = match var.var_type.as_str() {
            "echo" => {
                var.params.get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
            "date" => resolve_date(&var.params)?,
            "clipboard" => resolve_clipboard()?,
            "shell" => resolve_shell(&var.params).await?,
            "form" => {
                form_values
                    .and_then(|fv| fv.get(&var.name))
                    .cloned()
                    .unwrap_or_else(|| {
                        var.params.get("default")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string()
                    })
            }
            "choice" => {
                form_values
                    .and_then(|fv| fv.get(&var.name))
                    .cloned()
                    .unwrap_or_default()
            }
            "random" => resolve_random(&var.params)?,
            _ => String::new(),
        };
        resolved.insert(var.name.clone(), value);
    }

    let mut result = snippet.body.clone();
    for (name, value) in &resolved {
        result = result.replace(&format!("{{{{{}}}}}", name), value);
    }
    result = result.replace("$|$", "");

    Ok(result)
}

fn resolve_date(params: &HashMap<String, serde_json::Value>) -> Result<String, String> {
    let format = params.get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("%Y-%m-%d");

    let offset_secs = params.get("offset")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let now = chrono::Utc::now() + chrono::Duration::seconds(offset_secs);
    Ok(now.format(format).to_string())
}

fn resolve_clipboard() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

async fn resolve_shell(params: &HashMap<String, serde_json::Value>) -> Result<String, String> {
    let cmd = params.get("cmd")
        .and_then(|v| v.as_str())
        .ok_or("Shell variable missing 'cmd' param")?;

    let output = tokio::process::Command::new("sh")
        .args(&["-c", cmd])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    // Trim trailing whitespace
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
    Ok(text)
}

fn resolve_random(params: &HashMap<String, serde_json::Value>) -> Result<String, String> {
    let values = params.get("values")
        .and_then(|v| v.as_array())
        .ok_or("Random variable missing 'values' param")?;

    if values.is_empty() {
        return Ok(String::new());
    }

    let idx = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos() as usize) % values.len();

    Ok(values[idx].as_str().unwrap_or("").to_string())
}
