use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct StorageLock {
    _file: File,
}

pub fn acquire_write_lock(parent: &Path) -> io::Result<StorageLock> {
    std::fs::create_dir_all(parent)?;
    let path = parent.join(".llmstatus-write.lock");
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        let file = options.open(&path)?;
        const LOCK_EXCLUSIVE: i32 = 2;
        const LOCK_NONBLOCKING: i32 = 4;
        unsafe extern "C" {
            fn flock(file_descriptor: i32, operation: i32) -> i32;
        }
        // SAFETY: `file` owns a valid descriptor for the duration of the lock.
        let result = unsafe { flock(file.as_raw_fd(), LOCK_EXCLUSIVE | LOCK_NONBLOCKING) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(StorageLock { _file: file })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
        options.open(&path).map(|file| StorageLock { _file: file })
    }
    #[cfg(not(any(unix, windows)))]
    {
        options.open(&path).map(|file| StorageLock { _file: file })
    }
}

#[cfg(debug_assertions)]
pub fn test_data_root() -> Result<Option<PathBuf>, ()> {
    let Some(value) = std::env::var_os("LLMSTATUS_TEST_DATA_DIR") else {
        return Ok(None);
    };
    validate_test_data_root(PathBuf::from(value)).map(Some)
}

#[cfg(not(debug_assertions))]
pub fn test_data_root() -> Result<Option<PathBuf>, ()> {
    Ok(None)
}

#[cfg(debug_assertions)]
fn validate_test_data_root(path: PathBuf) -> Result<PathBuf, ()> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(())
    }
}

pub fn temporary_path(parent: &Path, stem: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{stem}.{}.{}.tmp", std::process::id(), sequence))
}

#[cfg(not(windows))]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_paths_are_unique_within_a_process() {
        let parent = Path::new("/tmp");
        assert_ne!(
            temporary_path(parent, "settings"),
            temporary_path(parent, "settings")
        );
    }

    #[test]
    fn write_lock_is_exclusive_and_released_on_drop() {
        let parent = std::env::temp_dir().join(format!(
            "llmstatus-storage-lock-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&parent).unwrap();
        let first = acquire_write_lock(&parent).unwrap();
        assert!(acquire_write_lock(&parent).is_err());
        drop(first);
        assert!(acquire_write_lock(&parent).is_ok());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn test_data_root_must_be_absolute() {
        assert!(validate_test_data_root(PathBuf::from("relative")).is_err());
        assert!(validate_test_data_root(absolute_test_path()).is_ok());
    }

    #[cfg(all(debug_assertions, windows))]
    fn absolute_test_path() -> PathBuf {
        PathBuf::from(r"C:\llmstatus-test")
    }

    #[cfg(all(debug_assertions, not(windows)))]
    fn absolute_test_path() -> PathBuf {
        PathBuf::from("/tmp/llmstatus-test")
    }
}
