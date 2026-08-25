Set-StrictMode -Version Latest

# One authoritative public-source boundary shared by dry-run validation and
# snapshot export. Keep local/runtime/private paths here so the validator and
# exporter cannot silently drift apart.
$MonarchPublicAllowedTopLevelDirectories = @(
  '.github',
  '.monarch',
  'assets',
  'desktop',
  'docs',
  'installer',
  'oscar',
  'release',
  'scripts',
  'security',
  'shared',
  'src',
  'tests',
  'tools'
)

$MonarchPublicAllowedRootFiles = @(
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.npmrc',
  'Install-Monarch.cmd',
  'package-lock.json',
  'package.json',
  'PROJECT_MANIFEST.md',
  'PROJECT_STATUS.json',
  'PROJECT.md',
  'README.md',
  'OWNER_AUTHORITY_V1.md',
  'SECURITY.md',
  'tsconfig.json',
  'vitest.config.ts'
)

$MonarchPublicBlockedDirectoryPatterns = @(
  '^\.git($|/)',
  '^\.agents($|/)',
  '^\.codex($|/)',
  '^\.tools($|/)',
  '^\.playwright-cli($|/)',
  '^node_modules($|/)',
  '^showcase/[^/]+/node_modules($|/)',
  '^showcase/[^/]+/out($|/)',
  '^output($|/)',
  '^scratch($|/)',
  '^dist($|/)',
  '^vendor($|/)',
  '^runtime($|/)',
  '^installer/out($|[-/])',
  '^installer/\.offline-build-cache($|/)',
  '^installer/offline-payload($|/)',
  '^logs($|/)',
  '^secrets($|/)',
  '^marketing-site($|/)',
  '^monarch($|/)',
  '^monarch-1($|/)',
  '^showcase($|/)',
  '^data/local($|/)',
  '^artifacts/generated($|/)',
  '^artifacts/qa($|/)',
  '^artifacts/audits($|/)',
  '^artifacts/studio/qa($|/)',
  '^docs/debug($|/)',
  '^docs/(?:[^/]+/)*qa($|/)',
  '^docs/(?:[^/]+/)*audit($|/)',
  '^LLM models($|/)',
  '^models($|/)',
  '^local-models($|/)',
  '^runtime-models($|/)',
  '^llama-runtime($|/)',
  '^hf-runtime($|/)',
  '^voice-runtime($|/)',
  '^oscar/\.venv($|/)',
  '^oscar/frontend/node_modules($|/)',
  '^oscar/frontend/dist($|/)',
  '^oscar/data($|/)',
  '^oscar/model($|/)',
  '^oscar/model-small($|/)',
  '^oscar/runtime($|/)',
  '^oscar/Oscar\.exe\.WebView2($|/)',
  '^oscar/desktop/webview2_pkg($|/)',
  '^security/\.venv($|/)',
  '^security/data($|/)',
  '^security/logs($|/)'
)

$MonarchPublicBlockedFilePatterns = @(
  '^AGENTS\.md$',
  '^\.monarch-public-snapshot$',
  '^remove-(?:artifacts|memory|profile|workspace)\.js$',
  '^remove-workspace-smoke\.cjs$',
  '^(AI_HANDOFF|agent_notes|ORIGINAL_REQUEST|MARK_ALFA_FINDINGS|design-qa)\.md$',
  '^docs/architecture/CODEX_[^/]+\.md$',
  '^docs/release/MONARCH_0\.2\.5_COMPLETE_CHANGELOG\.md$',
  '^docs/OSCAR_AGENT_RUNTIME_QA_[^/]+\.md$',
  '^docs/(10_REPAIR_PLAN_[^/]+|CONTROL_PLANE_ARCHITECTURE_AUDIT_[^/]+|TECH_AUDIT_[^/]+|TECH_REVIEW_[^/]+|WORK_CHECKPOINT_[^/]+)\.md$',
  '^docs/astra/STRUCTURAL_PROGRESS\.md$',
  '^docs/oscar/PORT_PROGRESS\.md$',
  '^oscar/OSCAR_FIX_LOG\.md$',
  '(^|/)\.env($|\.(?!example$).*)',
  '(^|/)__pycache__/',
  '\.pyc$',
  '\.pyo$',
  '\.gguf$',
  '\.safetensors$',
  '\.sqlite3?$',
  '\.db$',
  '\.bin$',
  '\.exe$',
  '\.dll$',
  '\.pyd$',
  '\.zip$',
  '\.7z$',
  '\.rar$',
  '\.tar\.gz$',
  '\.lib$',
  '\.tlb$',
  '\.winmd$',
  '\.onnx$'
)

$MonarchPublicTextExtensions = @(
  '.cjs', '.cmd', '.cs', '.css', '.html', '.ini', '.iss', '.js', '.json',
  '.md', '.mjs', '.mmd', '.ps1', '.py', '.svg', '.toml', '.ts', '.tsx',
  '.txt', '.yaml', '.yml'
)

$MonarchPublicTextFileNames = @(
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.ignore',
  '.node-version',
  '.npmrc',
  '.prettierrc',
  'LICENSE'
)

