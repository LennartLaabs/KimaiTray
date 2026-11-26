//! Language-model help for sentences that hold several entries.
//!
//! The rules in `src/adversum/multi/segment.ts` understand most such
//! sentences. Where they are unsure, a language model may extract the
//! activities; it never calculates, and what it returns is checked by the
//! frontend before use. Two models can do it, in this order:
//!
//! 1. Apple's on-device model, through the small Swift helper next to the
//!    executable (`scripts/adversum/extract/`). Nothing leaves the Mac.
//! 2. The Claude Code command line with the user's own subscription
//!    (`claude -p`), unless the setting restricts help to this Mac. This
//!    sends the sentence to Anthropic. No API key is involved.
//!
//! Only the sentence is handed over, never the list of customers.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, WebviewWindow};

pub(crate) const MODE_KEY: &str = "multiModel";
const APPLE_HELPER: &str = "kimaitray-extract";
const TIMEOUT: Duration = Duration::from_secs(40);
const MAX_SENTENCE_CHARS: usize = 2_000;
const MAX_PROMPT_CHARS: usize = 8_000;

pub(crate) fn valid_mode(mode: &str) -> bool {
    matches!(mode, "auto" | "device" | "off")
}

fn mode(settings: &Map<String, Value>) -> &str {
    settings
        .get(MODE_KEY)
        .and_then(Value::as_str)
        .filter(|mode| valid_mode(mode))
        .unwrap_or("auto")
}

fn apple_helper() -> Option<PathBuf> {
    let helper = std::env::current_exe().ok()?.parent()?.join(APPLE_HELPER);
    helper.is_file().then_some(helper)
}

/// Where the Claude Code command line is usually installed. An app started
/// from the Finder does not have the shell's search path.
fn claude_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".claude/local/claude"));
    }
    candidates
}

fn claude_cli() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    claude_candidates(home.as_deref())
        .into_iter()
        .find(|path| path.is_file())
}

/// Runs a program with `input` on its standard input and returns whether it
/// succeeded and what it printed. A program that takes too long is ended.
fn run(command: &mut Command, input: &str, timeout: Duration) -> Result<(bool, String), String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("did not start: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // Dropping the handle closes the pipe, which ends the program's read.
        let _ = stdin.write_all(input.as_bytes());
    }
    let mut stdout = child.stdout.take().ok_or("no output")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("took too long".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    let output = reader.join().map_err(|_| "output could not be read")?;
    Ok((status.success(), output))
}

/// "available", "missing" (this build has no helper) or the reason the
/// on-device model cannot be used, as the helper states it.
fn apple_status() -> String {
    let Some(helper) = apple_helper() else {
        return "missing".into();
    };
    match run(
        Command::new(helper).arg("--check"),
        "",
        Duration::from_secs(10),
    ) {
        Ok((true, _)) => "available".into(),
        Ok((false, reason)) if !reason.trim().is_empty() => reason.trim().to_string(),
        Ok((false, _)) => "unavailable".into(),
        Err(error) => error,
    }
}

/// The answer inside what `claude -p --output-format json` prints: the
/// structured output when a schema was given, else the text.
pub(crate) fn claude_answer(printed: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(printed.trim()).map_err(|_| "Claude Code gave no JSON".to_string())?;
    let text = value.get("result").and_then(Value::as_str).unwrap_or("");
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(format!("Claude Code: {text}"));
    }
    match value.get("structured_output") {
        Some(structured) if structured.is_object() => Ok(structured.to_string()),
        _ if !text.is_empty() => Ok(text.to_string()),
        _ => Err("Claude Code gave no answer".into()),
    }
}

fn ask_apple(helper: &Path, sentence: &str, instructions: &str) -> Result<String, String> {
    match run(Command::new(helper).arg(instructions), sentence, TIMEOUT)? {
        (true, output) if !output.trim().is_empty() => Ok(output),
        (_, output) => Err(format!("on-device model: {}", output.trim())),
    }
}

