//! API token storage through the signed key helper (macOS release builds).
//!
//! macOS ties "Always Allow" for a keychain entry to the exact program that
//! asked. Without an Apple team ID that is the hash of its code, so every new
//! build of this app would be asked for the token again. The helper
//! (`scripts/adversum/keyhelper/keyhelper.c`) is built once and then never
//! changes; `install.sh` puts it next to the app's executable. The token
//! travels through pipes, never through command-line arguments.
//!
//! Each function returns `None` when this build has no helper (debug builds,
//! ad-hoc builds, other platforms); the caller then uses the keyring crate
//! as upstream does.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const HELPER_NAME: &str = "kimaitray-keyhelper";
const EXIT_NO_ENTRY: i32 = 3;
const EXIT_UNTRUSTED: i32 = 4;

/// The helper next to the given executable, if there is one.
fn helper_beside(executable: &Path) -> Option<PathBuf> {
    let helper = executable.parent()?.join(HELPER_NAME);
    helper.is_file().then_some(helper)
}

fn helper() -> Option<PathBuf> {
    if !cfg!(all(target_os = "macos", not(debug_assertions))) {
        return None;
    }
    helper_beside(&std::env::current_exe().ok()?)
}

/// Runs the helper and returns its exit code and output.
fn run(
    helper: &Path,
    command: &str,
    account: &str,
    input: Option<&str>,
) -> Result<(i32, Vec<u8>), String> {
    let mut child = Command::new(helper)
        .arg(command)
        .arg(account)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Key helper did not start: {error}"))?;
    if let Some(input) = input {
        // Dropping the handle closes the pipe, which ends the helper's read.
        let mut stdin = child.stdin.take().ok_or("Key helper has no input")?;
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| format!("Key helper input failed: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Key helper failed: {error}"))?;
    Ok((output.status.code().unwrap_or(-1), output.stdout))
}

fn failure(code: i32) -> String {
    match code {
        EXIT_UNTRUSTED => "Key helper refused this build of the app".into(),
        code => format!("Key helper failed with status {code}"),
    }
}

fn read_outcome(code: i32, stdout: Vec<u8>) -> Result<Option<String>, String> {
    match code {
        0 => String::from_utf8(stdout)
            .map(Some)
            .map_err(|_| "Stored token is not valid text".to_string()),
        EXIT_NO_ENTRY => Ok(None),
        code => Err(failure(code)),
    }
}

fn write_outcome(code: i32) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(failure(code))
    }
}

fn read_with(helper: &Path, account: &str) -> Result<Option<String>, String> {
    let (code, stdout) = run(helper, "get", account, None)?;
    read_outcome(code, stdout)
}

pub(crate) fn read(account: &str) -> Option<Result<Option<String>, String>> {
    let helper = helper()?;
    Some(read_with(&helper, account))
}

/// Stores the token and reads it back, as upstream does with the keyring.
pub(crate) fn save(account: &str, token: &str) -> Option<Result<(), String>> {
    let helper = helper()?;
    let saved = run(&helper, "set", account, Some(token))
        .and_then(|(code, _)| write_outcome(code))
        .and_then(|()| read_with(&helper, account))
        .and_then(|stored| {
            if stored.as_deref() == Some(token) {
                Ok(())
            } else {
                Err("Credential verification failed".to_string())
            }
        });
    Some(saved)
}

pub(crate) fn delete(account: &str) -> Option<Result<(), String>> {
    let helper = helper()?;
    Some(run(&helper, "delete", account, None).and_then(|(code, _)| write_outcome(code)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_of_a_read_are_understood() {
        assert_eq!(
            read_outcome(0, b"secret".to_vec()),
            Ok(Some("secret".into()))
        );
        assert_eq!(read_outcome(EXIT_NO_ENTRY, Vec::new()), Ok(None));
        assert!(read_outcome(0, vec![0xff, 0xfe]).is_err());
        assert_eq!(
            read_outcome(EXIT_UNTRUSTED, Vec::new()),
            Err("Key helper refused this build of the app".into())
        );
        assert_eq!(
            read_outcome(5, b"ignored".to_vec()),
            Err("Key helper failed with status 5".into())
        );
    }

    #[test]
    fn exit_codes_of_a_write_are_understood() {
        assert_eq!(write_outcome(0), Ok(()));
        assert!(write_outcome(EXIT_UNTRUSTED).is_err());
        assert!(write_outcome(-1).is_err());
    }

    #[test]
    fn the_helper_is_looked_for_beside_the_executable() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("kimaitray");
        assert_eq!(helper_beside(&executable), None);
        std::fs::write(dir.path().join(HELPER_NAME), b"").unwrap();
        assert_eq!(
            helper_beside(&executable),
            Some(dir.path().join(HELPER_NAME))
        );
        // Test builds are debug builds and never use a helper.
        assert!(helper().is_none());
        assert!(read("account").is_none());
        assert!(save("account", "token").is_none());
        assert!(delete("account").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn tokens_travel_through_pipes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("helper.sh");
        // Stands in for the helper: "set" copies stdin to a file, "get"
        // prints the file, and the account must arrive as one argument.
        std::fs::write(
            &script,
            "#!/bin/sh\n[ \"$2\" = \"api-token:https://k.example\" ] || exit 2\n\
             store=\"$(dirname \"$0\")/store\"\n\
             case \"$1\" in\n  set) cat > \"$store\" ;;\n  get) [ -f \"$store\" ] || exit 3; cat \"$store\" ;;\n\
             delete) rm -f \"$store\" ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let account = "api-token:https://k.example";
        assert_eq!(read_with(&script, account), Ok(None));
        assert_eq!(run(&script, "set", account, Some("tök en")).unwrap().0, 0);
        assert_eq!(read_with(&script, account), Ok(Some("tök en".into())));
        assert_eq!(run(&script, "delete", account, None).unwrap().0, 0);
        assert_eq!(read_with(&script, account), Ok(None));
        assert_eq!(run(&script, "get", "other", None).unwrap().0, 2);
        assert!(run(&dir.path().join("missing"), "get", account, None).is_err());
    }
}
