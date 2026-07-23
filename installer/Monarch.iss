#ifndef SourceRoot
  #define SourceRoot ".."
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif

#define AppName "Monarch"
#ifndef AppVersion
  #define AppVersion "0.2.3.5"
#endif
#ifndef RuntimeVersion
#define RuntimeVersion "2026.07.6"
#endif
#ifndef BackendEnvironment
#define BackendEnvironment "backend-0.1.5-offline5"
#endif
#ifndef DataSchemaVersion
  #define DataSchemaVersion "1"
#endif
#ifndef MinimumReadableDataSchema
  #define MinimumReadableDataSchema "1"
#endif
#ifndef MaximumReadableDataSchema
  #define MaximumReadableDataSchema "1"
#endif
#ifndef MinimumModelCatalogSchema
  #define MinimumModelCatalogSchema "1"
#endif
#ifndef MaximumModelCatalogSchema
  #define MaximumModelCatalogSchema "1"
#endif
#define AppPublisher "MrPastio"
#define AppExeName "Monarch.exe"

[Setup]
AppId={{9D19CB58-91DB-4A0D-9E1B-4AB5DE0E4047}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={code:GetDefaultInstallPath}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir={#OutputDir}
OutputBaseFilename=Monarch-Setup
SetupIconFile={#SourceRoot}\assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\{#AppExeName}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Monarch local-first AI ecosystem installer

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked

[Files]
Source: "{#SourceRoot}\installer\offline-payload\app\*"; DestDir: "{app}\.staging\{#AppVersion}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\installer\offline-payload\runtime\*"; DestDir: "{app}\.staging\{#AppVersion}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\installer\offline-payload\environment\*"; DestDir: "{app}\.staging\{#AppVersion}\environment"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\installer\offline-payload\payload-manifest.json"; DestDir: "{app}\.staging\{#AppVersion}"; Flags: ignoreversion
Source: "{#SourceRoot}\installer\offline-payload\Monarch.exe"; DestDir: "{app}"; DestName: "Monarch.next.exe"; Flags: ignoreversion; AfterInstall: FinalizeOfflinePayload

[Icons]
Name: "{group}\Monarch"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\Monarch"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Запустить Monarch"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent; Check: CriticalInstallSucceeded

[Code]
function GetLauncherSwapParameters(Param: String): String;
begin
  Result :=
    '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\versions\{#AppVersion}\installer\swap-launcher.ps1') +
    '" -InstallRoot "' + ExpandConstant('{app}') +
    '" -LauncherVersion "1.0.0"';
end;

function GetFinalizeParameters(Param: String): String;
begin
  Result :=
    '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\.staging\{#AppVersion}\app\installer\finalize-offline-install.ps1') +
    '" -StagingRoot "' + ExpandConstant('{app}\.staging\{#AppVersion}') +
    '" -InstallRoot "' + ExpandConstant('{app}') +
    '" -AppVersion "{#AppVersion}"' +
    ' -RuntimeVersion "{#RuntimeVersion}"' +
    ' -BackendEnvironment "{#BackendEnvironment}"' +
    ' -DataSchemaVersion "{#DataSchemaVersion}"' +
    ' -MinimumReadableDataSchema "{#MinimumReadableDataSchema}"' +
    ' -MaximumReadableDataSchema "{#MaximumReadableDataSchema}"' +
    ' -MinimumModelCatalogSchema "{#MinimumModelCatalogSchema}"' +
    ' -MaximumModelCatalogSchema "{#MaximumModelCatalogSchema}"';
end;

function GetDefaultInstallPath(Param: String): String;
begin
  if DirExists('E:\') then
    Result := 'E:\Programs\Monarch'
  else if DirExists('D:\') then
    Result := 'D:\Programs\Monarch'
  else
    Result := ExpandConstant('{localappdata}\Programs\Monarch');
end;

function RunCriticalStep(
  const Description: String;
  const Parameters: String;
  const WorkingDirectory: String
): Boolean;
var
  ResultCode: Integer;
begin
  WizardForm.StatusLabel.Caption := Description;
  ResultCode := -1;
  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Parameters,
    WorkingDirectory,
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then begin
    Log(Description + ' Windows не смогла запустить процесс.');
    Result := False;
    Exit;
  end;
  Result := ResultCode = 0;
  if not Result then
    Log(Description + ' Код ошибки: ' + IntToStr(ResultCode) + '.');
end;

var
  CriticalExitCode: Integer;
  CriticalFinalizerCompleted: Boolean;

procedure FinalizeOfflinePayload;
begin
  CriticalFinalizerCompleted := RunCriticalStep(
    'Проверяется и устанавливается автономный Monarch...',
    GetFinalizeParameters(''),
    ExpandConstant('{app}')
  );
  if not CriticalFinalizerCompleted then
    CriticalExitCode := 20;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    Exit;
  if not CriticalFinalizerCompleted then begin
    if CriticalExitCode = 0 then
      CriticalExitCode := 22;
    Exit;
  end;
  if not RunCriticalStep(
    'Обновляется безопасный загрузчик Monarch...',
    GetLauncherSwapParameters(''),
    ExpandConstant('{app}\versions\{#AppVersion}')
  ) then
    CriticalExitCode := 21;
end;

function CriticalInstallSucceeded: Boolean;
begin
  Result := CriticalFinalizerCompleted and (CriticalExitCode = 0);
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := CriticalExitCode;
end;