fn ask_claude(
    cli: &Path,
    sentence: &str,
    instructions: &str,
    schema: &str,
) -> Result<String, String> {
    let mut command = Command::new(cli);
    command
        .args(["-p", "--model", "haiku", "--tools", ""])
        .args(["--no-session-persistence", "--strict-mcp-config"])
        .args(["--disable-slash-commands", "--setting-sources", ""])
        .args(["--output-format", "json", "--json-schema", schema])
        .args(["--system-prompt", instructions])
        // No project around it: nothing of a repository is read or sent.
        .current_dir(std::env::temp_dir());
    if let Some(directory) = cli.parent() {
        let path = std::env::var("PATH").unwrap_or_default();
        command.env(
            "PATH",
            format!("{}:/usr/bin:/bin:{path}", directory.display()),
        );
    }
    let (_, printed) = run(&mut command, sentence, TIMEOUT)?;
    claude_answer(&printed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiStatus {
    mode: String,
    apple: String,
    claude: bool,
}

/// Which language models could help on this machine.
#[tauri::command]
pub async fn adversum_multi_status(app: AppHandle) -> Result<MultiStatus, String> {
    let mode = mode(&super::settings::read(&app)).to_string();
    tauri::async_runtime::spawn_blocking(move || MultiStatus {
        mode,
        apple: apple_status(),
        claude: claude_cli().is_some(),
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Serialize)]
pub struct MultiAnswer {
    /// "apple" or "claude".
    provider: &'static str,
    /// The model's answer, JSON as text. Checked by the frontend.
    output: String,
}

/// Asks a language model for the activities in a sentence. `None` when the
/// setting forbids it or no model is there or willing.
#[tauri::command]
pub async fn adversum_multi_extract(
    app: AppHandle,
    window: WebviewWindow,
    sentence: String,
    instructions: String,
    schema: String,
) -> Result<Option<MultiAnswer>, String> {
    if window.label() != super::quick::WINDOW_LABEL {
        return Err("Window is not authorized to ask a language model".into());
    }
    if sentence.chars().count() > MAX_SENTENCE_CHARS
        || instructions.chars().count() > MAX_PROMPT_CHARS
        || schema.chars().count() > MAX_PROMPT_CHARS
    {
        return Err("Too much text for the language model".into());
    }
    let mode = mode(&super::settings::read(&app)).to_string();
    if mode == "off" {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(helper) = apple_helper() {
            match ask_apple(&helper, &sentence, &instructions) {
                Ok(output) => {
                    return Some(MultiAnswer {
                        provider: "apple",
                        output,
                    })
                }
                Err(error) => log::info!("Several entries: {error}"),
            }
        }
        if mode != "auto" {
            return None;
        }
        let cli = claude_cli()?;
        match ask_claude(&cli, &sentence, &instructions, &schema) {
            Ok(output) => Some(MultiAnswer {
                provider: "claude",
                output,
            }),
            Err(error) => {
                log::info!("Several entries: {error}");
                None
            }
        }
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_mode_defaults_to_auto_and_ignores_nonsense() {
        let settings = |value: Value| value.as_object().cloned().unwrap();
        assert_eq!(mode(&settings(json!({}))), "auto");
        assert_eq!(mode(&settings(json!({"multiModel": "device"}))), "device");
        assert_eq!(mode(&settings(json!({"multiModel": "off"}))), "off");
        assert_eq!(mode(&settings(json!({"multiModel": "cloud"}))), "auto");
        assert_eq!(mode(&settings(json!({"multiModel": 3}))), "auto");
        assert!(valid_mode("auto") && !valid_mode(""));
    }

    #[test]
    fn claude_is_looked_for_where_it_is_installed() {
        let with_home = claude_candidates(Some(Path::new("/Users/someone")));
        assert!(with_home.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
        assert!(with_home.contains(&PathBuf::from("/Users/someone/.local/bin/claude")));
        assert_eq!(claude_candidates(None).len(), 2);
    }

    #[test]
    fn the_answer_is_taken_from_what_claude_prints() {
        let structured = json!({"is_error": false, "result": "",
            "structured_output": {"window_minutes": 0, "activities": []}});
        assert_eq!(
            claude_answer(&structured.to_string()).unwrap(),
            r#"{"activities":[],"window_minutes":0}"#
        );
        let text = json!({"is_error": false, "result": "{\"activities\":[]}"});
        assert_eq!(
            claude_answer(&text.to_string()).unwrap(),
            "{\"activities\":[]}"
        );
        let failed = json!({"is_error": true, "result": "Failed to authenticate"});
        assert_eq!(
            claude_answer(&failed.to_string()).unwrap_err(),
            "Claude Code: Failed to authenticate"
        );
        assert!(claude_answer("not json").is_err());
        assert!(claude_answer("{}").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_program_gets_its_input_and_is_ended_when_it_hangs() {
        let (ok, output) = run(&mut Command::new("/bin/cat"), "hallo", TIMEOUT).unwrap();
        assert!(ok);
        assert_eq!(output, "hallo");
        let (ok, _) = run(&mut Command::new("/usr/bin/false"), "", TIMEOUT).unwrap();
        assert!(!ok);
        let hung = run(
            Command::new("/bin/sleep").arg("5"),
            "",
            Duration::from_millis(150),
        );
        assert_eq!(hung.unwrap_err(), "took too long");
        assert!(run(&mut Command::new("/nonexistent/program"), "", TIMEOUT).is_err());
    }
}
