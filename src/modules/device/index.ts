import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchExecutionControl,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { permissionModeForRisk } from '../../core';
import { classifyVoiceBrightnessIntent } from './device-brightness';
import {
  classifyVoiceVolumeIntent,
  executeSystemVolumeAction,
  executeVoiceVolumeStatus,
  runWindowsVolumeAction,
  type VoiceVolumeAction,
  type VoiceVolumeState,
} from './device-volume';
import { deviceManifest } from './manifest';

const execFileAsync = promisify(execFile);

export type DevicePowerShellRunner = (
  script: string,
  extraEnv?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<string>;

export class DeviceModule implements MonarchModule {
  readonly manifest = deviceManifest;

  constructor(
    private readonly runPowerShell: DevicePowerShellRunner = runPowerShellCommand,
    private readonly now: () => Date = () => new Date(),
    private readonly runVolume: (action: VoiceVolumeAction) => Promise<VoiceVolumeState> = runWindowsVolumeAction,
  ) {}

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('device.activated', this.manifest.id, {
      platform: process.platform,
      supported: process.platform === 'win32',
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: process.platform === 'win32'
        ? 'Windows device-control capabilities are ready and confirmation-gated.'
        : 'Device-control module is loaded; Windows actions are unavailable on this platform.',
      output: { platform: process.platform, supported: process.platform === 'win32' },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    const clock = extractSystemClockRequest(text);
    if (clock) {
      return route(intent, 'device.system.time.get', 'read', clock, 0.99);
    }
    const volume = classifyVoiceVolumeIntent(intent.text);
    if (volume.kind === 'status') {
      return route(intent, 'device.volume.get', 'read', {}, 0.98);
    }
    if (volume.kind === 'action' && volume.action) {
      return route(intent, 'device.volume.set', 'device-control', { ...volume.action }, 0.98);
    }
    const brightness = classifyVoiceBrightnessIntent(intent.text);
    if (brightness.kind === 'status') {
      return route(intent, 'device.brightness.get', 'read', {}, 0.97);
    }
    if (brightness.kind === 'action') {
      return route(intent, 'device.brightness.set', 'device-control', brightnessRouteInput(brightness.slots), 0.97);
    }
    const browserOpen = extractBrowserOpenRequest(text);
    if (browserOpen) {
      return route(intent, 'device.browser.open', 'device-control', browserOpen, 0.97);
    }
    const app = extractApplicationName(text);
    if (app) {
      return route(intent, 'device.app.open', 'device-control', { app }, 0.96);
    }
    const emptyRecycleBin = /(?:empty|clear|очисти|опустоши).{0,32}(?:recycle\s*bin|корзин)/i.test(text);
    const closeActiveBrowser = /(?:close|закрой|выключи).{0,32}(?:active\s+browser|активн\w*\s+браузер|браузер)/i.test(text);
    if (emptyRecycleBin) {
      return route(intent, 'device.recycle-bin.empty', 'delete', {}, 0.98);
    }
    if (closeActiveBrowser) {
      return route(intent, 'device.browser.close-active', 'device-control', {}, 0.98);
    }
    return null;
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    control: MonarchExecutionControl = {},
  ): Promise<MonarchExecutionResult> {
    if (request.capabilityId === 'device.system.time.get') {
      return this.readSystemTime(request.input, context);
    }
    if (process.platform !== 'win32') {
      return { ok: false, summary: 'This device-control capability requires Windows.', error: 'platform-not-supported' };
    }
    if (control.signal?.aborted) {
      return {
        ok: false,
        summary: 'Действие остановлено до отправки в Windows.',
        error: 'device-action-cancelled',
        output: {
          capabilityId: request.capabilityId,
          verified: false,
          authoritative: true,
          reconciliation: 'not-dispatched',
          cancellationObservedAfterDispatch: false,
        },
      };
    }
    try {
      if (request.capabilityId === 'device.apps.search') {
        return await this.searchInstalledApplications(request.input, context, control.signal);
      }
      if (request.capabilityId === 'device.app.open') {
        return await this.openApplication(request.input, context, control.signal);
      }
      if (request.capabilityId === 'device.browser.open') {
        return await this.openBrowser(request.input, context, control.signal);
      }
      if (request.capabilityId === 'device.volume.get') {
        return await this.controlVolume({ action: 'get' }, context, false, control.signal);
      }
      if (request.capabilityId === 'device.volume.set') {
        return await this.controlVolume(normalizeVolumeRequest(request.input), context, true, control.signal);
      }
      if (request.capabilityId === 'device.brightness.get') {
        return await this.controlBrightness({}, context, false, control.signal);
      }
      if (request.capabilityId === 'device.brightness.set') {
        return await this.controlBrightness(request.input, context, true, control.signal);
      }
      if (request.capabilityId === 'device.recycle-bin.empty') {
        return await this.emptyRecycleBin(context, control.signal);
      }
      if (request.capabilityId === 'device.browser.close-active') {
        return await this.closeActiveBrowser(context, control.signal);
      }
      return { ok: false, summary: `Unsupported device capability: ${request.capabilityId}`, error: 'unsupported-capability' };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          summary: 'Действие остановлено во время отправки. Итоговое состояние Windows не подтверждено.',
          error: 'device-action-state-uncertain',
          output: {
            capabilityId: request.capabilityId,
            verified: false,
            authoritative: true,
            reconciliation: 'uncertain',
            cancellationObservedAfterDispatch: control.signal?.aborted === true,
          },
        };
      }
      return {
        ok: false,
        summary: `Windows action failed: ${safeError(error)}`,
        error: 'device-action-failed',
      };
    }
  }

  private async readSystemTime(
    input: unknown,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const kind = readRecord(input).kind === 'date' ? 'date' : 'time';
    const observedAt = this.now();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    const text = kind === 'date'
      ? `Сегодня ${new Intl.DateTimeFormat('ru-RU', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        }).format(observedAt)}.`
      : `Сейчас ${new Intl.DateTimeFormat('ru-RU', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(observedAt)}.`;
    const output = {
      text,
      kind,
      observedAt: observedAt.toISOString(),
      timeZone,
      performed: false,
      verified: true,
      authoritative: true,
      source: 'system-clock',
    };
    await context.emit('device.system.time.read', this.manifest.id, output);
    return { ok: true, summary: text, output };
  }

  private async controlVolume(
    action: VoiceVolumeAction,
    context: MonarchKernelContext,
    mutating: boolean,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const result = mutating
      ? await executeSystemVolumeAction(action, this.runVolume)
      : await executeVoiceVolumeStatus(this.runVolume);
    const output = {
      ...result,
      authoritative: true,
      verified: true,
      cancellationObservedAfterDispatch: signal?.aborted === true,
    };
    await context.emit(mutating ? 'device.volume.changed' : 'device.volume.read', this.manifest.id, output);
    return { ok: true, summary: result.text, output };
  }

  private async controlBrightness(
    input: unknown,
    context: MonarchKernelContext,
    mutating: boolean,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const request = normalizeBrightnessRequest(input, mutating);
    const output = await this.runPowerShell(`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_DEVICE_REQUEST_B64)) | ConvertFrom-Json
$operation = [string]$request.operation
$readers = @(Get-CimInstance -Namespace 'root/WMI' -ClassName 'WmiMonitorBrightness' -ErrorAction Stop | Where-Object Active)
if ($readers.Count -lt 1) { throw 'Active built-in display brightness is unavailable through Windows WMI.' }
$before = [int]$readers[0].CurrentBrightness
if ($operation -eq 'get') {
  [pscustomobject]@{
    operation = 'get'
    before = $before
    level = $before
    requested = $before
    verified = $true
    performed = $false
    monitorCount = $readers.Count
  } | ConvertTo-Json -Compress
  exit 0
}
if ($operation -eq 'set') {
  $target = [int]$request.value
} elseif ($operation -eq 'change') {
  $target = [Math]::Max(0, [Math]::Min(100, $before + [int]$request.delta))
} else {
  throw "Unsupported brightness operation: $operation"
}
$writers = @(Get-CimInstance -Namespace 'root/WMI' -ClassName 'WmiMonitorBrightnessMethods' -ErrorAction Stop | Where-Object Active)
if ($writers.Count -lt 1) { throw 'Active built-in display brightness cannot be changed through Windows WMI.' }
foreach ($writer in $writers) {
  [void](Invoke-CimMethod -InputObject $writer -MethodName 'WmiSetBrightness' -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$target } -ErrorAction Stop)
}
Start-Sleep -Milliseconds 140
$afterReaders = @(Get-CimInstance -Namespace 'root/WMI' -ClassName 'WmiMonitorBrightness' -ErrorAction Stop | Where-Object Active)
$levels = @($afterReaders | ForEach-Object { [int]$_.CurrentBrightness })
$mismatches = @($levels | Where-Object { [Math]::Abs($_ - $target) -gt 1 })
$verified = $levels.Count -gt 0 -and $mismatches.Count -eq 0
[pscustomobject]@{
  operation = $operation
  before = $before
  level = if ($levels.Count -gt 0) { [int]$levels[0] } else { -1 }
  requested = $target
  verified = $verified
  performed = $true
  monitorCount = $levels.Count
} | ConvertTo-Json -Compress
`, deviceRequestEnv(request), signal);
    const payload = parsePowerShellJson(output);
    const before = readBrightnessLevel(payload.before);
    const level = readBrightnessLevel(payload.level);
    const requested = readBrightnessLevel(payload.requested);
    if (payload.verified !== true || before === null || level === null || requested === null) {
      return {
        ok: false,
        summary: mutating
          ? 'Windows не подтвердил новый уровень яркости.'
          : 'Windows не вернул подтверждённый уровень яркости.',
        error: mutating ? 'brightness-unverified' : 'brightness-read-unverified',
        output: payload,
      };
    }
    const text = mutating
      ? `Яркость установлена на ${level}%.`
      : `Сейчас яркость экрана ${level}%.`;
    await context.emit(
      mutating ? 'device.brightness.changed' : 'device.brightness.read',
      this.manifest.id,
      { operation: request.operation, before, level, requested, verified: true },
    );
    return {
      ok: true,
      summary: text,
      output: {
        ...payload,
        operation: request.operation,
        before,
        level,
        requested,
        verified: true,
        authoritative: true,
        text,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async emptyRecycleBin(
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    await this.runPowerShell(`
$ErrorActionPreference = 'Stop'
Clear-RecycleBin -Force -ErrorAction Stop
[pscustomobject]@{ emptied = $true; verified = $true } | ConvertTo-Json -Compress
`, undefined, signal);
    const payload = {
      emptied: true,
      verified: true,
      cancellationObservedAfterDispatch: signal?.aborted === true,
    };
    await context.emit('device.recycle_bin.emptied', this.manifest.id, payload);
    return { ok: true, summary: 'Windows Recycle Bin emptied.', output: payload };
  }

  private async closeActiveBrowser(
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const output = await this.runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MonarchForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
'@
$handle = [MonarchForegroundWindow]::GetForegroundWindow()
$processId = [uint32]0
[void][MonarchForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction Stop
$allowed = @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi')
if ($allowed -notcontains $process.ProcessName.ToLowerInvariant()) {
  throw "Foreground app is not a supported browser: $($process.ProcessName)"
}
$closed = $process.CloseMainWindow()
if ($closed) {
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    Start-Sleep -Milliseconds 100
    $windowClosed = -not [MonarchForegroundWindow]::IsWindow($handle)
  } while (-not $windowClosed -and [DateTime]::UtcNow -lt $deadline)
} else {
  $windowClosed = $false
}
[pscustomobject]@{ closed = $windowClosed; closeRequested = $closed; verified = $windowClosed; process = $process.ProcessName; processId = $process.Id; windowHandle = $handle.ToInt64() } | ConvertTo-Json -Compress
`, undefined, signal);
    const payload = parsePowerShellJson(output);
    if (payload.closed !== true || payload.verified !== true) {
      return {
        ok: false,
        summary: `Active browser ${String(payload.process || '')} did not accept a graceful close request.`,
        error: 'browser-close-rejected',
        output: payload,
      };
    }
    await context.emit('device.browser.closed', this.manifest.id, payload);
    return {
      ok: true,
      summary: `Closed active browser ${String(payload.process || '')} gracefully.`,
      output: {
        ...payload,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async openApplication(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const app = normalizeApplicationRequest(readRecord(input).app);
    const output = await this.runPowerShell(`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_DEVICE_REQUEST_B64)) | ConvertFrom-Json
$requested = [string]$request.app
$key = $requested.ToLowerInvariant().Trim()
function Test-MonarchVisibleWindow([int]$launchedProcessId, [string[]]$labels) {
  $deadline = [DateTime]::UtcNow.AddSeconds(6)
  do {
    $windows = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
    })
    if (@($windows | Where-Object { $_.Id -eq $launchedProcessId }).Count -gt 0) {
      return $true
    }
    foreach ($label in $labels) {
      $needle = ([string]$label).Trim()
      if ($needle.Length -ge 3 -and @($windows | Where-Object {
        $_.MainWindowTitle -like "*$needle*" -or $_.ProcessName -like "*$needle*"
      }).Count -gt 0) {
        return $true
      }
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}
$direct = @{
  'calculator' = @('calc.exe', 'Калькулятор')
  'notepad' = @('notepad.exe', 'Блокнот')
  'terminal' = @('wt.exe', 'Windows Terminal')
  'explorer' = @('explorer.exe', 'Проводник')
}
$startHints = @{
  'chrome' = @('Google Chrome', 'Chrome')
  'edge' = @('Microsoft Edge', 'Edge')
  'firefox' = @('Firefox', 'Mozilla Firefox')
  'discord' = @('Discord')
  'telegram' = @('Telegram Desktop', 'Telegram')
  'steam' = @('Steam')
  'vscode' = @('Visual Studio Code')
}
if ($key -eq 'browser') {
  $process = Start-Process -FilePath 'https://www.google.com/' -PassThru -ErrorAction Stop
  $verified = Test-MonarchVisibleWindow $process.Id @('chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi')
  [pscustomobject]@{ opened = $verified; verified = $verified; app = 'browser'; displayName = 'Браузер'; processId = $process.Id; launcher = 'default-browser' } | ConvertTo-Json -Compress
  exit 0
}
if ($direct.ContainsKey($key)) {
  $entry = $direct[$key]
  $process = Start-Process -FilePath $entry[0] -PassThru -ErrorAction Stop
  $verified = Test-MonarchVisibleWindow $process.Id @([string]$entry[1], $requested, $key)
  [pscustomobject]@{ opened = $verified; verified = $verified; app = $key; displayName = $entry[1]; processId = $process.Id; launcher = 'direct' } | ConvertTo-Json -Compress
  exit 0
}
$hints = if ($startHints.ContainsKey($key)) { @($startHints[$key]) } else { @($requested) }
$apps = @(Get-StartApps)
$matches = @()
foreach ($hint in $hints) {
  $matches = @($apps | Where-Object { $_.Name -ieq $hint })
  if ($matches.Count -eq 1) { break }
}
if ($matches.Count -ne 1) {
  foreach ($hint in $hints) {
    $matches = @($apps | Where-Object { $_.Name -like "*$hint*" })
    if ($matches.Count -eq 1) { break }
  }
}
if ($matches.Count -ne 1) {
  $resolutionError = if ($matches.Count -eq 0) { 'app-not-found' } else { 'app-ambiguous' }
  [pscustomobject]@{ opened = $false; verified = $false; app = $key; displayName = $requested; error = $resolutionError; matchCount = $matches.Count; candidates = @($matches | Select-Object -First 8 -ExpandProperty Name) } | ConvertTo-Json -Compress
  exit 0
}
$match = $matches[0]
$process = Start-Process -FilePath 'explorer.exe' -ArgumentList @("shell:AppsFolder\\$($match.AppID)") -PassThru -ErrorAction Stop
$verified = Test-MonarchVisibleWindow $process.Id @([string]$match.Name, $requested, $key)
[pscustomobject]@{ opened = $verified; verified = $verified; app = $key; displayName = $match.Name; processId = $process.Id; launcher = 'start-apps' } | ConvertTo-Json -Compress
`, deviceRequestEnv({ app }), signal);
    const payload = parsePowerShellJson(output);
    if (payload.opened !== true || payload.verified !== true) {
      const resolutionError = payload.error === 'app-not-found' || payload.error === 'app-ambiguous'
        ? payload.error
        : 'app-open-unverified';
      return {
        ok: false,
        summary: resolutionError === 'app-not-found'
          ? 'Приложение не найдено в Windows.'
          : resolutionError === 'app-ambiguous'
            ? 'Найдено несколько приложений; нужен точный выбор.'
            : 'Windows не подтвердил запуск приложения.',
        error: resolutionError,
        output: payload,
      };
    }
    await context.emit('device.app.opened', this.manifest.id, payload);
    return {
      ok: true,
      summary: `Открыл ${String(payload.displayName || app)}.`,
      output: {
        ...payload,
        performed: true,
        verified: true,
        authoritative: true,
        text: `Открыл ${String(payload.displayName || app)}.`,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async openBrowser(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const request = normalizeBrowserRequest(input);
    const output = await this.runPowerShell(`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_DEVICE_REQUEST_B64)) | ConvertFrom-Json
$browser = [string]$request.browser
$target = [string]$request.target
$executables = @{ 'chrome' = 'chrome.exe'; 'edge' = 'msedge.exe'; 'firefox' = 'firefox.exe' }
if ($browser -eq 'default') {
  $process = Start-Process -FilePath $target -PassThru -ErrorAction Stop
} else {
  $process = Start-Process -FilePath $executables[$browser] -ArgumentList @($target) -PassThru -ErrorAction Stop
}
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $visibleBrowsers = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi') -contains $_.ProcessName.ToLowerInvariant()
  })
  $verified = @($visibleBrowsers | Where-Object { $_.Id -eq $process.Id }).Count -gt 0
  if (-not $verified) { Start-Sleep -Milliseconds 125 }
} while (-not $verified -and [DateTime]::UtcNow -lt $deadline)
[pscustomobject]@{ opened = $verified; verified = $verified; browser = $browser; processId = $process.Id; targetOrigin = ([Uri]$target).GetLeftPart([UriPartial]::Authority) } | ConvertTo-Json -Compress
`, deviceRequestEnv(request), signal);
    const payload = parsePowerShellJson(output);
    if (payload.opened !== true || payload.verified !== true) {
      return { ok: false, summary: 'Windows не подтвердил открытие браузера.', error: 'browser-open-unverified', output: payload };
    }
    await context.emit('device.browser.opened', this.manifest.id, payload);
    const text = request.provider === 'youtube' && request.query
      ? `Открыл поиск YouTube по запросу «${request.query}».`
      : request.query
        ? `Открыл поиск в браузере по запросу «${request.query}».`
        : 'Открыл страницу в браузере.';
    return {
      ok: true,
      summary: text,
      output: {
        ...payload,
        performed: true,
        verified: true,
        authoritative: true,
        text,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async searchInstalledApplications(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    const record = readRecord(input);
    const query = normalizeApplicationRequest(record.query);
    const limitValue = Number(record.limit ?? 12);
    const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(limitValue, 50)) : 12;
    const output = await this.runPowerShell(`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_DEVICE_REQUEST_B64)) | ConvertFrom-Json
