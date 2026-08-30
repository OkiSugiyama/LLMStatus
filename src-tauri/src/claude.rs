use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use thiserror::Error;

use crate::model::{SanitizedObservation, UsageWindow};
use crate::settings::{validate_account_id, AdapterKind, AppSettings};

pub const MAX_COLLECTOR_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OBSERVATION_BYTES: u64 = 16 * 1024;
const OBSERVATION_SCHEMA_VERSION: u8 = 4;
const UNBOUND_OBSERVATION_SCHEMA_VERSIONS: [u8; 2] = [2, 3];
const FIVE_HOUR_LABEL: &str = "5 hours";
const SEVEN_DAY_LABEL: &str = "7 days";
const LEGACY_FIVE_HOUR_LABEL: &str = "5\u{6642}\u{9593}";
const LEGACY_SEVEN_DAY_LABEL: &str = "7\u{65e5}\u{9593}";

#[derive(Debug, Error)]
pub enum ClaudeError {
    #[error("invalid account ID")]
    InvalidAccountId,
    #[error("Claude status payload is too large")]
    PayloadTooLarge,
    #[error("Claude status payload is malformed")]
    MalformedPayload,
    #[error("Claude rate limit data is unavailable")]
    MissingRateLimits,
    #[error("Claude rate limit percentage is invalid")]
    InvalidPercentage,
    #[error("Claude reset timestamp is invalid")]
    InvalidTimestamp,
    #[error("Claude collector source revision is invalid")]
    InvalidSourceRevision,
    #[error("Claude collector no longer matches the saved account")]
    CollectorSuperseded,
    #[error("a newer Claude observation is already stored")]
    ObservationSuperseded,
    #[error("local observation storage is unavailable")]
    StorageUnavailable,
}

#[derive(Debug, Deserialize)]
struct RawStatusLine {
    rate_limits: Option<RawRateLimits>,
}

#[derive(Debug, Deserialize)]
struct RawRateLimits {
    five_hour: Option<RawWindow>,
    seven_day: Option<RawWindow>,
}

