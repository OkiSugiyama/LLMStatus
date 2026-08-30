use std::fs;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", windows))]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::process::Stdio;

use thiserror::Error;

use crate::settings::{AdapterKind, AppSettings};

const CLAUDE_REFRESH_PROMPT: &str = "Reply only with OK.";
const WORKSPACE_DIRECTORY_NAME: &str = "claude-workspace";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClaudeTerminalError {
    #[error("save and enable this account first")]
    AccountUnavailable,
    #[error("account is not configured for Claude statusLine")]
    WrongAdapter,
    #[error("select a Claude profile in Settings first")]
    ProfileRequired,
    #[error("the selected Claude profile directory is unavailable")]
    ProfileUnavailable,
    #[error("the LLMStatus refresh workspace could not be prepared")]
    WorkspaceUnavailable,
    #[cfg(any(windows, test))]
    #[error("the standard Windows PowerShell host is unavailable")]
    PowerShellUnavailable,
    #[cfg(any(not(any(target_os = "macos", windows)), test))]
    #[error("opening Claude in Terminal is supported only on macOS and Windows")]
    UnsupportedPlatform,
    #[error("Claude could not be opened in Terminal")]
    LaunchFailed,
}

#[derive(Debug, PartialEq, Eq)]
struct LaunchPlan {
    program: String,
    arguments: Vec<String>,
}

#[derive(Debug, Clone)]
enum TerminalPlatform {
    #[cfg(any(target_os = "macos", test))]
    MacOs,
    #[cfg(any(windows, test))]
    Windows { system_directory: String },
    #[cfg(any(not(any(target_os = "macos", windows)), test))]
    Unsupported,
}

pub fn launch(
    settings: &AppSettings,
    account_id: &str,
    executable: &Path,
) -> Result<(), ClaudeTerminalError> {
    let plan = launch_plan_for_current_platform(settings, account_id, executable)?;
    execute_launch_plan(plan)
}

pub(crate) fn profile_is_usable(config_dir: Option<&str>) -> bool {
    validate_profile_dir(config_dir).is_ok()
}

fn launch_plan_for_account(
    settings: &AppSettings,
    account_id: &str,
    executable: &Path,
    workspace_dir: &str,
    platform: TerminalPlatform,
) -> Result<LaunchPlan, ClaudeTerminalError> {
    let account = settings
        .account(account_id)
        .filter(|account| account.enabled)
        .ok_or(ClaudeTerminalError::AccountUnavailable)?;
    if account.adapter_kind != AdapterKind::ClaudeStatusLine {
        return Err(ClaudeTerminalError::WrongAdapter);
    }

    let config_dir = validate_profile_dir(account.config_dir.as_deref())?;
    let temporary_settings =
        crate::claude_temporary_settings(executable, &account.id, account.source_revision)
            .map_err(|_| ClaudeTerminalError::LaunchFailed)?;
    match platform {
        #[cfg(any(target_os = "macos", test))]
        TerminalPlatform::MacOs => Ok(macos_launch_plan(
            config_dir,
            workspace_dir,
            &temporary_settings,
        )),
        #[cfg(any(windows, test))]
        TerminalPlatform::Windows { system_directory } => windows_launch_plan(
            &system_directory,
            config_dir,
            workspace_dir,
            &temporary_settings,
        ),
        #[cfg(any(not(any(target_os = "macos", windows)), test))]
        TerminalPlatform::Unsupported => Err(ClaudeTerminalError::UnsupportedPlatform),
    }
}

fn validate_profile_dir(config_dir: Option<&str>) -> Result<&str, ClaudeTerminalError> {
    let config_dir = config_dir.ok_or(ClaudeTerminalError::ProfileRequired)?;
    let path = Path::new(config_dir);
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ClaudeTerminalError::ProfileUnavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ClaudeTerminalError::ProfileUnavailable);
    }
    Ok(config_dir)
}

