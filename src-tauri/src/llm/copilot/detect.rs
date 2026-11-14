//! Locate the official GitHub Copilot CLI, read its version and build the
//! restricted `copilot --acp --stdio` launch.
//!
//! Nothing here reads a credential: the sign-in state is whatever the CLI
//! itself reports over ACP (see `hub.rs`).

use super::acp::SpawnSpec;
use std::path::{Path, PathBuf};
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Shown wherever the CLI is not signed in. Sign-in is the CLI's own flow.
pub const LOGIN_HINT: &str = "Run `copilot login` in a terminal and finish the sign-in there, \
then check the connection again. NexQ never sees your GitHub credentials.";

/// Shown when no `copilot` executable was found.
pub const INSTALL_HINT: &str = "Install the GitHub Copilot CLI (https://docs.github.com/en/copilot/how-tos/copilot-cli), \
then run `copilot login` in a terminal.";

/// Server options that keep Copilot from doing anything but answering.
/// * `--available-tools` with a name that is no tool leaves the model no
///   tool at all (built-in, MCP and plugin tools alike);
/// * the `--deny-tool` kinds refuse shell, file writes and URL access even if
///   a tool were exposed;
/// * no repo/user instructions, no built-in MCP servers, no questions to the
///   user, no self-update, no experimental features, no log files.
/// On top of this the ACP client refuses every permission request and aborts
/// a turn that starts a tool call.
pub fn restricted_args() -> Vec<String> {
    [
        "--acp",
        "--stdio",
        "--available-tools=nexq-no-tools",
        "--deny-tool=shell",
        "--deny-tool=write",
        "--deny-tool=url",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--no-ask-user",
        "--no-auto-update",
        "--no-experimental",
        "--log-level=none",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Environment variables removed from the child: they would approve tools
/// automatically or send the chat to another model provider than GitHub
/// Copilot. The user's own sign-in (and `GH_TOKEN`-style tokens the official
/// CLI honours) are left alone.
pub const STRIPPED_ENV: [&str; 12] = [
    "COPILOT_ALLOW_ALL",
    "COPILOT_OFFLINE",
    "COPILOT_MODEL",
    "COPILOT_PROVIDERS_CONFIG",
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_API_KEY_COMMAND",
    "COPILOT_PROVIDER_BEARER_TOKEN",
    "COPILOT_PROVIDER_WIRE_API",
    "COPILOT_PROVIDER_MODEL_ID",
    "COPILOT_PROVIDER_WIRE_MODEL",
];

/// `%LOCALAPPDATA%\NexQ\copilot-sandbox`: the empty working directory Copilot runs in.
pub fn sandbox_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("NexQ").join("copilot-sandbox")
}

/// The launch of the real CLI at `bin`.
pub fn launch_spec(bin: &Path) -> SpawnSpec {
    SpawnSpec {
        program: bin.to_path_buf(),
        args: restricted_args(),
        cwd: sandbox_dir(),
        remove_env: STRIPPED_ENV.iter().map(|s| s.to_string()).collect(),
        set_env: vec![
            ("COPILOT_AUTO_UPDATE".to_string(), "false".to_string()),
            ("NO_COLOR".to_string(), "1".to_string()),
        ],
    }
}

/// Find `copilot.exe`: the installer location, the WinGet link, then `where.exe`.
#[cfg(windows)]
pub fn find_copilot_binary() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        for candidate in [
            local.join("Programs").join("GitHubCopilotCLI").join("copilot.exe"),
            local.join("Microsoft").join("WinGet").join("Links").join("copilot.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    first_line_ending(&where_copilot()?, ".exe")
}

/// An npm install of the CLI (`copilot.cmd`). NexQ spawns executables
/// directly, never through a shell, so it cannot use that shim.
#[cfg(windows)]
pub fn find_npm_copilot() -> Option<PathBuf> {
    first_line_ending(&where_copilot()?, ".cmd")
}

#[cfg(windows)]
fn where_copilot() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("where.exe");
    cmd.arg("copilot").creation_flags(0x0800_0000);
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// First `where.exe` line ending in `ext` (case-insensitive).
#[cfg(windows)]
fn first_line_ending(stdout: &str, ext: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().ends_with(ext))
        .map(PathBuf::from)
}

/// Find `copilot` in the usual user install folders, then on PATH.
#[cfg(unix)]
pub fn find_copilot_binary() -> Option<PathBuf> {
    find_copilot_in(std::env::var_os("HOME").as_deref(), std::env::var_os("PATH").as_deref())
}

#[cfg(unix)]
fn find_copilot_in(
    home: Option<&std::ffi::OsStr>,
    path: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    if let Some(home) = home {
        let p = Path::new(home).join(".local").join("bin").join("copilot");
        if is_executable_file(&p) {
            return Some(p);
        }
    }
    std::env::split_paths(path?)
        .map(|dir| dir.join("copilot"))
        .find(|p| is_executable_file(p))
}

#[cfg(unix)]
pub fn find_npm_copilot() -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// The version out of `copilot --version` output
/// ("GitHub Copilot CLI 1.0.105.\nRun 'copilot update' ..."): the first
/// dotted number of the first non-empty line, else that line.
pub fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let number = line
        .split_whitespace()
        .map(|w| w.trim_end_matches(|c: char| c == '.' || c == ','))
        .find(|w| w.contains('.') && w.chars().next().is_some_and(|c| c.is_ascii_digit()));
    Some(number.unwrap_or(line).to_string())
}

