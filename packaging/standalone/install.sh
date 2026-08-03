#!/bin/sh

set -eu

REPOSITORY="austin-smith/spotuify"
RELEASES_URL="https://github.com/$REPOSITORY/releases"
VERSION="${SPOTUIFY_VERSION:-latest}"
INSTALL_PREFIX="${SPOTUIFY_INSTALL_PREFIX:-${HOME:?HOME is required}/.local}"
BIN_DIR="$INSTALL_PREFIX/bin"
LIBEXEC_DIR="$INSTALL_PREFIX/libexec"
INSTALL_ROOT="$INSTALL_PREFIX/share/spotuify"
RELEASES_DIR="$INSTALL_ROOT/releases"
CURRENT_LINK="$INSTALL_ROOT/current"
BIN_PATH="$BIN_DIR/spotuify"
ENGINE_PATH="$LIBEXEC_DIR/spotuify-engine"
LOCK_DIR="$INSTALL_ROOT/.install.lock"
MARKER_PATH="$INSTALL_ROOT/.spotuify-install.json"

tmp_dir=""
staged_release=""
lock_acquired="false"
lock_token=""
path_action="already"
path_profile=""
activation_pending="false"
current_preexisting="false"
previous_current_target=""
fresh_install="false"
release_created="false"
marker_created="false"
install_completed="false"

step() {
  printf '==> %s\n' "$1"
}

warn() {
  printf 'WARNING: %s\n' "$1" >&2
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

release_lock() {
  if [ "$lock_acquired" = "true" ]; then
    owner_token="$(sed -n '2p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    if [ "$owner_token" = "$lock_token" ]; then
      rm -rf "$LOCK_DIR"
    fi
    lock_acquired="false"
  fi
}

cleanup() {
  rollback_succeeded="true"
  if [ "$activation_pending" = "true" ]; then
    if [ "$current_preexisting" = "true" ]; then
      if ! replace_symlink "$CURRENT_LINK" "$previous_current_target"; then
        warn "could not restore the previous active release at $CURRENT_LINK"
        rollback_succeeded="false"
      fi
    else
      rm -f "$CURRENT_LINK"
      if managed_symlink "$BIN_PATH" "$CURRENT_LINK/spotuify"; then
        rm -f "$BIN_PATH"
      fi
      if managed_symlink "$ENGINE_PATH" "$CURRENT_LINK/spotuify-engine"; then
        rm -f "$ENGINE_PATH"
      fi
    fi
  fi
  if [ "$install_completed" != "true" ] && [ "$fresh_install" = "true" ] &&
    [ "$rollback_succeeded" = "true" ]; then
    if [ "$marker_created" = "true" ] && [ ! -L "$MARKER_PATH" ] &&
      [ "$(cat "$MARKER_PATH" 2>/dev/null || true)" = "$expected_marker" ]; then
      rm -f "$MARKER_PATH"
    fi
    if [ "$release_created" = "true" ] && [ -d "$release_dir" ] && [ ! -L "$release_dir" ]; then
      rm -rf "$release_dir"
    fi
  fi
  release_lock
  if [ -n "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  if [ -n "$staged_release" ]; then
    rm -rf "$staged_release"
  fi
  if [ "$install_completed" != "true" ] && [ "$fresh_install" = "true" ]; then
    rmdir "$RELEASES_DIR" "$INSTALL_ROOT" "$BIN_DIR" "$LIBEXEC_DIR" 2>/dev/null || true
  fi
}

trap cleanup 0
trap 'exit 1' 1 2 3 15

normalize_version() {
  case "$VERSION" in
    "" | latest)
      VERSION="latest"
      ;;
    v*)
      VERSION="${VERSION#v}"
      ;;
  esac

  if [ "$VERSION" != "latest" ] &&
    ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    fail "SPOTUIFY_VERSION must be latest or a stable version such as 1.2.3"
  fi
}

