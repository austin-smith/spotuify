#Requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $repositoryRoot 'packaging/standalone/install.ps1'
. $installerPath

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("spotuify-installer-tests-$([guid]::NewGuid().ToString('N'))")
$script:FixtureManifest = $null
$script:FixtureArchive = $null
$script:FixtureLauncher = $null
$script:MarkerDuringDownload = $null
$script:DownloadUrls = New-Object System.Collections.Generic.List[string]
$originalDownloadFunction = ${function:Invoke-InstallerDownload}
$originalBinaryTestFunction = ${function:Test-SpotuifyBinaries}
$originalMarkerFunction = ${function:Write-InstallerMarker}
$environmentNames = @(
	'PROCESSOR_ARCHITECTURE',
	'PROCESSOR_ARCHITEW6432',
	'SPOTUIFY_INSTALL_DIR',
	'SPOTUIFY_NO_MODIFY_PATH',
	'SPOTUIFY_VERSION'
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
	$originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Assert-True {
	param(
		[Parameter(Mandatory = $true)][bool]$Condition,
		[Parameter(Mandatory = $true)][string]$Message
	)
	if (-not $Condition) {
		throw "Assertion failed: $Message"
	}
}

function Assert-Equal {
	param(
		[AllowNull()]$Actual,
		[AllowNull()]$Expected,
		[Parameter(Mandatory = $true)][string]$Message
	)
	if ($Actual -cne $Expected) {
		throw "Assertion failed: $Message. Expected '$Expected', received '$Actual'."
	}
}

function Assert-Throws {
	param(
		[Parameter(Mandatory = $true)][scriptblock]$Action,
		[Parameter(Mandatory = $true)][string]$MessagePattern
	)
	try {
		& $Action
	} catch {
		if ($_.Exception.Message -notmatch $MessagePattern) {
			throw "Expected error matching '$MessagePattern', received '$($_.Exception.Message)'."
		}
		return
	}
	throw "Expected an error matching '$MessagePattern', but no error was thrown."
}

function Invoke-Test {
	param(
		[Parameter(Mandatory = $true)][string]$Name,
		[Parameter(Mandatory = $true)][scriptblock]$Test
	)
	& $Test
	Write-Host "PASS $Name"
}

function Get-Sha256Digest {
	param([Parameter(Mandatory = $true)][string]$Path)
	$stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
	$hasher = $null
	try {
		$hasher = [Security.Cryptography.SHA256]::Create()
		return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
	} finally {
		if ($null -ne $hasher) {
			$hasher.Dispose()
		}
		$stream.Dispose()
	}
}

function New-TestExecutable {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][string]$Output
	)
	$className = "Fixture$([guid]::NewGuid().ToString('N'))"
	$escapedOutput = $Output.Replace('\', '\\').Replace('"', '\"')
	$source = @"
using System;
using System.Threading;
public static class $className
{
    public static int Main(string[] args)
    {
		if (args.Length == 1 && args[0] == "--hold")
		{
			Thread.Sleep(30000);
			return 0;
		}
        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine("$escapedOutput");
            return 0;
        }
        return 2;
    }
}
"@
	Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $Path -OutputType ConsoleApplication
}

function New-TestLauncher {
	param([Parameter(Mandatory = $true)][string]$Path)
	$className = "FixtureLauncher$([guid]::NewGuid().ToString('N'))"
	$source = @"
using System;
using System.Diagnostics;
using System.IO;
public static class $className
{
    public static int Main(string[] args)
    {
        string bin = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string root = Directory.GetParent(bin).FullName;
        string current = File.ReadAllText(Path.Combine(root, "current")).Trim();
        string executable = Path.Combine(root, "releases", current, "spotuify.exe");
        Process process = Process.Start(new ProcessStartInfo(executable, String.Join(" ", args)) { UseShellExecute = false });
        process.WaitForExit();
        return process.ExitCode;
    }
}
"@
	Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $Path -OutputType ConsoleApplication
}

