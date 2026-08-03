#[cfg(windows)]
const APPLY_PENDING: &str = "--spotuify-apply-pending-launcher";

#[cfg(not(windows))]
fn main() {
    eprintln!("spotuify-launcher is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    use std::ffi::OsStr;

    let mut arguments = std::env::args_os().skip(1);
    let helper_mode = arguments.next().as_deref() == Some(OsStr::new(APPLY_PENDING))
        && arguments.next().is_none();
    let result = if helper_mode {
        apply_pending_launcher()
    } else {
        run()
    };
    if let Err(error) = result {
        eprintln!("spotuify: {error}");
        std::process::exit(1);
    }
}

#[cfg(any(windows, test))]
fn regular(metadata: &std::fs::Metadata, directory: bool) -> bool {
    let expected_type = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        expected_type && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    }
    #[cfg(not(windows))]
    {
        expected_type && !metadata.file_type().is_symlink()
    }
}

#[cfg(any(windows, test))]
fn identical_files(first: &std::path::Path, second: &std::path::Path) -> std::io::Result<bool> {
    const MAX_LAUNCHER_BYTES: u64 = 64 * 1024 * 1024;
    let first_metadata = std::fs::symlink_metadata(first)?;
    let second_metadata = std::fs::symlink_metadata(second)?;
    if !regular(&first_metadata, false)
        || !regular(&second_metadata, false)
        || first_metadata.len() > MAX_LAUNCHER_BYTES
        || second_metadata.len() > MAX_LAUNCHER_BYTES
        || first_metadata.len() != second_metadata.len()
    {
        return Ok(false);
    }
    Ok(std::fs::read(first)? == std::fs::read(second)?)
}

#[cfg(any(windows, test))]
struct LockOwner {
    pid: u32,
    token: String,
}

#[cfg(any(windows, test))]
fn parse_lock_owner(contents: &str) -> Option<LockOwner> {
    let mut lines = contents.lines();
    let pid = lines.next()?.parse().ok()?;
    let token = lines.next()?;
    if pid == 0 || token.is_empty() {
        return None;
    }
    Some(LockOwner {
        pid,
        token: token.to_owned(),
    })
}

#[cfg(any(windows, test))]
fn process_is_alive(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

#[cfg(any(windows, test))]
fn read_lock_owner(path: &std::path::Path) -> std::io::Result<Option<String>> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !regular(&metadata, true) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the installation lock is not a regular directory",
        ));
    }
    let owner = path.join("owner");
    let metadata = match std::fs::symlink_metadata(&owner) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !regular(&metadata, false) || metadata.len() > 256 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the installation lock owner is not a regular file",
        ));
    }
    std::fs::read_to_string(owner).map(Some)
}