$MonarchPublicReviewedBinarySha256 = @{
  'assets/icon.ico' = '56949cee58cad8ea8096982d30c71e97ed9f8e34b85cc06ec53ded728b49ea0a'
  'assets/icon.png' = '81cf1442dff4249f2ea0e00806fdbf72f99e6796dc59d6a529523a6cf86b0960'
  'assets/safe/monarch-safe-logo.png' = '7235a10ddf470b207f33359633f47c7bae3c780c281d966d4a04aa2895a3f6ed'
  'assets/safe/monarch-safe.ico' = 'b1d6cb23385a2aa6868452a6af93c5d8ce0f3a98f037d54a7421b32178b739ef'
  'assets/voice/aurora-reference.wav' = '47d7eeef4f4e1b9eff20d9664b047196a20f6479f2d0e579a6da76f10a12f1c5'
  'assets/voice/oscar-clear-reference.wav' = 'b58ee475c1ac7ada0752cd01d2a5e14323403f100f687d6f059caab0cab26003'
  'assets/voice/oscar-reference.wav' = 'c8f7331c103a524d415b3c4fc680a1cb1d8dda69bec7f57bb8448f9195223a1d'
  'desktop/safe/monarch-safe-logo.png' = '7235a10ddf470b207f33359633f47c7bae3c780c281d966d4a04aa2895a3f6ed'
  'desktop/safe/safe-classic-lock.png' = '4b9a04fd2c4f806492a66d21c0f8f1a08a6e9348777e034f2b6754a9cb40d52f'
  'docs/safe/design/safe-lock-concept.png' = '04785d539e14ed1649a277c96662ecad984caa56c545ff009db6280f99674cf7'
  'docs/safe/design/safe-workspace-concept.png' = '0bb8ef9b6e45d542db8ffbfa0a668f0e469c84e974feb2d0588ac39511a1dd49'
  'docs/security-rebuild/2026-07-11/design/security-incident-reference.png' = '5059edaa02507a72010eed5e2ae318ae1e8470a44fd460820bfd4554bcbd5e85'
  'docs/security-rebuild/2026-07-11/design/security-overview-selected.png' = '4eebc5bdd2510db3d57fa9bb550ffa9fed2f330ced110f0ee661bdb1bef4707b'
  'oscar/frontend/public/assets/brand/monarch-icon.png' = '81cf1442dff4249f2ea0e00806fdbf72f99e6796dc59d6a529523a6cf86b0960'
  'oscar/frontend/public/assets/brand/monarch-mark.png' = '2821f1df15f051310587e64326516cc6384c7269170bcbd56cb15c668ce4fde3'
  'oscar/frontend/public/assets/mascot/oscar-coding.png' = 'f8b9c3bbf1c373e40aaaa468a753162dec148ae27697488cb832620c141a4487'
  'oscar/frontend/public/assets/mascot/oscar-error.png' = '8c860bba4d6f04af3fb9615242c92e7a53af719699d4318097946b2f205145ab'
  'oscar/frontend/public/assets/mascot/oscar-idle.png' = 'aa8d4e040a105a351ef3e3b46c8e2870196c33b09e0d91f7344448cba05c055c'
  'oscar/frontend/public/assets/mascot/oscar-listening.png' = '46165686357b066866891c3e21367f823ff76882cba84fddfe0b6d54877f80fb'
  'oscar/frontend/public/assets/mascot/oscar-security.png' = 'b43b890cfc073d0833dd2b84c5936e105b3c04103e1b4b9bb3d0491204681af1'
  'oscar/frontend/public/assets/mascot/oscar-success.png' = '88a59f176ef76d3854e33ca96df6fde3626cc25397744be8b847eb18c25d9587'
  'oscar/frontend/public/assets/mascot/oscar-thinking.png' = '0f1d3e5a957463bc7e2eb6e9a1669677898e775b32a303af5c9aeb649192c23a'
  'oscar/frontend/public/favicon.ico' = '56949cee58cad8ea8096982d30c71e97ed9f8e34b85cc06ec53ded728b49ea0a'
  'src/ui/public/assets/brand/monarch-icon.png' = '81cf1442dff4249f2ea0e00806fdbf72f99e6796dc59d6a529523a6cf86b0960'
  'src/ui/public/assets/brand/monarch-incognito-hooded.png' = '4e8e0ae26c1f188f4a855f2de70ff0942738b1a47985355ad5ff65cec6fca0ce'
  'src/ui/public/assets/brand/monarch-mark.png' = '2821f1df15f051310587e64326516cc6384c7269170bcbd56cb15c668ce4fde3'
  'src/ui/public/assets/brand/monarch-startup-3d.png' = '31700673a5e43d03983b2dd22603475a5bb66fa03dd9fbfd48af73ed27b1c15c'
  'src/ui/public/assets/mascot/oscar-coding.png' = 'f8b9c3bbf1c373e40aaaa468a753162dec148ae27697488cb832620c141a4487'
  'src/ui/public/assets/mascot/oscar-error.png' = '8c860bba4d6f04af3fb9615242c92e7a53af719699d4318097946b2f205145ab'
  'src/ui/public/assets/mascot/oscar-idle.png' = 'aa8d4e040a105a351ef3e3b46c8e2870196c33b09e0d91f7344448cba05c055c'
  'src/ui/public/assets/mascot/oscar-listening.png' = '46165686357b066866891c3e21367f823ff76882cba84fddfe0b6d54877f80fb'
  'src/ui/public/assets/mascot/oscar-security.png' = 'b43b890cfc073d0833dd2b84c5936e105b3c04103e1b4b9bb3d0491204681af1'
  'src/ui/public/assets/mascot/oscar-success.png' = '88a59f176ef76d3854e33ca96df6fde3626cc25397744be8b847eb18c25d9587'
  'src/ui/public/assets/mascot/oscar-thinking.png' = '0f1d3e5a957463bc7e2eb6e9a1669677898e775b32a303af5c9aeb649192c23a'
  'src/ui/public/assets/monarch-safe-logo.png' = '7235a10ddf470b207f33359633f47c7bae3c780c281d966d4a04aa2895a3f6ed'
  'src/ui/public/assets/studio/guided-portrait.png' = '7f7d31c3e43295d446d5e2cddb57270e732d670227a5b81d903d7eb074964d22'
  'src/ui/public/assets/studio/preset-auto.png' = '76e9b8a2ff146db294b2b544f1e4ddf9d5ac4e18f9eac1a22b6c06d23878cb7b'
  'src/ui/public/assets/studio/preset-cool.png' = 'baf3c304784f49a7f4273a78f223b48ff5d0e804f6a0078e1f4993e518e8c9ce'
  'src/ui/public/assets/studio/preset-warm.png' = '7be4491a7e02b5716bcf4e44834b810e94bc52e660c7d6e906f06785961f66f6'
  'src/ui/public/favicon.ico' = '56949cee58cad8ea8096982d30c71e97ed9f8e34b85cc06ec53ded728b49ea0a'
  'tools/computer-use/assets/oscar-cursor-idle.png' = '0a84b4fee7a33fab24ee069dec1bd407f199c0581b8927d5535ab6e3e3a0b5df'
  'tools/computer-use/assets/oscar-cursor-hover.png' = '20f396ea6b52be11c24b3007ce61777f5f421b347103b4fb327beeefdffa2843'
  'tools/computer-use/assets/oscar-cursor-pressed.png' = '2f3d816b32c3d79efeb6a765d69d0e58fd4ee2a3594cfa37cd1442af03b1e3d6'
  'tools/computer-use/assets/oscar-cursor-moving.png' = '80c8f3c9d66f04b04b5a0d0fe3045f9d84d705e4264f46b33534ce6707714228'
  'tools/computer-use/assets/oscar-cursor-busy.png' = '72e31a3872c6ea6de7228b607ae9c529ff74324e6c06ff5e8da93069429f20e2'
  'tools/computer-use/assets/oscar-cursor-text.png' = '2ee973a6a236868cb936f9fba16ddd7e61f3e9c4bee72a2960034770554a2e3f'
  'tools/computer-use/assets/oscar-cursor-disabled.png' = '3a36a2035b89bc668037e8b53d30118b59b1cf676a60335e21070a7e6333ea3a'
}

$MonarchPublicForbiddenContentPatterns = @(
  ('C:' + '\\Users\\' + 'anton'),
  ('E:' + '\\' + 'Monarch'),
  ('E:' + '/' + 'Monarch'),
  'gh[pousr]_[A-Za-z0-9_]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  '\bglpat-[A-Za-z0-9_-]{20,}\b',
  '\bhf_[A-Za-z0-9]{20,}\b',
  '\bnpm_[A-Za-z0-9]{30,}\b',
  '\bpypi-AgEIcH[A-Za-z0-9_-]{30,}\b',
  '\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b',
  '\bsk-[A-Za-z0-9_-]{20,}\b',
  'AIza[0-9A-Za-z_-]{20,}',
  'xox[baprs]-[A-Za-z0-9-]{20,}',
  '-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----',
  '\bAKIA[0-9A-Z]{16}\b',
  '(?i)\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}\b',
  '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b',
  '(?i)\bhttps?://[^/\s:@]+:[^@\s/]+@'
)

$MonarchPublicSnapshotSchemaVersion = 2
$MonarchPublicSnapshotMarkerName = '.monarch-public-snapshot'
$MonarchPublicDefaultMaxFileBytes = 5242880
$MonarchPublicGenericRead = [uint32]2147483648
$MonarchPublicFileFlagOpenReparsePoint = [uint32]2097152
$MonarchPublicMaxGitTreeBytes = 16777216
$MonarchPublicMaxGitTreeEntries = 10000
$MonarchPublicDefaultMaxTotalBytes = 134217728
$MonarchPublicDefaultMaxFiles = 2000
$MonarchPublicBoundaryScripts = @(
  '.gitattributes',
  'scripts/export-public.ps1',
  'scripts/public-source-policy.ps1',
  'scripts/public-source-structure.json',
  'scripts/upload-dry-run.ps1'
)
$MonarchPublicStructureRegistryPath = 'scripts/public-source-structure.json'
$MonarchPublicRootRegistryScope = '__root__'
$MonarchPublicRequiredLockedZones = @(
  $MonarchPublicRootRegistryScope
) + $MonarchPublicAllowedTopLevelDirectories