function New-ReleaseFixture {
	param(
		[Parameter(Mandatory = $true)][string]$Name,
		[string]$Version = '9.8.7',
		[switch]$ExtraEntry,
		[switch]$WrongChecksum
	)

	$fixtureRoot = Join-Path $testRoot $Name
	$payloadRoot = Join-Path $fixtureRoot 'payload'
	New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
	$spotuifyPath = Join-Path $payloadRoot 'spotuify.exe'
	$enginePath = Join-Path $payloadRoot 'spotuify-engine.exe'
	New-TestExecutable -Path $spotuifyPath -Output "spotuify $Version"
	New-TestExecutable -Path $enginePath -Output "spotuify-engine $Version"
	$launcherName = "spotuify-v$Version-windows-x64-standalone-launcher.exe"
	$launcherPath = Join-Path $fixtureRoot $launcherName
	New-TestLauncher -Path $launcherPath

	$releaseName = "spotuify-v$Version-windows-x64"
	$assetName = "$releaseName.zip"
	$archivePath = Join-Path $fixtureRoot $assetName
	Add-Type -AssemblyName System.IO.Compression
	$fileStream = $null
	$archive = $null
	try {
		$fileStream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
		$archive = New-Object IO.Compression.ZipArchive($fileStream, [IO.Compression.ZipArchiveMode]::Create, $false)
		$null = $archive.CreateEntry("$releaseName/")
		foreach ($fileName in @('spotuify.exe', 'spotuify-engine.exe')) {
			$entry = $archive.CreateEntry("$releaseName/$fileName", [IO.Compression.CompressionLevel]::Optimal)
			$inputStream = $null
			$outputStream = $null
			try {
				$inputStream = [IO.File]::OpenRead((Join-Path $payloadRoot $fileName))
				$outputStream = $entry.Open()
				$inputStream.CopyTo($outputStream)
			} finally {
				if ($null -ne $outputStream) {
					$outputStream.Dispose()
				}
				if ($null -ne $inputStream) {
					$inputStream.Dispose()
				}
			}
		}
		if ($ExtraEntry) {
			$extra = $archive.CreateEntry("$releaseName/unexpected.txt")
			$extraStream = $null
			$writer = $null
			try {
				$extraStream = $extra.Open()
				$writer = New-Object IO.StreamWriter($extraStream)
				$writer.Write('unexpected')
			} finally {
				if ($null -ne $writer) {
					$writer.Dispose()
				} elseif ($null -ne $extraStream) {
					$extraStream.Dispose()
				}
			}
		}
	} finally {
		if ($null -ne $archive) {
			$archive.Dispose()
		}
		if ($null -ne $fileStream) {
			$fileStream.Dispose()
		}
	}

	$digest = Get-Sha256Digest -Path $archivePath
	if ($WrongChecksum) {
		$digest = '0' * 64
	}
	$manifestPath = Join-Path $fixtureRoot 'SHA256SUMS'
	$launcherDigest = Get-Sha256Digest -Path $launcherPath
	[IO.File]::WriteAllText($manifestPath, "$digest  $assetName`n$launcherDigest  $launcherName`n")
	return [pscustomobject]@{
		Archive = $archivePath
		Asset = $assetName
		Launcher = $launcherPath
		Manifest = $manifestPath
		Version = $Version
	}
}

function Use-ReleaseFixture {
	param([Parameter(Mandatory = $true)]$Fixture)
	$script:FixtureManifest = $Fixture.Manifest
	$script:FixtureArchive = $Fixture.Archive
	$script:FixtureLauncher = $Fixture.Launcher
	$script:MarkerDuringDownload = $null
	$script:DownloadUrls.Clear()
}

