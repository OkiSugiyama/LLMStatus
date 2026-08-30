use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::settings::{canonical_profile_identity, AdapterKind};

const MAX_HOME_ENTRIES: usize = 256;
const MAX_CANDIDATES: usize = 256;
const MAX_EXPLICIT_PATH_BYTES: usize = 4096;
const MAX_RESOLUTION_ATTEMPTS_PER_SECOND: usize = 8;
const RESOLUTION_WINDOW: Duration = Duration::from_secs(1);

static RESOLUTION_RATE_LIMITER: OnceLock<Mutex<ResolutionRateLimiter>> = OnceLock::new();

#[derive(Debug, Default)]
pub struct ResolutionRateLimiter {
    attempts: VecDeque<Instant>,
}

impl ResolutionRateLimiter {
    fn charge(&mut self, now: Instant) -> Result<(), String> {
        while self
            .attempts
            .front()
            .is_some_and(|attempt| now.saturating_duration_since(*attempt) >= RESOLUTION_WINDOW)
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= MAX_RESOLUTION_ATTEMPTS_PER_SECOND {
            return Err("profile directory validation is temporarily rate limited".to_owned());
        }
        self.attempts.push_back(now);
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCandidate {
    pub adapter_kind: AdapterKind,
    pub path: String,
    pub label: String,
    pub profile_identity: String,
}

pub fn discover_config_dirs(adapter_kind: AdapterKind) -> Vec<ConfigCandidate> {
    discover_from(
        adapter_kind,
        environment_path(adapter_kind),
        dirs::home_dir(),
    )
}

pub fn resolve_config_dir(
    adapter_kind: AdapterKind,
    path: &str,
) -> Result<ConfigCandidate, String> {
    if path.len() > MAX_EXPLICIT_PATH_BYTES {
        return Err("profile directory path is too long".to_owned());
    }
    if path.trim().is_empty() {
        return Err("profile directory is required".to_owned());
    }

    let selected = PathBuf::from(path);
    if !selected.is_absolute() {
        return Err("profile directory must be an absolute path".to_owned());
    }

    let metadata = fs::symlink_metadata(&selected)
        .map_err(|_| "profile directory is unavailable".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Err("profile directory cannot be a symbolic link".to_owned());
    }
    if !metadata.is_dir() {
        return Err("profile directory is unavailable".to_owned());
    }

    let canonical = selected
        .canonicalize()
        .map_err(|_| "profile directory is unavailable".to_owned())?;
    if is_broad_root(&canonical) {
        return Err(
            "choose a dedicated profile directory instead of a filesystem or home root".to_owned(),
        );
    }

    candidate_from_canonical(adapter_kind, canonical, "Added profile")
        .ok_or_else(|| "profile directory is unavailable".to_owned())
}

pub fn resolve_config_dir_bounded(
    adapter_kind: AdapterKind,
    path: &str,
) -> Result<ConfigCandidate, String> {
    let limiter =
        RESOLUTION_RATE_LIMITER.get_or_init(|| Mutex::new(ResolutionRateLimiter::default()));
    resolve_config_dir_with_limiter(adapter_kind, path, limiter, Instant::now())
}

fn resolve_config_dir_with_limiter(
    adapter_kind: AdapterKind,
    path: &str,
    limiter: &Mutex<ResolutionRateLimiter>,
    now: Instant,
) -> Result<ConfigCandidate, String> {
    limiter
        .lock()
        .map_err(|_| "profile directory validation is temporarily unavailable".to_owned())?
        .charge(now)?;
    resolve_config_dir(adapter_kind, path)
}

fn discover_from(
    adapter_kind: AdapterKind,
    environment: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Vec<ConfigCandidate> {
    let mut candidates = Vec::new();
    let mut canonical_paths = HashSet::new();

    if let Some(path) = environment {
        add_candidate(
            &mut candidates,
            &mut canonical_paths,
            adapter_kind,
            path,
            "Profile from environment variable",
        );
    }

    if let Some(home) = home.as_deref() {
        let default_name = match adapter_kind {
            AdapterKind::CodexAppServer => ".codex",
            AdapterKind::ClaudeStatusLine => ".claude",
        };
        add_candidate(
            &mut candidates,
            &mut canonical_paths,
            adapter_kind,
            home.join(default_name),
            "Standard profile",
        );

        // Multi-profile directories are intentionally limited to the home directory
        // and a fixed provider-specific prefix. No recursive search is performed.
        let prefix = match adapter_kind {
            AdapterKind::CodexAppServer => ".codex-",
            AdapterKind::ClaudeStatusLine => ".claude-",
        };
        if let Ok(entries) = fs::read_dir(home) {
            for entry in entries.take(MAX_HOME_ENTRIES).flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if name.starts_with(prefix) {
                    add_candidate(
                        &mut candidates,
                        &mut canonical_paths,
                        adapter_kind,
                        path,
                        "Named profile",
                    );
                }
            }
        }
    }

    candidates
}

fn environment_path(adapter_kind: AdapterKind) -> Option<PathBuf> {
    let variable = match adapter_kind {
        AdapterKind::CodexAppServer => "CODEX_HOME",
        AdapterKind::ClaudeStatusLine => "CLAUDE_CONFIG_DIR",
    };
    std::env::var_os(variable).map(PathBuf::from)
}

fn add_candidate(
    candidates: &mut Vec<ConfigCandidate>,
    canonical_paths: &mut HashSet<String>,
    adapter_kind: AdapterKind,
    path: PathBuf,
    label: &str,
) {
    if candidates.len() >= MAX_CANDIDATES || !path.is_absolute() || !is_safe_directory(&path) {
        return;
    }
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    let Some(candidate) = candidate_from_canonical(adapter_kind, canonical, label) else {
        return;
    };
    if !canonical_paths.insert(candidate.profile_identity.clone()) {
        return;
    }
    candidates.push(candidate);
}

fn candidate_from_canonical(
    adapter_kind: AdapterKind,
    canonical: PathBuf,
    label: &str,
) -> Option<ConfigCandidate> {
    let path = canonical.to_str()?.to_owned();
    let profile_identity = canonical_profile_identity(&canonical)?;
    Some(ConfigCandidate {
        adapter_kind,
        path,
        label: label.to_owned(),
        profile_identity,
    })
}

fn is_safe_directory(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_dir() && !metadata.file_type().is_symlink(),
        Err(_) => false,
    }
}

fn is_broad_root(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    dirs::home_dir()
        .and_then(|home| home.canonicalize().ok())
        .is_some_and(|home| home == path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("llmstatus-discovery-{name}-{}", std::process::id()))
    }

