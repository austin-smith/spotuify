#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
license_tools_dir="$repo_root/tools/licenses"
cd "$repo_root"

cargo_about_version="0.9.1"
cargo_deny_version="0.20.2"

require_tool() {
  local command_name="$1"
  local expected_version="$2"
  local install_command="$3"
  local actual_version

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required. Install it with:" >&2
    echo "  $install_command" >&2
    exit 1
  fi

  actual_version="$("$command_name" --version)"
  if [[ "$actual_version" != "$command_name $expected_version" ]]; then
    echo "expected $command_name $expected_version, found $actual_version" >&2
    echo "install the expected version with:" >&2
    echo "  $install_command" >&2
    exit 1
  fi
}

generate_notices() (
  local output_path="$1"
  local raw_output

  cargo fetch --locked --manifest-path native/Cargo.toml
  raw_output="$(mktemp)"
  trap 'rm -f "$raw_output"' EXIT
  cargo-about generate \
    --manifest-path native/Cargo.toml \
    --config "$license_tools_dir/about.toml" \
    --locked \
    --fail \
    --output-file "$raw_output" \
    "$license_tools_dir/about.hbs"
  tr -d '\r' < "$raw_output" |
    sed 's/[[:blank:]]*$//' |
    awk 'NF { while (blank > 0) { print ""; blank-- } print; next } { blank++ }' > "$output_path"
)

case "${1:-}" in
  generate)
    require_tool \
      cargo-about \
      "$cargo_about_version" \
      "cargo install --locked --version $cargo_about_version cargo-about"
    generate_notices "$repo_root/THIRD_PARTY_NOTICES.txt"
    ;;
  check)
    require_tool \
      cargo-about \
      "$cargo_about_version" \
      "cargo install --locked --version $cargo_about_version cargo-about"
    require_tool \
      cargo-deny \
      "$cargo_deny_version" \
      "cargo install --locked --version $cargo_deny_version cargo-deny"

    cargo-deny \
      --manifest-path native/Cargo.toml \
      --config "$license_tools_dir/deny.toml" \
      --exclude-dev \
      --locked \
      check licenses

    generated_notices="$(mktemp)"
    trap 'rm -f "$generated_notices"' EXIT
    generate_notices "$generated_notices"
    diff -u THIRD_PARTY_NOTICES.txt "$generated_notices"
    ;;
  *)
    echo "usage: $0 <generate|check>" >&2
    exit 2
    ;;
esac