function Invoke-InstallerDownload {
	param(
		[Parameter(Mandatory = $true)][uri]$Uri,
		[Parameter(Mandatory = $true)][string]$Destination
	)
	$script:DownloadUrls.Add($Uri.AbsoluteUri)
	if ($Uri.AbsolutePath.EndsWith('/SHA256SUMS', [StringComparison]::Ordinal)) {
		Copy-Item -LiteralPath $script:FixtureManifest -Destination $Destination
		return
	}
	if ($Uri.AbsolutePath.EndsWith('.zip', [StringComparison]::Ordinal)) {
		Copy-Item -LiteralPath $script:FixtureArchive -Destination $Destination
		if ($null -ne $script:MarkerDuringDownload) {
			New-Item -ItemType Directory -Path $script:MarkerDuringDownload -Force | Out-Null
			[IO.File]::WriteAllText(
				(Join-Path $script:MarkerDuringDownload '.spotuify-install.json'),
				'{"schema":1,"manager":"spotuify-installer","target":"windows-x64"}'
			)
		}
		return
	}
	if ($Uri.AbsolutePath.EndsWith('-standalone-launcher.exe', [StringComparison]::Ordinal)) {
		Copy-Item -LiteralPath $script:FixtureLauncher -Destination $Destination
		return
	}
	throw "Unexpected test download: $Uri"
}

function Set-TestInstallEnvironment {
	param([Parameter(Mandatory = $true)][string]$Name)
	$env:SPOTUIFY_INSTALL_DIR = Join-Path $testRoot $Name
	$env:SPOTUIFY_NO_MODIFY_PATH = '1'
	Remove-Item Env:\SPOTUIFY_VERSION -ErrorAction SilentlyContinue
}