    #[test]
    fn provider_profile_prefixes_are_not_interchangeable() {
        assert!(".codex-work".starts_with(".codex-"));
        assert!(!".claude-work".starts_with(".codex-"));
        assert!(".claude-personal".starts_with(".claude-"));
        assert!(!".gemini".starts_with(".claude-"));
    }

    #[test]
    fn missing_paths_are_not_candidates() {
        assert!(!is_safe_directory(Path::new("/path/that/does/not/exist")));
    }

    #[test]
    fn explicit_existing_directory_is_resolved_without_reading_profile_files() {
        let root = test_root("explicit");
        let profile = root.join("custom-provider-profile");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("credentials-must-not-be-read"), b"private").unwrap();

        let candidate =
            resolve_config_dir(AdapterKind::ClaudeStatusLine, profile.to_str().unwrap()).unwrap();
        let canonical = profile
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        assert_eq!(candidate.adapter_kind, AdapterKind::ClaudeStatusLine);
        assert_eq!(candidate.path, canonical);
        assert_eq!(candidate.profile_identity, canonical);
        assert_eq!(candidate.label, "Added profile");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_profile_must_be_absolute_existing_and_dedicated() {
        assert_eq!(
            resolve_config_dir(AdapterKind::CodexAppServer, "relative-profile"),
            Err("profile directory must be an absolute path".to_owned())
        );
        let missing = test_root("explicit-missing").join("does-not-exist");
        assert_eq!(
            resolve_config_dir(AdapterKind::CodexAppServer, missing.to_str().unwrap()),
            Err("profile directory is unavailable".to_owned())
        );

        let filesystem_root = std::env::current_dir()
            .unwrap()
            .canonicalize()
            .unwrap()
            .ancestors()
            .last()
            .unwrap()
            .to_path_buf();
        assert_eq!(
            resolve_config_dir(
                AdapterKind::CodexAppServer,
                filesystem_root.to_str().unwrap()
            ),
            Err(
                "choose a dedicated profile directory instead of a filesystem or home root"
                    .to_owned()
            )
        );
    }

