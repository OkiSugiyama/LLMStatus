use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use thiserror::Error;

use crate::model::{AccountSnapshot, UsageWindow};
use crate::settings::AccountConfig;

const RPC_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_RPC_LINE_BYTES: usize = 256 * 1024;
const MAX_RPC_MESSAGES: usize = 128;
const MAX_RPC_STDOUT_BYTES: usize = 1024 * 1024;
const READER_QUEUE_CAPACITY: usize = 128;
const MAX_CONCURRENT_SESSIONS: usize = 4;
const ALLOWED_NOTIFICATION: &str = "account/rateLimits/updated";

static SESSION_LIMITER: OnceLock<SessionLimiter> = OnceLock::new();

struct SessionLimiter {
    available: Mutex<usize>,
    ready: Condvar,
}

impl SessionLimiter {
    fn new(capacity: usize) -> Self {
        Self {
            available: Mutex::new(capacity),
            ready: Condvar::new(),
        }
    }

    fn acquire(&self) -> Result<SessionPermit<'_>, CodexError> {
        let mut available = self.available.lock().map_err(|_| CodexError::StartFailed)?;
        while *available == 0 {
            available = self
                .ready
                .wait(available)
                .map_err(|_| CodexError::StartFailed)?;
        }
        *available -= 1;
        Ok(SessionPermit { limiter: self })
    }
}

struct SessionPermit<'a> {
    limiter: &'a SessionLimiter,
}

impl Drop for SessionPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut available) = self.limiter.available.lock() {
            *available += 1;
            self.limiter.ready.notify_one();
        }
    }
}

#[derive(Debug, Error)]
pub enum CodexError {
    #[error("Codex CLI is not installed")]
    CliUnavailable,
    #[error("Codex profile directory is unavailable")]
    ConfigDirectoryUnavailable,
    #[error("Codex app-server could not start")]
    StartFailed,
    #[error("Codex app-server timed out")]
    Timeout,
    #[error("Codex app-server protocol failed")]
    Protocol,
    #[error("Codex account is not authenticated")]
    NotAuthenticated,
    #[error("Codex rate-limit response is unavailable")]
    MissingRateLimits,
}

pub fn refresh_codex(account: &AccountConfig) -> Result<AccountSnapshot, CodexError> {
    let _permit = SESSION_LIMITER
        .get_or_init(|| SessionLimiter::new(MAX_CONCURRENT_SESSIONS))
        .acquire()?;
    let codex_path = resolve_codex_cli(account.executable_path.as_deref())?;
    let config_dir = account.config_dir.as_deref().map(std::path::Path::new);
    if config_dir.is_some_and(|path| !path.is_dir()) {
        return Err(CodexError::ConfigDirectoryUnavailable);
    }
    let mut session = RpcSession::start(&codex_path, config_dir)?;

    session.send(json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "llmstatus", "title": "LLMStatus", "version": "0.2.0" },
            "capabilities": {
                "experimentalApi": false,
                "optOutNotificationMethods": ["remoteControl/status/changed"]
            }
        }
    }))?;
    session.wait_for_result(1)?;
    session.send(json!({ "method": "initialized" }))?;

    session.send(json!({
        "id": 2,
        "method": "account/read",
        "params": { "refreshToken": false }
    }))?;
    let account_response = session.wait_for_result(2)?;
    validate_account(&account_response)?;

    session.send(json!({ "id": 3, "method": "account/rateLimits/read" }))?;
    let rate_limits = session.wait_for_result(3)?;
    session.send(json!({ "id": 4, "method": "account/usage/read" }))?;
    let usage = session.wait_for_result(4).ok();

    build_snapshot(
        &rate_limits,
        usage.as_ref(),
        Utc::now(),
        &account.id,
        &account.label,
    )
}

