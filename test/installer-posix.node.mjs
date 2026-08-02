import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(repositoryRoot, 'packaging', 'standalone', 'install.sh');
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function temporaryDirectory(name) {
	const directory = mkdtempSync(join(tmpdir(), `spotuify-${name}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function executable(path, contents) {
	writeFileSync(path, contents, { mode: 0o755 });
	chmodSync(path, 0o755);
}

function releaseFixture(
	root,
	{ extraFile = false, marker = 'original', target = 'linux-x64', version = '9.8.7' } = {},
) {
	const releaseName = `spotuify-v${version}-${target}`;
	const releaseParent = join(root, 'release');
	const releaseDirectory = join(releaseParent, releaseName);
	mkdirSync(releaseDirectory, { recursive: true });
	executable(
		join(releaseDirectory, 'spotuify'),
		`#!/bin/sh\n# ${marker}\n[ "\${1:-}" = "--version" ] && printf 'spotuify ${version}\\n'\n`,
	);
	executable(
		join(releaseDirectory, 'spotuify-engine'),
		`#!/bin/sh\n[ "\${1:-}" = "--version" ] && printf 'spotuify-engine ${version}\\n'\n`,
	);
	if (extraFile) writeFileSync(join(releaseDirectory, 'unexpected'), 'nope\n');

	const asset = `${releaseName}.tar.gz`;
	const archive = join(root, asset);
	execFileSync('tar', ['-czf', archive, '-C', releaseParent, releaseName]);
	const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
	const manifest = join(root, 'SHA256SUMS');
	writeFileSync(manifest, `${digest}  ${asset}\n`);
	return { archive, asset, digest, manifest, target, version };
}

function mockCommands(root) {
	const binaryDirectory = join(root, 'mock-bin');
	mkdirSync(binaryDirectory);
	const nativeMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
	const nativeCp = execFileSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim();
	executable(
		join(binaryDirectory, 'cp'),
		`#!/bin/sh
last=""
for argument in "$@"; do
  last="$argument"
done
case "$last" in
  */share/spotuify/releases/.staging.*/spotuify)
    if [ "\${SPOTUIFY_TEST_FAIL_STAGING_COPY:-}" = "1" ]; then exit 74; fi
    ;;
esac
exec "${nativeCp}" "$@"
`,
	);
	executable(
		join(binaryDirectory, 'mv'),
		`#!/bin/sh
last=""
for argument in "$@"; do
  last="$argument"
done
if [ -n "\${SPOTUIFY_TEST_FAIL_MV_TARGET:-}" ] && [ "$last" = "$SPOTUIFY_TEST_FAIL_MV_TARGET" ]; then
  exit 73
fi
if [ "${process.platform}" = "darwin" ] && [ "\${1:-}" = "-fT" ]; then
  shift
  exec "${nativeMv}" -fh "$@"
fi
if [ "${process.platform}" = "linux" ] && [ "\${1:-}" = "-fh" ]; then
  shift
  exec "${nativeMv}" -fT "$@"
fi
exec "${nativeMv}" "$@"
`,
	);
	executable(
		join(binaryDirectory, 'uname'),
		`#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\\n' "\${SPOTUIFY_TEST_OS:-Linux}" ;;
  -m) printf '%s\\n' "\${SPOTUIFY_TEST_ARCH:-x86_64}" ;;
  *) exit 1 ;;
esac
`,
	);
	executable(
		join(binaryDirectory, 'getconf'),
		`#!/bin/sh
[ "\${1:-}" = "GNU_LIBC_VERSION" ] || exit 1
printf '%s\\n' "\${SPOTUIFY_TEST_LIBC:-glibc 2.36}"
`,
	);
	executable(
		join(binaryDirectory, 'sysctl'),
		`#!/bin/sh
printf '%s\\n' "\${SPOTUIFY_TEST_ROSETTA:-0}"
`,
	);
	executable(
		join(binaryDirectory, 'curl'),
		`#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output="$1" ;;
    http://* | https://*) url="$1" ;;
  esac
  shift
done
[ -n "$output" ] && [ -n "$url" ] || exit 2
printf '%s\\n' "$url" >>"$SPOTUIFY_TEST_URL_LOG"
case "$url" in
  */SHA256SUMS) cp "$SPOTUIFY_TEST_MANIFEST" "$output" ;;
  *.tar.gz)
    cp "$SPOTUIFY_TEST_ARCHIVE" "$output"
    if [ -n "\${SPOTUIFY_TEST_MARKER_DURING_DOWNLOAD:-}" ]; then
      mkdir -p "$SPOTUIFY_TEST_MARKER_DURING_DOWNLOAD"
      printf '%s\n' '{"schema":1,"manager":"spotuify-installer","target":"linux-x64"}' >"$SPOTUIFY_TEST_MARKER_DURING_DOWNLOAD/.spotuify-install.json"
    fi
    ;;
  *) exit 22 ;;
esac
`,
	);
	return binaryDirectory;
}

function runInstaller({ fixture, mutateEnvironment, root = temporaryDirectory('run') } = {}) {
	const selectedFixture = fixture ?? releaseFixture(root);
	const home = join(root, 'home with spaces');
	const prefix = join(home, '.local');
	const urlLog = join(root, 'urls.log');
	mkdirSync(home, { recursive: true });
	const binaryDirectory = mockCommands(root);
	const environment = {
		...process.env,
		HOME: home,
		PATH: `${binaryDirectory}:${process.env.PATH}`,
		SHELL: '/bin/zsh',
		SPOTUIFY_INSTALL_PREFIX: prefix,
		SPOTUIFY_TEST_ARCHIVE: selectedFixture.archive,
		SPOTUIFY_TEST_MANIFEST: selectedFixture.manifest,
		SPOTUIFY_TEST_URL_LOG: urlLog,
	};
	mutateEnvironment?.(environment, { home, prefix, root });
	const result = spawnSync('sh', [installer], { encoding: 'utf8', env: environment });
	return { environment, fixture: selectedFixture, home, prefix, result, root, urlLog };
}

test('is valid POSIX shell syntax', () => {
	execFileSync('sh', ['-n', installer]);
});

test('installs and verifies the latest release without requiring a package manager', () => {
	const run = runInstaller();
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.match(run.result.stdout, /Spotuify 9\.8\.7 installed successfully/);

	const canonicalPrefix = realpathSync(run.prefix);
	const releaseDirectory = join(canonicalPrefix, 'share', 'spotuify', 'releases', '9.8.7-linux-x64');
	const currentLink = join(canonicalPrefix, 'share', 'spotuify', 'current');
	const commandLink = join(canonicalPrefix, 'bin', 'spotuify');
	const engineLink = join(canonicalPrefix, 'libexec', 'spotuify-engine');
	assert.equal(lstatSync(currentLink).isSymbolicLink(), true);
	assert.equal(readlinkSync(currentLink), releaseDirectory);
	assert.equal(readlinkSync(commandLink), `${currentLink}/spotuify`);
	assert.equal(readlinkSync(engineLink), `${currentLink}/spotuify-engine`);
	assert.deepEqual(
		JSON.parse(readFileSync(join(run.prefix, 'share', 'spotuify', '.spotuify-install.json'), 'utf8')),
		{ schema: 1, manager: 'spotuify-installer', target: 'linux-x64' },
	);
	assert.equal(execFileSync(commandLink, ['--version'], { encoding: 'utf8' }), 'spotuify 9.8.7\n');
	assert.equal(
		execFileSync(engineLink, ['--version'], { encoding: 'utf8' }),
		'spotuify-engine 9.8.7\n',
	);
	assert.match(readFileSync(join(run.home, '.zshrc'), 'utf8'), /Spotuify installer/);
	assert.match(readFileSync(run.urlLog, 'utf8'), /releases\/latest\/download\/SHA256SUMS/);
});

test('supports a pinned stable release and keeps PATH configuration idempotent', () => {
	const root = temporaryDirectory('pinned');
	const fixture = releaseFixture(root, { version: '1.2.3' });
	const first = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment) {
			environment.SPOTUIFY_VERSION = 'v1.2.3';
		},
	});
	assert.equal(first.result.status, 0, first.result.stderr);
	const installedCommand = join(
		first.prefix,
		'share',
		'spotuify',
		'releases',
		'1.2.3-linux-x64',
		'spotuify',
	);
	assert.match(readFileSync(installedCommand, 'utf8'), /# original/);
	const secondRoot = temporaryDirectory('pinned-second');
	const replacementFixture = releaseFixture(secondRoot, { marker: 'replacement', version: '1.2.3' });
	const second = runInstaller({
		fixture: replacementFixture,
		root: secondRoot,
		mutateEnvironment(environment) {
			environment.HOME = first.home;
			environment.SPOTUIFY_INSTALL_PREFIX = first.prefix;
			environment.SPOTUIFY_VERSION = '1.2.3';
		},
	});
	assert.equal(second.result.status, 0, second.result.stderr);
	assert.match(readFileSync(installedCommand, 'utf8'), /# original/);
	assert.doesNotMatch(readFileSync(installedCommand, 'utf8'), /# replacement/);
	const profile = readFileSync(join(first.home, '.zshrc'), 'utf8');
	assert.equal(profile.match(/>>> Spotuify installer >>>/g)?.length, 1);
	assert.match(readFileSync(first.urlLog, 'utf8'), /releases\/download\/v1\.2\.3\/SHA256SUMS/);
});

test('atomically switches an existing installation to a newer release', () => {
	const firstRoot = temporaryDirectory('upgrade-first');
	const firstFixture = releaseFixture(firstRoot, { version: '1.0.0' });
	const first = runInstaller({ fixture: firstFixture, root: firstRoot });
	assert.equal(first.result.status, 0, first.result.stderr);

	const secondRoot = temporaryDirectory('upgrade-second');
	const secondFixture = releaseFixture(secondRoot, { version: '2.0.0' });
	const second = runInstaller({
		fixture: secondFixture,
		root: secondRoot,
		mutateEnvironment(environment) {
			environment.HOME = first.home;
			environment.SPOTUIFY_INSTALL_PREFIX = first.prefix;
		},
	});
	assert.equal(second.result.status, 0, second.result.stderr);
	const current = join(first.prefix, 'share', 'spotuify', 'current');
	assert.equal(
		readlinkSync(current),
		join(realpathSync(first.prefix), 'share', 'spotuify', 'releases', '2.0.0-linux-x64'),
	);
	assert.equal(
		execFileSync(join(first.prefix, 'bin', 'spotuify'), ['--version'], { encoding: 'utf8' }),
		'spotuify 2.0.0\n',
	);
});

test('restores the previous active release when activation fails', () => {
	const firstRoot = temporaryDirectory('rollback-first');
	const firstFixture = releaseFixture(firstRoot, { version: '1.0.0' });
	const first = runInstaller({ fixture: firstFixture, root: firstRoot });
	assert.equal(first.result.status, 0, first.result.stderr);

	const secondRoot = temporaryDirectory('rollback-second');
	const secondFixture = releaseFixture(secondRoot, { version: '2.0.0' });
	const second = runInstaller({
		fixture: secondFixture,
		root: secondRoot,
		mutateEnvironment(environment) {
			environment.HOME = first.home;
			environment.SPOTUIFY_INSTALL_PREFIX = first.prefix;
			environment.SPOTUIFY_TEST_FAIL_MV_TARGET = join(
				realpathSync(first.prefix),
				'libexec',
				'spotuify-engine',
			);
		},
	});
	assert.equal(second.result.status, 73, second.result.stderr);
	const current = join(first.prefix, 'share', 'spotuify', 'current');
	assert.equal(
		readlinkSync(current),
		join(realpathSync(first.prefix), 'share', 'spotuify', 'releases', '1.0.0-linux-x64'),
	);
	assert.equal(
		execFileSync(join(first.prefix, 'bin', 'spotuify'), ['--version'], { encoding: 'utf8' }),
		'spotuify 1.0.0\n',
	);
});

test('recovers a stale installer lock through the reclamation protocol', () => {
	const root = temporaryDirectory('stale-lock');
	const fixture = releaseFixture(root);
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(_environment, { prefix }) {
			const lock = join(prefix, 'share', 'spotuify', '.install.lock');
			mkdirSync(lock, { recursive: true });
			writeFileSync(join(lock, 'owner'), '2147483647\nstale-owner\n');
		},
	});
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.match(run.result.stderr, /removing a stale installer lock/);
	assert.equal(existsSync(join(run.prefix, 'share', 'spotuify', '.install.lock')), false);
});