/// `copilot --version` (15 s timeout, no console window).
pub async fn copilot_version(bin: &Path) -> Result<String, String> {
    let mut std_cmd = std::process::Command::new(bin);
    std_cmd.arg("--version").env("COPILOT_AUTO_UPDATE", "false");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(0x0800_0000);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "`copilot --version` timed out after 15 s".to_string())?
        .map_err(|e| format!("failed to run `copilot --version`: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_version(&stdout).ok_or_else(|| {
        format!(
            "`copilot --version` printed nothing: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })
}

/// Working directory and `cmd.exe` command line that open a visible console
/// running `copilot login` (kept open by `/k` so the user sees the result).
/// The binary's folder becomes the working directory and the command names it
/// as `.\copilot.exe`, so a path with `&`, `%` or spaces never goes through
/// cmd's parser. Without a resolved binary, `copilot` comes from PATH.
pub fn login_launch(bin: Option<&Path>) -> (Option<PathBuf>, String) {
    let dir = bin
        .and_then(Path::parent)
        .filter(|d| !d.as_os_str().is_empty());
    let exe = if dir.is_some() { r".\copilot.exe" } else { "copilot" };
    (
        dir.map(Path::to_path_buf),
        format!(r#"/d /c start "Copilot login" cmd.exe /k {exe} login"#),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_args_disable_every_tool_and_side_channel() {
        let args = restricted_args();
        assert_eq!(&args[..2], ["--acp", "--stdio"]);
        for flag in [
            "--available-tools=nexq-no-tools",
            "--deny-tool=shell",
            "--deny-tool=write",
            "--deny-tool=url",
            "--no-custom-instructions",
            "--disable-builtin-mcps",
            "--no-ask-user",
            "--no-auto-update",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        // Nothing may ever grant permissions.
        for forbidden in ["--allow-all", "--yolo", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls"] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden} must not be passed");
        }
        assert!(!args.iter().any(|a| a.starts_with("--allow-tool") || a.starts_with("--autopilot")));
    }

    #[test]
    fn launch_spec_strips_env_that_would_approve_tools_or_reroute_the_chat() {
        let spec = launch_spec(Path::new("copilot.exe"));
        assert!(spec.remove_env.iter().any(|k| k == "COPILOT_ALLOW_ALL"));
        assert!(spec.remove_env.iter().any(|k| k == "COPILOT_PROVIDER_BASE_URL"));
        // The user's own auth tokens are not touched.
        assert!(!spec.remove_env.iter().any(|k| k.contains("GITHUB_TOKEN") || k == "GH_TOKEN"));
        assert!(spec.set_env.iter().any(|(k, v)| k == "COPILOT_AUTO_UPDATE" && v == "false"));
        assert!(spec.cwd.ends_with("copilot-sandbox"));
    }

    #[test]
    fn version_is_parsed_from_the_cli_banner() {
        assert_eq!(
            parse_version("GitHub Copilot CLI 1.0.105.\nRun 'copilot update' to check for updates.\n").as_deref(),
            Some("1.0.105")
        );
        assert_eq!(parse_version("\n  2.3.4  \n").as_deref(), Some("2.3.4"));
        assert_eq!(parse_version("weird output").as_deref(), Some("weird output"));
        assert_eq!(parse_version("  \n"), None);
    }

    #[test]
    fn login_launch_keeps_the_path_out_of_cmd() {
        let bin = Path::new(r"C:\Users\Tom&Jerry 100%\AppData\copilot.exe");
        let (dir, line) = login_launch(Some(bin));
        assert_eq!(dir.as_deref(), Some(Path::new(r"C:\Users\Tom&Jerry 100%\AppData")));
        assert_eq!(line, r#"/d /c start "Copilot login" cmd.exe /k .\copilot.exe login"#);
        assert!(!line.contains('&') && !line.contains('%'));
        let (dir, line) = login_launch(None);
        assert_eq!(dir, None);
        assert_eq!(line, r#"/d /c start "Copilot login" cmd.exe /k copilot login"#);
    }

    #[cfg(windows)]
    #[test]
    fn where_output_picks_the_exe_and_flags_an_npm_shim() {
        let out = "C:\\npm\\copilot\r\nC:\\npm\\copilot.cmd\r\nC:\\bin\\COPILOT.EXE\r\n";
        assert_eq!(first_line_ending(out, ".exe"), Some(PathBuf::from("C:\\bin\\COPILOT.EXE")));
        assert_eq!(first_line_ending("C:\\npm\\copilot.cmd\r\n", ".exe"), None);
        assert_eq!(first_line_ending("C:\\npm\\copilot.CMD\r\n", ".cmd"), Some(PathBuf::from("C:\\npm\\copilot.CMD")));
    }
}