function Test-MonarchPublicBlockedPath {
  param([Parameter(Mandatory = $true)][string] $RelativePath)

  $normalized = $RelativePath.Replace('\', '/')
  foreach ($pattern in $MonarchPublicBlockedDirectoryPatterns) {
    if ($normalized -match $pattern) {
      return $true
    }
  }
  foreach ($pattern in $MonarchPublicBlockedFilePatterns) {
    if ($normalized -match $pattern) {
      return $true
    }
  }
  return $false
}

function Test-MonarchPublicAllowedPath {
  param([Parameter(Mandatory = $true)][string] $RelativePath)

  if ($RelativePath.Contains('\')) {
    return $false
  }
  $normalized = $RelativePath
  if ([string]::IsNullOrWhiteSpace($normalized) -or
      $normalized.StartsWith('/') -or
      $normalized.EndsWith('/') -or
      $normalized.Contains('//') -or
      $normalized -match '^[A-Za-z]:' -or
      $normalized -match '(^|/)\.\.?($|/)' -or
      $normalized -match '[<>:"|?*\x00-\x1f]' -or
      $normalized.IndexOf([char]0) -ge 0) {
    return $false
  }
  foreach ($segment in $normalized.Split('/')) {
    if ($segment.EndsWith('.') -or
        $segment.EndsWith(' ') -or
        $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
      return $false
    }
  }

  $separatorIndex = $normalized.IndexOf('/')
  if ($separatorIndex -lt 0) {
    return $MonarchPublicAllowedRootFiles -ccontains $normalized
  }

  $topLevel = $normalized.Substring(0, $separatorIndex)
  return $MonarchPublicAllowedTopLevelDirectories -ccontains $topLevel
}

function Test-MonarchPublicCandidatePath {
  param([Parameter(Mandatory = $true)][string] $RelativePath)

  if ($RelativePath.Contains('\')) {
    return $false
  }
  $normalized = $RelativePath
  if (-not (Test-MonarchPublicAllowedPath $normalized) -or
      (Test-MonarchPublicBlockedPath $normalized)) {
    return $false
  }
  if (Test-MonarchPublicTextSource $normalized) {
    return $true
  }
  return $MonarchPublicReviewedBinarySha256.ContainsKey($normalized)
}

function Test-MonarchPublicTextSource {
  param([Parameter(Mandatory = $true)][string] $RelativePath)

  $normalized = $RelativePath.Replace('\', '/')
  $leafName = [System.IO.Path]::GetFileName($normalized).ToLowerInvariant()
  if ($MonarchPublicTextFileNames -contains $leafName) {
    return $true
  }

  $extension = [System.IO.Path]::GetExtension($leafName).ToLowerInvariant()
  return $MonarchPublicTextExtensions -contains $extension
}

function Test-MonarchPublicReviewedBinaryContent {
  param(
    [Parameter(Mandatory = $true)][string] $RelativePath,
    [Parameter(Mandatory = $true)][string] $FullPath
  )

  $normalized = $RelativePath.Replace('\', '/')
  if (-not $MonarchPublicReviewedBinarySha256.ContainsKey($normalized)) {
    return $false
  }
  $record = Get-MonarchRegularFileRecord $FullPath $normalized
  return $record.sha256 -eq $MonarchPublicReviewedBinarySha256[$normalized]
}

function Test-MonarchSensitiveSourceName {
  param([Parameter(Mandatory = $true)][string] $RelativePath)

  if ($RelativePath -eq 'oscar/scripts/token.ps1') {
    return $false
  }
  return $RelativePath -match '(^|/)(secret|secrets|token|tokens|key|keys|credential|credentials|password|passwd)(\.|_|-|/|$)'
}

function ConvertTo-MonarchHex {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)

  return [System.BitConverter]::ToString($Bytes).Replace('-', '').ToLowerInvariant()
}

function Get-MonarchSha256Hex {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ConvertTo-MonarchHex ($sha256.ComputeHash($Bytes))
  } finally {
    $sha256.Dispose()
  }
}

function Get-MonarchGitBlobId {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)

  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $prefix = $strictUtf8.GetBytes("blob $($Bytes.LongLength)`0")
  $input = [byte[]]::new($prefix.Length + $Bytes.Length)
  [System.Buffer]::BlockCopy($prefix, 0, $input, 0, $prefix.Length)
  if ($Bytes.Length -gt 0) {
    [System.Buffer]::BlockCopy($Bytes, 0, $input, $prefix.Length, $Bytes.Length)
  }

  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try {
    return ConvertTo-MonarchHex ($sha1.ComputeHash($input))
  } finally {
    $sha1.Dispose()
  }
}

function Initialize-MonarchPublicNativeMethods {
  if ('MonarchPublicNativeMethods' -as [type]) {
    return
  }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

[StructLayout(LayoutKind.Sequential)]
public struct MonarchPublicByHandleFileInformation
{
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct MonarchPublicFindStreamData
{
    public long StreamSize;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)]
    public string StreamName;
}

public static class MonarchPublicNativeMethods
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle handle,
        out MonarchPublicByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindFirstStreamW(
        string fileName,
        int infoLevel,
        out MonarchPublicFindStreamData data,
        uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool FindNextStreamW(
        IntPtr findHandle,
        out MonarchPublicFindStreamData data);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FindClose(IntPtr findHandle);
}
'@
}

function Assert-MonarchNoAlternateDataStreams {
  param([Parameter(Mandatory = $true)][string] $FullPath)

  Initialize-MonarchPublicNativeMethods
  $streamData = New-Object MonarchPublicFindStreamData
  $findHandle = [MonarchPublicNativeMethods]::FindFirstStreamW(
    [System.IO.Path]::GetFullPath($FullPath),
    0,
    [ref]$streamData,
    [uint32]0
  )
  $invalidHandle = [System.IntPtr]::new(-1)
  if ($findHandle -eq $invalidHandle) {
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 38) {
      return
    }
    throw "Could not enumerate alternate data streams for $FullPath (Win32 $errorCode)."
  }
  try {
    while ($true) {
      if ([string]$streamData.StreamName -cne '::$DATA') {
        throw "Alternate data streams are forbidden in the public boundary: $FullPath"
      }
      $streamData = New-Object MonarchPublicFindStreamData
      if (-not [MonarchPublicNativeMethods]::FindNextStreamW(
          $findHandle,
          [ref]$streamData
        )) {
        $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne 38) {
          throw "Could not finish enumerating alternate data streams for $FullPath (Win32 $errorCode)."
        }
        break
      }
    }
  } finally {
    [void][MonarchPublicNativeMethods]::FindClose($findHandle)
  }
}

function Assert-MonarchNoReparsePath {
  param([Parameter(Mandatory = $true)][string] $FullPath)

  $cursor = [System.IO.Path]::GetFullPath($FullPath)
  while (-not (Test-Path -LiteralPath $cursor)) {
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) {
      throw "Could not resolve an existing ancestor for path: $FullPath"
    }
    $cursor = $parent
  }

  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are forbidden in the public boundary: $($item.FullName)"
    }
    Assert-MonarchNoAlternateDataStreams $item.FullName
    $parent = Split-Path -Parent $item.FullName
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $item.FullName) {
      break
    }
    $cursor = $parent
  }
}

function Assert-MonarchRegularFile {
  param([Parameter(Mandatory = $true)][string] $FullPath)

  Assert-MonarchNoReparsePath $FullPath
  $item = Get-Item -LiteralPath $FullPath -Force
  if ($item.PSIsContainer -or
      (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Expected a regular non-reparse file: $FullPath"
  }
  if ($item.PSObject.Properties['LinkType'] -and $item.LinkType) {
    throw "Linked files are forbidden in the public boundary: $FullPath"
  }

  $record = Get-MonarchRegularFileRecord $FullPath '' ([long]::MaxValue)
  if ($null -eq $record) {
    throw "Could not inspect regular file: $FullPath"
  }
}

function Get-MonarchRegularFileRecord {
  param(
    [Parameter(Mandatory = $true)][string] $FullPath,
    [string] $RelativePath = '',
    [long] $MaxBytes = $MonarchPublicDefaultMaxFileBytes
  )

  if ($MaxBytes -le 0) {
    throw "Public boundary maximum file size must be positive: $MaxBytes"
  }
  Assert-MonarchNoReparsePath $FullPath
  $fullPathValue = [System.IO.Path]::GetFullPath($FullPath)
  Initialize-MonarchPublicNativeMethods
  $nativeHandle = [MonarchPublicNativeMethods]::CreateFile(
    $fullPathValue,
    $MonarchPublicGenericRead,
    [uint32]0,
    [System.IntPtr]::Zero,
    [uint32]3,
    $MonarchPublicFileFlagOpenReparsePoint,
    [System.IntPtr]::Zero
  )
  if ($nativeHandle.IsInvalid) {
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $nativeHandle.Dispose()
    throw "Could not exclusively open a non-reparse file for $FullPath (Win32 $errorCode)."
  }
  $stream = $null
  try {
    $information = New-Object MonarchPublicByHandleFileInformation
    if (-not [MonarchPublicNativeMethods]::GetFileInformationByHandle(
        $nativeHandle,
        [ref]$information
      )) {
      $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Could not inspect file identity for $FullPath (Win32 $errorCode)."
    }
    if (($information.FileAttributes -band [uint32][System.IO.FileAttributes]::Directory) -ne 0 -or
        ($information.FileAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Expected a regular non-reparse file: $FullPath"
    }
    if ($information.NumberOfLinks -ne 1) {
      throw "Hardlinked files are forbidden in the public boundary: $FullPath"
    }
    $stream = New-Object System.IO.FileStream(
      $nativeHandle,
      [System.IO.FileAccess]::Read
    )
    $nativeHandle = $null
    if ([long]$stream.Length -gt $MaxBytes) {
      throw "Public boundary file exceeds $MaxBytes bytes: $FullPath"
    }
    Assert-MonarchNoAlternateDataStreams $fullPathValue

    $bytes = [byte[]]::new([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -le 0) {
        throw "Public boundary file ended before its locked length: $FullPath"
      }
      $offset += $read
    }
    if ($stream.ReadByte() -ne -1) {
      throw "Public boundary file changed while held exclusively: $FullPath"
    }
    $finalInformation = New-Object MonarchPublicByHandleFileInformation
    if (-not [MonarchPublicNativeMethods]::GetFileInformationByHandle(
        $stream.SafeFileHandle,
        [ref]$finalInformation
      )) {
      $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Could not re-inspect file identity for $FullPath (Win32 $errorCode)."
    }
    if ($finalInformation.VolumeSerialNumber -ne $information.VolumeSerialNumber -or
        $finalInformation.FileIndexHigh -ne $information.FileIndexHigh -or
        $finalInformation.FileIndexLow -ne $information.FileIndexLow -or
        $finalInformation.NumberOfLinks -ne 1 -or
        $finalInformation.FileAttributes -ne $information.FileAttributes -or
        $finalInformation.FileSizeHigh -ne $information.FileSizeHigh -or
        $finalInformation.FileSizeLow -ne $information.FileSizeLow) {
      throw "Public boundary file identity changed while held: $FullPath"
    }
    Assert-MonarchNoReparsePath $fullPathValue
    return [pscustomobject]@{
      path = $RelativePath.Replace('\', '/')
      fullPath = $fullPathValue
      volumeSerialNumber = [uint32]$information.VolumeSerialNumber
      fileIndexHigh = [uint32]$information.FileIndexHigh
      fileIndexLow = [uint32]$information.FileIndexLow
      size = [long]$bytes.LongLength
      sha256 = Get-MonarchSha256Hex $bytes
      gitBlobId = Get-MonarchGitBlobId $bytes
      bytes = $bytes
    }
  } finally {
    if ($null -ne $stream) {
      $stream.Dispose()
    } elseif ($null -ne $nativeHandle) {
      $nativeHandle.Dispose()
    }
  }
}

function ConvertFrom-MonarchStrictUtf8 {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes,
    [Parameter(Mandatory = $true)][string] $DisplayPath
  )

  if ([System.Array]::IndexOf($Bytes, [byte]0) -ge 0) {
    throw "NUL bytes are forbidden in public text source: $DisplayPath"
  }
  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  try {
    return [string]$strictUtf8.GetString($Bytes)
  } catch {
    throw "Public text source is not strict UTF-8: $DisplayPath"
  }
}

function New-MonarchGitProcessStartInfo {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [Parameter(Mandatory = $true)][string] $Arguments
  )

  $gitCommand = Get-Command git.exe -ErrorAction Stop
  $gitExecutable = [System.IO.Path]::GetFullPath($gitCommand.Source)
  if ([System.IO.Path]::GetFileName((Split-Path -Parent $gitExecutable)) -ieq 'cmd') {
    $nativeGitCandidate = [System.IO.Path]::GetFullPath(
      (Join-Path (Split-Path -Parent $gitExecutable) '..\mingw64\bin\git.exe')
    )
    if (Test-Path -LiteralPath $nativeGitCandidate -PathType Leaf) {
      $nativeGitItem = Get-Item -LiteralPath $nativeGitCandidate -Force
      if (($nativeGitItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        $gitExecutable = $nativeGitCandidate
      }
    }
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $gitExecutable
  $startInfo.WorkingDirectory = [System.IO.Path]::GetFullPath($SourceRoot)
  $startInfo.Arguments = "--no-replace-objects $Arguments"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  foreach ($environmentName in @($startInfo.EnvironmentVariables.Keys)) {
    if ([string]$environmentName -like 'GIT_*') {
      $startInfo.EnvironmentVariables.Remove([string]$environmentName)
    }
  }
  $startInfo.EnvironmentVariables['GIT_NO_REPLACE_OBJECTS'] = '1'
  $startInfo.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'
  $startInfo.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
  $startInfo.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = 'NUL'
  $startInfo.EnvironmentVariables['LC_ALL'] = 'C'
  $startInfo.EnvironmentVariables['LANG'] = 'C'
  return $startInfo
}

function Stop-MonarchProcessTree {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process] $Process)

  try {
    if ($Process.HasExited) {
      return
    }
  } catch {
    return
  }
  $killTreeMethod = $Process.GetType().GetMethod(
    'Kill',
    [type[]]@([bool])
  )
  if ($null -ne $killTreeMethod) {
    try {
      [void]$killTreeMethod.Invoke($Process, [object[]]@($true))
      return
    } catch {
      # Windows PowerShell on .NET Framework does not expose Kill(bool).
    }
  }

  $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkillPath -PathType Leaf) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $taskkillPath
    $startInfo.Arguments = "/PID $($Process.Id) /T /F"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $terminator = New-Object System.Diagnostics.Process
    $terminator.StartInfo = $startInfo
    try {
      if ($terminator.Start()) {
        $outputTask = $terminator.StandardOutput.ReadToEndAsync()
        $errorTask = $terminator.StandardError.ReadToEndAsync()
        if (-not $terminator.WaitForExit(10000)) {
          $terminator.Kill()
        }
        [void]$outputTask
        [void]$errorTask
      }
    } catch {
      # Fall through to the exact root process kill below.
    } finally {
      $terminator.Dispose()
    }
  }
  try {
    if (-not $Process.HasExited) {
      $Process.Kill()
    }
  } catch {
    # The process may have exited between the checks.
  }
}