validate_install_prefix() {
  newline='
'
  case "$INSTALL_PREFIX" in
    /*) ;;
    *) fail "SPOTUIFY_INSTALL_PREFIX must be an absolute path" ;;
  esac
  case "$INSTALL_PREFIX" in
    /) fail "SPOTUIFY_INSTALL_PREFIX cannot be the filesystem root" ;;
    *"$newline"*) fail "SPOTUIFY_INSTALL_PREFIX cannot contain a newline" ;;
  esac
}

normalize_install_prefix() {
  mkdir -p "$INSTALL_PREFIX"
  canonical_prefix="$(CDPATH= cd "$INSTALL_PREFIX" 2>/dev/null && pwd -P)" ||
    fail "could not resolve SPOTUIFY_INSTALL_PREFIX"
  if [ "$canonical_prefix" = "/" ]; then
    fail "SPOTUIFY_INSTALL_PREFIX cannot resolve to the filesystem root"
  fi
  INSTALL_PREFIX="$canonical_prefix"
  BIN_DIR="$INSTALL_PREFIX/bin"
  LIBEXEC_DIR="$INSTALL_PREFIX/libexec"
  INSTALL_ROOT="$INSTALL_PREFIX/share/spotuify"
  RELEASES_DIR="$INSTALL_ROOT/releases"
  CURRENT_LINK="$INSTALL_ROOT/current"
  BIN_PATH="$BIN_DIR/spotuify"
  ENGINE_PATH="$LIBEXEC_DIR/spotuify-engine"
  LOCK_DIR="$INSTALL_ROOT/.install.lock"
  MARKER_PATH="$INSTALL_ROOT/.spotuify-install.json"

  if [ -L "$INSTALL_PREFIX/share" ]; then
    fail "$INSTALL_PREFIX/share cannot be a symbolic link"
  fi
}

download_file() {
  url="$1"
  output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -q -fsSL --connect-timeout 10 --max-time 300 "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -T 300 -O "$output" "$url"
    return
  fi

  fail "curl or wget is required"
}

file_sha256() {
  path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | sed 's/^.*= //'
    return
  fi

  fail "sha256sum, shasum, or openssl is required"
}

require_glibc() {
  libc_info=""
  if command -v getconf >/dev/null 2>&1; then
    libc_info="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  fi
  if [ -z "$libc_info" ] && command -v ldd >/dev/null 2>&1; then
    libc_info="$(ldd --version 2>&1 || true)"
  fi

  if printf '%s\n' "$libc_info" | grep -Eiq 'glibc|gnu libc'; then
    return
  fi
  if printf '%s\n' "$libc_info" | grep -iq 'musl'; then
    fail "Spotuify's Linux builds require glibc; musl is not supported"
  fi
  fail "Spotuify's Linux builds require glibc, but glibc could not be detected"
}

detect_target() {
  case "$(uname -s)" in
    Darwin)
      os="darwin"
      ;;
    Linux)
      os="linux"
      ;;
    *)
      fail "this installer supports macOS and Linux; use npm or GitHub Releases on Windows"
      ;;
  esac

  case "$(uname -m)" in
    arm64 | aarch64)
      arch="arm64"
      ;;
    x86_64 | amd64)
      arch="x64"
      ;;
    *)
      fail "unsupported architecture: $(uname -m)"
      ;;
  esac

  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi

  if [ "$os" = "darwin" ] && [ "$arch" != "arm64" ]; then
    fail "Spotuify currently supports Apple Silicon Macs only"
  fi
  if [ "$os" = "linux" ]; then
    require_glibc
  fi

  target="$os-$arch"
}

refuse_sudo() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] &&
    [ "$SUDO_USER" != "root" ] && [ -z "${SPOTUIFY_INSTALL_ALLOW_SUDO:-}" ]; then
    fail "do not run this installer with sudo; it installs into your home directory"
  fi
}

managed_symlink() {
  path="$1"
  expected="$2"
  [ -L "$path" ] && [ "$(readlink "$path" 2>/dev/null || true)" = "$expected" ]
}

check_install_paths() {
  fresh_install="false"
  if { [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; } &&
    { [ ! -d "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ]; }; then
    fail "$INSTALL_ROOT is not a regular directory"
  fi
  if { [ -e "$RELEASES_DIR" ] || [ -L "$RELEASES_DIR" ]; } &&
    { [ ! -d "$RELEASES_DIR" ] || [ -L "$RELEASES_DIR" ]; }; then
    fail "$RELEASES_DIR is not a regular directory"
  fi

  expected_marker="{\"schema\":1,\"manager\":\"spotuify-installer\",\"target\":\"$target\"}"
  if [ -e "$MARKER_PATH" ]; then
    if [ ! -f "$MARKER_PATH" ] || [ -L "$MARKER_PATH" ] ||
      [ "$(cat "$MARKER_PATH" 2>/dev/null || true)" != "$expected_marker" ]; then
      fail "$MARKER_PATH is not a valid Spotuify installer marker"
    fi
  elif [ -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ] ||
    [ -e "$RELEASES_DIR" ] || [ -L "$RELEASES_DIR" ] ||
    [ -e "$BIN_PATH" ] || [ -L "$BIN_PATH" ] ||
    [ -e "$ENGINE_PATH" ] || [ -L "$ENGINE_PATH" ]; then
    fail "$INSTALL_ROOT is not marked as a Spotuify installer-managed installation"
  else
    fresh_install="true"
  fi

  if { [ -e "$BIN_PATH" ] || [ -L "$BIN_PATH" ]; } &&
    ! managed_symlink "$BIN_PATH" "$CURRENT_LINK/spotuify"; then
    fail "$BIN_PATH already exists and is not managed by this installer"
  fi

  if { [ -e "$ENGINE_PATH" ] || [ -L "$ENGINE_PATH" ]; } &&
    ! managed_symlink "$ENGINE_PATH" "$CURRENT_LINK/spotuify-engine"; then
    fail "$ENGINE_PATH already exists and is not managed by this installer"
  fi

  if [ -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ]; then
    if [ ! -L "$CURRENT_LINK" ]; then
      fail "$CURRENT_LINK already exists and is not a symbolic link"
    fi
    current_target="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
    case "$current_target" in
      "$RELEASES_DIR"/*) ;;
      *) fail "$CURRENT_LINK is not managed by this installer" ;;
    esac
  fi
}

acquire_lock() {
  mkdir -p "$INSTALL_ROOT"
  lock_token="shell-$$-${tmp_dir##*/}"

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n%s\n' "$$" "$lock_token" >"$LOCK_DIR/owner"
    lock_acquired="true"
    return
  fi

  if [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ] ||
    [ ! -f "$LOCK_DIR/owner" ] || [ -L "$LOCK_DIR/owner" ]; then
    fail "$LOCK_DIR is not a valid installer lock"
  fi

  lock_pid="$(sed -n '1p' "$LOCK_DIR/owner" 2>/dev/null || true)"
  observed_token="$(sed -n '2p' "$LOCK_DIR/owner" 2>/dev/null || true)"
  case "$lock_pid" in
    "" | *[!0-9]*) fail "another Spotuify installation is already running" ;;
    *)
      if kill -0 "$lock_pid" 2>/dev/null; then
        fail "another Spotuify installation is already running"
      fi
      ;;
  esac
  if [ -z "$observed_token" ]; then
    fail "another Spotuify installation is already running"
  fi

  reclaim_dir="$LOCK_DIR/reclaim"
  if ! mkdir "$reclaim_dir" 2>/dev/null; then
    fail "another Spotuify installation is already running"
  fi
  if ! printf '%s\n' "$lock_token" >"$reclaim_dir/owner"; then
    rm -rf "$reclaim_dir"
    fail "could not claim the stale installer lock at $LOCK_DIR"
  fi

  confirmed_pid="$(sed -n '1p' "$LOCK_DIR/owner" 2>/dev/null || true)"
  confirmed_token="$(sed -n '2p' "$LOCK_DIR/owner" 2>/dev/null || true)"
  confirmed_claim="$(cat "$reclaim_dir/owner" 2>/dev/null || true)"
  if [ "$confirmed_pid" != "$lock_pid" ] || [ "$confirmed_token" != "$observed_token" ] ||
    [ "$confirmed_claim" != "$lock_token" ] ||
    kill -0 "$confirmed_pid" 2>/dev/null; then
    if [ "$(cat "$reclaim_dir/owner" 2>/dev/null || true)" = "$lock_token" ]; then
      rm -rf "$reclaim_dir"
    fi
    fail "another Spotuify installation is already running"
  fi

  warn "removing a stale installer lock at $LOCK_DIR"
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another Spotuify installation is already running"
  fi
  printf '%s\n%s\n' "$$" "$lock_token" >"$LOCK_DIR/owner"
  lock_acquired="true"
}

