#Requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Repository = 'austin-smith/spotuify'
$script:ReleasesUrl = "https://github.com/$($script:Repository)/releases"
$script:InstallerMarkerName = '.spotuify-install.json'
$script:InstallerManager = 'spotuify-installer'
# Windows PowerShell 5.1 coerces bare $null to an empty string when binding File.Replace.
$script:NullBackupPath = [System.Management.Automation.Language.NullString]::Value

function Write-InstallerStep {
	param([Parameter(Mandatory = $true)][string]$Message)
	Write-Host "==> $Message"
}

function Get-RequestedVersion {
	$requested = if ([string]::IsNullOrWhiteSpace($env:SPOTUIFY_VERSION)) {
		'latest'
	} else {
		$env:SPOTUIFY_VERSION.Trim()
	}

	if ($requested -eq 'latest') {
		return 'latest'
	}

	if ($requested -match '^v(?<version>[0-9]+\.[0-9]+\.[0-9]+)$') {
		return $Matches.version
	}

	if ($requested -match '^[0-9]+\.[0-9]+\.[0-9]+$') {
		return $requested
	}

	throw 'SPOTUIFY_VERSION must be latest or a stable version such as 1.2.3.'
}

function Get-SpotuifyInstallDirectory {
	$directory = if ([string]::IsNullOrWhiteSpace($env:SPOTUIFY_INSTALL_DIR)) {
		$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
		if ([string]::IsNullOrWhiteSpace($localAppData)) {
			throw 'LOCALAPPDATA is required unless SPOTUIFY_INSTALL_DIR is set.'
		}
		[IO.Path]::Combine($localAppData, 'Programs', 'Spotuify')
	} else {
		$env:SPOTUIFY_INSTALL_DIR.Trim()
	}

	if ($directory.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) {
		throw 'SPOTUIFY_INSTALL_DIR cannot contain a newline or null character.'
	}
	if ($directory.Contains(';')) {
		throw 'SPOTUIFY_INSTALL_DIR cannot contain a semicolon because Windows PATH uses it as a separator.'
	}
	if (-not [IO.Path]::IsPathRooted($directory) -or $directory -notmatch '^[a-zA-Z]:[\\/]') {
		throw 'SPOTUIFY_INSTALL_DIR must be an absolute path.'
	}
	if ($directory.StartsWith('\\')) {
		throw 'SPOTUIFY_INSTALL_DIR must be on a local drive, not a network path.'
	}

	$fullPath = [IO.Path]::GetFullPath($directory).TrimEnd('\', '/')
	$pathRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
	if ([string]::Equals($fullPath, $pathRoot, [StringComparison]::OrdinalIgnoreCase)) {
		throw 'SPOTUIFY_INSTALL_DIR cannot be a drive root.'
	}

	return $fullPath
}

function Assert-SupportedWindows {
	if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
		throw 'This installer supports 64-bit Windows. Use install.sh on macOS or Linux.'
	}
	if (-not [Environment]::Is64BitOperatingSystem) {
		throw 'Spotuify requires 64-bit Windows.'
	}

	$architecture = if (-not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
		$env:PROCESSOR_ARCHITEW6432
	} else {
		$env:PROCESSOR_ARCHITECTURE
	}
	if ($architecture -ne 'AMD64') {
		throw "Spotuify currently supports x64 Windows only; detected $architecture."
	}
}

function Invoke-InstallerDownload {
	param(
		[Parameter(Mandatory = $true)][uri]$Uri,
		[Parameter(Mandatory = $true)][string]$Destination
	)

	Invoke-WebRequest `
		-Uri $Uri `
		-OutFile $Destination `
		-UseBasicParsing `
		-TimeoutSec 300 `
		-MaximumRedirection 10 `
		-Headers @{ 'User-Agent' = 'Spotuify-Installer' }
}