function Assert-MonarchNoGitRepositoryContext {
  param([Parameter(Mandatory = $true)][string] $Path)

  $startInfo = New-MonarchGitProcessStartInfo $Path 'rev-parse --absolute-git-dir'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw 'Could not prove that the public destination is outside Git metadata.'
  }
  try {
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $outputText = $outputTask.Result
    $errorText = $errorTask.Result
    if ($process.ExitCode -eq 0) {
      throw 'A public snapshot must have fresh unrelated history, not an existing Git worktree or object database.'
    }
    $expectedNotRepository = 'fatal: not a git repository (or any of the parent directories): .git'
    if ($process.ExitCode -ne 128 -or
        -not [string]::IsNullOrWhiteSpace($outputText) -or
        $errorText.Trim() -cne $expectedNotRepository) {
      throw "Could not prove that the public destination is outside Git metadata: $($errorText.Trim())"
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-MonarchGitRaw {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [Parameter(Mandatory = $true)][string] $Arguments,
    [switch] $AllowFailure,
    [long] $MaxOutputBytes = 1048576
  )

  if ($MaxOutputBytes -le 0) {
    throw "Git output limit must be positive: $MaxOutputBytes"
  }
  $startInfo = New-MonarchGitProcessStartInfo $SourceRoot $Arguments
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Could not start git --no-replace-objects $Arguments"
  }
  try {
    $errorTask = $process.StandardError.ReadToEndAsync()
    $buffer = New-Object System.IO.MemoryStream
    try {
      $copyBuffer = [byte[]]::new(65536)
      [long]$copiedBytes = 0
      while ($true) {
        $remainingBytes = $MaxOutputBytes - $copiedBytes
        $readLimit = [int][Math]::Min(
          [long]$copyBuffer.Length,
          $remainingBytes + 1
        )
        $readCount = $process.StandardOutput.BaseStream.Read(
          $copyBuffer,
          0,
          $readLimit
        )
        if ($readCount -le 0) {
          break
        }
        if ($copiedBytes + $readCount -gt $MaxOutputBytes) {
          Stop-MonarchProcessTree $process
          [void]$process.WaitForExit(10000)
          throw "git --no-replace-objects $Arguments exceeded $MaxOutputBytes output bytes"
        }
        $buffer.Write($copyBuffer, 0, $readCount)
        $copiedBytes += $readCount
      }
      $process.WaitForExit()
      $errorText = $errorTask.Result
      if ($process.ExitCode -ne 0) {
        if ($AllowFailure) {
          return $null
        }
        throw "git --no-replace-objects $Arguments failed: $errorText"
      }
      return ,$buffer.ToArray()
    } finally {
      $buffer.Dispose()
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-MonarchGitText {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [Parameter(Mandatory = $true)][string] $Arguments,
    [switch] $AllowFailure
  )

  $bytes = Invoke-MonarchGitRaw $SourceRoot $Arguments -AllowFailure:$AllowFailure
  if ($null -eq $bytes) {
    return $null
  }
  return ConvertFrom-MonarchStrictUtf8 $bytes "git --no-replace-objects $Arguments output"
}

function Resolve-MonarchPublicSourceRevision {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [string] $SourceRevision = 'HEAD'
  )

  if ($SourceRevision -ne 'HEAD' -and $SourceRevision -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'SourceRevision must be HEAD or an exact 40-character commit id.'
  }
  Assert-MonarchNoReparsePath $SourceRoot
  $gitDirectoryText = Invoke-MonarchGitText $SourceRoot 'rev-parse --git-common-dir'
  $gitDirectoryValue = @($gitDirectoryText.TrimEnd("`r", "`n").Split("`n"))
  if ($gitDirectoryValue.Count -ne 1) {
    throw "Could not resolve the Git object database for: $SourceRoot"
  }
  $gitDirectory = [string]$gitDirectoryValue[0]
  if (-not [System.IO.Path]::IsPathRooted($gitDirectory)) {
    $gitDirectory = Join-Path $SourceRoot $gitDirectory
  }
  Assert-MonarchNoReparsePath ([System.IO.Path]::GetFullPath($gitDirectory))
  $resolvedText = Invoke-MonarchGitText $SourceRoot "rev-parse --verify $SourceRevision^{commit}"
  $resolved = @($resolvedText.TrimEnd("`r", "`n").Split("`n"))
  if ($resolved.Count -ne 1) {
    throw "Could not resolve source commit: $SourceRevision"
  }
  $commit = ([string]$resolved[0]).Trim().ToLowerInvariant()
  if ($commit -notmatch '^[0-9a-f]{40}$') {
    throw "Git did not return an exact SHA-1 commit id: $commit"
  }
  return $commit
}

function Get-MonarchGitTreeRecords {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [Parameter(Mandatory = $true)][string] $SourceRevision,
    [int] $MaxTreeEntries = $MonarchPublicMaxGitTreeEntries,
    [long] $MaxTreeBytes = $MonarchPublicMaxGitTreeBytes
  )

  if ($MaxTreeEntries -le 0 -or $MaxTreeBytes -le 0) {
    throw 'Git tree limits must be positive.'
  }
  # The default -z format is deliberate: unlike %(path), it emits the path as
  # raw bytes instead of C-quoting non-ASCII names even when -z is present.
  $bytes = Invoke-MonarchGitRaw $SourceRoot (
    "ls-tree -r -z --full-tree -l $SourceRevision"
  ) -MaxOutputBytes $MaxTreeBytes
  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $records = New-Object System.Collections.Generic.List[object]
  $recordStart = 0
  for ($index = 0; $index -lt $bytes.Length; $index += 1) {
    if ($bytes[$index] -ne 0) {
      continue
    }
    $length = $index - $recordStart
    if ($length -le 0) {
      throw 'Git returned an empty NUL-delimited tree record.'
    }
    try {
      $recordText = $strictUtf8.GetString($bytes, $recordStart, $length)
    } catch {
      throw 'Git tree contains a path that is not strict UTF-8.'
    }
    $firstSpace = $recordText.IndexOf(' ')
    $secondSpace = if ($firstSpace -ge 0) {
      $recordText.IndexOf(' ', $firstSpace + 1)
    } else {
      -1
    }
    $thirdSpace = if ($secondSpace -ge 0) {
      $recordText.IndexOf(' ', $secondSpace + 1)
    } else {
      -1
    }
    $pathSeparator = if ($thirdSpace -ge 0) {
      $recordText.IndexOf("`t", $thirdSpace + 1)
    } else {
      -1
    }
    if ($firstSpace -le 0 -or
        $secondSpace -le $firstSpace -or
        $thirdSpace -le $secondSpace -or
        $pathSeparator -le $thirdSpace) {
      throw "Git returned a malformed tree record: $recordText"
    }
    # Keep the exact Git pathname. A literal backslash is legal in a tree but
    # invalid at the Windows publication boundary and must be rejected by
    # Test-MonarchPublicAllowedPath, never normalized into a reviewed slash.
    $path = $recordText.Substring($pathSeparator + 1)
    if ($path.IndexOf([char]0) -ge 0) {
      throw 'Git tree contains a NUL path.'
    }
    if ($records.Count -ge $MaxTreeEntries) {
      throw "Git tree exceeds the bounded entry limit: $MaxTreeEntries"
    }
    $objectType = $recordText.Substring($firstSpace + 1, $secondSpace - $firstSpace - 1)
    $objectSizeText = $recordText.Substring($thirdSpace + 1, $pathSeparator - $thirdSpace - 1).Trim()
    if (($objectType -ceq 'blob' -and $objectSizeText -notmatch '^\d+$') -or
        ($objectType -cne 'blob' -and $objectSizeText -cne '-')) {
      throw "Git returned an invalid tree object size: $recordText"
    }
    [void]$records.Add([pscustomobject]@{
      mode = $recordText.Substring(0, $firstSpace)
      objectType = $objectType
      objectId = $recordText.Substring($secondSpace + 1, $thirdSpace - $secondSpace - 1).ToLowerInvariant()
      objectSize = if ($objectType -ceq 'blob') { [long]$objectSizeText } else { [long]-1 }
      path = $path
    })
    $recordStart = $index + 1
  }
  if ($recordStart -ne $bytes.Length) {
    throw 'Git tree output was not terminated by NUL.'
  }
  return $records.ToArray()
}