validate_archive() {
  archive="$1"
  release_name="$2"
  listing="$tmp_dir/archive-list.txt"
  verbose_listing="$tmp_dir/archive-list-verbose.txt"

  tar -tzf "$archive" >"$listing"
  tar -tvzf "$archive" >"$verbose_listing"

  if [ "$(wc -l <"$listing" | tr -d '[:space:]')" != "3" ] ||
    [ "$(grep -Fxc "$release_name/" "$listing" || true)" != "1" ] ||
    [ "$(grep -Fxc "$release_name/spotuify" "$listing" || true)" != "1" ] ||
    [ "$(grep -Fxc "$release_name/spotuify-engine" "$listing" || true)" != "1" ]; then
    fail "the release archive has an unexpected layout"
  fi

  if ! awk -v root="$release_name" '
    $NF == root "/" { directories += substr($1, 1, 1) == "d" }
    $NF == root "/spotuify" { files += substr($1, 1, 1) == "-" }
    $NF == root "/spotuify-engine" { files += substr($1, 1, 1) == "-" }
    END { exit !(directories == 1 && files == 2) }
  ' "$verbose_listing"; then
    fail "the release archive contains unexpected file types"
  fi
}

replace_symlink() {
  link_path="$1"
  link_target="$2"
  temporary_link="$link_path.tmp.$$"

  rm -f "$temporary_link"
  ln -s "$link_target" "$temporary_link"
  if [ "$os" = "darwin" ]; then
    mv -fh "$temporary_link" "$link_path"
  else
    mv -fT "$temporary_link" "$link_path"
  fi
}