function Resolve-ReleaseAsset {
	param(
		[Parameter(Mandatory = $true)][string]$ManifestPath,
		[Parameter(Mandatory = $true)][string]$RequestedVersion
	)

	$assetPattern = '^spotuify-v(?<version>[0-9]+\.[0-9]+\.[0-9]+)-windows-x64\.zip$'
	$candidates = New-Object System.Collections.Generic.List[object]
	foreach ($line in [IO.File]::ReadAllLines($ManifestPath)) {
		$manifestMatch = [regex]::Match($line, '^(?<digest>[0-9a-fA-F]{64})\s{2}(?<asset>\S+)$')
		if (-not $manifestMatch.Success) {
			continue
		}
		$asset = $manifestMatch.Groups['asset'].Value
		$assetMatch = [regex]::Match($asset, $assetPattern)
		if (-not $assetMatch.Success) {
			continue
		}

		$candidates.Add([pscustomobject]@{
			Asset = $asset
			Digest = $manifestMatch.Groups['digest'].Value.ToLowerInvariant()
			Version = $assetMatch.Groups['version'].Value
		})
	}

	if ($candidates.Count -ne 1) {
		throw 'The release does not contain exactly one windows-x64 ZIP in SHA256SUMS.'
	}

	$candidate = $candidates[0]
	if ($RequestedVersion -ne 'latest' -and $candidate.Version -ne $RequestedVersion) {
		throw "Release metadata resolved $($candidate.Version) instead of requested version $RequestedVersion."
	}

	return $candidate
}

function Resolve-LauncherAsset {
	param(
		[Parameter(Mandatory = $true)][string]$ManifestPath,
		[Parameter(Mandatory = $true)][string]$Version
	)

	$name = "spotuify-v$Version-windows-x64-standalone-launcher.exe"
	$matches = New-Object System.Collections.Generic.List[object]
	foreach ($line in [IO.File]::ReadAllLines($ManifestPath)) {
		$manifestMatch = [regex]::Match($line, '^(?<digest>[0-9a-fA-F]{64})\s{2}(?<asset>\S+)$')
		if ($manifestMatch.Success -and $manifestMatch.Groups['asset'].Value -ceq $name) {
			$matches.Add([pscustomobject]@{
				Asset = $name
				Digest = $manifestMatch.Groups['digest'].Value.ToLowerInvariant()
			})
		}
	}
	if ($matches.Count -ne 1) {
		throw 'The release does not contain exactly one verified Windows launcher.'
	}
	return $matches[0]
}

function Expand-VerifiedSpotuifyArchive {
	param(
		[Parameter(Mandatory = $true)][string]$ArchivePath,
		[Parameter(Mandatory = $true)][string]$AssetName,
		[Parameter(Mandatory = $true)][string]$Destination
	)

	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$releaseName = $AssetName.Substring(0, $AssetName.Length - '.zip'.Length)
	$expectedNames = @(
		"$releaseName/",
		"$releaseName/spotuify.exe",
		"$releaseName/spotuify-engine.exe"
	)
	$archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
	try {
		$entries = @($archive.Entries)
		if ($entries.Count -ne $expectedNames.Count) {
			throw 'The release ZIP has an unexpected layout.'
		}

		foreach ($expectedName in $expectedNames) {
			$matchingEntries = @($entries | Where-Object { $_.FullName -ceq $expectedName })
			if ($matchingEntries.Count -ne 1) {
				throw 'The release ZIP has an unexpected layout.'
			}
		}

		$directoryEntry = $entries | Where-Object { $_.FullName -ceq "$releaseName/" }
		if ($directoryEntry.Name -ne '' -or $directoryEntry.Length -ne 0) {
			throw 'The release ZIP contains an invalid root entry.'
		}

		New-Item -ItemType Directory -Path $Destination | Out-Null
		foreach ($fileName in @('spotuify.exe', 'spotuify-engine.exe')) {
			$entry = $entries | Where-Object { $_.FullName -ceq "$releaseName/$fileName" }
			if ($entry.Length -le 0) {
				throw "The release ZIP contains an empty $fileName."
			}
			if ($entry.Length -gt 268435456) {
				throw "The release ZIP contains an unexpectedly large $fileName."
			}

			$unixFileType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
			if ($unixFileType -eq 0xA000) {
				throw 'The release ZIP contains a symbolic link.'
			}

			$inputStream = $entry.Open()
			$outputPath = Join-Path $Destination $fileName
			$outputStream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
			try {
				$inputStream.CopyTo($outputStream)
			} finally {
				$outputStream.Dispose()
				$inputStream.Dispose()
			}
		}
	} finally {
		$archive.Dispose()
	}
}

