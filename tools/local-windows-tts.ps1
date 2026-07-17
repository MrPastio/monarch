$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) {
  throw 'Speech request is empty.'
}

$request = $payload | ConvertFrom-Json
$text = [string]$request.text
if ([string]::IsNullOrWhiteSpace($text)) {
  throw 'Speech text is empty.'
}
if ($text.Length -gt 64000) {
  throw 'Speech text exceeds the local safety limit.'
}

Add-Type -AssemblyName System.Speech
$synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$probeStream = $null

try {
  $language = if ($request.language) { [string]$request.language } else { 'ru-RU' }
  $rate = [Math]::Max(-2, [Math]::Min(2, [int]$request.rate))
  $volume = if ($null -ne $request.volume) {
    [Math]::Max(0, [Math]::Min(100, [int]$request.volume))
  } else {
    100
  }
  $voices = @($synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  if ($voices.Count -eq 0) {
    throw 'No enabled Windows speech voices are installed.'
  }

  $preferredNames = switch -Regex ($language) {
    '^ru' { @('Microsoft Pavel', 'Microsoft Irina', 'Microsoft Irina Desktop'); break }
    '^uk' { @('Microsoft Ostap', 'Microsoft Polina', 'Microsoft Pavel'); break }
    '^bg' { @('Microsoft Ivan', 'Microsoft Kalina', 'Microsoft Pavel'); break }
    '^en' { @('Microsoft Guy', 'Microsoft Mark', 'Microsoft Zira', 'Microsoft David'); break }
    default { @('Microsoft Pavel', 'Microsoft Zira') }
  }

  $selected = $null
  foreach ($name in $preferredNames) {
    $selected = $voices | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($selected) { break }
  }
  if (-not $selected) {
    $selected = $voices |
      Where-Object { $_.Culture.Name -eq $language } |
      Sort-Object @{ Expression = { if ($_.Name -match 'Desktop') { 1 } else { 0 } } }, Name |
      Select-Object -First 1
  }
  if (-not $selected -and $language -match '^(uk|bg)') {
    $selected = $voices | Where-Object { $_.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
  }
  if (-not $selected) {
    $selected = $voices | Select-Object -First 1
  }

  $synthesizer.SelectVoice($selected.Name)
  $synthesizer.Rate = $rate
  $synthesizer.Volume = $volume
  if ($request.probe -eq $true) {
    $probeStream = [System.IO.MemoryStream]::new()
    $synthesizer.SetOutputToWaveStream($probeStream)
  }
  $synthesizer.Speak($text)

  [Console]::Out.WriteLine((@{
    voice = $synthesizer.Voice.Name
    language = $synthesizer.Voice.Culture.Name
    rate = $synthesizer.Rate
    volume = $synthesizer.Volume
    probeBytes = if ($probeStream) { $probeStream.Length } else { 0 }
  } | ConvertTo-Json -Compress))
}
finally {
  if ($probeStream) { $probeStream.Dispose() }
  $synthesizer.Dispose()
}