#[derive(Debug, Deserialize)]
struct RawWindow {
    used_percentage: f64,
    resets_at: Option<RawTimestamp>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawTimestamp {
    Unix(i64),
    Rfc3339(String),
}

pub fn sanitize_status_line(
    account_id: &str,
    source_revision: u64,
    payload: &[u8],
    observed_at: DateTime<Utc>,
) -> Result<SanitizedObservation, ClaudeError> {
    validate_account_id(account_id).map_err(|_| ClaudeError::InvalidAccountId)?;
    if source_revision == 0 {
        return Err(ClaudeError::InvalidSourceRevision);
    }
    if payload.len() > MAX_COLLECTOR_INPUT_BYTES {
        return Err(ClaudeError::PayloadTooLarge);
    }

    let raw: RawStatusLine =
        serde_json::from_slice(payload).map_err(|_| ClaudeError::MalformedPayload)?;
    let limits = raw.rate_limits.ok_or(ClaudeError::MissingRateLimits)?;
    let mut windows = Vec::with_capacity(2);

    if let Some(value) = limits.five_hour {
        windows.push(sanitize_window(
            "five-hour",
            FIVE_HOUR_LABEL,
            Some(300),
            value,
        )?);
    }
    if let Some(value) = limits.seven_day {
        windows.push(sanitize_window(
            "seven-day",
            SEVEN_DAY_LABEL,
            Some(10_080),
            value,
        )?);
    }
    if windows.is_empty() {
        return Err(ClaudeError::MissingRateLimits);
    }

    Ok(SanitizedObservation {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        account_id: account_id.to_owned(),
        source_revision,
        observed_at,
        windows,
    })
}

fn sanitize_window(
    id: &str,
    label: &str,
    duration_minutes: Option<i64>,
    raw: RawWindow,
) -> Result<UsageWindow, ClaudeError> {
    if !raw.used_percentage.is_finite() || !(0.0..=100.0).contains(&raw.used_percentage) {
        return Err(ClaudeError::InvalidPercentage);
    }
    let resets_at = raw.resets_at.map(parse_timestamp).transpose()?;

    Ok(UsageWindow {
        id: id.to_owned(),
        label: label.to_owned(),
        used_percent: raw.used_percentage,
        resets_at,
        duration_minutes,
    })
}

fn parse_timestamp(value: RawTimestamp) -> Result<DateTime<Utc>, ClaudeError> {
    match value {
        RawTimestamp::Unix(value) => {
            DateTime::<Utc>::from_timestamp(value, 0).ok_or(ClaudeError::InvalidTimestamp)
        }
        RawTimestamp::Rfc3339(value) => DateTime::parse_from_rfc3339(&value)
            .map(|timestamp| timestamp.with_timezone(&Utc))
            .map_err(|_| ClaudeError::InvalidTimestamp),
    }
}

pub fn observation_root() -> Result<PathBuf, ClaudeError> {
    match crate::storage::test_data_root() {
        Ok(Some(root)) => return Ok(root.join("observations")),
        Ok(None) => {}
        Err(()) => return Err(ClaudeError::StorageUnavailable),
    }
    dirs::data_local_dir()
        .map(|root| root.join("LLMStatus").join("observations"))
        .ok_or(ClaudeError::StorageUnavailable)
}

pub fn observation_path(account_id: &str) -> Result<PathBuf, ClaudeError> {
    validate_account_id(account_id).map_err(|_| ClaudeError::InvalidAccountId)?;
    Ok(observation_root()?.join(format!("{account_id}.json")))
}

pub fn save_observation_if_current(observation: &SanitizedObservation) -> Result<(), ClaudeError> {
    let path = observation_path(&observation.account_id)?;
    let parent = path.parent().ok_or(ClaudeError::StorageUnavailable)?;
    fs::create_dir_all(parent).map_err(|_| ClaudeError::StorageUnavailable)?;
    let settings_path =
        crate::settings::settings_path().map_err(|_| ClaudeError::StorageUnavailable)?;
    let settings_parent = settings_path
        .parent()
        .ok_or(ClaudeError::StorageUnavailable)?;
    let _write_lock = crate::storage::acquire_write_lock(settings_parent)
        .map_err(|_| ClaudeError::StorageUnavailable)?;

    persist_observation_at(observation, &path, || {
        let settings =
            crate::settings::load_settings().map_err(|_| ClaudeError::StorageUnavailable)?;
        Ok(collector_matches_settings(&settings, observation))
    })
}

fn collector_matches_settings(settings: &AppSettings, observation: &SanitizedObservation) -> bool {
    settings
        .account(&observation.account_id)
        .is_some_and(|account| {
            account.enabled
                && account.adapter_kind == AdapterKind::ClaudeStatusLine
                && account.source_revision == observation.source_revision
        })
}

fn persist_observation_at<F>(
    observation: &SanitizedObservation,
    path: &Path,
    mut collector_is_current: F,
) -> Result<(), ClaudeError>
where
    F: FnMut() -> Result<bool, ClaudeError>,
{
    if observation.schema_version != OBSERVATION_SCHEMA_VERSION
        || !observation_is_valid(observation)
        || !collector_is_current()?
    {
        return Err(ClaudeError::CollectorSuperseded);
    }

    if stored_observation_supersedes(path, observation)? {
        return Err(ClaudeError::ObservationSuperseded);
    }

    let parent = path.parent().ok_or(ClaudeError::StorageUnavailable)?;
    fs::create_dir_all(parent).map_err(|_| ClaudeError::StorageUnavailable)?;
    let serialized =
        serde_json::to_vec(observation).map_err(|_| ClaudeError::StorageUnavailable)?;
    if serialized.len() as u64 > MAX_OBSERVATION_BYTES {
        return Err(ClaudeError::PayloadTooLarge);
    }
    let temporary_path = crate::storage::temporary_path(parent, &observation.account_id);
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary_path)
        .map_err(|_| ClaudeError::StorageUnavailable)?;
    file.write_all(&serialized)
        .and_then(|_| file.sync_all())
        .map_err(|_| ClaudeError::StorageUnavailable)?;
    drop(file);

    if !collector_is_current()? || stored_observation_supersedes(path, observation)? {
        let _ = fs::remove_file(&temporary_path);
        return Err(ClaudeError::CollectorSuperseded);
    }

    crate::storage::replace_file(&temporary_path, path).map_err(|_| ClaudeError::StorageUnavailable)
}