function Test-SpotuifyBinaries {
	param(
		[Parameter(Mandatory = $true)][string]$Directory,
		[Parameter(Mandatory = $true)][string]$Version
	)

	$expectations = @{
		'spotuify.exe' = "spotuify $Version"
		'spotuify-engine.exe' = "spotuify-engine $Version"
	}
	foreach ($fileName in $expectations.Keys) {
		$path = Join-Path $Directory $fileName
		if (-not [IO.File]::Exists($path)) {
			throw "The release is missing $fileName."
		}
		$item = Get-Item -LiteralPath $path -Force
		if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
			throw "$path is not a regular release executable."
		}

		$output = @(& $path --version 2>&1)
		if ($LASTEXITCODE -ne 0 -or (($output -join "`n").Trim()) -cne $expectations[$fileName]) {
			throw "$fileName did not report version $Version."
		}
	}
}

function Get-InstallerLockOwner {
	param([AllowNull()][string]$Contents)
	if ([string]::IsNullOrEmpty($Contents)) { return $null }
	$lines = $Contents -split "`n"
	if ($lines.Count -lt 2 -or $lines[0] -notmatch '^[1-9][0-9]*$' -or [string]::IsNullOrEmpty($lines[1])) {
		return $null
	}
	$ownerPid = 0
	if (-not [int]::TryParse($lines[0], [ref]$ownerPid)) { return $null }
	return [pscustomobject]@{ Pid = $ownerPid; Token = $lines[1] }
}