#[cfg(any(windows, test))]
fn initialize_owner(
    directory: &std::path::Path,
    contents: &str,
    token: &str,
) -> std::io::Result<()> {
    use std::io::Write;

    let temporary = directory.join(format!(".owner-{token}.tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, directory.join("owner"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(any(windows, test))]
fn remove_reclaim_if_owned(reclaim: &std::path::Path, token: &str) {
    let owner = reclaim.join("owner");
    let owned = std::fs::symlink_metadata(reclaim)
        .ok()
        .is_some_and(|metadata| regular(&metadata, true))
        && std::fs::symlink_metadata(&owner)
            .ok()
            .is_some_and(|metadata| regular(&metadata, false) && metadata.len() <= 256)
        && std::fs::read_to_string(owner)
            .ok()
            .is_some_and(|contents| contents == format!("{token}\n"));
    if owned {
        let _ = std::fs::remove_dir_all(reclaim);
    }
}

#[cfg(any(windows, test))]
fn remove_lock_directory_if_owned(
    path: &std::path::Path,
    expected_owner: &str,
) -> std::io::Result<bool> {
    let owned = read_lock_owner(path)?.as_deref() == Some(expected_owner);
    if owned {
        std::fs::remove_dir_all(path)?;
    }
    Ok(owned)
}

#[cfg(any(windows, test))]
fn publish_installer_lock(
    root: &std::path::Path,
    canonical: &std::path::Path,
    token: &str,
) -> std::io::Result<bool> {
    let prepared = root.join(format!(".install.lock.prepare-{token}"));
    std::fs::create_dir(&prepared)?;
    let owner = format!("{}\n{token}\n", std::process::id());
    if let Err(error) = initialize_owner(&prepared, &owner, token) {
        let _ = std::fs::remove_dir(&prepared);
        return Err(error);
    }

    if canonical.try_exists()? {
        remove_lock_directory_if_owned(&prepared, &owner)?;
        return Ok(false);
    }
    // On Windows, renaming a directory cannot replace an existing directory, so this publishes
    // the fully initialized lock atomically if another participant did not win the race.
    match std::fs::rename(&prepared, canonical) {
        Ok(()) => Ok(true),
        Err(error) => {
            remove_lock_directory_if_owned(&prepared, &owner)?;
            if canonical.try_exists()? {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(any(windows, test))]
struct InstallerLock {
    path: std::path::PathBuf,
    token: String,
}

#[cfg(any(windows, test))]
impl InstallerLock {
    fn try_acquire(root: &std::path::Path) -> std::io::Result<Option<Self>> {
        let path = root.join(".install.lock");
        let token = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple());
        for attempt in 0..2 {
            if publish_installer_lock(root, &path, &token)? {
                return Ok(Some(Self { path, token }));
            }

            let observed_contents = match read_lock_owner(&path) {
                Ok(contents) => contents,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let Some(observed) = observed_contents.as_deref().and_then(parse_lock_owner) else {
                return Ok(None);
            };
            if process_is_alive(observed.pid) || attempt != 0 {
                return Ok(None);
            }

            let reclaim = path.join("reclaim");
            match std::fs::create_dir(&reclaim) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
                Err(error) => return Err(error),
            }
            if let Err(error) = initialize_owner(&reclaim, &format!("{token}\n"), &token) {
                let _ = std::fs::remove_dir(&reclaim);
                return Err(error);
            }

            let confirmed_contents = read_lock_owner(&path).ok().flatten();
            let confirmed = confirmed_contents.as_deref().and_then(parse_lock_owner);
            let claim_owner = std::fs::read_to_string(reclaim.join("owner")).ok();
            let can_reclaim = confirmed_contents == observed_contents
                && confirmed.is_some_and(|owner| {
                    owner.pid == observed.pid
                        && owner.token == observed.token
                        && !process_is_alive(owner.pid)
                })
                && claim_owner.as_deref() == Some(&format!("{token}\n"));
            if can_reclaim {
                std::fs::remove_dir_all(&path)?;
                continue;
            }
            remove_reclaim_if_owned(&reclaim, &token);
            return Ok(None);
        }
        Ok(None)
    }

    fn release_if_owned(&self) {
        let owner = self.path.join("owner");
        let owned = std::fs::symlink_metadata(&self.path)
            .ok()
            .is_some_and(|metadata| regular(&metadata, true))
            && std::fs::symlink_metadata(&owner)
                .ok()
                .is_some_and(|metadata| regular(&metadata, false) && metadata.len() <= 256)
            && std::fs::read_to_string(&owner)
                .ok()
                .is_some_and(|contents| {
                    contents == format!("{}\n{}\n", std::process::id(), self.token)
                });
        if owned {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(any(windows, test))]
impl Drop for InstallerLock {
    fn drop(&mut self) {
        self.release_if_owned();
    }
}

#[cfg(windows)]
fn validate_installer_marker(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let marker_path = root.join(".spotuify-install.json");
    let metadata = std::fs::symlink_metadata(&marker_path)?;
    if !regular(&metadata, false) || metadata.len() > 256 {
        return Err("the pending launcher is not inside a managed installation".into());
    }
    let marker = std::fs::read_to_string(marker_path)?;
    if marker.trim() != r#"{"schema":1,"manager":"spotuify-installer","target":"windows-x64"}"# {
        return Err("the pending launcher is not inside a managed installation".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn current_release_launcher(
    root: &std::path::Path,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    use std::io::Read;

    let current = root.join("current");
    let metadata = std::fs::symlink_metadata(&current)?;
    if !regular(&metadata, false) || metadata.len() > 128 {
        return Err("the active Spotuify release pointer is not a regular metadata file".into());
    }
    let mut release_name = String::new();
    std::fs::File::open(current)?
        .take(129)
        .read_to_string(&mut release_name)?;
    let release_name = release_name.trim();
    if !valid_release_name(release_name) {
        return Err("the active Spotuify release pointer is invalid".into());
    }
    let releases = root.join("releases");
    if !regular(&std::fs::symlink_metadata(&releases)?, true) {
        return Err("the managed releases path is not a regular directory".into());
    }
    let release = releases.join(release_name);
    if !regular(&std::fs::symlink_metadata(&release)?, true) {
        return Err("the active Spotuify release directory is invalid".into());
    }
    let launcher = release.join("spotuify-launcher.exe");
    let metadata = std::fs::symlink_metadata(&launcher)?;
    if !regular(&metadata, false) || metadata.len() > 64 * 1024 * 1024 {
        return Err("the active release contains an invalid Windows launcher".into());
    }
    Ok(launcher)
}

#[cfg(windows)]
fn schedule_pending_launcher(
    root: &std::path::Path,
    bin: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::process::{Command, Stdio};

    let pending = bin.join("spotuify.pending.exe");
    if !pending.try_exists()? {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&pending)?;
    if !regular(&metadata, false) || metadata.len() > 64 * 1024 * 1024 {
        return Err("the pending Spotuify launcher is not a regular executable".into());
    }
    let versioned_launcher = current_release_launcher(root)?;
    if !identical_files(&pending, &versioned_launcher)? {
        return Err("the pending launcher does not match the active release".into());
    }
    Command::new(versioned_launcher)
        .arg("--spotuify-apply-pending-launcher")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(windows)]
fn schedule_versioned_helper_from_legacy_pending(
    pending: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::process::{Command, Stdio};

    let bin = pending
        .parent()
        .ok_or("the pending launcher has no parent")?;
    if bin.file_name().and_then(|name| name.to_str()) != Some("bin") {
        return Err("the pending launcher is not inside the managed bin directory".into());
    }
    if !regular(&std::fs::symlink_metadata(bin)?, true) {
        return Err("the pending launcher is not inside the managed bin directory".into());
    }
    let root = bin
        .parent()
        .ok_or("the pending launcher has no installation root")?;
    validate_installer_marker(root)?;
    let versioned_launcher = current_release_launcher(root)?;
    if !identical_files(pending, &versioned_launcher)? {
        return Ok(());
    }
    Command::new(versioned_launcher)
        .arg(APPLY_PENDING)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(any(windows, test))]
#[derive(Debug, Eq, PartialEq)]
enum PendingApplyOutcome {
    Applied,
    AlreadyCurrent,
    Deferred,
    Superseded,
}

#[cfg(any(windows, test))]
fn apply_versioned_pending_launcher(
    helper: &std::path::Path,
    root: &std::path::Path,
) -> Result<PendingApplyOutcome, Box<dyn std::error::Error>> {
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    let Some(_installer_lock) = InstallerLock::try_acquire(root)? else {
        return Ok(PendingApplyOutcome::Deferred);
    };
    let current_helper = current_release_launcher(root)?;
    if !identical_files(helper, &current_helper)? {
        return Ok(PendingApplyOutcome::Superseded);
    }
    let bin = root.join("bin");
    let pending = bin.join("spotuify.pending.exe");
    let pending_metadata = match std::fs::symlink_metadata(&pending) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PendingApplyOutcome::Superseded);
        }
        Err(error) => return Err(error.into()),
    };
    let helper_metadata = std::fs::symlink_metadata(helper)?;
    if !regular(&pending_metadata, false)
        || !regular(&helper_metadata, false)
        || pending_metadata.len() > 64 * 1024 * 1024
        || helper_metadata.len() > 64 * 1024 * 1024
    {
        return Err("the staged launcher replacement is not a regular file".into());
    }
    if !identical_files(&pending, helper)? {
        return Ok(PendingApplyOutcome::Superseded);
    }

    let active = bin.join("spotuify.exe");
    if identical_files(&active, &pending)? {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        return if remove_pending_with_retry(&pending, deadline) {
            Ok(PendingApplyOutcome::AlreadyCurrent)
        } else {
            Ok(PendingApplyOutcome::Deferred)
        };
    }
    let operation = uuid::Uuid::new_v4().simple();
    let replacement = root.join(format!(".spotuify-launcher-replacement-{operation}.exe"));
    let backup = root.join(format!(".spotuify-launcher-old-{operation}.exe"));
    if let Err(error) = std::fs::copy(helper, &replacement) {
        let _ = std::fs::remove_file(&replacement);
        return Err(error.into());
    }
    let replacement_metadata = std::fs::symlink_metadata(&replacement)?;
    if !regular(&replacement_metadata, false) {
        let _ = std::fs::remove_file(&replacement);
        return Err("the staged launcher replacement is not a regular file".into());
    }

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match std::fs::rename(&active, &backup) {
            Ok(()) => match std::fs::rename(&replacement, &active) {
                Ok(()) => {
                    let _ = remove_pending_with_retry(&pending, deadline);
                    while std::fs::remove_file(&backup).is_err() && Instant::now() < deadline {
                        sleep(Duration::from_millis(100));
                    }
                    return Ok(PendingApplyOutcome::Applied);
                }
                Err(error) => {
                    let _ = std::fs::rename(&backup, &active);
                    let _ = std::fs::remove_file(&replacement);
                    return Err(error.into());
                }
            },
            Err(error) if Instant::now() < deadline => {
                if error.kind() == std::io::ErrorKind::NotFound && active.try_exists()? {
                    return Err(error.into());
                }
                sleep(Duration::from_millis(100));
            }
            Err(error) => {
                let _ = std::fs::remove_file(&replacement);
                return Err(error.into());
            }
        }
    }
}

#[cfg(any(windows, test))]
fn remove_pending_with_retry(pending: &std::path::Path, deadline: std::time::Instant) -> bool {
    loop {
        match std::fs::remove_file(pending) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return false,
        }
    }
}

#[cfg(windows)]
fn apply_pending_launcher() -> Result<(), Box<dyn std::error::Error>> {
    let helper = std::env::current_exe()?;
    if helper.file_name().and_then(|name| name.to_str()) == Some("spotuify.pending.exe") {
        return schedule_versioned_helper_from_legacy_pending(&helper);
    }
    if helper.file_name().and_then(|name| name.to_str()) != Some("spotuify-launcher.exe") {
        return Err("the pending-launcher helper was invoked from an invalid path".into());
    }
    let release = helper
        .parent()
        .ok_or("the versioned launcher has no release directory")?;
    let release_name = release
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("the versioned launcher has an invalid release directory")?;
    if !valid_release_name(release_name) {
        return Err("the versioned launcher has an invalid release directory".into());
    }
    let releases = release
        .parent()
        .ok_or("the versioned launcher is not inside the releases directory")?;
    if releases.file_name().and_then(|name| name.to_str()) != Some("releases") {
        return Err("the versioned launcher is not inside the releases directory".into());
    }
    let root = releases
        .parent()
        .ok_or("the versioned launcher has no installation root")?;
    if !regular(&std::fs::symlink_metadata(releases)?, true)
        || !regular(&std::fs::symlink_metadata(release)?, true)
    {
        return Err("the versioned launcher is not inside regular release directories".into());
    }
    validate_installer_marker(root)?;
    let _ = apply_versioned_pending_launcher(&helper, root)?;
    Ok(())
}

#[cfg(windows)]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use std::fs;
    use std::io::Read;
    use std::process::{Command, exit};

    let launcher = std::env::current_exe()?;
    let bin = launcher
        .parent()
        .ok_or("the launcher has no parent directory")?;
    let root = bin
        .parent()
        .ok_or("the launcher is not inside an installation root")?;
    let current = root.join("current");
    let current_metadata = fs::symlink_metadata(&current)?;
    if !regular(&current_metadata, false) || current_metadata.len() > 128 {
        return Err("the active Spotuify release pointer is not a regular metadata file".into());
    }
    let mut release_name = String::new();
    fs::File::open(current)?
        .take(129)
        .read_to_string(&mut release_name)?;
    let release_name = release_name.trim();
    if !valid_release_name(release_name) {
        return Err("the active Spotuify release pointer is invalid".into());
    }

    let release = root.join("releases").join(release_name);
    if !regular(&fs::symlink_metadata(&release)?, true) {
        return Err("the active Spotuify release directory is invalid".into());
    }
    let executable = release.join("spotuify.exe");
    if !regular(&fs::symlink_metadata(&executable)?, false) {
        return Err("the active Spotuify executable is not a regular file".into());
    }

    let status = Command::new(executable)
        .args(std::env::args_os().skip(1))
        .env("SPOTUIFY_INSTALL_SOURCE", "standalone")
        .env("SPOTUIFY_INSTALL_ROOT", root)
        .status()?;
    if let Err(error) = schedule_pending_launcher(root, bin) {
        eprintln!("spotuify: warning: could not schedule the pending launcher update: {error}");
    }
    exit(status.code().unwrap_or(1));
}

#[cfg(any(windows, test))]
fn valid_release_name(value: &str) -> bool {
    let Some(version) = value.strip_suffix("-windows-x64") else {
        return false;
    };
    let mut parts = version.split('.');
    let valid_part = |part: Option<&str>| {
        part.is_some_and(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
    };
    valid_part(parts.next())
        && valid_part(parts.next())
        && valid_part(parts.next())
        && parts.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::{
        InstallerLock, PendingApplyOutcome, apply_versioned_pending_launcher, valid_release_name,
    };

    struct TestInstallation {
        root: std::path::PathBuf,
        helper: std::path::PathBuf,
        active: std::path::PathBuf,
        pending: std::path::PathBuf,
    }

    impl TestInstallation {
        fn new(name: &str, helper_contents: &str, active_contents: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "spotuify-launcher-{name}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let bin = root.join("bin");
            let release = root.join("releases").join("2.0.0-windows-x64");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(&release).unwrap();
            std::fs::write(
                root.join(".spotuify-install.json"),
                r#"{"schema":1,"manager":"spotuify-installer","target":"windows-x64"}"#,
            )
            .unwrap();
            std::fs::write(root.join("current"), "2.0.0-windows-x64\n").unwrap();
            let helper = release.join("spotuify-launcher.exe");
            let active = bin.join("spotuify.exe");
            let pending = bin.join("spotuify.pending.exe");
            std::fs::write(&helper, helper_contents).unwrap();
            std::fs::write(&active, active_contents).unwrap();
            std::fs::write(&pending, helper_contents).unwrap();
            Self {
                root,
                helper,
                active,
                pending,
            }
        }
    }

    impl Drop for TestInstallation {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn validates_only_stable_windows_release_names() {
        assert!(valid_release_name("1.2.3-windows-x64"));
        assert!(valid_release_name("0.0.0-windows-x64"));
        assert!(!valid_release_name("1.2.3-linux-x64"));
        assert!(!valid_release_name("../1.2.3-windows-x64"));
        assert!(!valid_release_name("01.2.3-windows-x64"));
        assert!(!valid_release_name("1.2.3-canary.1-windows-x64"));
    }

    #[test]
    fn applies_a_matching_pending_launcher_while_holding_the_installation_lock() {
        let installation = TestInstallation::new("apply", "new launcher", "old launcher");
        assert_eq!(
            apply_versioned_pending_launcher(&installation.helper, &installation.root).unwrap(),
            PendingApplyOutcome::Applied
        );
        assert_eq!(
            std::fs::read_to_string(&installation.active).unwrap(),
            "new launcher"
        );
        assert!(!installation.pending.exists());
        assert!(!installation.root.join(".install.lock").exists());
    }

    #[test]
    fn removes_an_already_active_pending_launcher_under_the_installation_lock() {
        let installation = TestInstallation::new("current", "current launcher", "current launcher");
        assert_eq!(
            apply_versioned_pending_launcher(&installation.helper, &installation.root).unwrap(),
            PendingApplyOutcome::AlreadyCurrent
        );
        assert!(!installation.pending.exists());
        assert!(!installation.root.join(".install.lock").exists());
    }

    #[test]
    fn defers_to_an_installer_then_rejects_its_superseded_pending_launcher() {
        let installation = TestInstallation::new("defer", "old launcher", "active launcher");
        let installer_lock = InstallerLock::try_acquire(&installation.root)
            .unwrap()
            .expect("test installer should acquire the lock");
        std::fs::write(&installation.active, "new launcher").unwrap();
        std::fs::write(&installation.pending, "new launcher").unwrap();
        assert_eq!(
            apply_versioned_pending_launcher(&installation.helper, &installation.root).unwrap(),
            PendingApplyOutcome::Deferred
        );
        drop(installer_lock);
        assert_eq!(
            apply_versioned_pending_launcher(&installation.helper, &installation.root).unwrap(),
            PendingApplyOutcome::Superseded
        );
        assert_eq!(
            std::fs::read_to_string(&installation.active).unwrap(),
            "new launcher"
        );
    }

    #[test]
    fn rejects_a_stale_pending_helper_after_the_current_release_advances() {
        let installation = TestInstallation::new("generation", "old launcher", "new launcher");
        let newer_release = installation.root.join("releases").join("3.0.0-windows-x64");
        std::fs::create_dir(&newer_release).unwrap();
        std::fs::write(newer_release.join("spotuify-launcher.exe"), "new launcher").unwrap();
        std::fs::write(installation.root.join("current"), "3.0.0-windows-x64\n").unwrap();

        assert_eq!(
            apply_versioned_pending_launcher(&installation.helper, &installation.root).unwrap(),
            PendingApplyOutcome::Superseded
        );
        assert_eq!(
            std::fs::read_to_string(&installation.active).unwrap(),
            "new launcher"
        );
        assert_eq!(
            std::fs::read_to_string(&installation.pending).unwrap(),
            "old launcher"
        );
    }

    #[test]
    fn installer_lock_cleanup_requires_the_original_owner_token() {
        let installation = TestInstallation::new("token", "new launcher", "old launcher");
        let lock = InstallerLock::try_acquire(&installation.root)
            .unwrap()
            .expect("test helper should acquire the lock");
        std::fs::write(
            installation.root.join(".install.lock").join("owner"),
            "2147483647\nreplacement-owner\n",
        )
        .unwrap();
        drop(lock);
        assert!(installation.root.join(".install.lock").exists());
    }

    #[test]
    fn helper_owned_lock_excludes_a_concurrent_installer() {
        let installation = TestInstallation::new("exclusive", "new launcher", "old launcher");
        let helper_lock = InstallerLock::try_acquire(&installation.root)
            .unwrap()
            .expect("test helper should acquire the lock");
        assert!(
            InstallerLock::try_acquire(&installation.root)
                .unwrap()
                .is_none()
        );
        drop(helper_lock);
        assert!(
            InstallerLock::try_acquire(&installation.root)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn reclaims_a_stale_installer_lock_with_the_shared_claim_protocol() {
        let installation = TestInstallation::new("stale", "new launcher", "old launcher");
        let lock_path = installation.root.join(".install.lock");
        std::fs::create_dir(&lock_path).unwrap();
        std::fs::write(lock_path.join("owner"), "2147483647\r\nstale-owner\r\n").unwrap();
        let lock = InstallerLock::try_acquire(&installation.root)
            .unwrap()
            .expect("the helper should reclaim a stale lock");
        let owner = std::fs::read_to_string(lock_path.join("owner")).unwrap();
        assert!(owner.starts_with(&format!("{}\n", std::process::id())));
        drop(lock);
        assert!(!lock_path.exists());
    }

    #[test]
    fn leaves_an_uninitialized_installer_lock_untouched() {
        let installation = TestInstallation::new("uninitialized", "new launcher", "old launcher");
        let lock_path = installation.root.join(".install.lock");
        std::fs::create_dir(&lock_path).unwrap();
        assert!(
            InstallerLock::try_acquire(&installation.root)
                .unwrap()
                .is_none()
        );
        assert!(lock_path.exists());
        assert!(std::fs::read_dir(lock_path).unwrap().next().is_none());
    }
}