    #[test]
    fn explicit_profile_rejects_more_than_4096_utf8_bytes() {
        let oversized = format!("/{}", "x".repeat(MAX_EXPLICIT_PATH_BYTES));
        assert!(oversized.len() > MAX_EXPLICIT_PATH_BYTES);
        assert_eq!(
            resolve_config_dir(AdapterKind::ClaudeStatusLine, &oversized),
            Err("profile directory path is too long".to_owned())
        );
    }

    #[test]
    fn invalid_and_oversize_attempts_are_charged_before_validation() {
        let root = test_root("rate-invalid");
        fs::create_dir_all(&root).unwrap();
        let limiter = Mutex::new(ResolutionRateLimiter::default());
        let now = Instant::now();
        for index in 0..7 {
            let invalid = if index % 2 == 0 {
                "relative-profile".to_owned()
            } else {
                format!("/{}", "x".repeat(MAX_EXPLICIT_PATH_BYTES))
            };
            assert!(resolve_config_dir_with_limiter(
                AdapterKind::ClaudeStatusLine,
                &invalid,
                &limiter,
                now
            )
            .is_err());
        }
        assert!(resolve_config_dir_with_limiter(
            AdapterKind::CodexAppServer,
            root.to_str().unwrap(),
            &limiter,
            now
        )
        .is_ok());
        assert_eq!(
            resolve_config_dir_with_limiter(
                AdapterKind::ClaudeStatusLine,
                root.to_str().unwrap(),
                &limiter,
                now
            ),
            Err("profile directory validation is temporarily rate limited".to_owned())
        );
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn cross_adapter_eight_attempt_capacity_rejects_ninth_and_recovers_after_rolling_second() {
        let root = test_root("rate-cross-adapter");
        fs::create_dir_all(&root).unwrap();
        let limiter = Mutex::new(ResolutionRateLimiter::default());
        let now = Instant::now();
        for index in 0..MAX_RESOLUTION_ATTEMPTS_PER_SECOND {
            let adapter = if index % 2 == 0 {
                AdapterKind::CodexAppServer
            } else {
                AdapterKind::ClaudeStatusLine
            };
            assert!(resolve_config_dir_with_limiter(
                adapter,
                root.to_str().unwrap(),
                &limiter,
                now
            )
            .is_ok());
        }
        assert!(resolve_config_dir_with_limiter(
            AdapterKind::CodexAppServer,
            root.to_str().unwrap(),
            &limiter,
            now
        )
        .is_err());
        assert!(resolve_config_dir_with_limiter(
            AdapterKind::ClaudeStatusLine,
            root.to_str().unwrap(),
            &limiter,
            now + RESOLUTION_WINDOW
        )
        .is_ok());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn concurrent_resolution_calls_share_one_eight_attempt_capacity() {
        let root = test_root("rate-concurrent");
        fs::create_dir_all(&root).unwrap();
        let path = Arc::new(root.to_string_lossy().into_owned());
        let limiter = Arc::new(Mutex::new(ResolutionRateLimiter::default()));
        let now = Instant::now();
        let handles = (0..16)
            .map(|index| {
                let limiter = Arc::clone(&limiter);
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    let adapter = if index % 2 == 0 {
                        AdapterKind::CodexAppServer
                    } else {
                        AdapterKind::ClaudeStatusLine
                    };
                    resolve_config_dir_with_limiter(adapter, &path, &limiter, now).is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|succeeded| *succeeded)
                .count(),
            MAX_RESOLUTION_ATTEMPTS_PER_SECOND
        );
        fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_profile_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = test_root("explicit-symlink");
        let profile = root.join("profile");
        let link = root.join("profile-link");
        fs::create_dir_all(&profile).unwrap();
        symlink(&profile, &link).unwrap();

        assert_eq!(
            resolve_config_dir(AdapterKind::CodexAppServer, link.to_str().unwrap()),
            Err("profile directory cannot be a symbolic link".to_owned())
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovery_is_bounded_metadata_only_non_recursive_and_canonical_deduplicated() {
        let root = test_root("bounded");
        let standard = root.join(".claude");
        let named = root.join(".claude-work");
        let unrelated = root.join("other");
        fs::create_dir_all(&standard).unwrap();
        fs::create_dir_all(&named).unwrap();
        fs::create_dir_all(unrelated.join(".claude-nested")).unwrap();
        fs::write(root.join(".claude-file"), b"metadata only").unwrap();
        for index in 0..260 {
            fs::create_dir(root.join(format!(".claude-{index:03}"))).unwrap();
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&named, root.join(".claude-link")).unwrap();
        }

        let candidates = discover_from(
            AdapterKind::ClaudeStatusLine,
            Some(standard.clone()),
            Some(root.clone()),
        );
        assert!(candidates.len() <= MAX_CANDIDATES);
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| candidate.path
                    == standard.canonicalize().unwrap().to_string_lossy())
                .count(),
            1
        );
        assert!(candidates.iter().all(|candidate| {
            candidate.adapter_kind == AdapterKind::ClaudeStatusLine
                && candidate.profile_identity == candidate.path
                && Path::new(&candidate.path).is_absolute()
                && is_safe_directory(Path::new(&candidate.path))
        }));
        assert!(!candidates.iter().any(|candidate| {
            candidate.path.contains(".claude-nested")
                || candidate.path.ends_with(".claude-file")
                || candidate.path.ends_with(".claude-link")
        }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relative_environment_and_missing_standard_paths_fail_closed() {
        let root = test_root("missing");
        fs::create_dir_all(&root).unwrap();
        let candidates = discover_from(
            AdapterKind::CodexAppServer,
            Some(PathBuf::from("relative-profile")),
            Some(root.clone()),
        );
        assert!(candidates.is_empty());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn validated_windows_case_only_paths_are_not_folded_or_substituted() {
        let upper = candidate_from_canonical(
            AdapterKind::CodexAppServer,
            PathBuf::from(r"C:\Profiles\Work"),
            "Upper-case profile",
        )
        .unwrap();
        let lower = candidate_from_canonical(
            AdapterKind::CodexAppServer,
            PathBuf::from(r"C:\Profiles\work"),
            "Lower-case profile",
        )
        .unwrap();

        assert_eq!(upper.path, r"C:\Profiles\Work");
        assert_eq!(upper.profile_identity, upper.path);
        assert_eq!(lower.path, r"C:\Profiles\work");
        assert_eq!(lower.profile_identity, lower.path);
        assert_ne!(upper.profile_identity, lower.profile_identity);

        let folded_other_directory_or_symlink = r"c:\profiles\work";
        assert_ne!(upper.path, folded_other_directory_or_symlink);
    }

    #[test]
    fn canonical_equivalent_inputs_deduplicate_without_emitting_a_symlink_alias() {
        let root = test_root("aliases");
        let standard = root.join(".codex");
        let lexical_alias = root.join("nested").join("..").join(".codex");
        fs::create_dir_all(&standard).unwrap();
        fs::create_dir(root.join("nested")).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&standard, root.join(".codex-link")).unwrap();
        }

        let candidates = discover_from(
            AdapterKind::CodexAppServer,
            Some(lexical_alias),
            Some(root.clone()),
        );
        assert_eq!(candidates.len(), 1);
        let canonical = standard
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(candidates[0].path, canonical);
        assert_eq!(candidates[0].profile_identity, canonical);
        assert!(!candidates[0].path.ends_with(".codex-link"));

        fs::remove_dir_all(root).unwrap();
    }
}