function Get-MonarchPublicLockedZone {
  param([Parameter(Mandatory = $true)][string] $RelativePath)

  $separatorIndex = $RelativePath.IndexOf('/')
  if ($separatorIndex -lt 0) {
    return $MonarchPublicRootRegistryScope
  }
  $topLevel = $RelativePath.Substring(0, $separatorIndex)
  if ($MonarchPublicAllowedTopLevelDirectories -ccontains $topLevel) {
    return $topLevel
  }
  return $null
}

function Get-MonarchPathSetDigest {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $Paths)

  [string[]]$orderedPaths = @($Paths)
  [System.Array]::Sort($orderedPaths, [System.StringComparer]::Ordinal)
  $serialized = if ($orderedPaths.Count -gt 0) {
    ($orderedPaths -join "`0") + "`0"
  } else {
    ''
  }
  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  return Get-MonarchSha256Hex ($strictUtf8.GetBytes($serialized))
}

function Read-MonarchPublicStructureRegistry {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes)

  $content = ConvertFrom-MonarchStrictUtf8 $Bytes $MonarchPublicStructureRegistryPath
  try {
    $registry = $content | ConvertFrom-Json
  } catch {
    throw "Public structure registry is not valid JSON: $($_.Exception.Message)"
  }
  if ([int]$registry.schemaVersion -ne 2 -or
      $null -eq $registry.zones -or
      $null -eq $registry.additions) {
    throw 'Public structure registry has an unsupported schema.'
  }

  $zoneProperties = @($registry.zones.PSObject.Properties)
  if ($zoneProperties.Count -ne $MonarchPublicRequiredLockedZones.Count) {
    throw 'Public structure registry must declare every locked zone exactly once.'
  }
  foreach ($property in $zoneProperties) {
    if ($MonarchPublicRequiredLockedZones -cnotcontains $property.Name) {
      throw "Public structure registry contains an unknown zone: $($property.Name)"
    }
  }
  foreach ($zone in $MonarchPublicRequiredLockedZones) {
    $zoneProperty = $registry.zones.PSObject.Properties[$zone]
    if ($null -eq $zoneProperty) {
      throw "Public structure registry is missing locked zone: $zone"
    }
    if ([int]$zoneProperty.Value.baseCount -lt 0 -or
        [string]$zoneProperty.Value.basePathDigest -notmatch '^[0-9a-f]{64}$') {
      throw "Public structure registry contains invalid metadata for: $zone"
    }
  }
  return $registry
}

function Assert-MonarchPublicStructureRegistry {
  param(
    [Parameter(Mandatory = $true)][object[]] $IncludedFiles,
    [Parameter(Mandatory = $true)][object] $Registry
  )

  $additions = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($property in @($Registry.additions.PSObject.Properties)) {
    $relative = [string]$property.Name
    $zone = [string]$property.Value.scope
    $objectId = [string]$property.Value.objectId
    if (-not (Test-MonarchPublicCandidatePath $relative) -or
        $relative -ceq $MonarchPublicStructureRegistryPath -or
        $MonarchPublicRequiredLockedZones -cnotcontains $zone -or
        (Get-MonarchPublicLockedZone $relative) -cne $zone -or
        $objectId -notmatch '^[0-9a-f]{40}$') {
      throw "Public structure registry contains an invalid addition: $relative"
    }
    if ($additions.ContainsKey($relative)) {
      throw "Public structure registry contains a duplicate addition: $relative"
    }
    $additions.Add($relative, [pscustomobject]@{
      scope = $zone
      objectId = $objectId
    })
  }

  $basePaths = @{}
  foreach ($zone in $MonarchPublicRequiredLockedZones) {
    $basePaths[$zone] = New-Object System.Collections.Generic.List[string]
  }
  $seenAdditions = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $IncludedFiles) {
    $relative = [string]$file.path
    $zone = Get-MonarchPublicLockedZone $relative
    if (-not $zone -or $relative -ceq $MonarchPublicStructureRegistryPath) {
      continue
    }
    if ($additions.ContainsKey($relative)) {
      if ($relative -cne ($additions.Keys | Where-Object { $_ -ieq $relative } | Select-Object -First 1)) {
        throw "Registered public addition casing differs from Git: $relative"
      }
      if ([string]$file.objectId -cne [string]$additions[$relative].objectId) {
        throw "Registered public addition object differs from review: $relative"
      }
      [void]$seenAdditions.Add($relative)
      continue
    }
    [void]$basePaths[$zone].Add($relative)
  }

  if ($seenAdditions.Count -ne $additions.Count) {
    $missing = @(
      $additions.Keys |
        Where-Object { -not $seenAdditions.Contains($_) } |
        Sort-Object
    )
    throw "Public structure registry additions are missing from the pinned commit: $($missing -join ', ')"
  }

  foreach ($zone in $MonarchPublicRequiredLockedZones) {
    [string[]]$paths = $basePaths[$zone].ToArray()
    $expected = $Registry.zones.PSObject.Properties[$zone].Value
    $digest = Get-MonarchPathSetDigest $paths
    if ($paths.Count -ne [int]$expected.baseCount -or
        $digest -cne [string]$expected.basePathDigest) {
      throw "Locked public zone changed without registry review: $zone (count $($paths.Count), digest $digest)"
    }
  }
}

