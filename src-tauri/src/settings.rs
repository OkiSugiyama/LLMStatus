use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SETTINGS_SCHEMA_VERSION: u8 = 1;
pub const MAX_ACCOUNTS: usize = 32;
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AdapterKind {
    CodexAppServer,
    ClaudeStatusLine,
}

impl AdapterKind {
    pub fn provider(self) -> &'static str {
        match self {
            Self::CodexAppServer => "openai",
            Self::ClaudeStatusLine => "anthropic",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub id: String,
    pub label: String,
    pub adapter_kind: AdapterKind,
    pub enabled: bool,
    #[serde(default)]
    pub source_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u8,
    pub refresh_interval_seconds: u64,
    pub stale_after_minutes: i64,
    pub accounts: Vec<AccountConfig>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfigView {
    pub id: String,
    pub label: String,
    pub adapter_kind: AdapterKind,
    pub enabled: bool,
    pub source_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsView {
    pub schema_version: u8,
    pub refresh_interval_seconds: u64,
    pub stale_after_minutes: i64,
    pub accounts: Vec<AccountConfigView>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            refresh_interval_seconds: 300,
            stale_after_minutes: 10,
            accounts: Vec::new(),
        }
    }
}

impl AppSettings {
    pub fn to_view(&self) -> AppSettingsView {
        self.to_view_for(cfg!(windows))
    }

    fn to_view_for(&self, windows: bool) -> AppSettingsView {
        AppSettingsView {
            schema_version: self.schema_version,
            refresh_interval_seconds: self.refresh_interval_seconds,
            stale_after_minutes: self.stale_after_minutes,
            accounts: self
                .accounts
                .iter()
                .map(|account| AccountConfigView {
                    id: account.id.clone(),
                    label: account.label.clone(),
                    adapter_kind: account.adapter_kind,
                    enabled: account.enabled,
                    source_revision: account.source_revision,
                    executable_path: account.executable_path.clone(),
                    config_dir: account.config_dir.clone(),
                    profile_identity: account
                        .config_dir
                        .as_deref()
                        .map(|config_dir| profile_key_for_platform(Some(config_dir), windows)),
                })
                .collect(),
        }
    }

    pub fn assign_source_revisions(&mut self, previous: &Self) -> Result<(), SettingsError> {
        for account in &mut self.accounts {
            account.source_revision = match previous.account(&account.id) {
                Some(previous_account) if same_source(previous_account, account) => {
                    previous_account.source_revision.max(1)
                }
                Some(previous_account) => previous_account
                    .source_revision
                    .max(1)
                    .checked_add(1)
                    .ok_or(SettingsError::SourceRevisionExhausted)?,
                None => 1,
            };
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), SettingsError> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsError::UnsupportedSchema);
        }
        if !(60..=3600).contains(&self.refresh_interval_seconds) {
            return Err(SettingsError::InvalidRefreshInterval);
        }
        if !(1..=1440).contains(&self.stale_after_minutes) {
            return Err(SettingsError::InvalidStaleThreshold);
        }
        if self.accounts.len() > MAX_ACCOUNTS {
            return Err(SettingsError::TooManyAccounts);
        }