fn stored_observation_supersedes(
    path: &Path,
    candidate: &SanitizedObservation,
) -> Result<bool, ClaudeError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(ClaudeError::StorageUnavailable),
    };
    if metadata.len() > MAX_OBSERVATION_BYTES {
        return Err(ClaudeError::PayloadTooLarge);
    }
    let bytes = fs::read(path).map_err(|_| ClaudeError::StorageUnavailable)?;
    let Ok(existing) = serde_json::from_slice::<SanitizedObservation>(&bytes) else {
        return Ok(false);
    };
    if existing.schema_version != OBSERVATION_SCHEMA_VERSION
        || existing.account_id != candidate.account_id
        || !observation_is_valid(&existing)
    {
        return Ok(false);
    }
    // The caller has already confirmed, inside the write lock, that the
    // candidate carries the source revision the settings currently assign to
    // this account. A stored observation from any other revision therefore
    // belongs to a retired source: `load_observation` refuses to display it, so
    // treating it as newer only strands the account. That happens whenever the
    // settings revision returns to a lower value than a stored observation, for
    // example after an account is removed and added again or after a settings
    // file is restored: the card keeps asking for a refresh, and every refresh
    // is rejected by data the dashboard will never show. Only an observation
    // from the same current revision can win, and then only on write order.
    Ok(existing.source_revision == candidate.source_revision
        && existing.observed_at >= candidate.observed_at)
}

pub fn load_observation(
    account_id: &str,
    source_revision: u64,
) -> Result<Option<SanitizedObservation>, ClaudeError> {
    let path = observation_path(account_id)?;
    load_observation_from(&path, account_id, source_revision)
}

fn load_observation_from(
    path: &Path,
    expected_account_id: &str,
    expected_source_revision: u64,
) -> Result<Option<SanitizedObservation>, ClaudeError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ClaudeError::StorageUnavailable),
    };
    if metadata.len() > MAX_OBSERVATION_BYTES {
        return Err(ClaudeError::PayloadTooLarge);
    }
    let bytes = fs::read(path).map_err(|_| ClaudeError::StorageUnavailable)?;
    let mut observation: SanitizedObservation =
        serde_json::from_slice(&bytes).map_err(|_| ClaudeError::MalformedPayload)?;
    if observation.account_id != expected_account_id || !observation_is_valid(&observation) {
        return Err(ClaudeError::MalformedPayload);
    }
    if UNBOUND_OBSERVATION_SCHEMA_VERSIONS.contains(&observation.schema_version) {
        return Ok(None);
    }
    if observation.schema_version != OBSERVATION_SCHEMA_VERSION {
        return Err(ClaudeError::MalformedPayload);
    }
    if observation.source_revision != expected_source_revision {
        return Ok(None);
    }
    normalize_window_labels(&mut observation)?;
    Ok(Some(observation))
}

fn canonical_window_label(window: &UsageWindow) -> Option<&'static str> {
    match window.id.as_str() {
        "five-hour"
            if window.duration_minutes == Some(300)
                && (window.label == FIVE_HOUR_LABEL || window.label == LEGACY_FIVE_HOUR_LABEL) =>
        {
            Some(FIVE_HOUR_LABEL)
        }
        "seven-day"
            if window.duration_minutes == Some(10_080)
                && (window.label == SEVEN_DAY_LABEL || window.label == LEGACY_SEVEN_DAY_LABEL) =>
        {
            Some(SEVEN_DAY_LABEL)
        }
        _ => None,
    }
}

fn normalize_window_labels(observation: &mut SanitizedObservation) -> Result<(), ClaudeError> {
    for window in &mut observation.windows {
        let canonical_label =
            canonical_window_label(window).ok_or(ClaudeError::MalformedPayload)?;
        window.label = canonical_label.to_owned();
    }
    Ok(())
}

