# Monarch Windows installer

`Install-Monarch.cmd` bootstraps an extracted source tree in place. It installs
an isolated Node.js runtime under `.tools`, Python 3.11 when missing, npm
dependencies, Oscar, Monarch Security, the frontend build, and the launcher.

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
drive exists. Existing user configuration and runtime data are not overwritten.