$testFailure = $null
$cleanupFailure = $null
try {
	New-Item -ItemType Directory -Path $testRoot | Out-Null

	Invoke-Test 'installs and verifies the latest release' {
		$fixture = New-ReleaseFixture -Name 'latest'
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'latest-install'
		Install-Spotuify

		$binDirectory = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin'
		Assert-Equal ((& (Join-Path $binDirectory 'spotuify.exe') --version).Trim()) 'spotuify 9.8.7' 'spotuify version'
		$releaseDirectory = Join-Path $env:SPOTUIFY_INSTALL_DIR 'releases\9.8.7-windows-x64'
		Assert-Equal ((& (Join-Path $releaseDirectory 'spotuify-engine.exe') --version).Trim()) 'spotuify-engine 9.8.7' 'engine version'
		$marker = Get-Content -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR '.spotuify-install.json') -Raw | ConvertFrom-Json
		Assert-Equal $marker.manager 'spotuify-installer' 'installer marker manager'
		Assert-Equal (Get-Content -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR 'current') -Raw).Trim() '9.8.7-windows-x64' 'current release pointer'
		Assert-True ($script:DownloadUrls[0] -match '/releases/latest/download/SHA256SUMS$') 'latest release URL'
		Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR 'releases') -Filter '.staging-*').Count 0 'staging cleanup'
	}

	Invoke-Test 'supports a pinned stable version' {
		$fixture = New-ReleaseFixture -Name 'pinned' -Version '1.2.3'
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'pinned-install'
		$env:SPOTUIFY_VERSION = 'v1.2.3'
		Install-Spotuify
		Assert-True ($script:DownloadUrls[0] -match '/releases/download/v1\.2\.3/SHA256SUMS$') 'pinned release URL'
	}

	Invoke-Test 'refreshes an existing managed launcher' {
		$firstFixture = New-ReleaseFixture -Name 'launcher-first' -Version '1.0.0'
		Use-ReleaseFixture $firstFixture
		Set-TestInstallEnvironment 'launcher-refresh-install'
		Install-Spotuify
		$installedLauncher = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin\spotuify.exe'
		$firstDigest = Get-Sha256Digest -Path $installedLauncher

		$secondFixture = New-ReleaseFixture -Name 'launcher-second' -Version '2.0.0'
		Use-ReleaseFixture $secondFixture
		Install-Spotuify
		$secondDigest = Get-Sha256Digest -Path $installedLauncher
		$expectedDigest = Get-Sha256Digest -Path $secondFixture.Launcher
		Assert-True ($firstDigest -cne $secondDigest) 'launcher changed between releases'
		Assert-Equal $secondDigest $expectedDigest 'installed launcher digest'
		Assert-Equal ((& $installedLauncher --version).Trim()) 'spotuify 2.0.0' 'refreshed launcher behavior'
	}

	Invoke-Test 'repairs an installer-owned empty bin directory' {
		$fixture = New-ReleaseFixture -Name 'launcher-repair' -Version '3.0.0'
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'launcher-repair-install'
		New-Item -ItemType Directory -Path (Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin') -Force | Out-Null
		[IO.File]::WriteAllText(
			(Join-Path $env:SPOTUIFY_INSTALL_DIR '.spotuify-install.json'),
			'{"schema":1,"manager":"spotuify-installer","target":"windows-x64"}'
		)
		Install-Spotuify
		$installedLauncher = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin\spotuify.exe'
		Assert-Equal ((& $installedLauncher --version).Trim()) 'spotuify 3.0.0' 'repaired launcher behavior'
	}

	Invoke-Test 'cleans a failed fresh installation so it can be retried' {
		$fixture = New-ReleaseFixture -Name 'fresh-retry' -Version '4.0.0'
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'fresh-retry-install'
		function Write-InstallerMarker {
			param([string]$InstallDirectory)
			throw 'simulated marker write failure'
		}
		try {
			Assert-Throws { Install-Spotuify } 'simulated marker write failure'
		} finally {
			Set-Item Function:\Write-InstallerMarker -Value $originalMarkerFunction
		}
		Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR 'releases'))) 'failed release cleanup'
		Install-Spotuify
		$installedLauncher = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin\spotuify.exe'
		Assert-Equal ((& $installedLauncher --version).Trim()) 'spotuify 4.0.0' 'retry behavior'
	}

	Invoke-Test 'recomputes installation ownership after acquiring the lock' {
		$fixture = New-ReleaseFixture -Name 'ownership-race' -Version '5.0.0'
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'ownership-race-install'
		$script:MarkerDuringDownload = $env:SPOTUIFY_INSTALL_DIR
		function Write-InstallerMarker {
			param([string]$InstallDirectory)
			throw 'simulated post-lock marker failure'
		}
		try {
			Assert-Throws { Install-Spotuify } 'simulated post-lock marker failure'
		} finally {
			Set-Item Function:\Write-InstallerMarker -Value $originalMarkerFunction
			$script:MarkerDuringDownload = $null
		}
		$marker = Get-Content -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR '.spotuify-install.json') -Raw | ConvertFrom-Json
		Assert-Equal $marker.manager 'spotuify-installer' 'concurrent installer marker preservation'
	}

	Invoke-Test 'rejects relative install directories' {
		$env:SPOTUIFY_INSTALL_DIR = 'relative\spotuify'
		Assert-Throws { $null = Get-SpotuifyInstallDirectory } 'must be an absolute path'
	}

	Invoke-Test 'rejects install directories that would corrupt Windows PATH' {
		$env:SPOTUIFY_INSTALL_DIR = 'C:\Spotuify;Injected'
		Assert-Throws { $null = Get-SpotuifyInstallDirectory } 'cannot contain a semicolon'
	}

	Invoke-Test 'rejects Windows ARM64 until a native release exists' {
		$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
		$originalArchitectureW6432 = $env:PROCESSOR_ARCHITEW6432
		try {
			$env:PROCESSOR_ARCHITECTURE = 'ARM64'
			$env:PROCESSOR_ARCHITEW6432 = 'ARM64'
			Assert-Throws { Assert-SupportedWindows } 'x64 Windows only'
		} finally {
			$env:PROCESSOR_ARCHITECTURE = $originalArchitecture
			$env:PROCESSOR_ARCHITEW6432 = $originalArchitectureW6432
		}
	}

	Invoke-Test 'rejects a checksum mismatch before installing files' {
		$fixture = New-ReleaseFixture -Name 'checksum' -WrongChecksum
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'checksum-install'
		Assert-Throws { Install-Spotuify } 'Checksum verification failed'
		Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin'))) 'no bin directory after checksum failure'
	}

	Invoke-Test 'rejects an unexpected ZIP entry' {
		$fixture = New-ReleaseFixture -Name 'archive-layout' -ExtraEntry
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'archive-layout-install'
		Assert-Throws { Install-Spotuify } 'unexpected layout'
		Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin'))) 'no bin directory after archive failure'
	}

	Invoke-Test 'refuses to overwrite an unmanaged bin directory' {
		$fixture = New-ReleaseFixture -Name 'unmanaged'
		Use-ReleaseFixture $fixture
		Set-TestInstallEnvironment 'unmanaged-install'
		$binDirectory = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin'
		New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
		[IO.File]::WriteAllText((Join-Path $binDirectory 'spotuify.exe'), 'keep me')
		Assert-Throws { Install-Spotuify } 'not marked|not managed|contains files'
		Assert-Equal ([IO.File]::ReadAllText((Join-Path $binDirectory 'spotuify.exe'))) 'keep me' 'unmanaged file preservation'
	}

	Invoke-Test 'restores the previous installation when verification fails after the swap' {
		$firstFixture = New-ReleaseFixture -Name 'rollback-first' -Version '1.0.0'
		Use-ReleaseFixture $firstFixture
		Set-TestInstallEnvironment 'rollback-install'
		Install-Spotuify

		$secondFixture = New-ReleaseFixture -Name 'rollback-second' -Version '2.0.0'
		Use-ReleaseFixture $secondFixture
		$script:BinaryTestCalls = 0
		$script:OriginalBinaryTestForRollback = $originalBinaryTestFunction
		function Test-SpotuifyBinaries {
			param([string]$Directory, [string]$Version)
			$script:BinaryTestCalls += 1
			& $script:OriginalBinaryTestForRollback -Directory $Directory -Version $Version
			if ($script:BinaryTestCalls -eq 3) {
				throw 'simulated post-swap verification failure'
			}
		}
		try {
			Assert-Throws { Install-Spotuify } 'simulated post-swap verification failure'
		} finally {
			Set-Item Function:\Test-SpotuifyBinaries -Value $originalBinaryTestFunction
		}
		$installed = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin\spotuify.exe'
		Assert-Equal ((& $installed --version).Trim()) 'spotuify 1.0.0' 'rolled-back version'
	}

	Invoke-Test 'updates without replacing a running Windows payload executable' {
		$firstFixture = New-ReleaseFixture -Name 'running-first' -Version '1.0.0'
		Use-ReleaseFixture $firstFixture
		Set-TestInstallEnvironment 'running-install'
		Install-Spotuify
		$launcher = Join-Path $env:SPOTUIFY_INSTALL_DIR 'bin\spotuify.exe'
		$running = Start-Process -FilePath $launcher -ArgumentList '--hold' -PassThru
		try {
			Start-Sleep -Milliseconds 500
			Assert-True (-not $running.HasExited) 'old payload is running'
			$secondFixture = New-ReleaseFixture -Name 'running-second' -Version '2.0.0'
			Use-ReleaseFixture $secondFixture
			Install-Spotuify
			Assert-True (-not $running.HasExited) 'old payload remains running through update'
			Assert-Equal ((& $launcher --version).Trim()) 'spotuify 2.0.0' 'new commands use updated payload'
		} finally {
			if (-not $running.HasExited) {
				& taskkill.exe /PID $running.Id /T /F 2>$null | Out-Null
			}
		}
	}

	Invoke-Test 'uses a bounded exclusive installer lock' {
		$lockRoot = Join-Path $testRoot 'lock'
		New-Item -ItemType Directory -Path $lockRoot | Out-Null
		$lockPath = Join-Path $lockRoot '.install.lock'
		New-Item -ItemType Directory -Path $lockPath | Out-Null
		[IO.File]::WriteAllText((Join-Path $lockPath 'owner'), "$PID`ntest-lock`n")
		try {
			Assert-Throws { $null = Enter-InstallerLock -LockPath $lockPath -TimeoutSeconds 0.01 } 'already running'
		} finally {
			Remove-Item -LiteralPath $lockPath -Recurse -Force
		}
	}

	Invoke-Test 'reclaims a stale installer lock through an exclusive claim' {
		$lockRoot = Join-Path $testRoot 'stale-lock'
		New-Item -ItemType Directory -Path $lockRoot | Out-Null
		$lockPath = Join-Path $lockRoot '.install.lock'
		New-Item -ItemType Directory -Path $lockPath | Out-Null
		[IO.File]::WriteAllText((Join-Path $lockPath 'owner'), "2147483647`nstale-owner`n")
		$token = Enter-InstallerLock -LockPath $lockPath -TimeoutSeconds 1
		try {
			$owner = Get-Content -LiteralPath (Join-Path $lockPath 'owner')
			Assert-Equal $owner[1] $token 'replacement lock token'
		} finally {
			Exit-InstallerLock -LockPath $lockPath -Token $token
		}
		Assert-True (-not (Test-Path -LiteralPath $lockPath)) 'lock cleanup'
	}

	Invoke-Test 'deduplicates the user PATH case-insensitively' {
		$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		$originalProcessPath = $env:Path
		$binDirectory = 'C:\Users\runner\AppData\Local\Programs\Spotuify\bin'
		try {
			[Environment]::SetEnvironmentVariable('Path', "C:\Tools;$binDirectory;$($binDirectory.ToUpperInvariant())\", 'User')
			$env:Path = 'C:\Windows\System32'
			Remove-Item Env:\SPOTUIFY_NO_MODIFY_PATH -ErrorAction SilentlyContinue
			$action = Add-SpotuifyToPath -BinDirectory $binDirectory
			Assert-Equal $action 'already' 'PATH action'
			$updated = [Environment]::GetEnvironmentVariable('Path', 'User')
			Assert-Equal ([regex]::Matches($updated, [regex]::Escape($binDirectory), [Text.RegularExpressions.RegexOptions]::IgnoreCase).Count) 1 'PATH occurrence count'
			Assert-True ($env:Path.StartsWith("$binDirectory;", [StringComparison]::OrdinalIgnoreCase)) 'current process PATH update'
		} finally {
			[Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
			$env:Path = $originalProcessPath
		}
	}

	Write-Host 'All Spotuify Windows installer tests passed.'
} catch {
	$testFailure = $_
} finally {
	try {
		Set-Item Function:\Invoke-InstallerDownload -Value $originalDownloadFunction
		Set-Item Function:\Test-SpotuifyBinaries -Value $originalBinaryTestFunction
		Set-Item Function:\Write-InstallerMarker -Value $originalMarkerFunction
		foreach ($name in $environmentNames) {
			[Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
		}
	} catch {
		$cleanupFailure = $_
	}
	if (Test-Path -LiteralPath $testRoot) {
		try {
			Remove-Item -LiteralPath $testRoot -Recurse -Force
		} catch {
			if ($null -eq $cleanupFailure) {
				$cleanupFailure = $_
			} else {
				Write-Warning "Additional test cleanup failure: $($_.Exception.Message)"
			}
		}
	}
}

if ($null -ne $testFailure) {
	if ($null -ne $cleanupFailure) {
		Write-Warning "Test cleanup also failed: $($cleanupFailure.Exception.Message)"
	}
	throw $testFailure
}
if ($null -ne $cleanupFailure) {
	throw $cleanupFailure
}
