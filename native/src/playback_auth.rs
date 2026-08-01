use anyhow::{Context, Result, anyhow};
use librespot_core::{Session, authentication::Credentials, cache::Cache, config::SessionConfig};
use librespot_oauth::OAuthClientBuilder;
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const OAUTH_REDIRECT_URI: &str = "http://127.0.0.1:5588/login";
const OAUTH_SCOPES: &[&str] = &["streaming"];
const CREDENTIALS_FILE: &str = "credentials.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub cache_dir: PathBuf,
    pub device_name: String,
    #[serde(default)]
    pub force: bool,
}

pub async fn authenticate(config: AuthConfig, session_config: SessionConfig) -> Result<()> {
    if config.device_name.trim().is_empty() {
        return Err(anyhow!("playback device name cannot be empty"));
    }
    let credentials_path = config.cache_dir.join(CREDENTIALS_FILE);

    let cache = open_cache(&config.cache_dir)?;

    // Forced replacement deliberately leaves the old file in place until Session::connect has
    // obtained and persisted new reusable credentials. Canceling OAuth cannot destroy a working
    // playback login.
    if !needs_oauth(&cache, config.force) {
        secure_credentials_file(&credentials_path)?;
        return Ok(());
    }

    let oauth = OAuthClientBuilder::new(
        &session_config.client_id,
        OAUTH_REDIRECT_URI,
        OAUTH_SCOPES.to_vec(),
    )
    .open_in_browser()
    .with_custom_message("Playback authorization complete. You can return to spotuify.")
    .build()
    .context("creating librespot OAuth client")?;
    let token = oauth
        .get_access_token()
        .context("authorizing terminal playback")?;

    let session = Session::new(session_config, Some(cache.clone()));
    session
        .connect(Credentials::with_access_token(token.access_token), true)
        .await
        .context("exchanging playback authorization for reusable credentials")?;

    if session.username().is_empty() {
        session.shutdown();
        return Err(anyhow!(
            "playback authorization returned no canonical Spotify account"
        ));
    }
    if cache.credentials().is_none() {
        session.shutdown();
        return Err(anyhow!(
            "librespot authenticated but did not persist reusable credentials"
        ));
    }

    secure_credentials_file(&credentials_path)?;
    session.shutdown();
    Ok(())
}

fn needs_oauth(cache: &Cache, force: bool) -> bool {
    force || cache.credentials().is_none()
}

pub fn open_cache(path: &Path) -> Result<Cache> {
    if path.as_os_str().is_empty() {
        return Err(anyhow!("librespot cache path cannot be empty"));
    }
    prepare_cache_directory(path)?;
    let credentials_path = path.join(CREDENTIALS_FILE);
    match fs::symlink_metadata(&credentials_path) {
        Ok(_) => secure_credentials_file(&credentials_path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).context("inspecting cached librespot credentials");
        }
    }
    Cache::new(Some(path.to_owned()), Some(path.to_owned()), None, None)
        .context("opening librespot credential cache")
}

fn prepare_cache_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).context("creating librespot cache directory")?;
    let metadata = fs::symlink_metadata(path).context("inspecting librespot cache directory")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "librespot cache path must be a real directory: {}",
            path.display()
        ));
    }
    set_owner_only_directory(path)
}

fn secure_credentials_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("inspecting cached librespot credentials")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!(
            "librespot credentials path must be a real file: {}",
            path.display()
        ));
    }
    set_owner_only_file(path)
}

#[cfg(unix)]
fn set_owner_only_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .context("securing librespot cache directory")
}

#[cfg(not(unix))]
fn set_owner_only_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("securing librespot credentials")
}

#[cfg(not(unix))]
fn set_owner_only_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "spotuify-playback-auth-{name}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn cache_directory_and_existing_credentials_are_owner_only() {
        let directory = temp_dir("permissions");
        prepare_cache_directory(&directory).unwrap();
        let credentials = directory.join(CREDENTIALS_FILE);
        fs::write(&credentials, "{}").unwrap();
        fs::set_permissions(&credentials, fs::Permissions::from_mode(0o644)).unwrap();

        secure_credentials_file(&credentials).unwrap();

        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&credentials).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn credential_symlinks_are_rejected() {
        let directory = temp_dir("symlink");
        prepare_cache_directory(&directory).unwrap();
        let target = directory.join("target");
        fs::write(&target, "do not remove").unwrap();
        let credentials = directory.join(CREDENTIALS_FILE);
        symlink(&target, &credentials).unwrap();

        assert!(secure_credentials_file(&credentials).is_err());
        assert!(open_cache(&directory).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "do not remove");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn forced_reauthentication_preserves_credentials_until_replacement_succeeds() {
        let directory = temp_dir("transactional-force");
        let cache = open_cache(&directory).unwrap();
        let credentials = Credentials::with_access_token("existing-credential");
        cache.save_credentials(&credentials);
        secure_credentials_file(&directory.join(CREDENTIALS_FILE)).unwrap();

        assert!(!needs_oauth(&cache, false));
        assert!(needs_oauth(&cache, true));
        assert_eq!(cache.credentials(), Some(credentials));

        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn cached_authentication_completes_without_starting_oauth() {
        let directory = temp_dir("cached-auth");
        let cache = open_cache(&directory).unwrap();
        cache.save_credentials(&Credentials::with_access_token("existing-credential"));

        authenticate(
            AuthConfig {
                cache_dir: directory.clone(),
                device_name: "spotuify-test".to_owned(),
                force: false,
            },
            SessionConfig::default(),
        )
        .await
        .unwrap();

        assert!(cache.credentials().is_some());
        assert_eq!(
            fs::metadata(directory.join(CREDENTIALS_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