pub fn refresh_accounts(
    accounts: Vec<AccountConfig>,
) -> Vec<(AccountConfig, Result<AccountSnapshot, CodexError>)> {
    let handles = accounts
        .into_iter()
        .map(|account| {
            std::thread::spawn(move || {
                let result = refresh_codex(&account);
                (account, result)
            })
        })
        .collect::<Vec<_>>();
    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

fn resolve_codex_cli(explicit_path: Option<&str>) -> Result<std::path::PathBuf, CodexError> {
    if let Some(path) = explicit_path {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Ok(path.canonicalize().unwrap_or(path));
        }
        return Err(CodexError::CliUnavailable);
    }
    if let Ok(path) = which::which("codex") {
        return Ok(path.canonicalize().unwrap_or(path));
    }
    #[cfg(target_os = "macos")]
    {
        let bundled =
            std::path::PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    Err(CodexError::CliUnavailable)
}

fn validate_account(result: &Value) -> Result<(), CodexError> {
    if result.get("account").map_or(true, Value::is_null) {
        return Err(CodexError::NotAuthenticated);
    }
    Ok(())
}

fn build_snapshot(
    result: &Value,
    usage: Option<&Value>,
    observed_at: DateTime<Utc>,
    account_id: &str,
    label: &str,
) -> Result<AccountSnapshot, CodexError> {
    let rate_limits = result
        .get("rateLimits")
        .ok_or(CodexError::MissingRateLimits)?;
    let mut windows = Vec::with_capacity(2);
    if let Some(primary) = rate_limits.get("primary").filter(|value| !value.is_null()) {
        windows.push(parse_window("primary", primary)?);
    }
    if let Some(secondary) = rate_limits
        .get("secondary")
        .filter(|value| !value.is_null())
    {
        windows.push(parse_window("secondary", secondary)?);
    }
    if windows.is_empty() {
        return Err(CodexError::MissingRateLimits);
    }

    let detail = usage
        .and_then(|value| value.pointer("/summary/lifetimeTokens"))
        .and_then(Value::as_i64)
        .map(|tokens| format!("Total {tokens} tokens (reference only)"));

    Ok(AccountSnapshot {
        id: account_id.to_owned(),
        provider: "openai".to_owned(),
        label: label.to_owned(),
        status: "live".to_owned(),
        observed_at: Some(observed_at),
        windows,
        detail,
        error_code: None,
    })
}

fn parse_window(id: &str, value: &Value) -> Result<UsageWindow, CodexError> {
    let used_percent = value
        .get("usedPercent")
        .and_then(Value::as_f64)
        .filter(|percent| percent.is_finite() && (0.0..=100.0).contains(percent))
        .ok_or(CodexError::Protocol)?;
    let duration_minutes = value.get("windowDurationMins").and_then(Value::as_i64);
    let resets_at = value
        .get("resetsAt")
        .and_then(Value::as_i64)
        .map(|timestamp| DateTime::<Utc>::from_timestamp(timestamp, 0).ok_or(CodexError::Protocol))
        .transpose()?;
    let label = match duration_minutes {
        Some(300) => "5 hours".to_owned(),
        Some(10_080) => "7 days".to_owned(),
        Some(minutes) if minutes % 1_440 == 0 => format!("{} days", minutes / 1_440),
        Some(minutes) if minutes % 60 == 0 => format!("{} hours", minutes / 60),
        Some(minutes) => format!("{minutes} minutes"),
        None if id == "primary" => "Short-term window".to_owned(),
        None => "Long-term window".to_owned(),
    };
    Ok(UsageWindow {
        id: id.to_owned(),
        label,
        used_percent,
        resets_at,
        duration_minutes,
    })
}

struct RpcSession {
    child: Child,
    stdin: ChildStdin,
    receiver: Receiver<Result<Value, CodexError>>,
    deadline: Instant,
}

impl RpcSession {
    fn start(
        path: &std::path::Path,
        config_dir: Option<&std::path::Path>,
    ) -> Result<Self, CodexError> {
        let mut command = Command::new(path);
        command.args(["app-server", "--stdio"]);
        command.env_remove("CODEX_ACCESS_TOKEN");
        command.env_remove("CODEX_API_KEY");
        if let Some(config_dir) = config_dir {
            command.env("CODEX_HOME", config_dir);
            command.env_remove("CODEX_SQLITE_HOME");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| CodexError::StartFailed)?;
        let stdin = child.stdin.take().ok_or(CodexError::StartFailed)?;
        let stdout = child.stdout.take().ok_or(CodexError::StartFailed)?;
        let (sender, receiver) = mpsc::sync_channel(READER_QUEUE_CAPACITY);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut budget = ReaderBudget::default();
            loop {
                match read_bounded_json_line(&mut reader, &mut budget) {
                    Ok(Some(value)) => {
                        if sender.send(Ok(value)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            receiver,
            deadline: Instant::now() + RPC_TIMEOUT,
        })
    }

    fn send(&mut self, request: Value) -> Result<(), CodexError> {
        serde_json::to_writer(&mut self.stdin, &request).map_err(|_| CodexError::Protocol)?;
        self.stdin
            .write_all(b"\n")
            .map_err(|_| CodexError::Protocol)?;
        self.stdin.flush().map_err(|_| CodexError::Protocol)
    }

    fn wait_for_result(&mut self, expected_id: i64) -> Result<Value, CodexError> {
        loop {
            let remaining = remaining_before_deadline(self.deadline, Instant::now())?;
            let message = match self.receiver.recv_timeout(remaining) {
                Ok(message) => message?,
                Err(RecvTimeoutError::Timeout) => return Err(CodexError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(CodexError::Protocol),
            };
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if method == ALLOWED_NOTIFICATION {
                    continue;
                }
                return Err(CodexError::Protocol);
            }
            if message.get("id").and_then(Value::as_i64) != Some(expected_id) {
                continue;
            }
            if message.get("error").is_some() {
                return Err(CodexError::Protocol);
            }
            return message.get("result").cloned().ok_or(CodexError::Protocol);
        }
    }
}

fn remaining_before_deadline(deadline: Instant, now: Instant) -> Result<Duration, CodexError> {
    deadline
        .checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
        .ok_or(CodexError::Timeout)
}

#[derive(Debug, Default)]
struct ReaderBudget {
    messages: usize,
    stdout_bytes: usize,
}

impl ReaderBudget {
    fn charge_bytes(&mut self, bytes: usize) -> Result<(), CodexError> {
        self.stdout_bytes = self
            .stdout_bytes
            .checked_add(bytes)
            .filter(|total| *total <= MAX_RPC_STDOUT_BYTES)
            .ok_or(CodexError::Protocol)?;
        Ok(())
    }

    fn charge_message(&mut self) -> Result<(), CodexError> {
        self.messages = self
            .messages
            .checked_add(1)
            .filter(|total| *total <= MAX_RPC_MESSAGES)
            .ok_or(CodexError::Protocol)?;
        Ok(())
    }
}

fn read_bounded_json_line(
    reader: &mut impl BufRead,
    budget: &mut ReaderBudget,
) -> Result<Option<Value>, CodexError> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| CodexError::Protocol)?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(CodexError::Protocol);
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len() + newline > MAX_RPC_LINE_BYTES {
                return Err(CodexError::Protocol);
            }
            budget.charge_bytes(newline + 1)?;
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            budget.charge_message()?;
            return serde_json::from_slice(&line)
                .map(Some)
                .map_err(|_| CodexError::Protocol);
        }
        if line.len() + available.len() > MAX_RPC_LINE_BYTES {
            return Err(CodexError::Protocol);
        }
        let length = available.len();
        budget.charge_bytes(length)?;
        line.extend_from_slice(available);
        reader.consume(length);
    }
}