$query = [string]$request.query
$limit = [int]$request.limit
$apps = @(Get-StartApps | Where-Object {
  $_.Name -ieq $query -or $_.Name -like "*$query*"
} | Sort-Object Name, AppID -Unique | Select-Object -First $limit)
$matches = @($apps | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; appId = [string]$_.AppID }
})
[pscustomobject]@{ query = $query; matches = $matches; count = $matches.Count } | ConvertTo-Json -Compress -Depth 4
`, deviceRequestEnv({ query, limit }), signal);
    const payload = parsePowerShellJson(output);
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    await context.emit('device.apps.searched', this.manifest.id, {
      query,
      count: matches.length,
    });
    return {
      ok: true,
      summary: matches.length
        ? `Нашёл установленные приложения: ${matches.map((entry) => String(readRecord(entry).name || '')).filter(Boolean).join(', ')}.`
        : `Установленные приложения по запросу «${query}» не найдены.`,
      output: { query, matches, count: matches.length },
    };
  }
}

function route(
  intent: MonarchIntent,
  capabilityId: string,
  risk: 'read' | 'delete' | 'device-control',
  input: Record<string, unknown>,
  confidence: number
): MonarchRouteDecision {
  return {
    intentId: intent.id,
    targetModuleId: 'device',
    capabilityId,
    confidence,
    reason: 'Explicit supported Windows device action detected.',
    permissionMode: permissionModeForRisk(risk),
    input,
  };
}

async function runPowerShellCommand(
  script: string,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    env: createDevicePowerShellEnvironment(extraEnv),
    ...(signal ? { signal } : {}),
  });
  return stdout.trim();
}

const DEVICE_POWERSHELL_ENV_ALLOWLIST = new Set([
  'allusersprofile',
  'appdata',
  'commonprogramfiles',
  'commonprogramfiles(x86)',
  'commonprogramw6432',
  'comspec',
  'homedrive',
  'homepath',
  'localappdata',
  'number_of_processors',
  'os',
  'path',
  'pathext',
  'processor_architecture',
  'processor_identifier',
  'processor_level',
  'processor_revision',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'programw6432',
  'psmodulepath',
  'public',
  'systemdrive',
  'systemroot',
  'temp',
  'tmp',
  'userdomain',
  'userdomain_roamingprofile',
  'username',
  'userprofile',
  'windir',
]);

export function createDevicePowerShellEnvironment(
  extraEnv: Record<string, string> = {},
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value === 'string' && DEVICE_POWERSHELL_ENV_ALLOWLIST.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (key !== 'MONARCH_DEVICE_REQUEST_B64') {
      throw new Error(`Unsupported Device PowerShell environment field: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