function Read-MonarchGitBlobBytes {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [Parameter(Mandatory = $true)][string] $ObjectId,
    [Parameter(Mandatory = $true)][long] $ExpectedSize,
    [long] $MaxBytes = $MonarchPublicDefaultMaxFileBytes
  )

  if ($ObjectId -notmatch '^[0-9a-f]{40}$' -or
      $ExpectedSize -lt 0 -or
      $ExpectedSize -gt $MaxBytes) {
    throw "Invalid bounded Git blob preflight: $ObjectId"
  }
  $bytes = Invoke-MonarchGitRaw `
    $SourceRoot `
    "cat-file blob $ObjectId" `
    -MaxOutputBytes ([Math]::Max([long]1, $ExpectedSize))
  if ([long]$bytes.LongLength -ne $ExpectedSize) {
    throw "Git blob length differs during content preflight: $ObjectId"
  }
  if ((Get-MonarchGitBlobId $bytes) -cne $ObjectId) {
    throw "Git blob bytes differ during content preflight: $ObjectId"
  }
  return ,$bytes
}

function Assert-MonarchPublicBlobContent {
  param(
    [Parameter(Mandatory = $true)][string] $RelativePath,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes
  )

  if (Test-MonarchSensitiveSourceName $RelativePath) {
    throw "Public candidate has a sensitive-looking source name: $RelativePath"
  }
  if (Test-MonarchPublicTextSource $RelativePath) {
    $content = ConvertFrom-MonarchStrictUtf8 $Bytes $RelativePath
    foreach ($pattern in $MonarchPublicForbiddenContentPatterns) {
      if ($content -match $pattern) {
        throw "Public Git text matched forbidden content pattern in $RelativePath`: $pattern"
      }
    }
    return
  }
  if (-not $MonarchPublicReviewedBinarySha256.ContainsKey($RelativePath) -or
      (Get-MonarchSha256Hex $Bytes) -cne [string]$MonarchPublicReviewedBinarySha256[$RelativePath]) {
    throw "Public Git binary is not byte-for-byte reviewed: $RelativePath"
  }
}

function New-MonarchPublicSnapshotPlan {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [string] $SourceRevision = 'HEAD',
    [long] $MaxSourceBytes = $MonarchPublicDefaultMaxFileBytes,
    [long] $MaxTotalSourceBytes = $MonarchPublicDefaultMaxTotalBytes,
    [int] $MaxPublicFiles = $MonarchPublicDefaultMaxFiles
  )

  if ($MaxSourceBytes -le 0 -or $MaxTotalSourceBytes -le 0 -or $MaxPublicFiles -le 0) {
    throw 'Public snapshot limits must all be positive.'
  }
  $root = [System.IO.Path]::GetFullPath($SourceRoot)
  $commit = Resolve-MonarchPublicSourceRevision $root $SourceRevision
  $treeRecords = @(Get-MonarchGitTreeRecords $root $commit)
  $treeByPath = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($record in $treeRecords) {
    if ($treeByPath.ContainsKey($record.path)) {
      throw "Git tree contains a case-insensitive path collision: $($record.path)"
    }
    $treeByPath.Add($record.path, $record)
  }

  $boundaryRecords = @{}
  foreach ($relativePath in $MonarchPublicBoundaryScripts) {
    if (-not $treeByPath.ContainsKey($relativePath)) {
      throw "Pinned commit is missing publication boundary script: $relativePath"
    }
    $treeRecord = $treeByPath[$relativePath]
    if ($treeRecord.objectType -ne 'blob' -or $treeRecord.mode -notin @('100644', '100755')) {
      throw "Publication boundary script is not a regular Git blob: $relativePath"
    }
    $workingRecord = Get-MonarchRegularFileRecord (Join-Path $root $relativePath) $relativePath
    if ($workingRecord.gitBlobId -ne $treeRecord.objectId) {
      throw "Publication boundary script differs from pinned commit: $relativePath"
    }
    $boundaryRecords[$relativePath] = $workingRecord
  }

  $included = New-Object System.Collections.Generic.List[object]
  $seenIncluded = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($record in $treeRecords) {
    if (-not (Test-MonarchPublicCandidatePath $record.path)) {
      continue
    }
    if ($record.objectType -ne 'blob' -or $record.mode -notin @('100644', '100755')) {
      throw "Public candidate is not a regular Git blob: $($record.path) [$($record.mode) $($record.objectType)]"
    }
    if (-not $seenIncluded.Add($record.path)) {
      throw "Public candidates contain a case-insensitive path collision: $($record.path)"
    }
    if (Test-MonarchSensitiveSourceName $record.path) {
      throw "Public candidate has a sensitive-looking source name: $($record.path)"
    }
    [void]$included.Add($record)
  }
  if ($included.Count -gt $MaxPublicFiles) {
    throw "Public candidate count exceeds preflight limit: $($included.Count) > $MaxPublicFiles"
  }

  $plannedFiles = New-Object System.Collections.Generic.List[object]
  [long]$plannedTotalBytes = 0
  foreach ($record in $included) {
    $blobSize = [long]$record.objectSize
    if ($blobSize -lt 0) {
      throw "Public Git blob has an invalid preflight size: $($record.path)"
    }
    if ($blobSize -gt $MaxSourceBytes) {
      throw "Public Git blob exceeds preflight file limit: $($record.path) ($blobSize > $MaxSourceBytes)"
    }
    $plannedTotalBytes += $blobSize
    if ($plannedTotalBytes -gt $MaxTotalSourceBytes) {
      throw "Public Git blobs exceed preflight total limit: $plannedTotalBytes > $MaxTotalSourceBytes"
    }
    [void]$plannedFiles.Add([pscustomobject]@{
      mode = $record.mode
      objectType = $record.objectType
      objectId = $record.objectId
      path = $record.path
      size = $blobSize
    })
  }

  $structureRegistryRecord = $boundaryRecords[$MonarchPublicStructureRegistryPath]
  $structureRegistry = Read-MonarchPublicStructureRegistry $structureRegistryRecord.bytes
  Assert-MonarchPublicStructureRegistry $plannedFiles.ToArray() $structureRegistry
  foreach ($plannedFile in $plannedFiles) {
    $preflightBytes = Read-MonarchGitBlobBytes `
      $root `
      $plannedFile.objectId `
      $plannedFile.size `
      $MaxSourceBytes
    Assert-MonarchPublicBlobContent $plannedFile.path $preflightBytes
  }

  $policyRecord = $boundaryRecords['scripts/public-source-policy.ps1']
  $combinedPolicyBytes = [byte[]]::new(
    $policyRecord.bytes.Length + 1 + $structureRegistryRecord.bytes.Length
  )
  [System.Buffer]::BlockCopy(
    $policyRecord.bytes,
    0,
    $combinedPolicyBytes,
    0,
    $policyRecord.bytes.Length
  )
  $combinedPolicyBytes[$policyRecord.bytes.Length] = 0
  [System.Buffer]::BlockCopy(
    $structureRegistryRecord.bytes,
    0,
    $combinedPolicyBytes,
    $policyRecord.bytes.Length + 1,
    $structureRegistryRecord.bytes.Length
  )

  return [pscustomobject]@{
    sourceRoot = $root
    sourceRevision = $commit
    policyDigest = Get-MonarchSha256Hex $combinedPolicyBytes
    structureRegistryDigest = $structureRegistryRecord.sha256
    files = $plannedFiles.ToArray()
    totalBytes = $plannedTotalBytes
    maxSourceBytes = $MaxSourceBytes
    maxTotalSourceBytes = $MaxTotalSourceBytes
    maxPublicFiles = $MaxPublicFiles
  }
}

