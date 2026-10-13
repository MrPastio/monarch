# Cosmetic repair of the EXACT existing response task. No runtime reinstall,
# code/config/key changes, protection stop, or admission/attestation bypass.
[CmdletBinding()]
param([string]$EvidenceRoot = 'E:\MonarchArtifacts\startup-20261001')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$name = 'MonarchSecurityResponseExecutor'
$task = Get-ScheduledTask -TaskName $name -TaskPath '\'
if (@($task.Actions).Count -ne 1) { throw 'Unexpected response task action count' }
$existing = $task.Actions[0]
$expectedExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($existing.Execute -ine $expectedExecutable -or $existing.Arguments -notmatch '^(-NoProfile -NonInteractive )(?:-WindowStyle Hidden )?(-EncodedCommand [A-Za-z0-9+/=]+)$') {
  throw 'Unexpected response task launch shape; no change made'
}
$newArguments = $Matches[1] + '-WindowStyle Hidden ' + $Matches[2]
$encoded = $Matches[2].Substring('-EncodedCommand '.Length)
$launch = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
if (!$launch.Contains('Response runtime digest mismatch') -or !$launch.Contains('response-service-run')) {
  throw 'Existing task is not an attested response executor; no change made'
}
New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null
Export-ScheduledTask -TaskName $name -TaskPath '\' | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'response-task-before.xml') -Encoding UTF8
if ($newArguments -cne $existing.Arguments) {
  $newAction = New-ScheduledTaskAction -Execute $existing.Execute -Argument $newArguments
  if ($existing.WorkingDirectory) { $newAction.WorkingDirectory = $existing.WorkingDirectory }
  Set-ScheduledTask -TaskName $name -TaskPath '\' -Action $newAction | Out-Null
}
$actual = Get-ScheduledTask -TaskName $name -TaskPath '\'
if ($actual.Actions[0].Execute -cne $existing.Execute -or $actual.Actions[0].Arguments -cne $newArguments) { throw 'Task repair readback mismatch' }
$original = Export-ScheduledTask -TaskName $name -TaskPath '\'
$original | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'response-task-after.xml') -Encoding UTF8
@{ task = $name; windowStyle = 'Hidden'; encodedLaunchPreserved = $true; restarted = $false } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'response-task-repair.json') -Encoding UTF8
Write-Output 'Response task launch is hidden; attested payload preserved; task was not restarted.'
