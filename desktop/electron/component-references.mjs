import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Read-only inventory. Returns component roots, never process arguments. */
export async function collectReferencedComponents(roots, { run = execute, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('Component ownership inspection is unavailable.');
  if (!roots.length) return [];
  const encodedRoots = Buffer.from(JSON.stringify(roots), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$roots = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoots}')) | ConvertFrom-Json
$texts = @()
foreach ($process in Get-CimInstance Win32_Process) {
  $texts += [string]$process.ExecutablePath
  $texts += [string]$process.CommandLine
}
foreach ($task in @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Monarch*' })) {
  foreach ($action in $task.Actions) {
    $texts += [string]$action.Execute
    $texts += [string]$action.Arguments
    $texts += [string]$action.WorkingDirectory
  }
}
$referenced = @()
foreach ($root in $roots) {
  $normalized = $root.Replace('/', '\\')
  foreach ($text in $texts) {
    $text = $text.Replace('/', '\\')
    $index = $text.IndexOf($normalized, [StringComparison]::OrdinalIgnoreCase)
    if ($index -lt 0) { continue }
    # Conservatively retain prefix matches too; a false positive costs only disk space.
    $referenced += $root
    break
  }
}
ConvertTo-Json -InputObject @($referenced) -Compress
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  const references = JSON.parse(stdout.trim());
  if (!Array.isArray(references) || references.some(value => typeof value !== 'string' || !roots.includes(value))) {
    throw new Error('Invalid component ownership readback.');
  }
  return references;
}