/// The fixed application-owned directory every refresh session runs in.
///
/// Claude Code records workspace trust per configuration directory and working
/// directory, and it never persists trust for a home directory. A terminal
/// window opens in the home directory, so launching there would leave the
/// workspace trust dialog in front of every session and the status line command
/// would never run. A stable directory below the LLMStatus data root keeps that
/// decision to one explicit human acceptance per Claude profile.
fn workspace_dir() -> Result<PathBuf, ClaudeTerminalError> {
    let root = match crate::storage::test_data_root() {
        Ok(Some(root)) => root,
        Ok(None) => dirs::data_local_dir()
            .map(|root| root.join("LLMStatus"))
            .ok_or(ClaudeTerminalError::WorkspaceUnavailable)?,
        Err(()) => return Err(ClaudeTerminalError::WorkspaceUnavailable),
    };
    Ok(root.join(WORKSPACE_DIRECTORY_NAME))
}

fn prepare_workspace_dir() -> Result<String, ClaudeTerminalError> {
    let path = workspace_dir()?;
    fs::create_dir_all(&path).map_err(|_| ClaudeTerminalError::WorkspaceUnavailable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o700));
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| ClaudeTerminalError::WorkspaceUnavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ClaudeTerminalError::WorkspaceUnavailable);
    }
    path.into_os_string()
        .into_string()
        .map_err(|_| ClaudeTerminalError::WorkspaceUnavailable)
}

#[cfg(target_os = "macos")]
fn launch_plan_for_current_platform(
    settings: &AppSettings,
    account_id: &str,
    executable: &Path,
) -> Result<LaunchPlan, ClaudeTerminalError> {
    let workspace_dir = prepare_workspace_dir()?;
    launch_plan_for_account(
        settings,
        account_id,
        executable,
        &workspace_dir,
        TerminalPlatform::MacOs,
    )
}

#[cfg(windows)]
fn launch_plan_for_current_platform(
    settings: &AppSettings,
    account_id: &str,
    executable: &Path,
) -> Result<LaunchPlan, ClaudeTerminalError> {
    let system_directory = windows_system_directory()?;
    let workspace_dir = prepare_workspace_dir()?;
    launch_plan_for_account(
        settings,
        account_id,
        executable,
        &workspace_dir,
        TerminalPlatform::Windows { system_directory },
    )
}

#[cfg(not(any(target_os = "macos", windows)))]
fn launch_plan_for_current_platform(
    settings: &AppSettings,
    account_id: &str,
    executable: &Path,
) -> Result<LaunchPlan, ClaudeTerminalError> {
    let workspace_dir = prepare_workspace_dir()?;
    launch_plan_for_account(
        settings,
        account_id,
        executable,
        &workspace_dir,
        TerminalPlatform::Unsupported,
    )
}

#[cfg(target_os = "macos")]
fn execute_launch_plan(plan: LaunchPlan) -> Result<(), ClaudeTerminalError> {
    let status = Command::new(plan.program)
        .args(plan.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ClaudeTerminalError::LaunchFailed)?;
    if status.success() {
        Ok(())
    } else {
        Err(ClaudeTerminalError::LaunchFailed)
    }
}

#[cfg(windows)]
fn execute_launch_plan(plan: LaunchPlan) -> Result<(), ClaudeTerminalError> {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    Command::new(plan.program)
        .args(plan.arguments)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|_| ClaudeTerminalError::LaunchFailed)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn execute_launch_plan(_plan: LaunchPlan) -> Result<(), ClaudeTerminalError> {
    Err(ClaudeTerminalError::UnsupportedPlatform)
}

/// Terminal runs the whole invocation, including the refresh prompt, as one
/// argument-passed shell command. Nothing is typed into the session, so no
/// dialog Claude may show can absorb synthetic input and the launch needs no
/// macOS Accessibility permission.
#[cfg(any(target_os = "macos", test))]
fn macos_launch_plan(
    config_dir: &str,
    workspace_dir: &str,
    temporary_settings: &str,
) -> LaunchPlan {
    LaunchPlan {
        program: "/usr/bin/osascript".to_owned(),
        arguments: vec![
            "-e".to_owned(),
            "on run argv".to_owned(),
            "-e".to_owned(),
            "tell application \"Terminal\"".to_owned(),
            "-e".to_owned(),
            "activate".to_owned(),
            "-e".to_owned(),
            "do script (item 1 of argv)".to_owned(),
            "-e".to_owned(),
            "end tell".to_owned(),
            "-e".to_owned(),
            "end run".to_owned(),
            "--".to_owned(),
            posix_shell_command(config_dir, workspace_dir, temporary_settings),
        ],
    }
}

