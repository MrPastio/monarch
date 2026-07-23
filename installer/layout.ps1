Set-StrictMode -Version Latest

function Write-MonarchAtomicJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText(
      $temporary,
      $json,
      (New-Object System.Text.UTF8Encoding($false))
    )
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $backup = "$Path.previous"
      if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Force
      }
      [System.IO.File]::Replace($temporary, $Path, $backup, $true)
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } else {
      [System.IO.File]::Move($temporary, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Resolve-MonarchPayloadRoot {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)

  $installPath = [System.IO.Path]::GetFullPath($InstallRoot)
  $installDrive = [System.IO.Path]::GetPathRoot($installPath)
  $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
  if ($installDrive -and
      -not $installDrive.Equals($systemDrive, [StringComparison]::OrdinalIgnoreCase)) {
    return Join-Path $installDrive "MonarchData"
  }
  return Join-Path $env:LOCALAPPDATA "Monarch\payloads"
}

function Set-MonarchPrivateAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @(
    $identity,
    (New-Object System.Security.Principal.SecurityIdentifier(
      [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
      $null
    ))
  )) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  $directoryInfo = New-Object System.IO.DirectoryInfo($Path)
  $directoryInfo.SetAccessControl($acl)
}

function New-MonarchDirectoryJunction {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Target
  )

  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  if (Test-Path -LiteralPath $Path) {
    $existing = Get-Item -LiteralPath $Path -Force
    if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      return
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) {
      Move-Item -LiteralPath $child.FullName -Destination $Target -Force
    }
    Remove-Item -LiteralPath $Path -Force
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

