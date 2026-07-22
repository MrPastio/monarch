# Monarch Windows installer

The public setup is self-contained for 64-bit Windows 10 and Windows 11. Node,
Electron, portable Python 3.11, Oscar CPU/CUDA runtime profiles, Security and
the built frontend are resolved on the CI/build machine and embedded into the
installer. The user's computer does not run npm, pip or winget during setup.
Models remain external shared payloads and are never deleted or transformed by
the installer.

Build the distributable setup executable with Inno Setup 6:

```powershell
.\installer\build-installer.ps1 -InstallCompiler
```

The setup defaults to `E:\Programs\Monarch`, then `D:\Programs\Monarch`, and
uses the current user's local application directory only when neither data
drive exists. When run from a development tree, the builder first creates a
temporary validated public snapshot and refuses to package local agent history.
Existing user configuration, models and mutable runtime data are not
overwritten. `installer/bootstrap.ps1` remains a developer-tree compatibility
tool and is not part of the public setup flow.
