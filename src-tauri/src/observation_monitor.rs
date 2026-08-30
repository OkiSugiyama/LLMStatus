use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter};

pub const CLAUDE_OBSERVATION_CHANGED_EVENT: &str = "llmstatus://claude-observation-changed";
const POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileFingerprint {
    length: u64,
    modified: Option<SystemTime>,
    identity: Option<FileIdentity>,
}

type DirectoryFingerprint = BTreeMap<String, FileFingerprint>;

#[cfg(unix)]
type FileIdentity = (u64, u64);

#[cfg(windows)]
type FileIdentity = (u32, u64, u64);

#[cfg(not(any(unix, windows)))]
type FileIdentity = ();

#[derive(Clone, Debug, Eq, PartialEq)]
struct MonitorState {
    fingerprint: DirectoryFingerprint,
}

impl MonitorState {
    fn new(root: &Path) -> Self {
        Self {
            fingerprint: fingerprint(root),
        }
    }

    fn poll(&mut self, root: &Path) -> bool {
        let current = fingerprint(root);
        let changed = current != self.fingerprint;
        self.fingerprint = current;
        changed
    }
}

pub fn spawn(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("llmstatus-observation-monitor".to_owned())
        .spawn(move || monitor(app));
}

fn monitor(app: AppHandle) {
    let Ok(root) = crate::claude::observation_root() else {
        return;
    };
    let mut state = MonitorState::new(&root);
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if state.poll(&root) {
            let _ = app.emit(CLAUDE_OBSERVATION_CHANGED_EVENT, ());
        }
    }
}

fn fingerprint(root: &Path) -> DirectoryFingerprint {
    let mut fingerprint = DirectoryFingerprint::new();
    let Ok(entries) = fs::read_dir(root) else {
        return fingerprint;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        fingerprint.insert(
            name.to_owned(),
            FileFingerprint {
                length: metadata.len(),
                modified: metadata.modified().ok(),
                identity: file_identity(&metadata),
            },
        );
    }
    fingerprint
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    Some((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::windows::fs::MetadataExt;

    Some((
        metadata.volume_serial_number()?,
        metadata.file_index()?,
        metadata.creation_time(),
    ))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_metadata: &fs::Metadata) -> Option<FileIdentity> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_root() -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "llmstatus-observation-monitor-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn initial_fingerprint_does_not_emit_a_change() {
        let root = test_root();
        let mut state = MonitorState::new(&root);
        assert!(!state.poll(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_create_equal_length_atomic_replace_and_delete_of_json_files() {
        let root = test_root();
        fs::write(root.join("claude.json"), b"one").unwrap();
        let mut state = MonitorState::new(&root);

        let source = crate::storage::temporary_path(&root, "claude");
        let mut file = File::create(&source).unwrap();
        file.write_all(b"two").unwrap();
        file.sync_all().unwrap();
        assert_eq!(fs::metadata(&source).unwrap().len(), 3);
        assert_eq!(fs::metadata(root.join("claude.json")).unwrap().len(), 3);
        crate::storage::replace_file(&source, &root.join("claude.json")).unwrap();
        assert!(state.poll(&root));

        fs::remove_file(root.join("claude.json")).unwrap();
        assert!(state.poll(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn poll_interval_is_exactly_one_second() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(1));
    }

    #[test]
    fn ignores_non_json_and_symlink_shaped_entries() {
        let root = test_root();
        fs::write(root.join("ignored.txt"), b"not an observation").unwrap();
        let initial = fingerprint(&root);

        let target = root.join("target.json");
        fs::write(&target, b"target").unwrap();
        let link = root.join("link.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            // A normal Windows user may not have the symlink privilege.
            fs::remove_dir_all(root).unwrap();
            return;
        }

        let observed = fingerprint(&root);
        assert_eq!(observed.len(), 1);
        assert!(observed.contains_key("target.json"));
        assert!(!observed.contains_key("link.json"));
        assert_ne!(initial, observed);
        fs::remove_dir_all(root).unwrap();
    }
}
