# Monarch Windows installer

`Install-Monarch.cmd` bootstraps an extracted source tree in place on 64-bit
Windows 10 or Windows 11. It installs
an isolated Node.js runtime under `.tools`, Python 3.11 when missing, npm
dependencies, Oscar, Monarch Security, the frontend build, and the launcher.
After a `winget` Python install it refreshes the process PATH and resolves
Python through the Windows PEP 514 registry. npm installation explicitly
includes the Electron package, then runs its packaged runtime installer and
validates the local executable before setup continues.

Optional model downloads are explicit because they are large:

```powershell
.\installer\bootstrap.ps1 -InstallSmallModel -InstallVoiceStt
```

Build the distributable setup executable with Inno Setup 6:

```powershell
.\installer\build-installer.ps1 -InstallCompiler
```

The setup defaults to `E:\Programs\Monarch`, then `D:\Programs\Monarch`, and
uses the current user's local application directory only when neither data
drive exists. When run from a development tree, the builder first creates a
temporary validated public snapshot and refuses to package local agent history.
Existing user configuration and runtime data are not overwritten.
