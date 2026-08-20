//! Normalizes a `sashiko-cli --format json` report into flat findings for VS Code diagnostics.
//!
//! The upstream report schema evolves between releases, so the walk is intentionally
//! structural: any object that looks like a finding is harvested, wherever it sits.

use std::io::Read;
use std::path::PathBuf;

use anyhow::Result;
use clap::Args;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Args)]
pub struct ParseArgs {
    /// Report file to read; stdin is used when omitted.
    #[arg(long)]
    pub input: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub file: Option<String>,
    pub line: Option<u32>,
    pub end_line: Option<u32>,
    pub severity: String,
    pub title: Option<String>,
    pub message: String,
    pub commit: Option<String>,
}

const FILE_KEYS: &[&str] = &["file", "file_path", "filename", "path"];
const LINE_KEYS: &[&str] = &["line", "line_number", "start_line", "lineno"];
const END_LINE_KEYS: &[&str] = &["end_line", "line_end", "last_line"];
const MESSAGE_KEYS: &[&str] = &["message", "description", "details", "body", "explanation"];
const TITLE_KEYS: &[&str] = &["title", "summary", "headline", "name"];
const COMMIT_KEYS: &[&str] = &["commit", "sha", "commit_id", "commit_sha"];

fn pick_str(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn pick_u32(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| match object.get(*key) {
        Some(Value::Number(number)) => number.as_u64().map(|value| value as u32),
        Some(Value::String(text)) => text.parse().ok(),
        _ => None,
    })
}

fn as_finding(object: &serde_json::Map<String, Value>) -> Option<Finding> {
    let severity = pick_str(object, &["severity", "level"])?;
    let message = pick_str(object, MESSAGE_KEYS).or_else(|| pick_str(object, TITLE_KEYS))?;

    Some(Finding {
        file: pick_str(object, FILE_KEYS),
        line: pick_u32(object, LINE_KEYS),
        end_line: pick_u32(object, END_LINE_KEYS),
        severity: severity.to_ascii_lowercase(),
        title: pick_str(object, TITLE_KEYS),
        message,
        commit: pick_str(object, COMMIT_KEYS),
    })
}

pub fn collect(value: &Value, commit: Option<&str>, out: &mut Vec<Finding>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect(item, commit, out);
            }
        }
        Value::Object(object) => {
            // Carry the nearest enclosing commit id down to findings that omit it.
            let commit = pick_str(object, COMMIT_KEYS)
                .filter(|value| value.len() >= 7)
                .or_else(|| commit.map(str::to_string));

            if let Some(mut finding) = as_finding(object) {
                if finding.commit.is_none() {
                    finding.commit = commit.clone();
                }
                out.push(finding);
                return;
            }
            for nested in object.values() {
                collect(nested, commit.as_deref(), out);
            }
        }
        _ => {}
    }
}

pub fn run(args: &ParseArgs) -> Result<()> {
    let raw = match &args.input {
        Some(path) => std::fs::read_to_string(path)?,
        None => {
            let mut buffer = String::new();
            std::io::stdin().read_to_string(&mut buffer)?;
            buffer
        }
    };

    let mut findings = Vec::new();
    // Sashiko interleaves logs with the report, so scan for the outermost JSON value.
    if let Some(value) = extract_json(&raw) {
        collect(&value, None, &mut findings);
    }

    println!("{}", serde_json::to_string(&findings)?);
    Ok(())
}

/// Finds the first balanced JSON object or array in a stream that may contain log noise.
fn extract_json(raw: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(raw.trim()) {
        return Some(value);
    }

    let bytes = raw.as_bytes();
    let start = bytes
        .iter()
        .position(|byte| *byte == b'{' || *byte == b'[')?;
    let mut deserializer = serde_json::Deserializer::from_str(&raw[start..]).into_iter::<Value>();
    deserializer.next()?.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn harvests_nested_findings_and_inherits_commit() {
        let report = json!({
            "patches": [{
                "commit": "0123456789abcdef",
                "review": {
                    "findings": [{
                        "severity": "High",
                        "file": "mm/slab.c",
                        "line": 42,
                        "message": "use-after-free"
                    }]
                }
            }]
        });

        let mut findings = Vec::new();
        collect(&report, None, &mut findings);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].severity, "high");
        assert_eq!(findings[0].commit.as_deref(), Some("0123456789abcdef"));
        assert_eq!(findings[0].line, Some(42));
    }

    #[test]
    fn skips_leading_log_noise() {
        let raw = "INFO starting review\n{\"severity\":\"low\",\"message\":\"nit\"}\n";
        let value = extract_json(raw).expect("json");
        let mut findings = Vec::new();
        collect(&value, None, &mut findings);
        assert_eq!(findings.len(), 1);
    }
}