test('refuses to reclaim a lock owned by a live installer', () => {
	const root = temporaryDirectory('live-lock');
	const fixture = releaseFixture(root);
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(_environment, { prefix }) {
			const lock = join(prefix, 'share', 'spotuify', '.install.lock');
			mkdirSync(lock, { recursive: true });
			writeFileSync(join(lock, 'owner'), `${process.pid}\nlive-owner\n`);
		},
	});
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /another Spotuify installation is already running/);
	assert.equal(
		readFileSync(join(run.prefix, 'share', 'spotuify', '.install.lock', 'owner'), 'utf8'),
		`${process.pid}\nlive-owner\n`,
	);
});

test('escapes a custom install prefix before writing it to a shell profile', () => {
	const root = temporaryDirectory('escaped-prefix');
	const fixture = releaseFixture(root);
	const home = join(root, 'home');
	const prefix = join(home, 'prefix $HOME `false` "quoted" ! \'single\'');
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment) {
			environment.HOME = home;
			environment.SPOTUIFY_INSTALL_PREFIX = prefix;
		},
	});
	assert.equal(run.result.status, 0, run.result.stderr);
	const profile = join(home, '.zshrc');
	const resolvedCommand = execFileSync(
		'sh',
		['-c', `. "${profile}" && command -v spotuify`],
		{ encoding: 'utf8', env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' } },
	).trim();
	assert.equal(resolvedCommand, join(realpathSync(prefix), 'bin', 'spotuify'));
});

