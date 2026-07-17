$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

namespace Monarch.Audio {
  public enum EDataFlow { eRender, eCapture, eAll }
  public enum ERole { eConsole, eMultimedia, eCommunications }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorComObject { }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    int Activate(ref Guid iid, int classContext, IntPtr activationParams,
      [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport]
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint channelCount);
    int SetMasterVolumeLevel(float levelDb, Guid eventContext);
    int SetMasterVolumeLevelScalar(float level, Guid eventContext);
    int GetMasterVolumeLevel(out float levelDb);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float levelDb, Guid eventContext);
    int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
    int GetChannelVolumeLevel(uint channel, out float levelDb);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
    int GetMute(out bool mute);
    int GetVolumeStepInfo(out uint step, out uint stepCount);
    int VolumeStepUp(Guid eventContext);
    int VolumeStepDown(Guid eventContext);
    int QueryHardwareSupport(out uint mask);
    int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
  }

  public sealed class EndpointVolume : IDisposable {
    private IMMDeviceEnumerator enumerator;
    private IMMDevice device;
    private IAudioEndpointVolume endpoint;

    public EndpointVolume() {
      enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(
        EDataFlow.eRender, ERole.eMultimedia, out device));
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object instance;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
      endpoint = (IAudioEndpointVolume)instance;
    }

    public float GetLevel() {
      float value;
      Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out value));
      return value;
    }

    public bool GetMute() {
      bool value;
      Marshal.ThrowExceptionForHR(endpoint.GetMute(out value));
      return value;
    }

    public void SetLevel(float value) {
      value = Math.Max(0.0f, Math.Min(1.0f, value));
      Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(value, Guid.Empty));
    }

    public void SetMute(bool value) {
      Marshal.ThrowExceptionForHR(endpoint.SetMute(value, Guid.Empty));
    }

    public void Dispose() {
      if (endpoint != null) Marshal.ReleaseComObject(endpoint);
      if (device != null) Marshal.ReleaseComObject(device);
      if (enumerator != null) Marshal.ReleaseComObject(enumerator);
      endpoint = null;
      device = null;
      enumerator = null;
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
  throw 'volume-request-empty'
}
$request = $raw | ConvertFrom-Json
$action = [string]$request.action

$endpoint = [Monarch.Audio.EndpointVolume]::new()
try {
  $beforeLevel = [Math]::Round($endpoint.GetLevel() * 100)
  $beforeMuted = $endpoint.GetMute()

  switch ($action) {
    'get' { }
    'set' {
      $target = [Math]::Max(0, [Math]::Min(100, [double]$request.value))
      $endpoint.SetLevel([single]($target / 100))
      if ($target -gt 0 -and $endpoint.GetMute()) { $endpoint.SetMute($false) }
    }
    'change' {
      $target = [Math]::Max(0, [Math]::Min(100, $beforeLevel + [double]$request.delta))
      $endpoint.SetLevel([single]($target / 100))
      if ($target -gt 0 -and $endpoint.GetMute()) { $endpoint.SetMute($false) }
    }
    'mute' { $endpoint.SetMute($true) }
    'unmute' { $endpoint.SetMute($false) }
    default { throw "volume-action-unsupported:$action" }
  }

  Start-Sleep -Milliseconds 45
  $afterLevel = [Math]::Round($endpoint.GetLevel() * 100)
  $afterMuted = $endpoint.GetMute()
  [pscustomobject]@{
    ok = $true
    action = $action
    before = [int]$beforeLevel
    beforeMuted = [bool]$beforeMuted
    level = [int]$afterLevel
    muted = [bool]$afterMuted
  } | ConvertTo-Json -Compress
}
finally {
  $endpoint.Dispose()
}
