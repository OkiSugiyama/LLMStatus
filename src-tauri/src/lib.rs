mod claude;
mod claude_terminal;
mod codex;
mod discovery;
mod model;
mod observation_monitor;
mod settings;
mod storage;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::Utc;
use model::{AccountSnapshot, DashboardState};
use settings::{AccountConfig, AdapterKind, AppSettings, AppSettingsView};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

struct AppState {
    settings: Mutex<AppSettings>,
    settings_load_error: Mutex<Option<String>>,
    codex_snapshots: Mutex<HashMap<String, AccountSnapshot>>,
    settings_revision: AtomicU64,
}

pub mod collector {
    use chrono::{DateTime, Utc};

    pub const MAX_INPUT_BYTES: usize = crate::claude::MAX_COLLECTOR_INPUT_BYTES;

    pub fn save_claude_status(
        account_id: &str,
        source_revision: u64,
        payload: &[u8],
        observed_at: DateTime<Utc>,
    ) -> Result<crate::model::SanitizedObservation, String> {
        let observation =
            crate::claude::sanitize_status_line(account_id, source_revision, payload, observed_at)
                .map_err(|error| error.to_string())?;
        crate::claude::save_observation_if_current(&observation)
            .map_err(|error| error.to_string())?;
        Ok(observation)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CollectorArgs {
    account_id: String,
    source_revision: u64,
}

fn parse_collector_args(mut args: impl Iterator<Item = String>) -> Result<CollectorArgs, String> {
    if args.next().as_deref() != Some("--account-id") {
        return Err(
            "usage: llmstatus --collect --account-id <configured-id> --source-revision <positive-integer>"
                .to_owned(),
        );
    }
    let account_id = args
        .next()
        .ok_or_else(|| "account ID is required".to_owned())?;
    if args.next().as_deref() != Some("--source-revision") {
        return Err("source revision is required".to_owned());
    }
    let source_revision = args
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "source revision must be a positive integer".to_owned())?;
    if args.next().is_some() {
        return Err("unexpected arguments".to_owned());
    }
    Ok(CollectorArgs {
        account_id,
        source_revision,
    })
}

pub fn run_collector(args: impl Iterator<Item = String>) -> Result<(), String> {
    use std::io::Read;

    let parsed = parse_collector_args(args)?;

    let settings = settings::load_settings().map_err(|error| error.to_string())?;
    let account = settings
        .account(&parsed.account_id)
        .filter(|account| account.enabled)
        .ok_or_else(|| "account ID is not enabled in LLMStatus settings".to_owned())?;
    if account.adapter_kind != AdapterKind::ClaudeStatusLine {
        return Err("account is not configured for the Claude statusLine adapter".to_owned());
    }
    if account.source_revision != parsed.source_revision {
        return Err("collector source revision is no longer current".to_owned());
    }

    let mut payload = Vec::new();
    std::io::stdin()
        .take((collector::MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut payload)
        .map_err(|_| "statusLine input could not be read".to_owned())?;
    let observation = collector::save_claude_status(
        &parsed.account_id,
        parsed.source_revision,
        &payload,
        Utc::now(),
    )?;
    println!("{}", collector_status_text(&observation));
    Ok(())
}

fn collector_status_text(observation: &model::SanitizedObservation) -> String {
    let values = observation
        .windows
        .iter()
        .map(|window| format!("{} {:.0}%", window.label, window.used_percent))
        .collect::<Vec<_>>()
        .join(" - ");
    format!("LLMStatus - {values}")
}

impl AppState {
    fn new() -> Self {
        let (settings, error) = match settings::load_settings() {
            Ok(settings) => (settings, None),
            Err(error) => (AppSettings::default(), Some(error.to_string())),
        };
        Self {
            settings: Mutex::new(settings),
            settings_load_error: Mutex::new(error),
            codex_snapshots: Mutex::new(HashMap::new()),
            settings_revision: AtomicU64::new(0),
        }
    }
}

#[tauri::command]
fn dashboard_state(state: State<'_, AppState>) -> Result<DashboardState, String> {
    ensure_settings_loaded(&state)?;
    Ok(build_dashboard(&state))
}

#[tauri::command]
fn app_settings(state: State<'_, AppState>) -> Result<AppSettingsView, String> {
    ensure_settings_loaded(&state)?;
    state
        .settings
        .lock()
        .map(|settings| settings.to_view())
        .map_err(|_| "settings state is unavailable".to_owned())
}

#[tauri::command]
fn discover_config_dirs(adapter_kind: AdapterKind) -> Vec<discovery::ConfigCandidate> {
    discovery::discover_config_dirs(adapter_kind)
}

#[tauri::command]
fn resolve_config_dir(
    adapter_kind: AdapterKind,
    path: String,
) -> Result<discovery::ConfigCandidate, String> {
    discovery::resolve_config_dir_bounded(adapter_kind, &path)
}

#[tauri::command]
fn save_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<AppSettingsView, String> {
    let mut current_settings = state
        .settings
        .lock()
        .map_err(|_| "settings state is unavailable".to_owned())?;
    let settings = settings::save_settings(settings).map_err(|error| error.to_string())?;
    let mut snapshots = state
        .codex_snapshots
        .lock()
        .map_err(|_| "dashboard state is unavailable".to_owned())?;
    snapshots.clear();
    *current_settings = settings.clone();
    state.settings_revision.fetch_add(1, Ordering::SeqCst);
    drop(snapshots);
    drop(current_settings);
    *state
        .settings_load_error
        .lock()
        .map_err(|_| "settings state is unavailable".to_owned())? = None;
    Ok(settings.to_view())
}

#[tauri::command]
fn claude_status_line_snippet(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings state is unavailable".to_owned())?;
    let account = settings
        .account(&account_id)
        .filter(|account| account.enabled)
        .ok_or_else(|| "save and enable this account first".to_owned())?;
    if account.adapter_kind != AdapterKind::ClaudeStatusLine {
        return Err("account is not configured for Claude statusLine".to_owned());
    }
    let executable = std::env::current_exe()
        .map_err(|_| "application executable path is unavailable".to_owned())?;
    let command = collector_command(&executable, &account.id, account.source_revision);
    let integration = format!(
        "# Add after reading stdin in the existing statusLine script\nprintf '%s' \"$LLMSTATUS_STATUS_INPUT\" | {command} >/dev/null 2>&1 || true"
    );
    serde_json::to_string_pretty(&serde_json::json!({
        "statusLine": {
            "type": "command",
            "command": command
        },
        "existingStatusLineIntegration": {
            "description": "To keep an existing statusLine, save all stdin to LLMSTATUS_STATUS_INPUT at the start of the script and add this line. Use the same variable for the original display logic.",
            "posix": integration
        }
    }))
    .map_err(|_| "statusLine snippet could not be generated".to_owned())
}

#[tauri::command]
fn launch_claude_terminal(account_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ensure_settings_loaded(&state)?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings state is unavailable".to_owned())?
        .clone();

    let executable = std::env::current_exe()
        .map_err(|_| "application executable path is unavailable".to_owned())?;
    claude_terminal::launch(&settings, &account_id, &executable).map_err(|error| error.to_string())
}

fn claude_temporary_settings(
    executable: &std::path::Path,
    account_id: &str,
    source_revision: u64,
) -> Result<String, String> {
    serde_json::to_string(&serde_json::json!({
        "statusLine": {
            "type": "command",
            "command": collector_command(executable, account_id, source_revision)
        }
    }))
    .map_err(|_| "temporary Claude settings could not be generated".to_owned())
}

#[cfg(windows)]
fn collector_command(
    executable: &std::path::Path,
    account_id: &str,
    source_revision: u64,
) -> String {
    format!(
        "\"{}\" --collect --account-id {account_id} --source-revision {source_revision}",
        executable.display()
    )
}

#[cfg(not(windows))]
fn collector_command(
    executable: &std::path::Path,
    account_id: &str,
    source_revision: u64,
) -> String {
    let path = executable.to_string_lossy().replace('\'', "'\\''");
    format!("'{path}' --collect --account-id {account_id} --source-revision {source_revision}")
}

#[tauri::command]
async fn refresh_dashboard(state: State<'_, AppState>) -> Result<DashboardState, String> {
    ensure_settings_loaded(&state)?;
    let settings_revision = state.settings_revision.load(Ordering::SeqCst);
    let accounts: Vec<AccountConfig> = state
        .settings
        .lock()
        .map_err(|_| "settings state is unavailable".to_owned())?
        .accounts
        .iter()
        .filter(|account| account.enabled && account.adapter_kind == AdapterKind::CodexAppServer)
        .cloned()
        .collect();

    let results = tauri::async_runtime::spawn_blocking(move || codex::refresh_accounts(accounts))
        .await
        .map_err(|_| "Codex refresh worker could not finish".to_owned())?;

    let mut current = state
        .codex_snapshots
        .lock()
        .map_err(|_| "dashboard state is unavailable".to_owned())?;
    if state.settings_revision.load(Ordering::SeqCst) != settings_revision {
        drop(current);
        return Ok(build_dashboard(&state));
    }
    for (account, result) in results {
        match result {
            Ok(snapshot) => {
                current.insert(account.id.clone(), snapshot);
            }
            Err(error) => {
                let code = codex_error_code(&error);
                let detail = codex_error_detail(&error);
                let snapshot = match current.remove(&account.id) {
                    Some(previous) if !previous.windows.is_empty() => {
                        previous.mark_stale_at(code, detail, Utc::now())
                    }
                    _ => AccountSnapshot::error(
                        &account.id,
                        account.adapter_kind.provider(),
                        &account.label,
                        code,
                        detail,
                    ),
                };
                current.insert(account.id.clone(), snapshot);
            }
        }
    }
    drop(current);
    Ok(build_dashboard(&state))
}

fn ensure_settings_loaded(state: &AppState) -> Result<(), String> {
    match state
        .settings_load_error
        .lock()
        .map_err(|_| "settings state is unavailable".to_owned())?
        .clone()
    {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn build_dashboard(state: &AppState) -> DashboardState {
    let settings = state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default();
    let codex_snapshots = state
        .codex_snapshots
        .lock()
        .map(|snapshots| snapshots.clone())
        .unwrap_or_default();
    let accounts = settings
        .accounts
        .iter()
        .filter(|account| account.enabled)
        .map(|account| match account.adapter_kind {
            AdapterKind::CodexAppServer => codex_snapshots
                .get(&account.id)
                .cloned()
                .unwrap_or_else(|| {
                    AccountSnapshot::unavailable(
                        &account.id,
                        account.adapter_kind.provider(),
                        &account.label,
                        "Waiting for the Codex CLI connection",
                    )
                }),
            AdapterKind::ClaudeStatusLine => claude_snapshot(account, settings.stale_after_minutes),
        })
        .collect();
    DashboardState {
        generated_at: Utc::now(),
        accounts,
    }
}

fn claude_snapshot(account: &AccountConfig, stale_after_minutes: i64) -> AccountSnapshot {
    let mut snapshot = match claude::load_observation(&account.id, account.source_revision) {
        Ok(Some(observation)) => AccountSnapshot::from_observation(
            observation,
            account.adapter_kind.provider(),
            &account.label,
            Utc::now(),
            stale_after_minutes,
        ),
        result => {
            if let Some((code, detail)) = claude_profile_error(account.config_dir.as_deref()) {
                let mut snapshot = AccountSnapshot::unavailable(
                    &account.id,
                    account.adapter_kind.provider(),
                    &account.label,
                    detail,
                );
                snapshot.error_code = Some(code.to_owned());
                return snapshot;
            }

            match result {
                Ok(None) => AccountSnapshot::unavailable(
                    &account.id,
                    account.adapter_kind.provider(),
                    &account.label,
                    "Waiting for Claude Code statusLine data",
                ),
                Err(error) => AccountSnapshot::error(
                    &account.id,
                    account.adapter_kind.provider(),
                    &account.label,
                    "invalid_observation",
                    &error.to_string(),
                ),
                Ok(Some(_)) => unreachable!("readable observations return before profile checks"),
            }
        }
    };
    apply_claude_profile_state(&mut snapshot, account.config_dir.as_deref());
    snapshot
}

fn claude_profile_error(config_dir: Option<&str>) -> Option<(&'static str, &'static str)> {
    if claude_terminal::profile_is_usable(config_dir) {
        None
    } else if config_dir.is_none() {
        Some((
            "claude_profile_required",
            "Select a Claude profile in Settings to enable the one-message usage refresh; the Account-ID snippet remains available for manual installation",
        ))
    } else {
        Some((
            "claude_profile_unavailable",
            "The selected Claude profile is unavailable; choose an existing non-symlink profile in Settings",
        ))
    }
}

fn apply_claude_profile_state(snapshot: &mut AccountSnapshot, config_dir: Option<&str>) {
    if !snapshot.windows.is_empty() {
        return;
    }
    if let Some((code, detail)) = claude_profile_error(config_dir) {
        snapshot.status = "unavailable".to_owned();
        snapshot.observed_at = None;
        snapshot.detail = Some(detail.to_owned());
        snapshot.error_code = Some(code.to_owned());
    } else {
        snapshot.error_code = Some("claude_refresh_available".to_owned());
    }
}

fn codex_error_code(error: &codex::CodexError) -> &'static str {
    match error {
        codex::CodexError::CliUnavailable => "cli_unavailable",
        codex::CodexError::ConfigDirectoryUnavailable => "config_directory_unavailable",
        codex::CodexError::StartFailed => "process_unavailable",
        codex::CodexError::Timeout => "source_timeout",
        codex::CodexError::Protocol => "unsupported_protocol",
        codex::CodexError::NotAuthenticated => "not_authenticated",
        codex::CodexError::MissingRateLimits => "rate_limits_unavailable",
    }
}

fn codex_error_detail(error: &codex::CodexError) -> &'static str {
    match error {
        codex::CodexError::CliUnavailable => "The configured official Codex CLI was not found",
        codex::CodexError::ConfigDirectoryUnavailable => {
            "The configured CODEX_HOME directory was not found"
        }
        codex::CodexError::StartFailed => "Could not start the Codex app-server",
        codex::CodexError::Timeout => "The Codex app-server did not respond in time",
        codex::CodexError::Protocol => {
            "An unsupported Codex app-server response was rejected for safety"
        }
        codex::CodexError::NotAuthenticated => {
            "Use this CODEX_HOME to sign in to ChatGPT with the Codex CLI"
        }
        codex::CodexError::MissingRateLimits => "Could not retrieve usage limits for this account",
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            observation_monitor::spawn(app.handle().clone());
            let show = MenuItem::with_id(app, "show", "Show LLMStatus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("LLMStatus")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            dashboard_state,
            refresh_dashboard,
            app_settings,
            save_app_settings,
            claude_status_line_snippet,
            launch_claude_terminal,
            discover_config_dirs,
            resolve_config_dir
        ])
        .run(tauri::generate_context!())
        .expect("LLMStatus failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn collector_status_text_contains_only_sanitized_quota_values() {
        let observation = model::SanitizedObservation {
            schema_version: 4,
            account_id: "private-label".to_owned(),
            source_revision: 1,
            observed_at: Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
            windows: vec![model::UsageWindow {
                id: "five-hour".to_owned(),
                label: "5 hours".to_owned(),
                used_percent: 12.5,
                resets_at: None,
                duration_minutes: Some(300),
            }],
        };
        let text = collector_status_text(&observation);
        assert_eq!(text, "LLMStatus - 5 hours 12%");
        assert!(!text.contains("private-label"));
    }

    #[test]
    fn temporary_claude_settings_override_only_the_status_line() {
        let executable = if cfg!(windows) {
            std::path::Path::new(r"C:\Program Files\LLMStatus\llmstatus.exe")
        } else {
            std::path::Path::new("/Applications/LLMStatus.app/Contents/MacOS/llmstatus")
        };
        let serialized = claude_temporary_settings(executable, "claude-work", 9).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            settings.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["statusLine"]
        );
        assert_eq!(settings["statusLine"]["type"], "command");
        assert!(settings["statusLine"]["command"]
            .as_str()
            .unwrap()
            .ends_with("--collect --account-id claude-work --source-revision 9"));
    }

    #[test]
    fn collector_requires_account_and_exact_positive_source_revision() {
        assert_eq!(
            parse_collector_args(
                ["--account-id", "claude-work", "--source-revision", "7",]
                    .into_iter()
                    .map(str::to_owned)
            )
            .unwrap(),
            CollectorArgs {
                account_id: "claude-work".to_owned(),
                source_revision: 7,
            }
        );
        assert!(parse_collector_args(
            ["--account-id", "claude-work"]
                .into_iter()
                .map(str::to_owned)
        )
        .is_err());
        for invalid in ["0", "not-a-number", "-1"] {
            assert!(parse_collector_args(
                ["--account-id", "claude-work", "--source-revision", invalid,]
                    .into_iter()
                    .map(str::to_owned)
            )
            .is_err());
        }
    }

    #[test]
    fn webview_capability_allows_only_event_listen_and_unlisten() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"])
        );
        let serialized = serde_json::to_string(&capability).unwrap();
        for forbidden in [
            "core:default",
            "core:image",
            "allow-from-path",
            "core:menu",
            "core:tray",
            "devtools",
            "shell:",
            "fs:",
            "http:",
        ] {
            assert!(!serialized.contains(forbidden), "found {forbidden}");
        }
    }

    #[test]
    fn backend_reports_claude_refresh_only_for_a_currently_usable_profile() {
        assert_eq!(
            claude_profile_error(None).map(|value| value.0),
            Some("claude_profile_required")
        );
        let root = crate::storage::temporary_path(
            &std::env::temp_dir(),
            "llmstatus-profile-eligibility-test",
        );
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing");
        assert_eq!(
            claude_profile_error(missing.to_str()).map(|value| value.0),
            Some("claude_profile_unavailable")
        );
        assert_eq!(claude_profile_error(root.to_str()), None);

        let expired = AccountSnapshot::from_observation(
            model::SanitizedObservation {
                schema_version: 4,
                account_id: "claude-synthetic".to_owned(),
                source_revision: 1,
                observed_at: Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
                windows: vec![model::UsageWindow {
                    id: "five-hour".to_owned(),
                    label: "5 hours".to_owned(),
                    used_percent: 25.0,
                    resets_at: None,
                    duration_minutes: Some(300),
                }],
            },
            "anthropic",
            "Synthetic Claude",
            Utc.with_ymd_and_hms(2026, 8, 16, 11, 0, 0).unwrap(),
            10,
        );
        assert!(expired.windows.is_empty());

        let mut launchable_expired = expired.clone();
        apply_claude_profile_state(&mut launchable_expired, root.to_str());
        assert_eq!(
            launchable_expired.error_code.as_deref(),
            Some("claude_refresh_available")
        );

        let mut unselected_expired = expired.clone();
        apply_claude_profile_state(&mut unselected_expired, None);
        assert_eq!(unselected_expired.status, "unavailable");
        assert_eq!(
            unselected_expired.error_code.as_deref(),
            Some("claude_profile_required")
        );

        let mut missing_expired = expired.clone();
        apply_claude_profile_state(&mut missing_expired, missing.to_str());
        assert_eq!(missing_expired.status, "unavailable");
        assert_eq!(
            missing_expired.error_code.as_deref(),
            Some("claude_profile_unavailable")
        );

        let mut readable = AccountSnapshot {
            id: "claude-readable".to_owned(),
            provider: "anthropic".to_owned(),
            label: "Synthetic readable Claude".to_owned(),
            status: "stale".to_owned(),
            observed_at: Some(Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap()),
            windows: vec![model::UsageWindow {
                id: "five-hour".to_owned(),
                label: "5 hours".to_owned(),
                used_percent: 25.0,
                resets_at: None,
                duration_minutes: Some(300),
            }],
            detail: None,
            error_code: None,
        };
        apply_claude_profile_state(&mut readable, missing.to_str());
        assert_eq!(readable.status, "stale");
        assert_eq!(readable.windows.len(), 1);
        assert_eq!(readable.error_code, None);

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = root.with_extension("link");
            symlink(&root, &link).unwrap();
            assert_eq!(
                claude_profile_error(link.to_str()).map(|value| value.0),
                Some("claude_profile_unavailable")
            );
            let mut symlinked_expired = expired;
            apply_claude_profile_state(&mut symlinked_expired, link.to_str());
            assert_eq!(
                symlinked_expired.error_code.as_deref(),
                Some("claude_profile_unavailable")
            );
            std::fs::remove_file(link).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
}