test('cleans a failed fresh installation so it can be retried', () => {
	const root = temporaryDirectory('fresh-retry');
	const fixture = releaseFixture(root);
	const failed = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment) {
			environment.SPOTUIFY_TEST_FAIL_STAGING_COPY = '1';
		},
	});
	assert.equal(failed.result.status, 74, failed.result.stderr);
	assert.equal(existsSync(join(realpathSync(failed.prefix), 'share', 'spotuify', 'releases')), false);
	assert.equal(
		existsSync(join(realpathSync(failed.prefix), 'share', 'spotuify', '.spotuify-install.json')),
		false,
	);

	const retryRoot = temporaryDirectory('fresh-retry-success');
	const retryFixture = releaseFixture(retryRoot);
	const retry = runInstaller({
		fixture: retryFixture,
		root: retryRoot,
		mutateEnvironment(environment) {
			environment.HOME = failed.home;
			environment.SPOTUIFY_INSTALL_PREFIX = failed.prefix;
		},
	});
	assert.equal(retry.result.status, 0, retry.result.stderr);
});

test('reports success when shell profile configuration is unavailable', () => {
	const root = temporaryDirectory('profile-unavailable');
	const fixture = releaseFixture(root);
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(_environment, { home }) {
			mkdirSync(join(home, '.zshrc'));
		},
	});
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.match(run.result.stderr, /installed, but PATH could not be updated/);
	assert.equal(
		execFileSync(join(run.prefix, 'bin', 'spotuify'), ['--version'], { encoding: 'utf8' }),
		'spotuify 9.8.7\n',
	);
});