function Test-InstallerProcessAlive {
	param([Parameter(Mandatory = $true)][int]$ProcessId)
	return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Enter-InstallerLock {
	param(
		[Parameter(Mandatory = $true)][string]$LockPath,
		[double]$TimeoutSeconds = 15
	)

	$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
	$token = "$PID-$([guid]::NewGuid().ToString('N'))"
	$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
	do {
		$created = $false
		try {
			New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop | Out-Null
			$created = $true
		} catch {}
		if ($created) {
			try {
				[IO.File]::WriteAllText((Join-Path $LockPath 'owner'), "$PID`n$token`n", $utf8WithoutBom)
				return $token
			} catch {
				Remove-Item -LiteralPath $LockPath -Recurse -Force -ErrorAction SilentlyContinue
				throw
			}
		}

		try {
			$lockItem = Get-Item -LiteralPath $LockPath -Force -ErrorAction Stop
		} catch {
			throw "Could not inspect the installer lock at $LockPath."
		}
		if (-not $lockItem.PSIsContainer -or
			(($lockItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
			throw "$LockPath is not a regular installer lock directory."
		}
		$ownerPath = Join-Path $LockPath 'owner'
		$ownerItem = Get-Item -LiteralPath $ownerPath -Force -ErrorAction SilentlyContinue
		if ($null -ne $ownerItem -and ($ownerItem.PSIsContainer -or
			(($ownerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0))) {
			throw "$ownerPath is not a regular installer lock owner file."
		}
		$observedContents = if ($null -eq $ownerItem) { $null } else {
			try { [IO.File]::ReadAllText($ownerPath) } catch { $null }
		}
		$observed = Get-InstallerLockOwner -Contents $observedContents
		if ($null -ne $observed -and -not (Test-InstallerProcessAlive -ProcessId $observed.Pid)) {
			$reclaimPath = Join-Path $LockPath 'reclaim'
			$claimCreated = $false
			try {
				New-Item -ItemType Directory -Path $reclaimPath -ErrorAction Stop | Out-Null
				$claimCreated = $true
				[IO.File]::WriteAllText((Join-Path $reclaimPath 'owner'), "$token`n", $utf8WithoutBom)
			} catch {
				if ($claimCreated) {
					Remove-Item -LiteralPath $reclaimPath -Recurse -Force -ErrorAction SilentlyContinue
					$claimCreated = $false
				}
			}

			if ($claimCreated) {
				$confirmedContents = try { [IO.File]::ReadAllText($ownerPath) } catch { $null }
				$confirmed = Get-InstallerLockOwner -Contents $confirmedContents
				$claimOwner = try { [IO.File]::ReadAllText((Join-Path $reclaimPath 'owner')) } catch { $null }
				if ($confirmedContents -ceq $observedContents -and $null -ne $confirmed -and
					$claimOwner -ceq "$token`n" -and
					-not (Test-InstallerProcessAlive -ProcessId $confirmed.Pid)) {
					Remove-Item -LiteralPath $LockPath -Recurse -Force -ErrorAction Stop
					continue
				}
				if ($claimOwner -ceq "$token`n") {
					Remove-Item -LiteralPath $reclaimPath -Recurse -Force -ErrorAction SilentlyContinue
				}
			}
		}

		if ([DateTime]::UtcNow -ge $deadline) {
			throw 'Another Spotuify installation is already running.'
		}
		Start-Sleep -Milliseconds 200
	} while ($true)
}

function Assert-SafeInstallRoot {
	param([Parameter(Mandatory = $true)][string]$InstallDirectory)

	if (-not (Test-Path -LiteralPath $InstallDirectory)) {
		return
	}
	$item = Get-Item -LiteralPath $InstallDirectory -Force
	if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
		throw "$InstallDirectory exists and is not a regular local directory."
	}
}

function Assert-ManagedInstallation {
	param([Parameter(Mandatory = $true)][string]$InstallDirectory)
	if (-not (Test-Path -LiteralPath $InstallDirectory)) { return }
	Assert-SafeInstallRoot -InstallDirectory $InstallDirectory
	$markerPath = Join-Path $InstallDirectory $script:InstallerMarkerName
	$managedPaths = @('bin', 'current', 'releases') | ForEach-Object { Join-Path $InstallDirectory $_ }
	if (-not (Test-Path -LiteralPath $markerPath)) {
		if (@($managedPaths | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) {
			throw "$InstallDirectory is not marked as a Spotuify installer-managed installation."
		}
		return
	}
	$markerItem = Get-Item -LiteralPath $markerPath -Force
	if ($markerItem.PSIsContainer -or (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
		throw "$markerPath is not a regular installer marker."
	}
	try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch {
		throw "$markerPath is not a valid installer marker."
	}
	if ($marker.schema -ne 1 -or $marker.manager -cne $script:InstallerManager -or $marker.target -cne 'windows-x64') {
		throw "$markerPath is not a valid installer marker."
	}
	$binDirectory = Join-Path $InstallDirectory 'bin'
	$releasesDirectory = Join-Path $InstallDirectory 'releases'
	foreach ($directory in @($binDirectory, $releasesDirectory)) {
		if (-not (Test-Path -LiteralPath $directory)) { continue }
		$item = Get-Item -LiteralPath $directory -Force
		if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
			throw "$directory is not a regular installer-managed directory."
		}
	}
	if (Test-Path -LiteralPath $binDirectory) {
		$item = Get-Item -LiteralPath $binDirectory -Force
		$actualNames = @(Get-ChildItem -LiteralPath $binDirectory -Force | ForEach-Object Name)
		$unexpectedNames = @($actualNames | Where-Object {
			$_ -cne 'spotuify.exe' -and $_ -cne 'spotuify.pending.exe'
		})
		if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
			$unexpectedNames.Count -ne 0) {
			throw "$binDirectory contains files not managed by this installer."
		}
		foreach ($launcherName in $actualNames) {
			$launcherItem = Get-Item -LiteralPath (Join-Path $binDirectory $launcherName) -Force
			if ($launcherItem.PSIsContainer -or
				(($launcherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
				throw "$binDirectory contains files not managed by this installer."
			}
		}
	}
	$currentPath = Join-Path $InstallDirectory 'current'
	if (Test-Path -LiteralPath $currentPath) {
		$currentItem = Get-Item -LiteralPath $currentPath -Force
		$currentRelease = (Get-Content -LiteralPath $currentPath -Raw).Trim()
		if ($currentItem.PSIsContainer -or (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
			$currentRelease -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-windows-x64$') {
			throw "$currentPath is not a valid active release pointer."
		}
	}
}

function Write-InstallerMarker {
	param([Parameter(Mandatory = $true)][string]$InstallDirectory)
	$marker = [ordered]@{ schema = 1; manager = $script:InstallerManager; target = 'windows-x64' } | ConvertTo-Json -Compress
	$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
	$markerPath = Join-Path $InstallDirectory $script:InstallerMarkerName
	$temporary = "$markerPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
	[IO.File]::WriteAllText($temporary, $marker + "`n", $utf8WithoutBom)
	if (Test-Path -LiteralPath $markerPath) {
		[IO.File]::Replace($temporary, $markerPath, $script:NullBackupPath)
	} else {
		Move-Item -LiteralPath $temporary -Destination $markerPath
	}
}

function Exit-InstallerLock {
	param([string]$LockPath, [string]$Token)
	try {
		$lockItem = Get-Item -LiteralPath $LockPath -Force -ErrorAction Stop
		$ownerItem = Get-Item -LiteralPath (Join-Path $LockPath 'owner') -Force -ErrorAction Stop
		if (-not $lockItem.PSIsContainer -or
			(($lockItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
			$ownerItem.PSIsContainer -or
			(($ownerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
			return
		}
		$owner = [IO.File]::ReadAllLines((Join-Path $LockPath 'owner'))
		if ($owner.Count -gt 1 -and $owner[1] -ceq $Token) {
			Remove-Item -LiteralPath $LockPath -Recurse -Force
		}
	} catch {}
}

function Test-TruthyEnvironmentValue {
	param([AllowNull()][string]$Value)
	return $Value -match '^(?i:1|true|yes)$'
}

function Add-SpotuifyToPath {
	param([Parameter(Mandatory = $true)][string]$BinDirectory)

	if (Test-TruthyEnvironmentValue $env:SPOTUIFY_NO_MODIFY_PATH) {
		return 'skipped'
	}

	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	$entries = if ([string]::IsNullOrWhiteSpace($userPath)) { @() } else { @($userPath.Split(';')) }
	$updatedEntries = New-Object System.Collections.Generic.List[string]
	$updatedEntries.Add($BinDirectory)
	$found = $false
	foreach ($entry in $entries) {
		if ([string]::IsNullOrWhiteSpace($entry)) {
			continue
		}
		$normalized = $entry.Trim().Trim('"').TrimEnd('\', '/')
		if ([string]::Equals($normalized, $BinDirectory.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
			$found = $true
		} else {
			$updatedEntries.Add($entry)
		}
	}

	$updatedUserPath = $updatedEntries -join ';'
	if ($updatedUserPath -cne $userPath) {
		[Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
	}

	$processEntries = if ([string]::IsNullOrWhiteSpace($env:Path)) { @() } else { @($env:Path.Split(';')) }
	$updatedProcessEntries = New-Object System.Collections.Generic.List[string]
	$updatedProcessEntries.Add($BinDirectory)
	foreach ($entry in $processEntries) {
		$normalized = $entry.Trim().Trim('"').TrimEnd('\', '/')
		if (-not [string]::IsNullOrWhiteSpace($entry) -and
			-not [string]::Equals($normalized, $BinDirectory.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
			$updatedProcessEntries.Add($entry)
		}
	}
	$env:Path = $updatedProcessEntries -join ';'

	return $(if ($found) { 'already' } else { 'added' })
}

function Install-Spotuify {
	Assert-SupportedWindows
	$requestedVersion = Get-RequestedVersion
	$installDirectory = Get-SpotuifyInstallDirectory
	$binDirectory = Join-Path $installDirectory 'bin'
	$releasesDirectory = Join-Path $installDirectory 'releases'
	$currentPath = Join-Path $installDirectory 'current'
	$lockPath = Join-Path $installDirectory '.install.lock'
	$markerPath = Join-Path $installDirectory $script:InstallerMarkerName
	$freshInstallation = -not (Test-Path -LiteralPath $markerPath)
	$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("spotuify-install-$([guid]::NewGuid().ToString('N'))")
	$stageDirectory = $null
	$releaseDirectory = $null
	$releaseCreated = $false
	$markerCreated = $false
	$lockToken = $null
	$currentBackup = $null
	$currentCreated = $false
	$launcherBackup = $null
	$launcherCreated = $false
	$launcherPendingCreated = $false
	$launcherDestination = Join-Path $binDirectory 'spotuify.exe'
	$pendingLauncher = Join-Path $binDirectory 'spotuify.pending.exe'
	$launcherTemporary = $null
	$installCompleted = $false
	$previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol

	try {
		[Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
		New-Item -ItemType Directory -Path $tempDirectory | Out-Null
		$manifestPath = Join-Path $tempDirectory 'SHA256SUMS'
		$releaseDownloadUrl = if ($requestedVersion -eq 'latest') {
			"$($script:ReleasesUrl)/latest/download"
		} else {
			"$($script:ReleasesUrl)/download/v$requestedVersion"
		}

		Write-InstallerStep 'Resolving Spotuify release for windows-x64'
		Invoke-InstallerDownload -Uri "$releaseDownloadUrl/SHA256SUMS" -Destination $manifestPath
		$release = Resolve-ReleaseAsset -ManifestPath $manifestPath -RequestedVersion $requestedVersion
		$launcher = Resolve-LauncherAsset -ManifestPath $manifestPath -Version $release.Version
		$archivePath = Join-Path $tempDirectory $release.Asset
		$launcherPath = Join-Path $tempDirectory $launcher.Asset

		Write-InstallerStep "Downloading Spotuify $($release.Version)"
		Invoke-InstallerDownload -Uri "$releaseDownloadUrl/$($release.Asset)" -Destination $archivePath
		$actualDigest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($actualDigest -cne $release.Digest) {
			throw "Checksum verification failed for $($release.Asset)."
		}
		Invoke-InstallerDownload -Uri "$releaseDownloadUrl/$($launcher.Asset)" -Destination $launcherPath
		$launcherDigest = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($launcherDigest -cne $launcher.Digest) {
			throw "Checksum verification failed for $($launcher.Asset)."
		}

		$payloadDirectory = Join-Path $tempDirectory 'payload'
		Expand-VerifiedSpotuifyArchive -ArchivePath $archivePath -AssetName $release.Asset -Destination $payloadDirectory
		Test-SpotuifyBinaries -Directory $payloadDirectory -Version $release.Version

		Assert-ManagedInstallation -InstallDirectory $installDirectory
		New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
		Assert-SafeInstallRoot -InstallDirectory $installDirectory
		$lockToken = Enter-InstallerLock -LockPath $lockPath
		Assert-ManagedInstallation -InstallDirectory $installDirectory
		$freshInstallation = -not (Test-Path -LiteralPath $markerPath)

		$existingCommand = Get-Command spotuify.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($null -ne $existingCommand -and
			-not [string]::Equals($existingCommand.Source, (Join-Path $binDirectory 'spotuify.exe'), [StringComparison]::OrdinalIgnoreCase)) {
			Write-Warning "Another Spotuify command exists at $($existingCommand.Source); PATH order determines which one runs."
		}

		New-Item -ItemType Directory -Path $releasesDirectory -Force | Out-Null
		$releaseName = "$($release.Version)-windows-x64"
		$releaseDirectory = Join-Path $releasesDirectory $releaseName
		if (Test-Path -LiteralPath $releaseDirectory) {
			$releaseItem = Get-Item -LiteralPath $releaseDirectory -Force
			if (-not $releaseItem.PSIsContainer -or
				(($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
				throw "$releaseDirectory is not a regular release directory."
			}
			Test-SpotuifyBinaries -Directory $releaseDirectory -Version $release.Version
		} else {
			$stageDirectory = Join-Path $releasesDirectory (".staging-$releaseName-$([guid]::NewGuid().ToString('N'))")
			New-Item -ItemType Directory -Path $stageDirectory | Out-Null
			Copy-Item -LiteralPath (Join-Path $payloadDirectory 'spotuify.exe') -Destination $stageDirectory
			Copy-Item -LiteralPath (Join-Path $payloadDirectory 'spotuify-engine.exe') -Destination $stageDirectory
			Copy-Item -LiteralPath $launcherPath -Destination (Join-Path $stageDirectory 'spotuify-launcher.exe')
			Test-SpotuifyBinaries -Directory $stageDirectory -Version $release.Version
			Move-Item -LiteralPath $stageDirectory -Destination $releaseDirectory
			$stageDirectory = $null
			$releaseCreated = $true
		}
		$releaseLauncher = Join-Path $releaseDirectory 'spotuify-launcher.exe'
		if (-not [IO.File]::Exists($releaseLauncher)) {
			throw 'The versioned Windows launcher is missing.'
		}
		$releaseLauncherItem = Get-Item -LiteralPath $releaseLauncher -Force
		$releaseLauncherDigest = (Get-FileHash -LiteralPath $releaseLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($releaseLauncherItem.PSIsContainer -or
			(($releaseLauncherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
			$releaseLauncherDigest -cne $launcher.Digest) {
			throw 'The versioned Windows launcher is invalid.'
		}

		Write-InstallerMarker -InstallDirectory $installDirectory
		if ($freshInstallation) { $markerCreated = $true }
		if (-not (Test-Path -LiteralPath $binDirectory)) {
			New-Item -ItemType Directory -Path $binDirectory | Out-Null
		}
		if (Test-Path -LiteralPath $pendingLauncher) {
			Remove-Item -LiteralPath $pendingLauncher -Force
		}
		$launcherTemporary = Join-Path $binDirectory (".spotuify-launcher-$PID-$([guid]::NewGuid().ToString('N')).tmp")
		Copy-Item -LiteralPath $launcherPath -Destination $launcherTemporary
		if (Test-Path -LiteralPath $launcherDestination) {
			$installedLauncherDigest = (Get-FileHash -LiteralPath $launcherDestination -Algorithm SHA256).Hash.ToLowerInvariant()
			if ($installedLauncherDigest -cne $launcher.Digest) {
				$launcherBackup = Join-Path $binDirectory (".spotuify-launcher-$PID-$([guid]::NewGuid().ToString('N')).backup")
				try {
					[IO.File]::Replace($launcherTemporary, $launcherDestination, $launcherBackup)
					$launcherTemporary = $null
				} catch [IO.IOException] {
					if (Test-Path -LiteralPath $launcherBackup) {
						if (Test-Path -LiteralPath $launcherDestination) {
							[IO.File]::Replace($launcherBackup, $launcherDestination, $script:NullBackupPath)
						} else {
							Move-Item -LiteralPath $launcherBackup -Destination $launcherDestination
						}
					}
					$launcherBackup = $null
					Move-Item -LiteralPath $launcherTemporary -Destination $pendingLauncher
					$launcherTemporary = $null
					$launcherPendingCreated = $true
					Write-Warning 'The running launcher is in use; its verified replacement was staged for the next launcher exit.'
				}
			} else {
				Remove-Item -LiteralPath $launcherTemporary -Force
				$launcherTemporary = $null
			}
		} else {
			Move-Item -LiteralPath $launcherTemporary -Destination $launcherDestination
			$launcherTemporary = $null
			$launcherCreated = $true
		}

		$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
		$currentTemporary = "$currentPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
		[IO.File]::WriteAllText($currentTemporary, "$releaseName`n", $utf8WithoutBom)
		if (Test-Path -LiteralPath $currentPath) {
			$currentBackup = "$currentPath.$PID.$([guid]::NewGuid().ToString('N')).backup"
			[IO.File]::Replace($currentTemporary, $currentPath, $currentBackup)
		} else {
			Move-Item -LiteralPath $currentTemporary -Destination $currentPath
			$currentCreated = $true
		}

		try {
			$mainVersion = @(& (Join-Path $binDirectory 'spotuify.exe') --version 2>&1)
			if ($LASTEXITCODE -ne 0 -or (($mainVersion -join "`n").Trim()) -cne "spotuify $($release.Version)") {
				throw 'The installed Spotuify launcher did not resolve the new version.'
			}
			Test-SpotuifyBinaries -Directory $releaseDirectory -Version $release.Version
			$installCompleted = $true
		} catch {
			if ($null -ne $currentBackup -and (Test-Path -LiteralPath $currentBackup)) {
				[IO.File]::Replace($currentBackup, $currentPath, $script:NullBackupPath)
				$currentBackup = $null
			} elseif ($currentCreated) {
				Remove-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
			}
			throw
		}
		if ($null -ne $currentBackup -and (Test-Path -LiteralPath $currentBackup)) {
			Remove-Item -LiteralPath $currentBackup -Force
			$currentBackup = $null
		}
		if ($null -ne $launcherBackup -and (Test-Path -LiteralPath $launcherBackup)) {
			Remove-Item -LiteralPath $launcherBackup -Force
			$launcherBackup = $null
		}

		try {
			$pathAction = Add-SpotuifyToPath -BinDirectory $binDirectory
		} catch {
			$pathAction = 'skipped'
			Write-Warning "Spotuify was installed, but the user PATH could not be updated: $($_.Exception.Message)"
		}

		Write-InstallerStep "Spotuify $($release.Version) installed successfully"
		if ($pathAction -eq 'added') {
			Write-InstallerStep 'PATH was added for your user. Open a new terminal, then run: spotuify auth'
		} elseif ($pathAction -eq 'already') {
			Write-InstallerStep 'Run: spotuify auth'
		} else {
			Write-InstallerStep "Add $binDirectory to PATH, then run: spotuify auth"
		}
	} finally {
		[Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
		if (-not $installCompleted) {
			if ($null -ne $currentBackup -and (Test-Path -LiteralPath $currentBackup)) {
				if (Test-Path -LiteralPath $currentPath) {
					[IO.File]::Replace($currentBackup, $currentPath, $script:NullBackupPath)
				} else {
					Move-Item -LiteralPath $currentBackup -Destination $currentPath
				}
				$currentBackup = $null
			} elseif ($currentCreated -and (Test-Path -LiteralPath $currentPath)) {
				Remove-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
			}
			if ($null -ne $launcherBackup -and (Test-Path -LiteralPath $launcherBackup)) {
				if (Test-Path -LiteralPath $launcherDestination) {
					[IO.File]::Replace($launcherBackup, $launcherDestination, $script:NullBackupPath)
				} else {
					Move-Item -LiteralPath $launcherBackup -Destination $launcherDestination
				}
				$launcherBackup = $null
			} elseif ($launcherCreated -and (Test-Path -LiteralPath $launcherDestination)) {
				Remove-Item -LiteralPath $launcherDestination -Force -ErrorAction SilentlyContinue
			}
			if ($launcherPendingCreated -and (Test-Path -LiteralPath $pendingLauncher)) {
				Remove-Item -LiteralPath $pendingLauncher -Force -ErrorAction SilentlyContinue
			}
			if ($freshInstallation -and $markerCreated -and (Test-Path -LiteralPath $markerPath)) {
				Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
			}
			if ($freshInstallation -and $releaseCreated -and $null -ne $releaseDirectory -and
				(Test-Path -LiteralPath $releaseDirectory)) {
				Remove-Item -LiteralPath $releaseDirectory -Recurse -Force -ErrorAction SilentlyContinue
			}
		}
		if ($null -ne $launcherTemporary -and (Test-Path -LiteralPath $launcherTemporary)) {
			Remove-Item -LiteralPath $launcherTemporary -Force -ErrorAction SilentlyContinue
		}
		if ($null -ne $lockToken) {
			Exit-InstallerLock -LockPath $lockPath -Token $lockToken
		}
		if (Test-Path -LiteralPath $tempDirectory) {
			Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
		}
		if ($null -ne $stageDirectory -and (Test-Path -LiteralPath $stageDirectory)) {
			Remove-Item -LiteralPath $stageDirectory -Recurse -Force -ErrorAction SilentlyContinue
		}
		if (-not $installCompleted -and $freshInstallation) {
			foreach ($directory in @($releasesDirectory, $binDirectory, $installDirectory)) {
				if ((Test-Path -LiteralPath $directory) -and
					@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
					Remove-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
				}
			}
		}
	}
}

if ($MyInvocation.InvocationName -ne '.') {
	try {
		Install-Spotuify
	} catch {
		throw "Spotuify installation failed: $($_.Exception.Message)"
	}
}