#[cfg(any(windows, test))]
fn windows_launch_plan(
    system_directory: &str,
    config_dir: &str,
    workspace_dir: &str,
    temporary_settings: &str,
) -> Result<LaunchPlan, ClaudeTerminalError> {
    Ok(LaunchPlan {
        program: windows_powershell_path(system_directory)?,
        arguments: vec![
            "-NoLogo".to_owned(),
            "-NoProfile".to_owned(),
            "-NoExit".to_owned(),
            "-Command".to_owned(),
            powershell_command(config_dir, workspace_dir, temporary_settings),
        ],
    })
}

#[cfg(any(windows, test))]
fn windows_powershell_path(system_directory: &str) -> Result<String, ClaudeTerminalError> {
    let directory = system_directory.trim_end_matches(['\\', '/']);
    let bytes = directory.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if directory.is_empty() || !drive_absolute || directory.chars().any(char::is_control) {
        return Err(ClaudeTerminalError::PowerShellUnavailable);
    }
    Ok(format!(
        r"{directory}\WindowsPowerShell\v1.0\powershell.exe"
    ))
}

#[cfg(windows)]
fn windows_system_directory() -> Result<String, ClaudeTerminalError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "GetSystemDirectoryW"]
        fn get_system_directory_w(buffer: *mut u16, size: u32) -> u32;
    }

    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: `buffer` is writable for `buffer.len()` UTF-16 code units and the
    // returned length is checked before a slice is created.
    let length =
        unsafe { get_system_directory_w(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(ClaudeTerminalError::PowerShellUnavailable);
    }
    OsString::from_wide(&buffer[..length])
        .into_string()
        .map_err(|_| ClaudeTerminalError::PowerShellUnavailable)
}

/// `--setting-sources=` keeps the profile's own user, project, and local
/// settings out of the launch so an existing status line cannot replace the
/// generated one. Authentication is deliberately left untouched: the Claude
/// plan rate limits this app reads exist only for a subscription session, so
/// no flag that forces API-key authentication may be added here.
#[cfg(any(target_os = "macos", test))]
fn posix_shell_command(config_dir: &str, workspace_dir: &str, temporary_settings: &str) -> String {
    format!(
        "cd {} && /usr/bin/env CLAUDE_CONFIG_DIR={} claude --setting-sources= --settings {} --strict-mcp-config --tools= -- {}",
        quote_posix(workspace_dir),
        quote_posix(config_dir),
        quote_posix(temporary_settings),
        quote_posix(CLAUDE_REFRESH_PROMPT),
    )
}

#[cfg(any(target_os = "macos", test))]
fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(any(windows, test))]
fn powershell_command(config_dir: &str, workspace_dir: &str, temporary_settings: &str) -> String {
    format!(
        "Set-Location -LiteralPath {} -ErrorAction Stop; $env:CLAUDE_CONFIG_DIR = {}; & claude --setting-sources= --settings {} --strict-mcp-config --tools= -- {}",
        quote_powershell(workspace_dir),
        quote_powershell(config_dir),
        quote_powershell(temporary_settings),
        quote_powershell(CLAUDE_REFRESH_PROMPT),
    )
}