test('recomputes fresh-install ownership after acquiring the lock', () => {
	const root = temporaryDirectory('ownership-race');
	const fixture = releaseFixture(root);
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment, { prefix }) {
			mkdirSync(prefix, { recursive: true });
			environment.SPOTUIFY_TEST_FAIL_STAGING_COPY = '1';
			environment.SPOTUIFY_TEST_MARKER_DURING_DOWNLOAD = join(
				realpathSync(prefix),
				'share',
				'spotuify',
			);
		},
	});
	assert.equal(run.result.status, 74, run.result.stderr);
	assert.deepEqual(
		JSON.parse(
			readFileSync(
				join(realpathSync(run.prefix), 'share', 'spotuify', '.spotuify-install.json'),
				'utf8',
			),
		),
		{ schema: 1, manager: 'spotuify-installer', target: 'linux-x64' },
	);
});

test('rejects a relative install prefix', () => {
	const run = runInstaller({
		mutateEnvironment(environment) {
			environment.SPOTUIFY_INSTALL_PREFIX = 'relative/prefix';
		},
	});
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /must be an absolute path/);
	assert.equal(existsSync(run.urlLog), false);
});

test('rejects an install prefix that resolves to the filesystem root', () => {
	const run = runInstaller({
		mutateEnvironment(environment) {
			environment.SPOTUIFY_INSTALL_PREFIX = '/tmp/..';
		},
	});
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /cannot resolve to the filesystem root/);
	assert.equal(existsSync(run.urlLog), false);
});

