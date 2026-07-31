# Releasing spotuify

GitHub Releases is the canonical distribution channel. Each release contains signed and notarized
macOS archives, Linux archives, SHA-256 checksums, and a generated Homebrew formula. After the
release is published, the workflow updates the maintainer-owned tap automatically.

## Release outputs

The tag `vX.Y.Z` produces:

| Asset | Build host | Compatibility |
| --- | --- | --- |
| `spotuify-vX.Y.Z-darwin-arm64.tar.gz` | `macos-26` | Apple silicon, macOS 13+ |
| `spotuify-vX.Y.Z-linux-arm64.tar.gz` | `ubuntu-22.04-arm` | arm64, glibc 2.35+ |
| `spotuify-vX.Y.Z-linux-x64.tar.gz` | `ubuntu-22.04` | x86-64 baseline, glibc 2.35+ |
| `SHA256SUMS` | release publisher | All archive checksums |
| `spotuify.rb` | release publisher | Formula ready for `homebrew-tap` |
| `THIRD_PARTY_NOTICES.txt` | release publisher | Notices for bundled dependencies |

Every archive has one top-level directory containing:

```text
spotuify-vX.Y.Z-<platform>-<architecture>/
├── spotuify
└── spotuify-engine
```

The two executables must remain together for a direct installation. The generated Homebrew formula
supports Apple silicon macOS, installs `spotuify` into `bin`, and keeps `spotuify-engine` private in
`libexec`. Dependency notices are published once as a separate release asset instead of being
duplicated inside every platform archive.

## One-time GitHub setup

Under **Settings → Secrets and variables → Actions**, add these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERT_P12_BASE64` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERT_PASSWORD` | Export password for the `.p12` |
| `APPLE_API_PRIVATE_KEY_BASE64` | Base64-encoded App Store Connect API `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER_ID` | App Store Connect issuer ID |
| `HOMEBREW_TAP_TOKEN` | Fine-grained token scoped to `austin-smith/homebrew-tap` with repository Contents read/write |

Encode the two files on macOS without modifying their contents:

```sh
base64 -i developer-id-application.p12 | pbcopy
base64 -i AuthKey_KEYID.p8 | pbcopy
```

The workflow imports the certificate into an ephemeral keychain, signs both executables with the
hardened runtime, applies Bun's required JIT entitlements only to `spotuify`, notarizes the archive,
and deletes the keychain and key material when the job ends.

### Create the Homebrew tap

A personal tap requires no Homebrew review. Create it with Homebrew's tap scaffold, then publish
that scaffold as the public `austin-smith/homebrew-tap` repository:

```sh
brew tap-new austin-smith/homebrew-tap
gh repo create austin-smith/homebrew-tap \
  --public \
  --source "$(brew --repository austin-smith/tap)" \
  --push
```

Create the fine-grained token with only the tap selected and only **Contents: Read and write**.
Store it as the `HOMEBREW_TAP_TOKEN` repository secret in `austin-smith/spotuify`. The release
workflow reads the formula back from the published GitHub release and commits it directly to
`Formula/spotuify.rb` in the tap. Users can then install it directly:

```sh
brew install austin-smith/tap/spotuify
```

The update is idempotent, so rerunning the publisher after a tap failure is safe. The workflow does
not replace assets when the GitHub release is already public.

## Publish a release

1. Update `package.json` and `native/Cargo.toml` to the same semantic version. Keep
   `native/Cargo.toml` set to `publish = false`.
2. Refresh the native package version recorded in `native/Cargo.lock` without updating third-party
   dependencies:

   ```sh
   cargo update --manifest-path native/Cargo.toml --workspace
   ```

3. Refresh and validate generated metadata:

   ```sh
   bun install
   bun run licenses:generate
   bun run licenses:check
   ```

4. Run the complete pre-release validation:

   ```sh
   bun run typecheck
   bun test
   bun run engine:test
   cargo fmt --manifest-path native/Cargo.toml --check
   cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
   ```

5. Commit the version and generated changes through the normal review process.
6. Create a signed version tag and push only that tag:

   ```sh
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Confirm that all three archives, `SHA256SUMS`, `spotuify.rb`, and
   `THIRD_PARTY_NOTICES.txt` are attached before the draft is published.
8. Confirm that `Formula/spotuify.rb` was updated in `austin-smith/homebrew-tap`.

The workflow rejects a tag unless it exactly matches the canonical `package.json` version and the
duplicate native Cargo version. It also extracts each finished archive and executes
`spotuify --version` and `spotuify-engine --version` before publication.

## Failed and incorrect releases

- If a build fails before publication, fix the cause and rerun the failed jobs. The publisher can
  safely replace assets while the release remains a draft.
- If a release has already been published, never move its tag or replace its assets. Correct the
  problem with a new patch version and release.
- If the tap update fails, rerun the publish job. It reads the canonical formula from the existing
  release and updates the tap without changing published release assets.