impl Drop for RpcSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    #[test]
    fn parses_official_rate_limit_shape_with_explicit_used_semantics() {
        let payload = json!({
            "rateLimits": {
                "primary": { "usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1786795200 },
                "secondary": { "usedPercent": 21, "windowDurationMins": 10080, "resetsAt": 1787300000 }
            }
        });
        let now = Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap();
        let snapshot = build_snapshot(&payload, None, now, "codex-work", "Codex Work").unwrap();
        assert_eq!(snapshot.id, "codex-work");
        assert_eq!(snapshot.label, "Codex Work");
        assert_eq!(snapshot.windows[0].label, "5 hours");
        assert_eq!(snapshot.windows[0].used_percent, 42.0);
        assert_eq!(snapshot.windows[1].label, "7 days");
    }

    #[test]
    fn rejects_malformed_percentage_instead_of_clamping_source_data() {
        let payload = json!({ "rateLimits": { "primary": { "usedPercent": 120 } } });
        assert!(matches!(
            build_snapshot(&payload, None, Utc::now(), "codex", "Codex"),
            Err(CodexError::Protocol)
        ));
    }

    #[test]
    fn accepts_authenticated_chatgpt_account_when_openai_auth_is_required() {
        let payload = json!({
            "account": { "type": "chatgpt", "email": null, "planType": "plus" },
            "requiresOpenaiAuth": true
        });
        assert!(validate_account(&payload).is_ok());
        assert!(matches!(
            validate_account(&json!({ "account": null, "requiresOpenaiAuth": true })),
            Err(CodexError::NotAuthenticated)
        ));
    }

    #[test]
    fn bounded_reader_rejects_an_oversized_line_before_json_parsing() {
        let input = vec![b'x'; MAX_RPC_LINE_BYTES + 1];
        let mut reader = BufReader::new(std::io::Cursor::new(input));
        let mut budget = ReaderBudget::default();
        assert!(matches!(
            read_bounded_json_line(&mut reader, &mut budget),
            Err(CodexError::Protocol)
        ));
    }

    #[test]
    fn reader_charges_malformed_messages_before_parse_and_rejects_the_129th() {
        let input = (0..=MAX_RPC_MESSAGES)
            .map(|_| "not-json\n")
            .collect::<String>();
        let mut reader = BufReader::new(std::io::Cursor::new(input));
        let mut budget = ReaderBudget::default();
        for _ in 0..MAX_RPC_MESSAGES {
            assert!(matches!(
                read_bounded_json_line(&mut reader, &mut budget),
                Err(CodexError::Protocol)
            ));
        }
        assert_eq!(budget.messages, MAX_RPC_MESSAGES);
        assert!(matches!(
            read_bounded_json_line(&mut reader, &mut budget),
            Err(CodexError::Protocol)
        ));
    }

    #[test]
    fn reader_rejects_aggregate_stdout_beyond_one_mib_before_parse() {
        let line = format!("\"{}\"\n", "x".repeat(MAX_RPC_LINE_BYTES - 3));
        let mut input = line.repeat(4);
        input.push_str("{}\n");
        let mut reader = BufReader::new(std::io::Cursor::new(input));
        let mut budget = ReaderBudget::default();
        for _ in 0..4 {
            assert!(read_bounded_json_line(&mut reader, &mut budget)
                .unwrap()
                .is_some());
        }
        assert_eq!(budget.stdout_bytes, MAX_RPC_STDOUT_BYTES);
        assert!(matches!(
            read_bounded_json_line(&mut reader, &mut budget),
            Err(CodexError::Protocol)
        ));
    }

    #[test]
    fn reader_queue_capacity_is_frozen_at_128_frames() {
        assert_eq!(READER_QUEUE_CAPACITY, 128);
    }

    #[test]
    fn session_timeout_is_deterministic_at_the_eight_second_deadline() {
        let start = Instant::now();
        assert_eq!(RPC_TIMEOUT, Duration::from_secs(8));
        assert_eq!(
            remaining_before_deadline(start + RPC_TIMEOUT, start + Duration::from_secs(7)).unwrap(),
            Duration::from_secs(1)
        );
        assert!(matches!(
            remaining_before_deadline(start + RPC_TIMEOUT, start + RPC_TIMEOUT),
            Err(CodexError::Timeout)
        ));
    }

    #[test]
    fn overlapping_refreshes_share_four_process_global_permits() {
        let limiter = Arc::new(SessionLimiter::new(MAX_CONCURRENT_SESSIONS));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(MAX_CONCURRENT_SESSIONS));
        let handles = (0..8)
            .map(|_| {
                let limiter = Arc::clone(&limiter);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let _permit = limiter.acquire().unwrap();
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    barrier.wait();
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), MAX_CONCURRENT_SESSIONS);
        assert_eq!(*limiter.available.lock().unwrap(), MAX_CONCURRENT_SESSIONS);
    }

    #[test]
    fn session_permit_releases_on_success_error_timeout_and_unwind_paths() {
        let limiter = SessionLimiter::new(MAX_CONCURRENT_SESSIONS);
        {
            let _success = limiter.acquire().unwrap();
        }
        let error_path: Result<(), CodexError> = (|| {
            let _permit = limiter.acquire()?;
            Err(CodexError::Protocol)
        })();
        assert!(error_path.is_err());
        let timeout_path: Result<(), CodexError> = (|| {
            let _permit = limiter.acquire()?;
            Err(CodexError::Timeout)
        })();
        assert!(matches!(timeout_path, Err(CodexError::Timeout)));
        let _ = std::panic::catch_unwind(|| {
            let _permit = limiter.acquire().unwrap();
            panic!("synthetic unwind");
        });
        assert_eq!(*limiter.available.lock().unwrap(), MAX_CONCURRENT_SESSIONS);
    }
}