test('rejects a symlinked share boundary that cannot be rediscovered safely', () => {
	const root = temporaryDirectory('share-symlink');
	const fixture = releaseFixture(root);
	const home = join(root, 'home');
	const prefix = join(home, '.local');
	const externalShare = join(root, 'external-share');
	mkdirSync(prefix, { recursive: true });
	mkdirSync(externalShare);
	symlinkSync(externalShare, join(prefix, 'share'));
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment) {
			environment.HOME = home;
			environment.SPOTUIFY_INSTALL_PREFIX = prefix;
		},
	});
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /share cannot be a symbolic link/);
	assert.equal(existsSync(run.urlLog), false);
});

test('rejects a checksum mismatch before creating install files', () => {
	const root = temporaryDirectory('checksum');
	const fixture = releaseFixture(root);
	writeFileSync(fixture.manifest, `${'0'.repeat(64)}  ${fixture.asset}\n`);
	const run = runInstaller({ fixture, root });
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /checksum verification failed/);
	assert.equal(existsSync(join(run.prefix, 'bin', 'spotuify')), false);
});

test('rejects archives with unexpected entries', () => {
	const root = temporaryDirectory('layout');
	const fixture = releaseFixture(root, { extraFile: true });
	const run = runInstaller({ fixture, root });
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /unexpected layout/);
	assert.equal(existsSync(join(run.prefix, 'bin', 'spotuify')), false);
});

test('refuses to overwrite an unrelated command', () => {
	const root = temporaryDirectory('conflict');
	const fixture = releaseFixture(root);
	const home = join(root, 'home with spaces');
	const prefix = join(home, '.local');
	mkdirSync(join(prefix, 'bin'), { recursive: true });
	const existing = join(prefix, 'bin', 'spotuify');
	writeFileSync(existing, 'keep me\n');
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment) {
			environment.HOME = home;
			environment.SPOTUIFY_INSTALL_PREFIX = prefix;
		},
	});
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /not marked|already exists and is not managed/);
	assert.equal(readFileSync(existing, 'utf8'), 'keep me\n');
});

test('rejects unsupported Intel Macs before downloading anything', () => {
	const run = runInstaller({
		mutateEnvironment(environment) {
			environment.SPOTUIFY_TEST_OS = 'Darwin';
			environment.SPOTUIFY_TEST_ARCH = 'x86_64';
		},
	});
	assert.notEqual(run.result.status, 0);
	assert.match(run.result.stderr, /Apple Silicon Macs only/);
	assert.equal(existsSync(run.urlLog), false);
});

test('installs on Apple Silicon with the BSD atomic symlink replacement form', () => {
	const root = temporaryDirectory('darwin-arm64');
	const fixture = releaseFixture(root, { target: 'darwin-arm64' });
	const run = runInstaller({
		fixture,
		root,
		mutateEnvironment(environment) {
			environment.SPOTUIFY_TEST_OS = 'Darwin';
			environment.SPOTUIFY_TEST_ARCH = 'arm64';
		},
	});
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.equal(
		execFileSync(join(run.prefix, 'bin', 'spotuify'), ['--version'], { encoding: 'utf8' }),
		'spotuify 9.8.7\n',
	);
});
