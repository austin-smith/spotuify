#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <staged-release-directory>" >&2
  exit 2
fi

required_variables=(
  APPLE_CERT_P12_BASE64
  APPLE_CERT_PASSWORD
  APPLE_API_PRIVATE_KEY_BASE64
  APPLE_API_KEY_ID
  APPLE_API_ISSUER_ID
)
for variable in "${required_variables[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    echo "$variable is required" >&2
    exit 1
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$(cd "$1" && pwd)"
temporary="$(mktemp -d)"
keychain="$temporary/signing.keychain-db"
certificate="$temporary/developer-id.p12"
api_key="$temporary/AuthKey_${APPLE_API_KEY_ID}.p8"
notarization_archive="$temporary/$(basename "$stage").zip"
keychain_password="$(openssl rand -hex 32)"
original_keychains=()
keychain_list_changed=false

while IFS= read -r existing_keychain; do
  existing_keychain="$(
    printf '%s' "$existing_keychain" |
      sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'
  )"
  if [[ -n "$existing_keychain" ]]; then
    original_keychains+=("$existing_keychain")
  fi
done <<<"$(security list-keychains -d user)"

cleanup() {
  if [[ "$keychain_list_changed" == true ]]; then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT

printf '%s' "$APPLE_CERT_P12_BASE64" | base64 -D > "$certificate"
printf '%s' "$APPLE_API_PRIVATE_KEY_BASE64" | base64 -D > "$api_key"
chmod 600 "$certificate" "$api_key"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$certificate" \
  -k "$keychain" \
  -P "$APPLE_CERT_PASSWORD" \
  -T /usr/bin/codesign
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$keychain_password" \
  "$keychain"
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"
keychain_list_changed=true

identity="$(
  security find-identity -v -p codesigning "$keychain" |
    awk '/"Developer ID Application:/ && identity == "" { identity = $2 }
         END { print identity }'
)"
if [[ -z "$identity" ]]; then
  echo "the certificate does not contain a Developer ID Application identity" >&2
  exit 1
fi

codesign \
  --force \
  --options runtime \
  --timestamp \
  --keychain "$keychain" \
  --sign "$identity" \
  "$stage/spotuify-engine"
codesign \
  --force \
  --options runtime \
  --timestamp \
  --entitlements "$repo_root/packaging/macos/entitlements.plist" \
  --keychain "$keychain" \
  --sign "$identity" \
  "$stage/spotuify"

codesign --verify --strict --verbose=4 "$stage/spotuify-engine"
codesign --verify --strict --verbose=4 "$stage/spotuify"

ditto -c -k --keepParent "$stage" "$notarization_archive"
xcrun notarytool submit "$notarization_archive" \
  --key "$api_key" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER_ID" \
  --wait

codesign -vvvv -R="notarized" --check-notarization "$stage/spotuify-engine"
codesign -vvvv -R="notarized" --check-notarization "$stage/spotuify"