        let mut ids = HashSet::new();
        let mut codex_profiles = HashSet::new();
        let mut claude_profiles = HashSet::new();
        for account in &self.accounts {
            validate_account_id(&account.id)?;
            validate_label(&account.label)?;
            if account.source_revision == 0 {
                return Err(SettingsError::InvalidSourceRevision);
            }
            if !ids.insert(account.id.clone()) {
                return Err(SettingsError::DuplicateAccountId);
            }
            validate_optional_absolute_path(account.executable_path.as_deref())?;
            validate_optional_absolute_path(account.config_dir.as_deref())?;
            if account.adapter_kind != AdapterKind::CodexAppServer
                && account.executable_path.is_some()
            {
                return Err(SettingsError::UnexpectedAdapterField);
            }

            if account.enabled {
                match account.adapter_kind {
                    AdapterKind::CodexAppServer => {
                        let profile = profile_key(account.config_dir.as_deref());
                        if !codex_profiles.insert(profile) {
                            return Err(SettingsError::DuplicateProfile);
                        }
                    }
                    AdapterKind::ClaudeStatusLine => {
                        if account.config_dir.is_some()
                            && !claude_profiles.insert(profile_key(account.config_dir.as_deref()))
                        {
                            return Err(SettingsError::DuplicateProfile);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn account(&self, id: &str) -> Option<&AccountConfig> {
        self.accounts.iter().find(|account| account.id == id)
    }
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("unsupported settings schema")]
    UnsupportedSchema,
    #[error("refresh interval must be between 60 and 3600 seconds")]
    InvalidRefreshInterval,
    #[error("stale threshold must be between 1 and 1440 minutes")]
    InvalidStaleThreshold,
    #[error("too many accounts")]
    TooManyAccounts,
    #[error("account ID must be 1-64 lowercase ASCII letters, digits, hyphens, or underscores")]
    InvalidAccountId,
    #[error("account label must be 1-80 visible characters")]
    InvalidLabel,
    #[error("account source revision is invalid")]
    InvalidSourceRevision,
    #[error("account source revision cannot be advanced safely")]
    SourceRevisionExhausted,
    #[error("account IDs must be unique")]
    DuplicateAccountId,
    #[error("enabled accounts for the same adapter cannot share a profile directory")]
    DuplicateProfile,
    #[error("configured paths must be absolute")]
    PathMustBeAbsolute,
    #[error("the selected adapter does not accept an executable path")]
    UnexpectedAdapterField,
    #[error("local settings storage is unavailable")]
    StorageUnavailable,
    #[error("local settings file is too large")]
    FileTooLarge,
    #[error("local settings file is malformed")]
    MalformedFile,
}

pub fn validate_account_id(value: &str) -> Result<(), SettingsError> {
    let valid_length = (1..=64).contains(&value.len());
    let mut characters = value.bytes();
    let valid_first = characters
        .next()
        .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
    let valid_rest = characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == b'-'
            || character == b'_'
    });
    let windows_reserved = matches!(
        value,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    );
    if valid_length && valid_first && valid_rest && !windows_reserved {
        Ok(())
    } else {
        Err(SettingsError::InvalidAccountId)
    }
}

fn validate_label(value: &str) -> Result<(), SettingsError> {
    let length = value.chars().count();
    if (1..=80).contains(&length) && value.trim() == value && !value.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(SettingsError::InvalidLabel)
    }
}

fn validate_optional_absolute_path(value: Option<&str>) -> Result<(), SettingsError> {
    if let Some(value) = value {
        if value.is_empty() || value.contains('\0') || !Path::new(value).is_absolute() {
            return Err(SettingsError::PathMustBeAbsolute);
        }
    }
    Ok(())
}

fn profile_key(value: Option<&str>) -> String {
    profile_key_for_platform(value, cfg!(windows))
}

fn profile_key_for_platform(value: Option<&str>, windows: bool) -> String {
    let Some(value) = value else {
        return String::new();
    };
    profile_key_with_canonicalizer(value, windows, Path::canonicalize)
}

pub(crate) fn canonical_profile_identity(path: &Path) -> Option<String> {
    path.to_str().map(str::to_owned)
}

fn profile_key_with_canonicalizer<F>(value: &str, windows: bool, canonicalize: F) -> String
where
    F: FnOnce(&Path) -> std::io::Result<PathBuf>,
{
    let path = Path::new(value);
    match canonicalize(path) {
        Ok(canonical) => canonical.to_string_lossy().into_owned(),
        Err(_) => {
            let identity = normalize_path(path).to_string_lossy().into_owned();
            if windows {
                identity.to_ascii_lowercase()
            } else {
                identity
            }
        }
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn same_source(previous: &AccountConfig, next: &AccountConfig) -> bool {
    previous.adapter_kind == next.adapter_kind
        && profile_key(previous.config_dir.as_deref()) == profile_key(next.config_dir.as_deref())
        && (next.adapter_kind != AdapterKind::CodexAppServer
            || profile_key(previous.executable_path.as_deref())
                == profile_key(next.executable_path.as_deref()))
}

pub fn settings_path() -> Result<PathBuf, SettingsError> {
    match crate::storage::test_data_root() {
        Ok(Some(root)) => return Ok(root.join("settings.json")),
        Ok(None) => {}
        Err(()) => return Err(SettingsError::StorageUnavailable),
    }
    dirs::config_dir()
        .map(|root| root.join("LLMStatus").join("settings.json"))
        .ok_or(SettingsError::StorageUnavailable)
}

pub fn load_settings() -> Result<AppSettings, SettingsError> {
    let path = settings_path()?;
    load_settings_from(&path)
}

fn load_settings_from(path: &Path) -> Result<AppSettings, SettingsError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppSettings::default())
        }
        Err(_) => return Err(SettingsError::StorageUnavailable),
    };
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err(SettingsError::FileTooLarge);
    }
    let bytes = fs::read(path).map_err(|_| SettingsError::StorageUnavailable)?;
    let mut settings: AppSettings =
        serde_json::from_slice(&bytes).map_err(|_| SettingsError::MalformedFile)?;
    for account in &mut settings.accounts {
        account.source_revision = account.source_revision.max(1);
    }
    settings.validate()?;
    Ok(settings)
}

