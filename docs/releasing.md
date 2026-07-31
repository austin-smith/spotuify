# Publishing spotuify

Spotuify has stable and canary publication channels. Both build and verify every supported platform
from source. They never share npm dist-tags or Homebrew state.

| Event | Version | npm | GitHub Release | Homebrew |
| --- | --- | --- | --- | --- |
| Push to `main` | `X.Y.Z-canary.<run-number>.g<commit>` | `canary` | No | No |
| Push tag `vX.Y.Z` | `X.Y.Z` | `latest` | Stable, marked latest | Update stable formula |

Canary versions are derived during the workflow and are never committed to the repository. Users
opt in with `npm install --global spotuify@canary`. A stable version is published only after the
matching version is committed to both manifests and its signed tag is pushed.

GitHub Releases is the canonical stable distribution channel. Each stable release contains signed
and notarized macOS builds, Linux builds, an unsigned Windows build, SHA-256 checksums, and a
generated Homebrew formula.

## Stable release outputs

The tag `vX.Y.Z` produces:

| Asset | Build host | Compatibility |
| --- | --- | --- |
| `spotuify-vX.Y.Z-darwin-arm64.tar.gz` | `macos-26` | Apple silicon, macOS 13+ |
| `spotuify-vX.Y.Z-linux-arm64.tar.gz` | `ubuntu-22.04-arm` | arm64, glibc 2.35+ |
| `spotuify-vX.Y.Z-linux-x64.tar.gz` | `ubuntu-22.04` | x86-64 baseline, glibc 2.35+ |
| `spotuify-vX.Y.Z-windows-x64.zip` | `windows-2025` | Windows 11, x86-64 with AVX2 |
| `SHA256SUMS` | release publisher | All archive checksums |
| `spotuify.rb` | release publisher | Formula ready for `homebrew-tap` |

Every archive has one top-level directory containing two executables. Windows uses the same names
with an `.exe` suffix.

```text
spotuify-vX.Y.Z-<platform>-<architecture>/
├── spotuify
└── spotuify-engine
```

The two executables must remain together for a direct installation. The generated Homebrew formula
supports Apple silicon macOS, installs `spotuify` into `bin`, and keeps `spotuify-engine` private in
`libexec`. License terms and third-party notices are embedded in `spotuify` and available through
`spotuify licenses`, so every distribution includes them without adding files to the archives.

The npm workflow publishes one user-facing package and four internal platform packages:

| Package | Purpose |
| --- | --- |
| `spotuify` | Exposes the `spotuify` command and selects the current platform |
| `spotuify-darwin-arm64` | Apple silicon binaries |
| `spotuify-linux-arm64` | Linux arm64 binaries |
| `spotuify-linux-x64` | Linux x86-64 binaries |
| `spotuify-windows-x64` | Windows x86-64 binaries |

Users install only `spotuify`. Its exact-version optional dependencies cause npm to install the
matching platform package without downloading binaries for other operating systems. The launcher
executes the platform binary directly; npm installation does not run a `postinstall` script.
Stable publications explicitly use npm's `latest` dist-tag; canaries explicitly use `canary`.

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

### Bootstrap npm trusted publishing

npm requires a package to exist before it can trust a GitHub Actions workflow. The workflow uploads
an `npm-packages` artifact on every publication. Bootstrap the packages from the first stable
release; canary publication remains disabled until this is complete.

Download that artifact, enter its directory, sign in with an npm account that has 2FA enabled, and
publish the platform packages before the launcher package:

```sh
npm login
npm publish spotuify-darwin-arm64-X.Y.Z.tgz --access public --tag latest
npm publish spotuify-linux-arm64-X.Y.Z.tgz --access public --tag latest
npm publish spotuify-linux-x64-X.Y.Z.tgz --access public --tag latest
npm publish spotuify-windows-x64-X.Y.Z.tgz --access public --tag latest
npm publish spotuify-X.Y.Z.tgz --access public --tag latest
```

For each package, configure **Settings → Trusted Publisher → GitHub Actions** with:

| Field | Value |
| --- | --- |
| Organization or user | `austin-smith` |
| Repository | `spotuify` |
| Workflow filename | `release.yml` |
| Environment | Leave blank |
| Allowed action | `npm publish` |

Then set **Publishing access** to **Require two-factor authentication and disallow tokens**. No npm
token or GitHub environment is required. Future releases publish with short-lived GitHub OIDC
credentials and npm provenance. The same `release.yml` trusted publisher authorizes both stable and
canary jobs; do not configure a second publisher.

## Publish a stable release

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

7. Confirm that all four archives, `SHA256SUMS`, and `spotuify.rb` are attached before the draft is
   published.
8. Confirm that `Formula/spotuify.rb` was updated in `austin-smith/homebrew-tap`.
9. Confirm that all five npm packages have the released version.

The workflow rejects a tag unless it points to a commit on `main` and exactly matches the canonical
`package.json` version and duplicate native Cargo version. It also extracts each finished archive
and executes `spotuify --version` and `spotuify-engine --version` before publication.

## Failed and incorrect releases

- If a build fails before publication, fix the cause and rerun the failed jobs. The publisher can
  safely replace assets while the release remains a draft.
- If a release has already been published, never move its tag or replace its assets. Correct the
  problem with a new patch version and release.
- If the tap update fails, rerun the Homebrew job. It reads the canonical formula from the existing
  release and updates the tap without changing published release assets.
- If npm publishing fails after the packages are bootstrapped, rerun the npm job. It skips versions
  already present and publishes only the missing packages.
- If a canary fails and no newer canary has published, rerun the failed jobs. Once a newer canary
  exists, an older rerun is skipped rather than moving npm's `canary` dist-tag backward.