fn observation_is_valid(observation: &SanitizedObservation) -> bool {
    if observation.source_revision == 0
        || observation.observed_at.timestamp() < 0
        || observation.windows.is_empty()
        || observation.windows.len() > 2
    {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    observation.windows.iter().all(|window| {
        canonical_window_label(window).is_some()
            && seen.insert(window.id.as_str())
            && window.used_percent.is_finite()
            && (0.0..=100.0).contains(&window.used_percent)
            && window
                .resets_at
                .map_or(true, |timestamp| timestamp.timestamp() >= 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn sanitization_persists_only_allowlisted_metrics() {
        let now = Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap();
        let raw = br#"{
          "session_id":"secret-shaped-session",
          "oauth_token":"must-not-survive",
          "rate_limits":{
            "five_hour":{"used_percentage":12.5,"resets_at":1786795200},
            "seven_day":{"used_percentage":48,"resets_at":null}
          }
        }"#;
        let result = sanitize_status_line("any-claude-account", 1, raw, now).unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert_eq!(result.windows.len(), 2);
        assert!(!serialized.contains("secret-shaped-session"));
        assert!(!serialized.contains("must-not-survive"));
        assert!(!serialized.contains("oauth"));
    }

    #[test]
    fn rejects_out_of_range_percentage() {
        let raw = br#"{"rate_limits":{"five_hour":{"used_percentage":101}}}"#;
        let error = sanitize_status_line("claude-work", 1, raw, Utc::now()).unwrap_err();
        assert!(matches!(error, ClaudeError::InvalidPercentage));
    }

    #[test]
    fn accepts_rfc3339_reset_for_backward_compatibility() {
        let raw = br#"{"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":"2026-08-15T12:00:00Z"}}}"#;
        let result = sanitize_status_line("claude-other", 1, raw, Utc::now()).unwrap();
        assert!(result.windows[0].resets_at.is_some());
    }

    #[test]
    fn rejects_path_traversal_shaped_account_id_before_persistence() {
        let raw = br#"{"rate_limits":{"five_hour":{"used_percentage":10}}}"#;
        let error = sanitize_status_line("../claude", 1, raw, Utc::now()).unwrap_err();
        assert!(matches!(error, ClaudeError::InvalidAccountId));
    }

    #[test]
    fn rejects_zero_source_revision_before_persistence() {
        let raw = br#"{"rate_limits":{"five_hour":{"used_percentage":10}}}"#;
        let error = sanitize_status_line("claude-work", 0, raw, Utc::now()).unwrap_err();
        assert!(matches!(error, ClaudeError::InvalidSourceRevision));
    }

    #[test]
    fn persisted_observation_rejects_corrupted_quota_values() {
        let observation = SanitizedObservation {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            account_id: "claude".to_owned(),
            source_revision: 2,
            observed_at: Utc::now(),
            windows: vec![UsageWindow {
                id: "five-hour".to_owned(),
                label: "5 hours".to_owned(),
                used_percent: 150.0,
                resets_at: None,
                duration_minutes: Some(300),
            }],
        };
        assert!(!observation_is_valid(&observation));
    }

    fn write_observation_for_load_test(observation: &SanitizedObservation) -> PathBuf {
        let path = crate::storage::temporary_path(
            &std::env::temp_dir(),
            "llmstatus-claude-observation-test",
        );
        std::fs::write(&path, serde_json::to_vec(observation).unwrap()).unwrap();
        path
    }

    #[test]
    fn persisted_observation_loads_current_english_labels() {
        let observation = SanitizedObservation {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            account_id: "claude".to_owned(),
            source_revision: 2,
            observed_at: Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
            windows: vec![UsageWindow {
                id: "five-hour".to_owned(),
                label: FIVE_HOUR_LABEL.to_owned(),
                used_percent: 25.0,
                resets_at: None,
                duration_minutes: Some(300),
            }],
        };
        let path = write_observation_for_load_test(&observation);

        let loaded = load_observation_from(&path, "claude", 2).unwrap().unwrap();
        std::fs::remove_file(path).unwrap();

        assert_eq!(loaded.windows[0].label, FIVE_HOUR_LABEL);
    }

    #[test]
    fn schema_two_and_three_observations_fail_closed_without_migration() {
        for schema_version in UNBOUND_OBSERVATION_SCHEMA_VERSIONS {
            let observation = SanitizedObservation {
                schema_version,
                account_id: "claude-personal".to_owned(),
                source_revision: 2,
                observed_at: Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
                windows: vec![UsageWindow {
                    id: "five-hour".to_owned(),
                    label: FIVE_HOUR_LABEL.to_owned(),
                    used_percent: 12.5,
                    resets_at: None,
                    duration_minutes: Some(300),
                }],
            };
            let path = write_observation_for_load_test(&observation);

            assert_eq!(
                load_observation_from(&path, "claude-personal", 2).unwrap(),
                None
            );

            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn unknown_observation_schema_is_rejected_while_schema_four_is_readable() {
        let current = valid_observation(
            "claude-current",
            4,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
        );
        let current_path = write_observation_for_load_test(&current);
        assert!(load_observation_from(&current_path, "claude-current", 4)
            .unwrap()
            .is_some());
        fs::remove_file(current_path).unwrap();

        let mut unknown = current;
        unknown.schema_version = 99;
        let unknown_path = write_observation_for_load_test(&unknown);
        assert!(matches!(
            load_observation_from(&unknown_path, "claude-current", 4),
            Err(ClaudeError::MalformedPayload)
        ));
        fs::remove_file(unknown_path).unwrap();
    }

    #[test]
    fn persisted_legacy_observation_loads_and_normalizes_labels() {
        let observation = SanitizedObservation {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            account_id: "claude".to_owned(),
            source_revision: 2,
            observed_at: Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
            windows: vec![
                UsageWindow {
                    id: "five-hour".to_owned(),
                    label: LEGACY_FIVE_HOUR_LABEL.to_owned(),
                    used_percent: 25.0,
                    resets_at: None,
                    duration_minutes: Some(300),
                },
                UsageWindow {
                    id: "seven-day".to_owned(),
                    label: LEGACY_SEVEN_DAY_LABEL.to_owned(),
                    used_percent: 50.0,
                    resets_at: None,
                    duration_minutes: Some(10_080),
                },
            ],
        };
        let path = write_observation_for_load_test(&observation);

        let loaded = load_observation_from(&path, "claude", 2).unwrap().unwrap();
        std::fs::remove_file(path).unwrap();

        assert_eq!(loaded.windows[0].label, FIVE_HOUR_LABEL);
        assert_eq!(loaded.windows[1].label, SEVEN_DAY_LABEL);
    }

    #[test]
    fn persisted_observation_rejects_arbitrary_window_label() {
        let observation = SanitizedObservation {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            account_id: "claude".to_owned(),
            source_revision: 2,
            observed_at: Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
            windows: vec![UsageWindow {
                id: "five-hour".to_owned(),
                label: "Five hour window".to_owned(),
                used_percent: 25.0,
                resets_at: None,
                duration_minutes: Some(300),
            }],
        };
        let path = write_observation_for_load_test(&observation);

        let error = load_observation_from(&path, "claude", 2).unwrap_err();
        std::fs::remove_file(path).unwrap();

        assert!(matches!(error, ClaudeError::MalformedPayload));
    }

    fn account_settings(
        id: &str,
        revision: u64,
        enabled: bool,
        adapter_kind: AdapterKind,
    ) -> AppSettings {
        AppSettings {
            accounts: vec![crate::settings::AccountConfig {
                id: id.to_owned(),
                label: "Synthetic account".to_owned(),
                adapter_kind,
                enabled,
                source_revision: revision,
                executable_path: None,
                config_dir: None,
            }],
            ..AppSettings::default()
        }
    }

    fn valid_observation(
        account_id: &str,
        source_revision: u64,
        observed_at: DateTime<Utc>,
    ) -> SanitizedObservation {
        SanitizedObservation {
            schema_version: OBSERVATION_SCHEMA_VERSION,
            account_id: account_id.to_owned(),
            source_revision,
            observed_at,
            windows: vec![UsageWindow {
                id: "five-hour".to_owned(),
                label: FIVE_HOUR_LABEL.to_owned(),
                used_percent: 25.0,
                resets_at: None,
                duration_minutes: Some(300),
            }],
        }
    }

    #[test]
    fn removed_disabled_wrong_adapter_and_old_revision_collectors_fail_closed() {
        let observation = valid_observation("claude-current", 7, Utc::now());
        assert!(collector_matches_settings(
            &account_settings("claude-current", 7, true, AdapterKind::ClaudeStatusLine),
            &observation
        ));
        assert!(!collector_matches_settings(
            &AppSettings::default(),
            &observation
        ));
        assert!(!collector_matches_settings(
            &account_settings("claude-current", 7, false, AdapterKind::ClaudeStatusLine),
            &observation
        ));
        assert!(!collector_matches_settings(
            &account_settings("claude-current", 7, true, AdapterKind::CodexAppServer),
            &observation
        ));
        assert!(!collector_matches_settings(
            &account_settings("claude-current", 8, true, AdapterKind::ClaudeStatusLine),
            &observation
        ));
    }

    #[test]
    fn revision_change_before_atomic_replace_keeps_concurrent_current_writer_authoritative() {
        let root = crate::storage::temporary_path(
            &std::env::temp_dir(),
            "llmstatus-claude-reassignment-test",
        );
        fs::create_dir_all(&root).unwrap();
        let path = root.join("observation.json");
        let observation = valid_observation(
            "claude-current",
            7,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
        );
        let current = valid_observation(
            "claude-current",
            8,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 1, 0).unwrap(),
        );
        let mut checks = 0;
        let error = persist_observation_at(&observation, &path, || {
            checks += 1;
            if checks == 1 {
                Ok(true)
            } else {
                fs::write(&path, serde_json::to_vec(&current).unwrap()).unwrap();
                Ok(false)
            }
        })
        .unwrap_err();

        assert!(matches!(error, ClaudeError::CollectorSuperseded));
        assert_eq!(
            serde_json::from_slice::<SanitizedObservation>(&fs::read(&path).unwrap()).unwrap(),
            current
        );
        assert!(load_observation_from(&path, "claude-current", 8)
            .unwrap()
            .is_some());
        assert_eq!(
            load_observation_from(&path, "claude-current", 7).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_out_of_order_write_at_the_current_revision_cannot_replace_the_stored_observation() {
        let root = crate::storage::temporary_path(
            &std::env::temp_dir(),
            "llmstatus-claude-write-order-test",
        );
        fs::create_dir_all(&root).unwrap();
        let path = root.join("observation.json");
        let newer = valid_observation(
            "claude-current",
            8,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 5, 0).unwrap(),
        );
        fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();

        let older_write = valid_observation(
            "claude-current",
            8,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 4, 0).unwrap(),
        );
        assert!(matches!(
            persist_observation_at(&older_write, &path, || Ok(true)),
            Err(ClaudeError::ObservationSuperseded)
        ));
        assert_eq!(
            serde_json::from_slice::<SanitizedObservation>(&fs::read(&path).unwrap()).unwrap(),
            newer
        );

        fs::remove_dir_all(root).unwrap();
    }

    /// A collector whose revision no longer matches the settings is stopped by
    /// `collector_is_current`, so a stored observation from a retired revision
    /// never protects live data. Letting it win instead deadlocks the account:
    /// the dashboard hides the retired observation and offers a refresh, and
    /// every refresh is rejected by the observation the dashboard is hiding.
    #[test]
    fn a_retired_higher_revision_observation_cannot_deadlock_the_current_collector() {
        let root = crate::storage::temporary_path(
            &std::env::temp_dir(),
            "llmstatus-claude-retired-revision-test",
        );
        fs::create_dir_all(&root).unwrap();
        let path = root.join("observation.json");
        let retired = valid_observation(
            "claude-current",
            2,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 5, 0).unwrap(),
        );
        fs::write(&path, serde_json::to_vec(&retired).unwrap()).unwrap();
        assert_eq!(
            load_observation_from(&path, "claude-current", 1).unwrap(),
            None
        );

        let current = valid_observation(
            "claude-current",
            1,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 6, 0).unwrap(),
        );
        persist_observation_at(&current, &path, || Ok(true)).unwrap();
        assert_eq!(
            load_observation_from(&path, "claude-current", 1)
                .unwrap()
                .unwrap(),
            current
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_schema_four_write_leaves_legacy_data_unavailable() {
        let root = crate::storage::temporary_path(
            &std::env::temp_dir(),
            "llmstatus-claude-failed-schema-four-test",
        );
        fs::create_dir_all(&root).unwrap();
        let path = root.join("observation.json");
        let mut legacy = valid_observation(
            "claude-current",
            3,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap(),
        );
        legacy.schema_version = 3;
        let legacy_bytes = serde_json::to_vec(&legacy).unwrap();
        fs::write(&path, &legacy_bytes).unwrap();

        let current = valid_observation(
            "claude-current",
            4,
            Utc.with_ymd_and_hms(2026, 8, 15, 10, 5, 0).unwrap(),
        );
        assert!(matches!(
            persist_observation_at(&current, &path, || Ok(false)),
            Err(ClaudeError::CollectorSuperseded)
        ));
        assert_eq!(fs::read(&path).unwrap(), legacy_bytes);
        assert_eq!(
            load_observation_from(&path, "claude-current", 3).unwrap(),
            None
        );

        persist_observation_at(&current, &path, || Ok(true)).unwrap();
        assert!(load_observation_from(&path, "claude-current", 4)
            .unwrap()
            .is_some());

        fs::remove_dir_all(root).unwrap();
    }
}