function Write-MonarchGitBlobToFile {
  param(
    [Parameter(Mandatory = $true)][string] $SourceRoot,
    [Parameter(Mandatory = $true)][string] $ObjectId,
    [Parameter(Mandatory = $true)][string] $TargetPath,
    [Parameter(Mandatory = $true)][long] $ExpectedSize,
    [long] $MaxBytes = $MonarchPublicDefaultMaxFileBytes
  )

  if ($ObjectId -notmatch '^[0-9a-f]{40}$' -or
      $ExpectedSize -lt 0 -or
      $ExpectedSize -gt $MaxBytes) {
    throw "Invalid Git blob id: $ObjectId"
  }
  $target = [System.IO.Path]::GetFullPath($TargetPath)
  if (Test-Path -LiteralPath $target) {
    throw "Refusing to overwrite a snapshot file: $target"
  }
  $targetParent = Split-Path -Parent $target
  [System.IO.Directory]::CreateDirectory($targetParent) | Out-Null
  Assert-MonarchNoReparsePath $targetParent

  $startInfo = New-MonarchGitProcessStartInfo $SourceRoot "cat-file blob $ObjectId"

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Could not read Git blob: $ObjectId"
  }
  try {
    $errorTask = $process.StandardError.ReadToEndAsync()
    $fileStream = [System.IO.File]::Open(
      $target,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    try {
      $copyBuffer = [byte[]]::new(65536)
      [long]$copiedBytes = 0
      while ($true) {
        $remainingBytes = $ExpectedSize - $copiedBytes
        $readLimit = [int][Math]::Min(
          [long]$copyBuffer.Length,
          $remainingBytes + 1
        )
        $readCount = $process.StandardOutput.BaseStream.Read(
          $copyBuffer,
          0,
          $readLimit
        )
        if ($readCount -le 0) {
          break
        }
        if ($copiedBytes + $readCount -gt $ExpectedSize) {
          Stop-MonarchProcessTree $process
          [void]$process.WaitForExit(10000)
          throw "Git blob exceeded its preflight length while streaming: $ObjectId"
        }
        $fileStream.Write($copyBuffer, 0, $readCount)
        $copiedBytes += $readCount
      }
      $process.WaitForExit()
      $errorText = $errorTask.Result
      if ($process.ExitCode -ne 0) {
        throw "Could not read Git blob $ObjectId`: $errorText"
      }
      $fileStream.Flush($true)
      if ([long]$fileStream.Length -ne $ExpectedSize) {
        throw "Git blob length differs from preflight: $ObjectId ($($fileStream.Length) != $ExpectedSize)"
      }

      Initialize-MonarchPublicNativeMethods
      $information = New-Object MonarchPublicByHandleFileInformation
      if (-not [MonarchPublicNativeMethods]::GetFileInformationByHandle(
          $fileStream.SafeFileHandle,
          [ref]$information
        )) {
        $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Could not inspect exported file identity for $target (Win32 $errorCode)."
      }
      if (($information.FileAttributes -band [uint32][System.IO.FileAttributes]::Directory) -ne 0 -or
          ($information.FileAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          $information.NumberOfLinks -ne 1) {
        throw "Exported file identity is not a unique regular file: $target"
      }
      Assert-MonarchNoAlternateDataStreams $target

      $fileStream.Position = 0
      $bytes = [byte[]]::new([int]$ExpectedSize)
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $read = $fileStream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -le 0) {
          throw "Exported Git blob ended before its locked length: $ObjectId"
        }
        $offset += $read
      }
      if ($fileStream.ReadByte() -ne -1) {
        throw "Exported Git blob grew while held exclusively: $ObjectId"
      }
      $gitBlobId = Get-MonarchGitBlobId $bytes
      if ($gitBlobId -cne $ObjectId) {
        throw "Git object export changed bytes: $ObjectId"
      }
      return [pscustomobject]@{
        path = ''
        fullPath = $target
        volumeSerialNumber = [uint32]$information.VolumeSerialNumber
        fileIndexHigh = [uint32]$information.FileIndexHigh
        fileIndexLow = [uint32]$information.FileIndexLow
        size = [long]$bytes.LongLength
        sha256 = Get-MonarchSha256Hex $bytes
        gitBlobId = $gitBlobId
        bytes = $bytes
      }
    } finally {
      $fileStream.Dispose()
    }
  } finally {
    $process.Dispose()
  }
}

function Write-MonarchExclusiveSnapshotMetadata {
  param(
    [Parameter(Mandatory = $true)][string] $TargetPath,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]] $Bytes
  )

  $target = [System.IO.Path]::GetFullPath($TargetPath)
  if (Test-Path -LiteralPath $target) {
    throw "Refusing to overwrite snapshot metadata: $target"
  }
  $targetParent = Split-Path -Parent $target
  Assert-MonarchNoReparsePath $targetParent
  $stream = [System.IO.File]::Open(
    $target,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
  try {
    if ($Bytes.Length -gt 0) {
      $stream.Write($Bytes, 0, $Bytes.Length)
    }
    $stream.Flush($true)
    Initialize-MonarchPublicNativeMethods
    $information = New-Object MonarchPublicByHandleFileInformation
    if (-not [MonarchPublicNativeMethods]::GetFileInformationByHandle(
        $stream.SafeFileHandle,
        [ref]$information
      )) {
      $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Could not inspect snapshot metadata identity for $target (Win32 $errorCode)."
    }
    if (($information.FileAttributes -band [uint32][System.IO.FileAttributes]::Directory) -ne 0 -or
        ($information.FileAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $information.NumberOfLinks -ne 1 -or
        [long]$stream.Length -ne [long]$Bytes.LongLength) {
      throw "Snapshot metadata is not a unique regular file: $target"
    }
    Assert-MonarchNoAlternateDataStreams $target
    Assert-MonarchNoReparsePath $targetParent
    $finalInformation = New-Object MonarchPublicByHandleFileInformation
    if (-not [MonarchPublicNativeMethods]::GetFileInformationByHandle(
        $stream.SafeFileHandle,
        [ref]$finalInformation
      )) {
      $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Could not re-inspect snapshot metadata identity for $target (Win32 $errorCode)."
    }
    if ($finalInformation.VolumeSerialNumber -ne $information.VolumeSerialNumber -or
        $finalInformation.FileIndexHigh -ne $information.FileIndexHigh -or
        $finalInformation.FileIndexLow -ne $information.FileIndexLow -or
        $finalInformation.NumberOfLinks -ne 1 -or
        $finalInformation.FileAttributes -ne $information.FileAttributes -or
        $finalInformation.FileSizeHigh -ne $information.FileSizeHigh -or
        $finalInformation.FileSizeLow -ne $information.FileSizeLow) {
      throw "Snapshot metadata identity changed while held: $target"
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-MonarchSnapshotInventory {
  param(
    [Parameter(Mandatory = $true)][string] $SnapshotPath,
    [long] $MaxSourceBytes = 5242880,
    [long] $MaxTotalBytes = 134217728,
    [int] $MaxFiles = 2001,
    [int] $MaxDirectories = 8001,
    [System.Collections.Generic.HashSet[string]] $ExpectedFiles = $null,
    [System.Collections.Generic.HashSet[string]] $ExpectedDirectories = $null
  )

  if ($MaxSourceBytes -le 0 -or
      $MaxTotalBytes -le 0 -or
      $MaxFiles -le 0 -or
      $MaxDirectories -le 0) {
    throw 'Snapshot inventory limits must be positive.'
  }
  $root = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SnapshotPath).Path)
  Assert-MonarchNoReparsePath $root
  $files = New-Object System.Collections.Generic.List[object]
  $directories = New-Object System.Collections.Generic.List[string]
  [void]$directories.Add('')
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($root)
  [long]$totalBytes = 0

  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $entryEnumerator = [System.IO.Directory]::EnumerateFileSystemEntries(
      $directory
    ).GetEnumerator()
    try {
      while ($entryEnumerator.MoveNext()) {
        $entryPath = [string]$entryEnumerator.Current
        $item = Get-Item -LiteralPath $entryPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($item.PSObject.Properties['LinkType'] -and $item.LinkType)) {
          throw "Snapshot contains a linked/reparse entry: $($item.FullName)"
        }
        $relative = $item.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
        if ($item.PSIsContainer) {
          if ($null -ne $ExpectedDirectories -and
              -not $ExpectedDirectories.Contains($relative)) {
            throw "Snapshot contains an unexpected directory before inventory: $relative"
          }
          if ($directories.Count -ge $MaxDirectories) {
            throw "Snapshot exceeds the bounded directory limit: $MaxDirectories"
          }
          [void]$directories.Add($relative)
          $pending.Push($item.FullName)
          continue
        }
        if ($null -ne $ExpectedFiles -and -not $ExpectedFiles.Contains($relative)) {
          throw "Snapshot contains an unexpected file before read: $relative"
        }
        if ($files.Count -ge $MaxFiles) {
          throw "Snapshot exceeds the bounded file limit: $MaxFiles"
        }
        $announcedLength = [long]$item.Length
        if ($announcedLength -gt $MaxSourceBytes -or
            $totalBytes + $announcedLength -gt $MaxTotalBytes) {
          throw "Snapshot exceeds its bounded byte limit before read: $relative"
        }
        $record = Get-MonarchRegularFileRecord $item.FullName $relative $MaxSourceBytes
        if ([long]$record.size -ne $announcedLength) {
          throw "Snapshot file length changed during inventory: $relative"
        }
        $totalBytes += [long]$record.size
        [void]$files.Add($record)
      }
    } finally {
      if ($entryEnumerator -is [System.IDisposable]) {
        $entryEnumerator.Dispose()
      }
    }
  }

  return [pscustomobject]@{
    root = $root
    files = $files.ToArray()
    directories = $directories.ToArray()
    totalBytes = $totalBytes
  }
}