export function normalizeApplicationRequest(value: unknown): string {
  const app = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!app || !/^[\p{L}\p{N} ._-]+$/u.test(app)) {
    throw new Error('Application name is empty or contains unsupported characters.');
  }
  const alias = app.toLowerCase().replace(/ё/g, 'е');
  return APPLICATION_ALIASES[alias] || app;
}

export function normalizeBrowserRequest(input: unknown): {
  target: string;
  browser: 'default' | 'chrome' | 'edge' | 'firefox';
  provider: 'google' | 'youtube';
  query?: string;
} {
  const record = readRecord(input);
  const browser = ['default', 'chrome', 'edge', 'firefox'].includes(String(record.browser || 'default'))
    ? String(record.browser || 'default') as 'default' | 'chrome' | 'edge' | 'firefox'
    : 'default';
  const provider = record.provider === 'youtube' ? 'youtube' : 'google';
  const query = typeof record.query === 'string'
    ? record.query.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    : '';
  const target = typeof record.url === 'string' && record.url.trim()
    ? normalizeHttpUrl(record.url)
    : query
      ? provider === 'youtube'
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`
      : provider === 'youtube'
        ? 'https://www.youtube.com/'
        : 'https://www.google.com/';
  return { target, browser, provider, ...(query ? { query } : {}) };
}

export function normalizeVolumeRequest(input: unknown): VoiceVolumeAction {
  const record = readRecord(input);
  const action = String(record.action || '').trim();
  if (action === 'mute' || action === 'unmute') return { action };
  if (action === 'set') {
    const value = Number(record.value);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error('Volume value must be an integer between 0 and 100.');
    }
    return { action, value };
  }
  if (action === 'change') {
    const delta = Number(record.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
      throw new Error('Volume delta must be a non-zero integer between -100 and 100.');
    }
    return { action, delta };
  }
  throw new Error('Volume action must be set, change, mute, or unmute.');
}

export function normalizeBrightnessRequest(
  input: unknown,
  mutating: boolean,
): { operation: 'get' } | { operation: 'set'; value: number } | { operation: 'change'; delta: number } {
  if (!mutating) return { operation: 'get' };
  const record = readRecord(input);
  const operation = String(record.operation || '').trim();
  if (operation === 'set') {
    const value = Number(record.value);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error('Brightness value must be an integer between 0 and 100.');
    }
    return { operation, value };
  }
  if (operation === 'change') {
    const delta = Number(record.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
      throw new Error('Brightness delta must be a non-zero integer between -100 and 100.');
    }
    return { operation, delta };
  }
  throw new Error('Brightness operation must be set or change.');
}

function normalizeHttpUrl(value: string): string {
  const raw = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new Error('Only HTTP(S) browser targets are supported.');
  }
  const candidate = /^(?:https?:\/\/)/i.test(raw) ? raw : `https://${raw.replace(/^www\./i, '')}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free HTTP(S) browser targets are supported.');
  }
  return url.toString();
}

