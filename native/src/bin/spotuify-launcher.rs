#[cfg(not(windows))]
fn main() {
    eprintln!("spotuify-launcher is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    use std::ffi::OsStr;

    const APPLY_PENDING: &str = "--spotuify-apply-pending-launcher";
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

#[cfg(windows)]
fn regular(metadata: &std::fs::Metadata, directory: bool) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let expected_type = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    expected_type && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

#[cfg(windows)]
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

#[cfg(windows)]
fn schedule_pending_launcher(bin: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::process::{Command, Stdio};

    let active = bin.join("spotuify.exe");
    let pending = bin.join("spotuify.pending.exe");
    if !pending.try_exists()? {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&pending)?;
    if !regular(&metadata, false) || metadata.len() > 64 * 1024 * 1024 {
        return Err("the pending Spotuify launcher is not a regular executable".into());
    }
    if identical_files(&active, &pending)? {
        let _ = std::fs::remove_file(pending);
        return Ok(());
    }
    Command::new(pending)
        .arg("--spotuify-apply-pending-launcher")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(windows)]
fn apply_pending_launcher() -> Result<(), Box<dyn std::error::Error>> {
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    let pending = std::env::current_exe()?;
    if pending.file_name().and_then(|name| name.to_str()) != Some("spotuify.pending.exe") {
        return Err("the pending-launcher helper was invoked from an invalid path".into());
    }
    let bin = pending
        .parent()
        .ok_or("the pending launcher has no parent")?;
    if bin.file_name().and_then(|name| name.to_str()) != Some("bin") {
        return Err("the pending launcher is not inside the managed bin directory".into());
    }
    let root = bin
        .parent()
        .ok_or("the pending launcher has no installation root")?;
    let marker = std::fs::read_to_string(root.join(".spotuify-install.json"))?;
    if marker.trim() != r#"{"schema":1,"manager":"spotuify-installer","target":"windows-x64"}"# {
        return Err("the pending launcher is not inside a managed installation".into());
    }

    let active = bin.join("spotuify.exe");
    let process_id = std::process::id();
    let replacement = root.join(format!(".spotuify-launcher-replacement-{process_id}.exe"));
    let backup = root.join(format!(".spotuify-launcher-old-{process_id}.exe"));
    std::fs::copy(&pending, &replacement)?;
    let replacement_metadata = std::fs::symlink_metadata(&replacement)?;
    if !regular(&replacement_metadata, false) {
        return Err("the staged launcher replacement is not a regular file".into());
    }

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match std::fs::rename(&active, &backup) {
            Ok(()) => match std::fs::rename(&replacement, &active) {
                Ok(()) => {
                    while std::fs::remove_file(&backup).is_err() && Instant::now() < deadline {
                        sleep(Duration::from_millis(100));
                    }
                    return Ok(());
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
    if let Err(error) = schedule_pending_launcher(bin) {
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
    use super::valid_release_name;

    #[test]
    fn validates_only_stable_windows_release_names() {
        assert!(valid_release_name("1.2.3-windows-x64"));
        assert!(valid_release_name("0.0.0-windows-x64"));
        assert!(!valid_release_name("1.2.3-linux-x64"));
        assert!(!valid_release_name("../1.2.3-windows-x64"));
        assert!(!valid_release_name("01.2.3-windows-x64"));
        assert!(!valid_release_name("1.2.3-canary.1-windows-x64"));
    }
}