pub fn save_settings(settings: AppSettings) -> Result<AppSettings, SettingsError> {
    let path = settings_path()?;
    save_settings_at(&path, settings)
}

fn save_settings_at(path: &Path, mut settings: AppSettings) -> Result<AppSettings, SettingsError> {
    let parent = path.parent().ok_or(SettingsError::StorageUnavailable)?;
    fs::create_dir_all(parent).map_err(|_| SettingsError::StorageUnavailable)?;
    let _write_lock = crate::storage::acquire_write_lock(parent)
        .map_err(|_| SettingsError::StorageUnavailable)?;
    let previous = load_settings_from(path)?;
    settings.assign_source_revisions(&previous)?;
    settings.validate()?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| SettingsError::MalformedFile)?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(SettingsError::FileTooLarge);
    }
    let temporary_path = crate::storage::temporary_path(parent, "settings");
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary_path)
        .map_err(|_| SettingsError::StorageUnavailable)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| SettingsError::StorageUnavailable)?;
    drop(file);
    crate::storage::replace_file(&temporary_path, path)
        .map_err(|_| SettingsError::StorageUnavailable)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, adapter_kind: AdapterKind, config_dir: Option<String>) -> AccountConfig {
        AccountConfig {
            id: id.to_owned(),
            label: id.to_owned(),
            adapter_kind,
            enabled: true,
            source_revision: 1,
            executable_path: None,
            config_dir,
        }
    }

    fn absolute_path(unix: &str, windows: &str) -> String {
        if cfg!(windows) {
            windows.to_owned()
        } else {
            unix.to_owned()
        }
    }

    #[test]
    fn default_settings_do_not_assume_an_account_count() {
        let settings = AppSettings::default();
        assert!(settings.accounts.is_empty());
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn accepts_distinct_dynamic_profiles() {
        let settings = AppSettings {
            accounts: vec![
                account(
                    "codex-personal",
                    AdapterKind::CodexAppServer,
                    Some(absolute_path("/profiles/personal", r"C:\profiles\personal")),
                ),
                account(
                    "codex-work",
                    AdapterKind::CodexAppServer,
                    Some(absolute_path("/profiles/work", r"C:\profiles\work")),
                ),
                account(
                    "claude-work",
                    AdapterKind::ClaudeStatusLine,
                    Some(absolute_path("/profiles/claude", r"C:\profiles\claude")),
                ),
            ],
            ..AppSettings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn accepts_multiple_claude_statusline_accounts_without_profile_paths() {
        let settings = AppSettings {
            accounts: vec![
                account("claude-personal", AdapterKind::ClaudeStatusLine, None),
                account("claude-work", AdapterKind::ClaudeStatusLine, None),
            ],
            ..AppSettings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn accepts_one_default_and_distinct_explicit_codex_profiles() {
        let settings = AppSettings {
            accounts: vec![
                account("codex-default", AdapterKind::CodexAppServer, None),
                account(
                    "codex-work",
                    AdapterKind::CodexAppServer,
                    Some(absolute_path("/profiles/work", r"C:\profiles\work")),
                ),
            ],
            ..AppSettings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn rejects_canonical_equivalent_explicit_claude_profiles() {
        let settings = AppSettings {
            accounts: vec![
                account(
                    "claude-first",
                    AdapterKind::ClaudeStatusLine,
                    Some(absolute_path(
                        "/profiles/team/../work",
                        r"C:\profiles\team\..\work",
                    )),
                ),
                account(
                    "claude-second",
                    AdapterKind::ClaudeStatusLine,
                    Some(absolute_path("/profiles/work", r"C:\profiles\work")),
                ),
            ],
            ..AppSettings::default()
        };
        assert!(matches!(
            settings.validate(),
            Err(SettingsError::DuplicateProfile)
        ));
    }

    #[test]
    fn permits_duplicate_profiles_when_only_one_account_is_enabled() {
        let profile = Some(absolute_path(
            "/profiles/claude-work",
            r"C:\profiles\claude-work",
        ));
        let mut disabled = account(
            "claude-disabled",
            AdapterKind::ClaudeStatusLine,
            profile.clone(),
        );
        disabled.enabled = false;
        let settings = AppSettings {
            accounts: vec![
                account("claude-enabled", AdapterKind::ClaudeStatusLine, profile),
                disabled,
            ],
            ..AppSettings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn rejects_traversal_shaped_ids_and_duplicate_profiles() {
        assert!(validate_account_id("../profile").is_err());
        let settings = AppSettings {
            accounts: vec![
                account("first", AdapterKind::CodexAppServer, None),
                account("second", AdapterKind::CodexAppServer, None),
            ],
            ..AppSettings::default()
        };
        assert!(matches!(
            settings.validate(),
            Err(SettingsError::DuplicateProfile)
        ));
    }

    #[test]
    fn equivalent_nonexistent_profile_paths_are_duplicates() {
        let settings = AppSettings {
            accounts: vec![
                account(
                    "first",
                    AdapterKind::CodexAppServer,
                    Some(absolute_path(
                        "/profiles/team/../work",
                        r"C:\profiles\team\..\work",
                    )),
                ),
                account(
                    "second",
                    AdapterKind::CodexAppServer,
                    Some(absolute_path("/profiles/work", r"C:\profiles\work")),
                ),
            ],
            ..AppSettings::default()
        };
        assert!(matches!(
            settings.validate(),
            Err(SettingsError::DuplicateProfile)
        ));
    }

    #[test]
    fn source_revision_changes_only_when_the_source_identity_changes() {
        let previous = AppSettings {
            accounts: vec![account(
                "codex-work",
                AdapterKind::CodexAppServer,
                Some(absolute_path("/profiles/work", r"C:\profiles\work")),
            )],
            ..AppSettings::default()
        };
        let mut renamed = previous.clone();
        renamed.accounts[0].label = "Renamed".to_owned();
        renamed.accounts[0].source_revision = 999;
        renamed.assign_source_revisions(&previous).unwrap();
        assert_eq!(renamed.accounts[0].source_revision, 1);

        let mut changed = renamed;
        changed.accounts[0].config_dir =
            Some(absolute_path("/profiles/personal", r"C:\profiles\personal"));
        changed.assign_source_revisions(&previous).unwrap();
        assert_eq!(changed.accounts[0].source_revision, 2);
    }

    #[test]
    fn source_revision_exhaustion_fails_closed_instead_of_saturating() {
        let mut previous = AppSettings {
            accounts: vec![account(
                "claude-work",
                AdapterKind::ClaudeStatusLine,
                Some(absolute_path("/profiles/work", r"C:\profiles\work")),
            )],
            ..AppSettings::default()
        };
        previous.accounts[0].source_revision = u64::MAX;
        let mut changed = previous.clone();
        changed.accounts[0].config_dir =
            Some(absolute_path("/profiles/personal", r"C:\profiles\personal"));

        assert!(matches!(
            changed.assign_source_revisions(&previous),
            Err(SettingsError::SourceRevisionExhausted)
        ));
        assert_eq!(changed.accounts[0].source_revision, u64::MAX);
    }

    #[test]
    fn stale_writers_recompute_source_revision_inside_the_cross_process_lock() {
        let root = test_root("locked-source-revision");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let mut base = AppSettings {
            accounts: vec![account(
                "claude-work",
                AdapterKind::ClaudeStatusLine,
                Some(absolute_path("/profiles/base", r"C:\profiles\base")),
            )],
            ..AppSettings::default()
        };
        base.accounts[0].source_revision = 7;
        fs::write(&path, serde_json::to_vec(&base).unwrap()).unwrap();

        let mut first_request = base.clone();
        first_request.accounts[0].config_dir = Some(absolute_path(
            "/profiles/first-writer",
            r"C:\profiles\first-writer",
        ));
        let mut second_stale_request = base;
        second_stale_request.accounts[0].config_dir = Some(absolute_path(
            "/profiles/second-writer",
            r"C:\profiles\second-writer",
        ));

        let first_saved = save_settings_at(&path, first_request).unwrap();
        let second_saved = save_settings_at(&path, second_stale_request).unwrap();
        assert_eq!(first_saved.accounts[0].source_revision, 8);
        assert_eq!(second_saved.accounts[0].source_revision, 9);
        assert_eq!(load_settings_from(&path).unwrap(), second_saved);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_view_separates_saved_paths_from_profile_identities_for_both_adapters() {
        let root = test_root("settings-view-identities");
        let codex_parent = root.join("codex");
        let claude_parent = root.join("claude");
        fs::create_dir_all(codex_parent.join("team")).unwrap();
        fs::create_dir_all(codex_parent.join("work")).unwrap();
        fs::create_dir_all(claude_parent.join("team")).unwrap();
        fs::create_dir_all(claude_parent.join("work")).unwrap();

        let codex_saved = codex_parent.join("team").join("..").join("work");
        let claude_saved = claude_parent.join("team").join("..").join("work");
        let mut settings = AppSettings {
            accounts: vec![
                account(
                    "codex-work",
                    AdapterKind::CodexAppServer,
                    Some(codex_saved.to_string_lossy().into_owned()),
                ),
                account(
                    "claude-work",
                    AdapterKind::ClaudeStatusLine,
                    Some(claude_saved.to_string_lossy().into_owned()),
                ),
            ],
            ..AppSettings::default()
        };
        settings.accounts[0].source_revision = 5;
        settings.accounts[1].source_revision = 7;

        let view = settings.to_view();
        assert_eq!(view.accounts[0].config_dir.as_deref(), codex_saved.to_str());
        assert_eq!(
            view.accounts[1].config_dir.as_deref(),
            claude_saved.to_str()
        );
        assert_eq!(
            view.accounts[0].profile_identity.as_deref(),
            codex_parent.join("work").canonicalize().unwrap().to_str()
        );
        assert_eq!(
            view.accounts[1].profile_identity.as_deref(),
            claude_parent.join("work").canonicalize().unwrap().to_str()
        );
        assert_eq!(
            settings.accounts[0].config_dir.as_deref(),
            codex_saved.to_str()
        );
        assert_eq!(
            settings.accounts[1].config_dir.as_deref(),
            claude_saved.to_str()
        );

        let serialized = serde_json::to_value(view).unwrap();
        assert!(serialized["accounts"][0].get("profileIdentity").is_some());
        let mut round_trip: AppSettings = serde_json::from_value(serialized).unwrap();
        round_trip.assign_source_revisions(&settings).unwrap();
        assert_eq!(round_trip.accounts, settings.accounts);
        assert!(!serde_json::to_string(&round_trip)
            .unwrap()
            .contains("profileIdentity"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn response_profile_identity_is_never_path_authority_for_both_adapters() {
        let root = test_root("untrusted-profile-identity");
        let previous_parent = root.join("previous");
        let submitted_path = root.join("submitted");
        fs::create_dir_all(previous_parent.join("team")).unwrap();
        fs::create_dir_all(previous_parent.join("work")).unwrap();
        fs::create_dir_all(&submitted_path).unwrap();

        let previous_raw = previous_parent.join("team").join("..").join("work");
        let previous_identity = previous_parent.join("work").canonicalize().unwrap();

        for adapter_kind in [AdapterKind::CodexAppServer, AdapterKind::ClaudeStatusLine] {
            let mut previous = AppSettings {
                accounts: vec![account(
                    "work",
                    adapter_kind,
                    Some(previous_raw.to_string_lossy().into_owned()),
                )],
                ..AppSettings::default()
            };
            previous.accounts[0].source_revision = 9;

            let response = serde_json::to_value(previous.to_view()).unwrap();
            assert_eq!(
                response["accounts"][0]["profileIdentity"],
                serde_json::json!(previous_identity)
            );

            let mut identity_only_json = response.clone();
            identity_only_json["accounts"][0]
                .as_object_mut()
                .unwrap()
                .remove("configDir");
            let mut identity_only: AppSettings =
                serde_json::from_value(identity_only_json).unwrap();
            identity_only.assign_source_revisions(&previous).unwrap();
            assert_eq!(identity_only.accounts[0].config_dir, None);
            assert_eq!(identity_only.accounts[0].source_revision, 10);
            let persisted_identity_only = serde_json::to_value(&identity_only).unwrap();
            assert!(persisted_identity_only["accounts"][0]
                .get("profileIdentity")
                .is_none());
            assert!(persisted_identity_only["accounts"][0]
                .get("configDir")
                .is_none());

            let mut injected_identity_json = response.clone();
            injected_identity_json["accounts"][0]["configDir"] = serde_json::json!(submitted_path);
            let mut injected_identity: AppSettings =
                serde_json::from_value(injected_identity_json).unwrap();
            injected_identity
                .assign_source_revisions(&previous)
                .unwrap();
            assert_eq!(
                injected_identity.accounts[0].config_dir.as_deref(),
                submitted_path.to_str()
            );
            assert_eq!(injected_identity.accounts[0].source_revision, 10);
            let persisted_injected = serde_json::to_value(&injected_identity).unwrap();
            assert_eq!(
                persisted_injected["accounts"][0]["configDir"],
                serde_json::json!(submitted_path)
            );
            assert!(persisted_injected["accounts"][0]
                .get("profileIdentity")
                .is_none());

            let mut modified_identity_json = response.clone();
            modified_identity_json["accounts"][0]["configDir"] =
                serde_json::json!(previous_identity);
            modified_identity_json["accounts"][0]["profileIdentity"] =
                serde_json::json!(submitted_path);
            let mut modified_identity: AppSettings =
                serde_json::from_value(modified_identity_json).unwrap();
            modified_identity
                .assign_source_revisions(&previous)
                .unwrap();
            assert_eq!(
                modified_identity.accounts[0].config_dir.as_deref(),
                previous_identity.to_str()
            );
            assert_ne!(
                modified_identity.accounts[0].config_dir.as_deref(),
                previous_raw.to_str()
            );
            assert_eq!(modified_identity.accounts[0].source_revision, 9);
            let persisted_modified = serde_json::to_value(&modified_identity).unwrap();
            assert_eq!(
                persisted_modified["accounts"][0]["configDir"],
                serde_json::json!(previous_identity)
            );
            assert!(persisted_modified["accounts"][0]
                .get("profileIdentity")
                .is_none());
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_unresolved_profile_identities_fold_without_replacing_raw_paths() {
        let marker = format!("LLMStatus-SEC2-{}", std::process::id());
        let marker_lower = marker.to_ascii_lowercase();
        let raw_paths = [
            format!("C:/{marker}/Codex/TEAM/../Work"),
            format!("c:/{marker_lower}/codex/work"),
            format!("D:/{marker}/Claude/TEAM/../Work"),
            format!("d:/{marker_lower}/claude/work"),
        ];
        let mut accounts = vec![
            account(
                "codex-first",
                AdapterKind::CodexAppServer,
                Some(raw_paths[0].clone()),
            ),
            account(
                "codex-second",
                AdapterKind::CodexAppServer,
                Some(raw_paths[1].clone()),
            ),
            account(
                "claude-first",
                AdapterKind::ClaudeStatusLine,
                Some(raw_paths[2].clone()),
            ),
            account(
                "claude-second",
                AdapterKind::ClaudeStatusLine,
                Some(raw_paths[3].clone()),
            ),
        ];
        for account in &mut accounts {
            account.enabled = false;
        }
        let settings = AppSettings {
            accounts,
            ..AppSettings::default()
        };

        let view = settings.to_view_for(true);
        assert_eq!(
            view.accounts[0].profile_identity,
            view.accounts[1].profile_identity
        );
        assert_eq!(
            view.accounts[2].profile_identity,
            view.accounts[3].profile_identity
        );
        assert!(view.accounts.iter().all(|account| {
            account
                .profile_identity
                .as_ref()
                .is_some_and(|identity| identity == &identity.to_ascii_lowercase())
        }));
        assert_eq!(
            view.accounts
                .iter()
                .map(|account| account.config_dir.as_deref())
                .collect::<Vec<_>>(),
            raw_paths
                .iter()
                .map(|path| Some(path.as_str()))
                .collect::<Vec<_>>()
        );

        let mut round_trip: AppSettings =
            serde_json::from_value(serde_json::to_value(view).unwrap()).unwrap();
        round_trip.assign_source_revisions(&settings).unwrap();
        assert_eq!(
            round_trip
                .accounts
                .iter()
                .map(|account| account.config_dir.as_deref())
                .collect::<Vec<_>>(),
            raw_paths
                .iter()
                .map(|path| Some(path.as_str()))
                .collect::<Vec<_>>()
        );
        assert_eq!(round_trip.accounts, settings.accounts);
    }

    #[test]
    fn windows_existing_case_only_canonical_directories_remain_distinct() {
        let upper = profile_key_with_canonicalizer(r"C:\Profiles\Work", true, |_| {
            Ok(PathBuf::from(r"C:\Profiles\Work"))
        });
        let lower = profile_key_with_canonicalizer(r"C:\Profiles\work", true, |_| {
            Ok(PathBuf::from(r"C:\Profiles\work"))
        });

        assert_eq!(upper, r"C:\Profiles\Work");
        assert_eq!(lower, r"C:\Profiles\work");
        assert_ne!(upper, lower);
    }

    #[test]
    fn canonical_equivalents_and_symlink_aliases_share_an_identity_for_both_adapters() {
        let root = test_root("canonical-aliases");
        let profile = root.join("profile");
        fs::create_dir_all(&profile).unwrap();
        let lexical_alias = root.join("nested").join("..").join("profile");
        fs::create_dir(root.join("nested")).unwrap();

        for adapter_kind in [AdapterKind::CodexAppServer, AdapterKind::ClaudeStatusLine] {
            let settings = AppSettings {
                accounts: vec![
                    account(
                        "first",
                        adapter_kind,
                        Some(profile.to_string_lossy().into_owned()),
                    ),
                    account(
                        "second",
                        adapter_kind,
                        Some(lexical_alias.to_string_lossy().into_owned()),
                    ),
                ],
                ..AppSettings::default()
            };
            assert!(matches!(
                settings.validate(),
                Err(SettingsError::DuplicateProfile)
            ));
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let symlink_alias = root.join("profile-link");
            symlink(&profile, &symlink_alias).unwrap();
            assert_eq!(
                profile_key(Some(&profile.to_string_lossy())),
                profile_key(Some(&symlink_alias.to_string_lossy()))
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn distinct_existing_canonical_directories_keep_distinct_identities() {
        let first = profile_key_with_canonicalizer("/profiles/first", true, |_| {
            Ok(PathBuf::from(r"C:\Profiles\First"))
        });
        let second = profile_key_with_canonicalizer("/profiles/second", true, |_| {
            Ok(PathBuf::from(r"C:\Profiles\Second"))
        });
        assert_ne!(first, second);
    }

    #[test]
    fn claude_adapter_rejects_an_executable_path() {
        let mut claude = account("claude", AdapterKind::ClaudeStatusLine, None);
        claude.executable_path = Some(absolute_path(
            "/usr/local/bin/unexpected",
            r"C:\Program Files\unexpected.exe",
        ));
        let settings = AppSettings {
            accounts: vec![claude],
            ..AppSettings::default()
        };
        assert!(matches!(
            settings.validate(),
            Err(SettingsError::UnexpectedAdapterField)
        ));
    }

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("llmstatus-settings-{name}-{}", std::process::id()))
    }
}