function deviceRequestEnv(value: Record<string, unknown>): Record<string, string> {
  return {
    MONARCH_DEVICE_REQUEST_B64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
  };
}

function extractApplicationName(text: string): string | null {
  const match = text.match(/(?:^|\s)(?:открой|запусти|open|launch)\s+(?:приложение\s+|программу\s+)?([\p{L}\p{N} ._-]{1,80})$/iu);
  return match?.[1] ? normalizeApplicationRequest(match[1]) : null;
}

function extractBrowserOpenRequest(text: string): Record<string, unknown> | null {
  if (!/(?:^|\s)(?:открой|покажи|перейди|зайди|open|browse)(?=\s|$)/iu.test(text)) return null;
  const browser = /(?:^|\s)(?:chrome|хром)(?=\s|$)/iu.test(text)
    ? 'chrome'
    : /(?:^|\s)edge(?=\s|$)/iu.test(text)
      ? 'edge'
      : /(?:^|\s)firefox(?=\s|$)/iu.test(text)
        ? 'firefox'
        : 'default';
  if (/(?:^|\s)(?:youtube|ютуб\p{L}*)(?=\s|$)/iu.test(text)) {
    const query = text.match(/(?:найди|поищи|включи|вруби|воспроизведи|поставь)\s+(.+?)\s+(?:на|в)\s+(?:youtube|ютуб\p{L}*)\s*$/iu)?.[1]?.trim();
    return { provider: 'youtube', browser, ...(query ? { query } : {}) };
  }
  if (!/(?:сайт|страниц|ссылк|браузер|https?:|www\.|\.(?:com|org|net|io|ru|ua|dev|app))/iu.test(text)) return null;
  const url = text.match(/(?:https?:\/\/|www\.)[^\s]+|[\p{L}\p{N}.-]+\.(?:com|org|net|io|ru|ua|dev|app)(?:\/[^\s]*)?/iu)?.[0];
  return url ? { url, browser } : { browser };
}