#[cfg(any(windows, test))]
fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{AccountConfig, AppSettings};

    const SYNTHETIC_WORKSPACE: &str = "/synthetic/data root/LLMStatus/claude-workspace";

    fn account(
        id: &str,
        adapter_kind: AdapterKind,
        enabled: bool,
        config_dir: Option<String>,
    ) -> AccountConfig {
        AccountConfig {
            id: id.to_owned(),
            label: "Saved label; $not-command".to_owned(),
            adapter_kind,
            enabled,
            source_revision: 1,
            executable_path: None,
            config_dir,
        }
    }

    fn settings(account: AccountConfig) -> AppSettings {
        AppSettings {
            accounts: vec![account],
            ..AppSettings::default()
        }
    }

    fn test_profile(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("llmstatus-terminal-{name}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn macos_plan_has_the_complete_fixed_argument_array_and_one_shell_argument() {
        let config_dir = "/Users/Test User/.claude-work's;$HOME`\n\u{96ea}";
        let temporary_settings =
            "{\"statusLine\":{\"command\":\"collector '$HOME`;\n\u{96ea}\u{0007}\"}}";
        let plan = macos_launch_plan(config_dir, SYNTHETIC_WORKSPACE, temporary_settings);
        assert_eq!(
            plan,
            LaunchPlan {
                program: "/usr/bin/osascript".to_owned(),
                arguments: vec![
                    "-e".to_owned(),
                    "on run argv".to_owned(),
                    "-e".to_owned(),
                    "tell application \"Terminal\"".to_owned(),
                    "-e".to_owned(),
                    "activate".to_owned(),
                    "-e".to_owned(),
                    "do script (item 1 of argv)".to_owned(),
                    "-e".to_owned(),
                    "end tell".to_owned(),
                    "-e".to_owned(),
                    "end run".to_owned(),
                    "--".to_owned(),
                    "cd '/synthetic/data root/LLMStatus/claude-workspace' && /usr/bin/env CLAUDE_CONFIG_DIR='/Users/Test User/.claude-work'\\''s;$HOME`\n\u{96ea}' claude --setting-sources= --settings '{\"statusLine\":{\"command\":\"collector '\\''$HOME`;\n\u{96ea}\u{0007}\"}}' --strict-mcp-config --tools= -- 'Reply only with OK.'".to_owned(),
                ],
            }
        );
        assert_eq!(plan.arguments.len(), 14);
        let terminal_command = plan.arguments.last().unwrap();
        assert!(terminal_command.contains("/usr/bin/env CLAUDE_CONFIG_DIR="));
        assert!(!terminal_command.contains("; claude "));
    }

    #[test]
    fn macos_command_keeps_claude_out_of_shell_command_position() {
        let terminal_command = posix_shell_command(
            "/synthetic/selected profile",
            SYNTHETIC_WORKSPACE,
            "{\"statusLine\":{}}",
        );
        assert!(terminal_command
            .contains("&& /usr/bin/env CLAUDE_CONFIG_DIR='/synthetic/selected profile' claude "));
        assert!(!terminal_command.starts_with("claude "));
        assert!(!terminal_command.contains("; claude "));
        assert!(!terminal_command.contains("alias "));
    }

    /// The refresh prompt has to reach Claude's own argument parsing. Typing it
    /// into the terminal window would let Claude's workspace trust dialog, or
    /// any other window that happened to be focused, absorb it instead.
    #[test]
    fn launch_never_types_synthetic_input_and_submits_the_prompt_as_an_argument() {
        let plan = macos_launch_plan(
            "/synthetic/selected profile",
            SYNTHETIC_WORKSPACE,
            "{\"statusLine\":{}}",
        );
        for argument in &plan.arguments {
            assert!(!argument.contains("System Events"));
            assert!(!argument.contains("keystroke"));
            assert!(!argument.contains("key code"));
            assert!(!argument.contains("delay "));
        }
        let terminal_command = plan.arguments.last().unwrap();
        assert!(terminal_command.ends_with(" --tools= -- 'Reply only with OK.'"));

        let windows_command = powershell_command(
            "C:\\Users\\Test User\\.claude-work",
            "C:\\Users\\Test User\\AppData\\Local\\LLMStatus\\claude-workspace",
            "{\"statusLine\":{}}",
        );
        assert!(windows_command.ends_with(" --tools= -- 'Reply only with OK.'"));
    }

    /// `--bare` forces API-key authentication, and Claude reports plan rate
    /// limits only for a subscription session, so it silently empties the very
    /// data this app collects. Permission bypasses are never acceptable here.
    #[test]
    fn launch_command_never_bypasses_permissions_or_forces_api_key_authentication() {
        let posix = posix_shell_command(
            "/synthetic/selected profile",
            SYNTHETIC_WORKSPACE,
            "{\"statusLine\":{}}",
        );
        let powershell = powershell_command(
            "C:\\Users\\Test User\\.claude-work",
            "C:\\Users\\Test User\\AppData\\Local\\LLMStatus\\claude-workspace",
            "{\"statusLine\":{}}",
        );
        for command in [posix.as_str(), powershell.as_str()] {
            assert!(!command.contains("--dangerously-skip-permissions"));
            assert!(!command.contains("--allow-dangerously-skip-permissions"));
            assert!(!command.contains("bypassPermissions"));
            assert!(!command.contains("--permission-mode"));
            assert!(!command.contains("--bare"));
            assert!(!command.contains("ANTHROPIC_API_KEY"));
            assert!(command.contains("--setting-sources="));
            assert!(command.contains("--tools="));
        }
    }

    /// Claude never persists workspace trust for a home directory, and a new
    /// terminal window starts there. Running in the fixed application workspace
    /// keeps the trust decision to one acceptance per Claude profile.
    #[test]
    fn launch_runs_in_the_fixed_application_workspace() {
        let posix = posix_shell_command(
            "/synthetic/selected profile",
            SYNTHETIC_WORKSPACE,
            "{\"statusLine\":{}}",
        );
        assert!(posix.starts_with("cd '/synthetic/data root/LLMStatus/claude-workspace' && "));

        let powershell = powershell_command(
            "C:\\Users\\Test User\\.claude-work",
            "C:\\Users\\Test User\\AppData\\Local\\LLMStatus\\claude-workspace",
            "{\"statusLine\":{}}",
        );
        assert!(powershell.starts_with(
            "Set-Location -LiteralPath 'C:\\Users\\Test User\\AppData\\Local\\LLMStatus\\claude-workspace' -ErrorAction Stop; "
        ));

        assert!(workspace_dir()
            .unwrap()
            .ends_with(Path::new("LLMStatus").join(WORKSPACE_DIRECTORY_NAME)));
        let prepared = prepare_workspace_dir().unwrap();
        assert!(fs::symlink_metadata(&prepared).unwrap().is_dir());
        assert_ne!(
            Path::new(&prepared),
            dirs::home_dir().unwrap_or_default().as_path()
        );
    }

    #[test]
    fn windows_plan_uses_system_powershell_without_profiles_and_quotes_hostile_values() {
        let config_dir = "C:\\Users\\Test User\\.claude-work's;$cash`\\edge\u{96ea}";
        let workspace_dir = "C:\\Users\\Test User\\AppData\\Local\\LLMStatus\\claude-workspace";
        let temporary_settings =
            "{\"statusLine\":{\"command\":\"collector '$cash`;\n\u{96ea}\u{0007}\"}}";
        let plan = windows_launch_plan(
            r"D:\Windows\System32",
            config_dir,
            workspace_dir,
            temporary_settings,
        )
        .unwrap();
        assert_eq!(
            plan,
            LaunchPlan {
                program: r"D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".to_owned(),
                arguments: vec![
                    "-NoLogo".to_owned(),
                    "-NoProfile".to_owned(),
                    "-NoExit".to_owned(),
                    "-Command".to_owned(),
                    "Set-Location -LiteralPath 'C:\\Users\\Test User\\AppData\\Local\\LLMStatus\\claude-workspace' -ErrorAction Stop; $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\Test User\\.claude-work''s;$cash`\\edge\u{96ea}'; & claude --setting-sources= --settings '{\"statusLine\":{\"command\":\"collector ''$cash`;\n\u{96ea}\u{0007}\"}}' --strict-mcp-config --tools= -- 'Reply only with OK.'".to_owned(),
                ],
            }
        );
        assert_eq!(plan.arguments.len(), 5);
        assert_eq!(
            plan.arguments
                .iter()
                .filter(|argument| argument.as_str() == "-Command")
                .count(),
            1
        );
    }

    #[test]
    fn windows_system_host_path_fails_closed() {
        assert_eq!(
            windows_powershell_path("Windows"),
            Err(ClaudeTerminalError::PowerShellUnavailable)
        );
        assert_eq!(
            windows_powershell_path("C:\\Windows\\System32\nInjected"),
            Err(ClaudeTerminalError::PowerShellUnavailable)
        );
        assert_eq!(
            windows_powershell_path(""),
            Err(ClaudeTerminalError::PowerShellUnavailable)
        );
    }

    #[test]
    fn account_resolution_rejects_webview_text_and_ignores_saved_labels() {
        let profile = test_profile("typed-boundary");
        let saved = settings(account(
            "claude-work",
            AdapterKind::ClaudeStatusLine,
            true,
            Some(profile.to_string_lossy().into_owned()),
        ));
        let executable = Path::new("/Applications/LLMStatus.app/Contents/MacOS/llmstatus");
        assert_eq!(
            launch_plan_for_account(
                &saved,
                "claude-work; open /tmp/anything",
                executable,
                SYNTHETIC_WORKSPACE,
                TerminalPlatform::MacOs,
            ),
            Err(ClaudeTerminalError::AccountUnavailable)
        );
        let plan = launch_plan_for_account(
            &saved,
            "claude-work",
            executable,
            SYNTHETIC_WORKSPACE,
            TerminalPlatform::MacOs,
        )
        .unwrap();
        let terminal_command = plan.arguments.last().unwrap();
        assert!(!terminal_command.contains("Saved label"));
        assert!(!terminal_command.contains("anything"));
        assert!(terminal_command.contains("--source-revision 1"));
        assert!(terminal_command.ends_with("-- 'Reply only with OK.'"));
        assert!(launch_plan_for_account(
            &saved,
            "claude-work",
            executable,
            SYNTHETIC_WORKSPACE,
            TerminalPlatform::Windows {
                system_directory: r"C:\Windows\System32".to_owned(),
            },
        )
        .is_ok());
        assert_eq!(
            launch_plan_for_account(
                &saved,
                "claude-work",
                executable,
                SYNTHETIC_WORKSPACE,
                TerminalPlatform::Unsupported,
            ),
            Err(ClaudeTerminalError::UnsupportedPlatform)
        );
        fs::remove_dir(profile).unwrap();
    }

    /// Every registered Claude profile must launch its own profile directory
    /// and write to its own observation, so no part of one account's launch may
    /// appear in another's.
    #[test]
    fn each_saved_claude_profile_launches_with_only_its_own_values() {
        let first_profile = test_profile("multi-first");
        let second_profile = test_profile("multi-second");
        let executable = Path::new("/Applications/LLMStatus.app/Contents/MacOS/llmstatus");
        let saved = AppSettings {
            accounts: vec![
                AccountConfig {
                    source_revision: 3,
                    ..account(
                        "claude-account-1",
                        AdapterKind::ClaudeStatusLine,
                        true,
                        Some(first_profile.to_string_lossy().into_owned()),
                    )
                },
                AccountConfig {
                    source_revision: 7,
                    ..account(
                        "claude-account-2",
                        AdapterKind::ClaudeStatusLine,
                        true,
                        Some(second_profile.to_string_lossy().into_owned()),
                    )
                },
            ],
            ..AppSettings::default()
        };

        let mut commands = Vec::new();
        for platform in [
            TerminalPlatform::MacOs,
            TerminalPlatform::Windows {
                system_directory: r"C:\Windows\System32".to_owned(),
            },
        ] {
            let first = launch_plan_for_account(
                &saved,
                "claude-account-1",
                executable,
                SYNTHETIC_WORKSPACE,
                platform.clone(),
            )
            .unwrap();
            let second = launch_plan_for_account(
                &saved,
                "claude-account-2",
                executable,
                SYNTHETIC_WORKSPACE,
                platform,
            )
            .unwrap();
            let first_command = first.arguments.last().unwrap().clone();
            let second_command = second.arguments.last().unwrap().clone();

            assert!(first_command.contains("--account-id claude-account-1 --source-revision 3"));
            assert!(second_command.contains("--account-id claude-account-2 --source-revision 7"));
            assert!(!first_command.contains("claude-account-2"));
            assert!(!second_command.contains("claude-account-1"));
            assert!(first_command.contains(&first_profile.to_string_lossy().into_owned()));
            assert!(second_command.contains(&second_profile.to_string_lossy().into_owned()));
            assert!(!first_command.contains(&second_profile.to_string_lossy().into_owned()));
            assert!(!second_command.contains(&first_profile.to_string_lossy().into_owned()));
            assert_ne!(first_command, second_command);

            for command in [&first_command, &second_command] {
                assert!(command.contains("--setting-sources="));
                assert!(command.ends_with("-- 'Reply only with OK.'"));
            }
            commands.push(first_command);
            commands.push(second_command);
        }

        assert_eq!(
            crate::claude::observation_path("claude-account-1")
                .unwrap()
                .parent(),
            crate::claude::observation_path("claude-account-2")
                .unwrap()
                .parent()
        );
        assert_ne!(
            crate::claude::observation_path("claude-account-1").unwrap(),
            crate::claude::observation_path("claude-account-2").unwrap()
        );
        assert_eq!(commands.len(), 4);

        fs::remove_dir(first_profile).unwrap();
        fs::remove_dir(second_profile).unwrap();
    }

    #[test]
    fn account_and_profile_failures_are_safe_before_any_launch() {
        let executable = Path::new("/Applications/LLMStatus.app/Contents/MacOS/llmstatus");
        let profile = test_profile("safe-failures");
        let profile_text = profile.to_string_lossy().into_owned();

        let disabled = settings(account(
            "claude-disabled",
            AdapterKind::ClaudeStatusLine,
            false,
            Some(profile_text.clone()),
        ));
        assert_eq!(
            launch_plan_for_account(
                &disabled,
                "claude-disabled",
                executable,
                SYNTHETIC_WORKSPACE,
                TerminalPlatform::MacOs,
            ),
            Err(ClaudeTerminalError::AccountUnavailable)
        );

        let wrong = settings(account(
            "codex-work",
            AdapterKind::CodexAppServer,
            true,
            Some(profile_text),
        ));
        assert_eq!(
            launch_plan_for_account(
                &wrong,
                "codex-work",
                executable,
                SYNTHETIC_WORKSPACE,
                TerminalPlatform::MacOs,
            ),
            Err(ClaudeTerminalError::WrongAdapter)
        );

        let unselected = settings(account(
            "claude-unselected",
            AdapterKind::ClaudeStatusLine,
            true,
            None,
        ));
        assert_eq!(
            launch_plan_for_account(
                &unselected,
                "claude-unselected",
                executable,
                SYNTHETIC_WORKSPACE,
                TerminalPlatform::MacOs,
            ),
            Err(ClaudeTerminalError::ProfileRequired)
        );

        let missing = settings(account(
            "claude-missing",
            AdapterKind::ClaudeStatusLine,
            true,
            Some(profile.join("missing").to_string_lossy().into_owned()),
        ));
        assert_eq!(
            launch_plan_for_account(
                &missing,
                "claude-missing",
                executable,
                SYNTHETIC_WORKSPACE,
                TerminalPlatform::MacOs,
            ),
            Err(ClaudeTerminalError::ProfileUnavailable)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let link = profile.with_extension("link");
            symlink(&profile, &link).unwrap();
            let linked = settings(account(
                "claude-linked",
                AdapterKind::ClaudeStatusLine,
                true,
                Some(link.to_string_lossy().into_owned()),
            ));
            assert_eq!(
                launch_plan_for_account(
                    &linked,
                    "claude-linked",
                    executable,
                    SYNTHETIC_WORKSPACE,
                    TerminalPlatform::MacOs,
                ),
                Err(ClaudeTerminalError::ProfileUnavailable)
            );
            fs::remove_file(link).unwrap();
        }

        fs::remove_dir(profile).unwrap();
    }
}
