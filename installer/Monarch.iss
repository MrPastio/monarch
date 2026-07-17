#ifndef SourceRoot
  #define SourceRoot ".."
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif

#define AppName "Monarch"
#define AppVersion "0.1.0"
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
UninstallDisplayIcon={app}\{#AppExeName}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Monarch local-first AI ecosystem installer

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked
Name: "smallmodel"; Description: "Установить малую модель Oscar"; GroupDescription: "Дополнительные локальные модели:"; Flags: unchecked
Name: "voicestt"; Description: "Установить Voice STT"; GroupDescription: "Дополнительные локальные модели:"; Flags: unchecked
Name: "voicetts"; Description: "Установить NVIDIA Voice TTS"; GroupDescription: "Дополнительные локальные модели:"; Flags: unchecked

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".git\*,.monarch-public-snapshot,.tools\*,node_modules\*,out\*,runtime\*,logs\*,secrets\*,data\local\*,artifacts\generated\*,oscar\.venv\*,oscar\frontend\node_modules\*,oscar\frontend\dist\*,oscar\data\*,security\.venv\*,security\data\*,security\logs\*,installer\out\*,*.gguf,*.safetensors,*.onnx,*.exe,*.dll,*.pyd,*.zip"
Source: "{#SourceRoot}\Monarch.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Monarch"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\Monarch"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -InstallDirectory ""{app}"" -NonInteractive"; WorkingDir: "{app}"; StatusMsg: "Устанавливаются зависимости Monarch..."; Flags: waituntilterminated
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\oscar\scripts\download-small-model.ps1"""; WorkingDir: "{app}"; StatusMsg: "Загружается малая модель Oscar..."; Flags: waituntilterminated; Tasks: smallmodel
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\setup-sherpa-t-one-stt.ps1"""; WorkingDir: "{app}"; StatusMsg: "Загружается Voice STT..."; Flags: waituntilterminated; Tasks: voicestt
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\setup-neural-tts.ps1"""; WorkingDir: "{app}"; StatusMsg: "Устанавливается Voice TTS..."; Flags: waituntilterminated; Tasks: voicetts
Filename: "{app}\{#AppExeName}"; Description: "Запустить Monarch"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
function GetDefaultInstallPath(Param: String): String;
begin
  if DirExists('E:\') then
    Result := 'E:\Programs\Monarch'
  else if DirExists('D:\') then
    Result := 'D:\Programs\Monarch'
  else
    Result := ExpandConstant('{localappdata}\Programs\Monarch');
end;