function extractSystemClockRequest(text: string): { kind: 'time' | 'date' } | null {
  const normalized = text.replace(/ё/g, 'е');
  if (/(?:сколько\s+времени|сколько\s+часов).{0,32}(?:займет|занимает|осталось|прошло|нужно|потребуется)/iu.test(normalized)) {
    return null;
  }
  if (/(?:который\s+час|сколько\s+(?:сейчас\s+)?времени|текущее\s+время|точное\s+время|what\s+time\s+is\s+it|current\s+time)/iu.test(normalized)) {
    return { kind: 'time' };
  }
  if (/(?:какое\s+сегодня\s+число|какая\s+сегодня\s+дата|какой\s+сегодня\s+день|today'?s\s+date|current\s+date)/iu.test(normalized)) {
    return { kind: 'date' };
  }
  return null;
}

function brightnessRouteInput(slots: Record<string, string>): Record<string, unknown> {
  if (slots.operation === 'set') return { operation: 'set', value: Number(slots.value) };
  if (slots.operation === 'change') return { operation: 'change', delta: Number(slots.delta) };
  throw new Error('Brightness action is missing a complete operation.');
}

const APPLICATION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'telegram': 'telegram',
  'telegram desktop': 'telegram',
  'телеграм': 'telegram',
  'телеграмм': 'telegram',
  'калькулятор': 'calculator',
  'calc': 'calculator',
  'блокнот': 'notepad',
  'виндовс терминал': 'terminal',
  'windows terminal': 'terminal',
  'терминал': 'terminal',
  'проводник': 'explorer',
  'браузер': 'browser',
  'хром': 'chrome',
  'google chrome': 'chrome',
  'visual studio code': 'vscode',
  'vs code': 'vscode',
  'код': 'vscode',
  'дискорд': 'discord',
  'стим': 'steam',
});

function parsePowerShellJson(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1) || '{}';
  const parsed = JSON.parse(line) as unknown;
  return readRecord(parsed);
}

function readBrightnessLevel(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: unknown }).stderr;
  const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error.message;
  return detail.replace(/\s+/g, ' ').slice(0, 600);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createDeviceModule(): MonarchModule {
  return new DeviceModule();
}

export const deviceModulePackage: MonarchModulePackage = {
  id: deviceManifest.id,
  moduleId: deviceManifest.id,
  version: deviceManifest.version,
  description: deviceManifest.description,
  core: { minVersion: '0.1.0' },
  factory: createDeviceModule,
};
