param([Parameter(Mandatory=$true)][string]$NativeBinary, [Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$fixturePath = (Resolve-Path -LiteralPath $FixtureRoot).ProviderPath
$binaryPath = (Resolve-Path -LiteralPath $NativeBinary).ProviderPath
if (-not $fixturePath.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase) -or
    -not $binaryPath.StartsWith($fixturePath + '\', [StringComparison]::OrdinalIgnoreCase) -or
    [IO.File]::ReadAllText((Join-Path $fixturePath '.fixture-marker')) -ne 'astra-computer-native-binding-pure-check') {
  throw 'Exact owned native fixture required'
}
# Reflection calls only pure metadata/envelope methods: no enumeration, capture,
# process launch, UI Automation or input is invoked from the compiled provider.
$assembly = [Reflection.Assembly]::LoadFrom($binaryPath)
$program = $assembly.GetType('MonarchComputerUse.Program', $true)
$method = $program.GetMethod('VerifyObservationSelection', [Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $method) { throw 'Missing native selection validator' }
$summary = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$summary.Add('processId', [int]42)
$processInstanceId = 'process:' + ('4' * 64)
$summary.Add('processInstanceId', $processInstanceId)
$summary.Add('title', 'Exact QA title')
function Test-Selection($Name, $Values, $Expected) {
  $selection = $null
  if ($null -ne $Values) {
    $selection = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    foreach ($entry in $Values.GetEnumerator()) { $selection.Add($entry.Key, $entry.Value) }
  }
  $outcome = 'accepted'
  $arguments = New-Object 'System.Object[]' 2
  $arguments[0] = $summary.PSObject.BaseObject
  $arguments[1] = if ($null -eq $selection) { $null } else { $selection.PSObject.BaseObject }
  try { $method.Invoke($null, $arguments) | Out-Null }
  catch {
    $cause = $_.Exception
    while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    $field = $cause.GetType().GetField('Code', [Reflection.BindingFlags]'NonPublic,Instance')
    if ($null -eq $field) { throw }
    $outcome = [string]$field.GetValue($cause)
  }
  if ($outcome -ne $Expected) { throw "Native binding case $Name returned $outcome instead of $Expected" }
  return @{ case=$Name; result=$outcome; passed=$true }
}
$results = @(
  (Test-Selection 'legacy-without-binding' $null 'accepted'),
  (Test-Selection 'exact' @{processId=[int]42; processInstanceId=$processInstanceId; title='Exact QA title'} 'accepted'),
  (Test-Selection 'different-process' @{processId=[int]43; processInstanceId=$processInstanceId; title='Exact QA title'} 'window-selection-stale'),
  (Test-Selection 'different-instance' @{processId=[int]42; processInstanceId=('process:' + ('5' * 64)); title='Exact QA title'} 'window-selection-stale'),
  (Test-Selection 'different-title' @{processId=[int]42; processInstanceId=$processInstanceId; title='Another title'} 'window-selection-stale'),
  (Test-Selection 'no-trimming' @{processId=[int]42; processInstanceId=$processInstanceId; title=' Exact QA title'} 'window-selection-stale'),
  (Test-Selection 'missing-process' @{processInstanceId=$processInstanceId; title='Exact QA title'} 'window-selection-binding-invalid'),
  (Test-Selection 'missing-instance' @{processId=[int]42; title='Exact QA title'} 'window-selection-binding-invalid'),
  (Test-Selection 'invalid-instance' @{processId=[int]42; processInstanceId='process:invalid'; title='Exact QA title'} 'window-selection-binding-invalid'),
  (Test-Selection 'string-process' @{processId='42'; processInstanceId=$processInstanceId; title='Exact QA title'} 'window-selection-binding-invalid'),
  (Test-Selection 'fractional-process' @{processId=42.5; processInstanceId=$processInstanceId; title='Exact QA title'} 'window-selection-binding-invalid'),
  (Test-Selection 'extra-field' @{processId=[int]42; processInstanceId=$processInstanceId; title='Exact QA title'; allowFallback=$true} 'window-selection-binding-invalid')
)
$enteredField = $program.GetField('actionEntered', [Reflection.BindingFlags]'NonPublic,Static')
$possibleField = $program.GetField('actionMayHaveDispatched', [Reflection.BindingFlags]'NonPublic,Static')
$failureMethod = $program.GetMethod('WriteFailure', [Reflection.BindingFlags]'NonPublic,Static')
foreach ($case in @(@{name='non-action'; entered=$false; possible=$false; expected=$null},
    @{name='action-preflight'; entered=$true; possible=$false; expected='not-dispatched'},
    @{name='action-after-entry'; entered=$true; possible=$true; expected='may-have-dispatched'})) {
  $enteredField.SetValue($null, $case.entered)
  $possibleField.SetValue($null, $case.possible)
  $outputPath = Join-Path $fixturePath ('failure-envelope-' + $case.name + '.json')
  if (Test-Path -LiteralPath $outputPath) { throw 'Refuse to overwrite retained native proof' }
  $failureArgs = New-Object 'System.Object[]' 3
  $failureArgs[0] = $outputPath.PSObject.BaseObject
  $failureArgs[1] = 'window-not-found'
  $failureArgs[2] = 'Synthetic pure envelope check'
  $failureMethod.Invoke($null, $failureArgs) | Out-Null
  $envelope = [IO.File]::ReadAllText($outputPath) | ConvertFrom-Json
  if ($envelope.actionDispatchState -ne $case.expected) { throw ('Native phase mismatch: ' + $case.name) }
  $results += @{case=$case.name; result=$envelope.actionDispatchState; passed=$true}
}
$textMethod = $program.GetMethod('ExactActionText', [Reflection.BindingFlags]'NonPublic,Static')
$modeMethod = $program.GetMethod('ReadTextMode', [Reflection.BindingFlags]'NonPublic,Static')
$fallbackMethod = $program.GetMethod('CanUseExactSemanticDispatch', [Reflection.BindingFlags]'NonPublic,Static')
$unicodeText = '  exact ' + [char]::ConvertFromUtf32(0x1F7E0) + "`r`n  "
foreach ($case in @(@{name='default-insert-exact'; text=$unicodeText},
    @{name='insert-whitespace'; text='   '; mode='insert'},
    @{name='replace-empty'; text=''; mode='replace'},
    @{name='replace-exact'; text=$unicodeText; mode='replace'},
    @{name='empty-insert'; text=''; mode='insert'; reject=$true},
    @{name='invalid-mode'; text='x'; mode='auto'; reject=$true},
    @{name='null-mode'; text='x'; mode=$null; reject=$true},
    @{name='numeric-text'; text=42; mode='replace'; reject=$true},
    @{name='unpaired-surrogate'; text=([string][char]0xD800); reject=$true},
    @{name='nul-text'; text=([string][char]0); mode='replace'; reject=$true},
    @{name='oversized-text'; text=('x' * 4001); reject=$true})) {
  $action = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $action.Add('kind', 'type')
  $action.Add('text', $case.text)
  if ($case.ContainsKey('mode')) { $action.Add('textMode', $case.mode) }
  $target = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $target.Add('elementId', 'synthetic-element')
  $action.Add('target', $target.PSObject.BaseObject)
  $arguments = New-Object 'System.Object[]' 1
  $arguments[0] = $action.PSObject.BaseObject
  $rejected = $false
  try { $textResult = $textMethod.Invoke($null, $arguments) }
  catch {
    $cause = $_.Exception
    while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    $codeField = $cause.GetType().GetField('Code', [Reflection.BindingFlags]'NonPublic,Instance')
    if ($null -eq $codeField -or $codeField.GetValue($cause) -ne 'computer-text-input-invalid') { throw }
    $rejected = $true
  }
  if ($rejected -ne [bool]$case.reject) { throw ('Text acceptance mismatch: ' + $case.name) }
  if (-not $rejected) {
    if (-not [string]::Equals($textResult, $case.text, [StringComparison]::Ordinal)) { throw ('Text changed: ' + $case.name) }
    $mode = $modeMethod.Invoke($null, $arguments)
    $fallbackArgs = New-Object 'System.Object[]' 3
    $fallbackArgs[0] = $action.PSObject.BaseObject
    $fallbackArgs[1] = 'type'
    $fallbackArgs[2] = $null
    $fallback = $fallbackMethod.Invoke($null, $fallbackArgs)
    if ($fallback -ne ($mode -eq 'replace')) { throw ('Implicit semantic fallback: ' + $case.name) }
  }
  $results += @{case=$case.name; rejected=$rejected; passed=$true}
}
@{ scope='compiled-native-pure-selection-envelope-and-text'; nativeCapture=$false; nativeInput=$false; results=$results } | ConvertTo-Json -Depth 5 -Compress