function Get-MonarchExpectedSnapshotDirectories {
  param([Parameter(Mandatory = $true)][object[]] $Files)

  $directories = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [void]$directories.Add('')
  foreach ($file in $Files) {
    $directory = [System.IO.Path]::GetDirectoryName($file.path.Replace('/', '\'))
    while (-not [string]::IsNullOrWhiteSpace($directory)) {
      $normalized = $directory.Replace('\', '/')
      [void]$directories.Add($normalized)
      $directory = [System.IO.Path]::GetDirectoryName($directory)
    }
  }
  return $directories
}

function Test-MonarchPublicSnapshot {
  param(
    [Parameter(Mandatory = $true)][string] $SnapshotPath,
    [Parameter(Mandatory = $true)][object] $Plan,
    [long] $MaxSourceBytes = 5242880
  )

  $snapshotFullPath = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $SnapshotPath).Path
  )
  $sourceFullPath = [System.IO.Path]::GetFullPath($Plan.sourceRoot).TrimEnd('\')
  if ($snapshotFullPath -eq $sourceFullPath -or
      $snapshotFullPath.StartsWith(
        "$sourceFullPath\",
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw 'A public snapshot cannot live inside the private source tree.'
  }
  Assert-MonarchNoGitRepositoryContext $snapshotFullPath

  $expectedInventoryFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [void]$expectedInventoryFiles.Add($MonarchPublicSnapshotMarkerName)
  foreach ($expectedFile in @($Plan.files)) {
    [void]$expectedInventoryFiles.Add([string]$expectedFile.path)
  }
  $expectedDirectories = Get-MonarchExpectedSnapshotDirectories @($Plan.files)
  $inventory = Get-MonarchSnapshotInventory `
    $snapshotFullPath `
    $MaxSourceBytes `
    ([long]$Plan.totalBytes + $MaxSourceBytes) `
    ($Plan.files.Count + 1) `
    $expectedDirectories.Count `
    $expectedInventoryFiles `
    $expectedDirectories
  $markerRecords = @($inventory.files | Where-Object { $_.path -eq $MonarchPublicSnapshotMarkerName })
  if ($markerRecords.Count -ne 1) {
    throw "Snapshot must contain exactly one $MonarchPublicSnapshotMarkerName manifest."
  }
  $manifestText = ConvertFrom-MonarchStrictUtf8 $markerRecords[0].bytes $MonarchPublicSnapshotMarkerName
  try {
    $manifest = $manifestText | ConvertFrom-Json
  } catch {
    throw "Snapshot manifest is not valid JSON: $($_.Exception.Message)"
  }
  if ([int]$manifest.schemaVersion -ne $MonarchPublicSnapshotSchemaVersion -or
      [string]$manifest.kind -ne 'monarch-public-snapshot' -or
      [string]$manifest.historyBoundary -ne 'fresh-unrelated') {
    throw 'Snapshot manifest has an unsupported schema or history boundary.'
  }
  if ([string]$manifest.sourceRevision -cne [string]$Plan.sourceRevision) {
    throw 'Snapshot sourceRevision does not match the pinned full commit.'
  }
  if ([string]$manifest.policyDigest -cne [string]$Plan.policyDigest) {
    throw 'Snapshot policyDigest does not match the pinned publication policy.'
  }
  if ([string]$manifest.structureRegistryDigest -cne [string]$Plan.structureRegistryDigest) {
    throw 'Snapshot structureRegistryDigest does not match the pinned registry.'
  }

  $expectedByPath = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($expected in @($Plan.files)) {
    $expectedByPath.Add($expected.path, $expected)
  }
  $manifestFiles = @($manifest.files)
  if ($manifestFiles.Count -ne $expectedByPath.Count) {
    throw "Snapshot manifest file count differs from pinned commit: $($manifestFiles.Count) != $($expectedByPath.Count)"
  }
  if ([int]$manifest.totalFiles -ne $expectedByPath.Count) {
    throw 'Snapshot manifest totalFiles is inconsistent.'
  }

  $actualByPath = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($actual in @($inventory.files)) {
    if ($actual.path -eq $MonarchPublicSnapshotMarkerName) {
      continue
    }
    if ($actualByPath.ContainsKey($actual.path)) {
      throw "Snapshot contains a case-insensitive path collision: $($actual.path)"
    }
    $actualByPath.Add($actual.path, $actual)
  }
  if ($actualByPath.Count -ne $expectedByPath.Count) {
    throw "Snapshot contains missing or extra files: $($actualByPath.Count) != $($expectedByPath.Count)"
  }

  $seenManifest = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [long]$totalBytes = 0
  foreach ($entry in $manifestFiles) {
    $relative = [string]$entry.path
    if (-not (Test-MonarchPublicCandidatePath $relative)) {
      throw "Snapshot manifest contains a non-public path: $relative"
    }
    if (-not $seenManifest.Add($relative)) {
      throw "Snapshot manifest contains a duplicate path: $relative"
    }
    if (-not $expectedByPath.ContainsKey($relative) -or
        -not $actualByPath.ContainsKey($relative)) {
      throw "Snapshot manifest contains an unexpected or missing path: $relative"
    }

    $expected = $expectedByPath[$relative]
    $actual = $actualByPath[$relative]
    if ($relative -cne [string]$expected.path -or $relative -cne [string]$actual.path) {
      throw "Snapshot path casing differs from the pinned commit: $relative"
    }
    if ([string]$entry.mode -cne [string]$expected.mode -or
        [string]$entry.mode -notin @('100644', '100755')) {
      throw "Snapshot manifest contains a non-regular or wrong Git mode: $relative"
    }
    if ([long]$entry.size -ne [long]$actual.size) {
      throw "Snapshot manifest size mismatch: $relative"
    }
    if ([string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$entry.sha256 -cne [string]$actual.sha256) {
      throw "Snapshot manifest SHA-256 mismatch: $relative"
    }
    if ([string]$actual.gitBlobId -cne [string]$expected.objectId) {
      throw "Snapshot bytes differ from pinned commit: $relative"
    }
    if ([long]$actual.size -gt $MaxSourceBytes) {
      throw "Snapshot file exceeds $MaxSourceBytes bytes: $relative"
    }
    if (Test-MonarchSensitiveSourceName $relative) {
      throw "Snapshot contains a sensitive-looking source name: $relative"
    }

    if (Test-MonarchPublicTextSource $relative) {
      $content = ConvertFrom-MonarchStrictUtf8 $actual.bytes $relative
      foreach ($pattern in $MonarchPublicForbiddenContentPatterns) {
        if ($content -match $pattern) {
          throw "Snapshot text matched forbidden content pattern in $relative`: $pattern"
        }
      }
    } elseif (-not $MonarchPublicReviewedBinarySha256.ContainsKey($relative) -or
        [string]$actual.sha256 -cne [string]$MonarchPublicReviewedBinarySha256[$relative]) {
      throw "Snapshot binary is not byte-for-byte reviewed: $relative"
    }
    $totalBytes += [long]$actual.size
  }

  if ([long]$manifest.totalBytes -ne $totalBytes) {
    throw 'Snapshot manifest totalBytes is inconsistent.'
  }

  foreach ($directory in @($inventory.directories)) {
    if (-not $expectedDirectories.Contains($directory)) {
      throw "Snapshot contains an extra directory: $directory"
    }
  }
  if ($inventory.directories.Count -ne $expectedDirectories.Count) {
    throw 'Snapshot contains missing directories.'
  }

  return [pscustomobject]@{
    snapshot = $inventory.root
    sourceRevision = $Plan.sourceRevision
    policyDigest = $Plan.policyDigest
    structureRegistryDigest = $Plan.structureRegistryDigest
    files = $expectedByPath.Count
    bytes = $totalBytes
    textFiles = @($manifestFiles | Where-Object { Test-MonarchPublicTextSource ([string]$_.path) }).Count
    binaryFiles = @($manifestFiles | Where-Object { -not (Test-MonarchPublicTextSource ([string]$_.path)) }).Count
    violations = 0
  }
}

function Remove-MonarchValidatedSnapshot {
  param(
    [Parameter(Mandatory = $true)][string] $SnapshotPath,
    [Parameter(Mandatory = $true)][object] $Plan,
    [long] $MaxSourceBytes = $MonarchPublicDefaultMaxFileBytes
  )

  [void](Test-MonarchPublicSnapshot $SnapshotPath $Plan $MaxSourceBytes)
  $expectedFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [void]$expectedFiles.Add($MonarchPublicSnapshotMarkerName)
  foreach ($expectedFile in @($Plan.files)) {
    [void]$expectedFiles.Add([string]$expectedFile.path)
  }
  $expectedDirectories = Get-MonarchExpectedSnapshotDirectories @($Plan.files)
  $inventory = Get-MonarchSnapshotInventory `
    $SnapshotPath `
    $MaxSourceBytes `
    ([long]$Plan.totalBytes + $MaxSourceBytes) `
    ($Plan.files.Count + 1) `
    $expectedDirectories.Count `
    $expectedFiles `
    $expectedDirectories
  foreach ($file in @($inventory.files | Sort-Object { $_.path.Length } -Descending)) {
    [void](Get-MonarchRegularFileRecord $file.fullPath $file.path $MaxSourceBytes)
    Remove-Item -LiteralPath $file.fullPath -Force
  }
  foreach ($relativeDirectory in @(
      $inventory.directories |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object { $_.Length } -Descending
    )) {
    $directoryPath = Join-Path $inventory.root $relativeDirectory
    Assert-MonarchNoReparsePath $directoryPath
    Remove-Item -LiteralPath $directoryPath -Force
  }
  Assert-MonarchNoReparsePath $inventory.root
  Remove-Item -LiteralPath $inventory.root -Force
}