pick_profile() {
  case "$os:${SHELL:-}" in
    darwin:*/zsh) printf '%s\n' "$HOME/.zprofile" ;;
    darwin:*/bash) printf '%s\n' "$HOME/.bash_profile" ;;
    linux:*/zsh) printf '%s\n' "$HOME/.zshrc" ;;
    linux:*/bash) printf '%s\n' "$HOME/.bashrc" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

configure_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      return
      ;;
  esac

  case "$BIN_DIR" in
    *:*)
      warn "$BIN_DIR contains a colon and cannot be represented safely in PATH"
      path_action="skipped"
      return
      ;;
  esac

  case "${SPOTUIFY_NO_MODIFY_PATH:-}" in
    1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss])
      path_action="skipped"
      return
      ;;
  esac

  path_profile="$(pick_profile)"
  begin_marker="# >>> Spotuify installer >>>"
  end_marker="# <<< Spotuify installer <<<"
  escaped_bin_dir="$(printf '%s' "$BIN_DIR" | sed "s/'/'\\\\''/g")"
  path_line="export PATH='$escaped_bin_dir':\"\$PATH\""

  if [ -f "$path_profile" ] && grep -F "$begin_marker" "$path_profile" >/dev/null 2>&1; then
    if grep -F "$path_line" "$path_profile" >/dev/null 2>&1 &&
      grep -F "$end_marker" "$path_profile" >/dev/null 2>&1; then
      path_action="configured"
      return
    fi
    warn "an existing Spotuify PATH block in $path_profile was left unchanged"
    path_action="skipped"
    return
  fi

  if ! (
    {
      printf '\n%s\n' "$begin_marker"
      printf '%s\n' "$path_line"
      printf '%s\n' "$end_marker"
    } >>"$path_profile"
  ); then
    path_action="skipped"
    return 1
  fi
  path_action="added"
}

normalize_version
validate_install_prefix
refuse_sudo
normalize_install_prefix
detect_target
check_install_paths

for command in id uname mktemp tar awk grep sed tr wc chmod cp mv ln mkdir rm rmdir readlink cat; do
  if ! command -v "$command" >/dev/null 2>&1; then
    fail "$command is required"
  fi
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/spotuify-install.XXXXXX")"
checksums_path="$tmp_dir/SHA256SUMS"

if [ "$VERSION" = "latest" ]; then
  release_download_url="$RELEASES_URL/latest/download"
else
  release_download_url="$RELEASES_URL/download/v$VERSION"
fi

step "Resolving Spotuify release for $target"
download_file "$release_download_url/SHA256SUMS" "$checksums_path"

asset="$(awk -v suffix="-$target.tar.gz" '
  length($1) == 64 && $1 !~ /[^0-9a-fA-F]/ &&
    length($2) > length(suffix) &&
    substr($2, length($2) - length(suffix) + 1) == suffix {
      matches++
      asset = $2
    }
  END {
    if (matches != 1) exit 1
    print asset
  }
' "$checksums_path")" || fail "the release does not contain exactly one archive for $target"

if ! printf '%s\n' "$asset" |
  grep -Eq "^spotuify-v[0-9]+\.[0-9]+\.[0-9]+-$target\.tar\.gz$"; then
  fail "the release manifest contains an invalid archive name"
fi

resolved_version="${asset#spotuify-v}"
resolved_version="${resolved_version%-$target.tar.gz}"
if [ "$VERSION" != "latest" ] && [ "$resolved_version" != "$VERSION" ]; then
  fail "release metadata resolved $resolved_version instead of requested version $VERSION"
fi

expected_digest="$(awk -v asset="$asset" '
  $2 == asset && length($1) == 64 && $1 !~ /[^0-9a-fA-F]/ {
    matches++
    digest = tolower($1)
  }
  END {
    if (matches != 1) exit 1
    print digest
  }
' "$checksums_path")" || fail "the release manifest does not contain one valid checksum for $asset"

archive_path="$tmp_dir/$asset"
step "Downloading Spotuify $resolved_version"
download_file "$release_download_url/$asset" "$archive_path"