function Copy-MonarchLegacySecretsForMigration {
  param(
    [Parameter(Mandatory = $true)][string]$LegacyRoot,
    [Parameter(Mandatory = $true)][string]$MigrationRoot
  )

  if (-not (Test-Path -LiteralPath $LegacyRoot -PathType Container)) {
    return $null
  }
  $files = @(Get-ChildItem -LiteralPath $LegacyRoot -File -Recurse -Force)
  if ($files.Count -eq 0) {
    return $null
  }

  $migrationId = "legacy-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"
  $destination = Join-Path $MigrationRoot $migrationId
  Set-MonarchPrivateAcl -Path $destination
  $legacyPath = [System.IO.Path]::GetFullPath($LegacyRoot).TrimEnd('\')
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($legacyPath.Length).TrimStart('\')
    $target = Join-Path $destination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
  return $destination
}

function Initialize-MonarchInstallLayout {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$VersionRoot,
    [Parameter(Mandatory = $true)][string]$AppVersion,
    [Parameter(Mandatory = $true)][string]$RuntimeVersion,
    [Parameter(Mandatory = $true)][string]$BackendEnvironment,
    [string]$PayloadRoot = ""
  )

  $install = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $version = [System.IO.Path]::GetFullPath($VersionRoot).TrimEnd('\')
  $versionsRoot = [System.IO.Path]::GetFullPath((Join-Path $install "versions")).TrimEnd('\')
  if (-not $version.StartsWith(
    $versionsRoot + '\',
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Version root must stay inside $versionsRoot."
  }

  $payload = if ($PayloadRoot) {
    [System.IO.Path]::GetFullPath($PayloadRoot).TrimEnd('\')
  } else {
    (Resolve-MonarchPayloadRoot -InstallRoot $install).TrimEnd('\')
  }
  $localState = Join-Path $env:LOCALAPPDATA "Monarch"
  $configRoot = Join-Path $env:APPDATA "Monarch"
  $runtimeRoot = Join-Path $payload "runtimes\runtime-$RuntimeVersion"
  $environmentRoot = Join-Path $payload "environments\$BackendEnvironment"
  $modelsRoot = Join-Path $payload "models"

  foreach ($directory in @(
    $install,
    $version,
    $payload,
    $runtimeRoot,
    $environmentRoot,
    $modelsRoot,
    (Join-Path $payload "generated"),
    (Join-Path $payload "downloads"),
    (Join-Path $payload "updates"),
    (Join-Path $payload "transactions"),
    (Join-Path $localState "data"),
    (Join-Path $localState "logs"),
    (Join-Path $configRoot "config"),
    (Join-Path $configRoot "Safe"),
    (Join-Path $configRoot "migration\secrets"),
    (Join-Path $install "secrets")
  )) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  Set-MonarchPrivateAcl -Path (Join-Path $install "secrets")

  New-MonarchDirectoryJunction -Path (Join-Path $version "gemma_models") -Target (Join-Path $modelsRoot "gemma_models")
  New-MonarchDirectoryJunction -Path (Join-Path $version "data\local") -Target (Join-Path $localState "data")
  New-MonarchDirectoryJunction -Path (Join-Path $version "logs") -Target (Join-Path $localState "logs")
  New-MonarchDirectoryJunction -Path (Join-Path $version "oscar\data") -Target (Join-Path $localState "data\oscar")
  New-MonarchDirectoryJunction -Path (Join-Path $version "oscar\logs") -Target (Join-Path $localState "logs\oscar")
  New-MonarchDirectoryJunction -Path (Join-Path $version "security\data") -Target (Join-Path $localState "data\security")
  New-MonarchDirectoryJunction -Path (Join-Path $version "security\logs") -Target (Join-Path $localState "logs\security")
  New-MonarchDirectoryJunction -Path (Join-Path $version "artifacts\generated") -Target (Join-Path $payload "generated")
  New-MonarchDirectoryJunction -Path (Join-Path $version "oscar\.venv") -Target (Join-Path $environmentRoot "oscar")
  New-MonarchDirectoryJunction -Path (Join-Path $version "security\.venv") -Target (Join-Path $environmentRoot "security")
  New-MonarchDirectoryJunction -Path (Join-Path $version "runtime\coder\models") -Target (Join-Path $modelsRoot "coder")
  New-MonarchDirectoryJunction -Path (Join-Path $version "runtime\voice\models") -Target (Join-Path $modelsRoot "voice")
  New-MonarchDirectoryJunction -Path (Join-Path $version "secrets") -Target (Join-Path $install "secrets")

  $legacySecretBackup = Copy-MonarchLegacySecretsForMigration `
    -LegacyRoot (Join-Path $install "secrets") `
    -MigrationRoot (Join-Path $configRoot "migration\secrets")

  $layout = [ordered]@{
    schemaVersion = 1
    installRoot = $install
    payloadRoot = $payload
    configRoot = $configRoot
    dataRoot = Join-Path $localState "data"
    logsRoot = Join-Path $localState "logs"
    modelsRoot = $modelsRoot
    runtimeRoot = $runtimeRoot
    environmentRoot = $environmentRoot
    transactionsRoot = Join-Path $payload "transactions"
    updatesRoot = Join-Path $payload "updates"
    legacySecretMigration = $legacySecretBackup
  }
  Write-MonarchAtomicJson -Path (Join-Path $install "install-layout.json") -Value $layout
  $dataSchemaPath = Join-Path $install "data-schema.json"
  if (-not (Test-Path -LiteralPath $dataSchemaPath -PathType Leaf)) {
    Write-MonarchAtomicJson -Path $dataSchemaPath -Value ([ordered]@{
      schemaVersion = 1
      dataSchemaVersion = 1
      updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    })
  }
  $modelCatalogPath = Join-Path $modelsRoot "catalog.json"
  if (-not (Test-Path -LiteralPath $modelCatalogPath -PathType Leaf)) {
    Write-MonarchAtomicJson -Path $modelCatalogPath -Value ([ordered]@{
      schemaVersion = 1
      models = @()
      updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    })
  }
  return $layout
}

function Write-MonarchVersionDescriptor {
  param(
    [Parameter(Mandatory = $true)][string]$VersionRoot,
    [Parameter(Mandatory = $true)][string]$AppVersion,
    [Parameter(Mandatory = $true)][string]$RuntimeVersion,
    [Parameter(Mandatory = $true)][string]$BackendEnvironment,
    [int]$DataSchemaVersion = 1,
    [int]$MinimumReadableDataSchema = 1,
    [int]$MaximumReadableDataSchema = 1,
    [int]$MinimumModelCatalogSchema = 1,
    [int]$MaximumModelCatalogSchema = 1
  )

  if ($MinimumReadableDataSchema -gt $DataSchemaVersion -or
      $DataSchemaVersion -gt $MaximumReadableDataSchema -or
      $MinimumModelCatalogSchema -gt $MaximumModelCatalogSchema) {
    throw "Invalid data or model catalog compatibility range."
  }
  $descriptor = [ordered]@{
    descriptorVersion = 1
    appVersion = $AppVersion
    layoutSchemaVersion = 1
    minimumLauncherVersion = "1.0.0"
    runtimeVersion = $RuntimeVersion
    backendEnvironment = $BackendEnvironment
    dataSchemaVersion = $DataSchemaVersion
    minimumReadableDataSchema = $MinimumReadableDataSchema
    maximumReadableDataSchema = $MaximumReadableDataSchema
    minimumModelCatalogSchema = $MinimumModelCatalogSchema
    maximumModelCatalogSchema = $MaximumModelCatalogSchema
    installedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-MonarchAtomicJson -Path (Join-Path $VersionRoot "version.json") -Value $descriptor
  return $descriptor
}

function Set-MonarchCurrentVersion {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$CurrentVersion,
    [string]$PreviousVersion = ""
  )

  $pointer = [ordered]@{
    schemaVersion = 1
    currentVersion = $CurrentVersion
    previousVersion = if ($PreviousVersion) { $PreviousVersion } else { $null }
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-MonarchAtomicJson -Path (Join-Path $InstallRoot "current.json") -Value $pointer
}

function New-MonarchPendingUpdate {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][object]$Layout,
    [Parameter(Mandatory = $true)][string]$PreviousVersion,
    [Parameter(Mandatory = $true)][string]$CandidateVersion,
    [Parameter(Mandatory = $true)][string]$CandidateRuntimeVersion,
    [Parameter(Mandatory = $true)][string]$CandidateBackendEnvironment,
    [int]$CandidateDataSchemaVersion = 1
  )

  $previousDescriptorPath = Join-Path $InstallRoot "versions\$PreviousVersion\version.json"
  if (-not (Test-Path -LiteralPath $previousDescriptorPath -PathType Leaf)) {
    throw "Previous version descriptor is missing: $previousDescriptorPath"
  }
  $previousDescriptor = Get-Content -LiteralPath $previousDescriptorPath -Raw | ConvertFrom-Json
  $launcherVersionPath = Join-Path $InstallRoot "launcher-version.json"
  $previousLauncherVersion = "1.0.0"
  if (Test-Path -LiteralPath $launcherVersionPath -PathType Leaf) {
    $launcherVersion = Get-Content -LiteralPath $launcherVersionPath -Raw | ConvertFrom-Json
    if ($launcherVersion.version) {
      $previousLauncherVersion = [string]$launcherVersion.version
    }
  }

  $updateId = [guid]::NewGuid().ToString("D")
  $transactionDirectory = Join-Path $Layout.transactionsRoot $updateId
  Set-MonarchPrivateAcl -Path $transactionDirectory
  $pending = [ordered]@{
    schemaVersion = 1
    updateId = $updateId
    previousVersion = $PreviousVersion
    candidateVersion = $CandidateVersion
    previousLauncherVersion = $previousLauncherVersion
    candidateLauncherVersion = "1.0.1"
    previousRuntimeVersion = [string]$previousDescriptor.runtimeVersion
    expectedRuntimeVersion = $CandidateRuntimeVersion
    previousBackendEnvironment = [string]$previousDescriptor.backendEnvironment
    expectedBackendEnvironment = $CandidateBackendEnvironment
    previousDataSchema = [int]$previousDescriptor.dataSchemaVersion
    expectedDataSchema = $CandidateDataSchemaVersion
    snapshotId = $null
    startedAt = [DateTimeOffset]::UtcNow.ToString("o")
    attempts = 0
    phase = "staged"
  }
  Write-MonarchAtomicJson `
    -Path (Join-Path $Layout.transactionsRoot "pending-update.json") `
    -Value $pending
  Write-MonarchAtomicJson `
    -Path (Join-Path $transactionDirectory "transaction.json") `
    -Value $pending
  return $pending
}