actual_digest="$(file_sha256 "$archive_path" | tr 'A-F' 'a-f')"
if [ "$actual_digest" != "$expected_digest" ]; then
  fail "checksum verification failed for $asset"
fi

release_name="${asset%.tar.gz}"
validate_archive "$archive_path" "$release_name"

extract_dir="$tmp_dir/extract"
mkdir "$extract_dir"
tar -xzf "$archive_path" -C "$extract_dir"
extracted_release="$extract_dir/$release_name"

if [ ! -f "$extracted_release/spotuify" ] || [ -L "$extracted_release/spotuify" ] ||
  [ ! -f "$extracted_release/spotuify-engine" ] ||
  [ -L "$extracted_release/spotuify-engine" ]; then
  fail "the extracted release does not contain regular Spotuify executables"
fi

chmod 0755 "$extracted_release/spotuify" "$extracted_release/spotuify-engine"
if [ "$("$extracted_release/spotuify" --version 2>/dev/null || true)" != "spotuify $resolved_version" ]; then
  fail "the Spotuify executable did not report version $resolved_version"
fi
if [ "$("$extracted_release/spotuify-engine" --version 2>/dev/null || true)" != "spotuify-engine $resolved_version" ]; then
  fail "the Spotuify engine did not report version $resolved_version"
fi

acquire_lock
check_install_paths
mkdir -p "$RELEASES_DIR" "$BIN_DIR" "$LIBEXEC_DIR"
release_dir="$RELEASES_DIR/$resolved_version-$target"
staged_release="$RELEASES_DIR/.staging.$resolved_version-$target.$$"
rm -rf "$staged_release"
mkdir "$staged_release"
cp "$extracted_release/spotuify" "$staged_release/spotuify"
cp "$extracted_release/spotuify-engine" "$staged_release/spotuify-engine"
chmod 0755 "$staged_release/spotuify" "$staged_release/spotuify-engine"

if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
  if [ ! -d "$release_dir" ] || [ -L "$release_dir" ] ||
    [ ! -f "$release_dir/spotuify" ] || [ -L "$release_dir/spotuify" ] ||
    [ ! -f "$release_dir/spotuify-engine" ] || [ -L "$release_dir/spotuify-engine" ] ||
    [ "$("$release_dir/spotuify" --version 2>/dev/null || true)" != "spotuify $resolved_version" ] ||
    [ "$("$release_dir/spotuify-engine" --version 2>/dev/null || true)" != "spotuify-engine $resolved_version" ]; then
    fail "$release_dir is not a valid Spotuify $resolved_version release"
  fi
  rm -rf "$staged_release"
else
  mv "$staged_release" "$release_dir"
  release_created="true"
fi
staged_release=""
marker_tmp="$MARKER_PATH.tmp.$$"
printf '{"schema":1,"manager":"spotuify-installer","target":"%s"}\n' "$target" >"$marker_tmp"
chmod 0600 "$marker_tmp"
mv -f "$marker_tmp" "$MARKER_PATH"
if [ "$fresh_install" = "true" ]; then
  marker_created="true"
fi
if [ -L "$CURRENT_LINK" ]; then
  current_preexisting="true"
  previous_current_target="$(readlink "$CURRENT_LINK")"
fi
activation_pending="true"
replace_symlink "$CURRENT_LINK" "$release_dir"
replace_symlink "$BIN_PATH" "$CURRENT_LINK/spotuify"
replace_symlink "$ENGINE_PATH" "$CURRENT_LINK/spotuify-engine"

if [ "$("$BIN_PATH" --version 2>/dev/null || true)" != "spotuify $resolved_version" ] ||
  [ "$("$ENGINE_PATH" --version 2>/dev/null || true)" != "spotuify-engine $resolved_version" ]; then
  fail "the installed Spotuify commands could not be verified"
fi

activation_pending="false"
install_completed="true"
release_lock

existing_command="$(command -v spotuify 2>/dev/null || true)"
if [ -n "$existing_command" ] && [ "$existing_command" != "$BIN_PATH" ]; then
  warn "another Spotuify command exists at $existing_command; PATH order determines which one runs"
fi

if ! configure_path; then
  warn "Spotuify was installed, but PATH could not be updated in $path_profile"
fi

step "Spotuify $resolved_version installed successfully"
case "$path_action" in
  added)
    step "PATH was added to $path_profile"
    step "Open a new terminal and run: spotuify auth"
    ;;
  configured)
    step "Open a new terminal and run: spotuify auth"
    ;;
  skipped)
    step "Add $BIN_DIR to PATH, then run: spotuify auth"
    ;;
  *)
    step "Run: spotuify auth"
    ;;
esac
