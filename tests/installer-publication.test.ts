import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), 'utf8');

describe('Windows installer and public snapshot boundary', () => {
  it('assembles a versioned offline runtime on the build machine', () => {
    const builder = read('installer/build-offline-payload.ps1');
    expect(builder).toContain('requirements-runtime.txt');
    expect(builder).toContain('node_modules\\electron\\dist');
    expect(builder).toContain('profiles\\cpu');
    expect(builder).toContain('profiles\\cuda');
    expect(builder).toContain('Portable Python runtime validation');
    expect(builder).toContain('Offline Oscar CPU runtime validation');
    expect(builder).toContain('Offline Oscar CUDA runtime validation');
    expect(builder).toContain('Offline Monarch Security runtime validation');
    expect(builder).toContain('payload-manifest.json');
    expect(builder).not.toContain('C:\\Users\\anton');
    expect(builder).not.toContain('E:\\Monarch');

    const requirements = read('oscar/requirements-runtime.txt');
    expect(requirements).toContain('fastapi==');
    expect(requirements).toContain('uvicorn[standard]==');
    expect(requirements).not.toContain('torch');
    expect(requirements).not.toContain('transformers');
    expect(requirements).not.toContain('triton');

    const finalizer = read('installer/finalize-offline-install.ps1');
    expect(finalizer).toContain('installationMode = "offline"');
    expect(finalizer).toContain('internetRequired = $false');
    expect(finalizer).toContain('Assert-TreeRecord');
    expect(finalizer).toContain('Publish-ImmutableComponent');
    expect(finalizer).not.toContain('winget.exe');
    expect(finalizer).not.toContain('npm.cmd');
    expect(finalizer).not.toMatch(/-m\s+pip\s+install/i);
  });

  it('installs llama.cpp from a published Windows wheel instead of compiling it locally', () => {
    const oscarInstaller = read('oscar/scripts/install.ps1');
    expect(oscarInstaller).toContain('.requirements-installer.tmp');
    expect(oscarInstaller).toContain(
      'https://abetlen.github.io/llama-cpp-python/whl/cpu',
    );
    expect(oscarInstaller).toContain(
      'https://abetlen.github.io/llama-cpp-python/whl/cu125',
    );
    expect(oscarInstaller).toContain('--only-binary llama-cpp-python');
    expect(oscarInstaller).not.toContain(
      '& $VenvPython -m pip install -r requirements.txt',
    );
    expect(oscarInstaller).toContain('MONARCH_CONFIG_ROOT');

    const oscarConfig = read('oscar/backend/oscar_agent/config.py');
    expect(oscarConfig).toContain('SETTINGS_ENV_FILE');
    expect(oscarConfig).toContain('MONARCH_CONFIG_ROOT');
  });

  it('keeps private collaboration history outside the public snapshot', () => {
    const exporter = read('scripts/export-public.ps1');
    for (const privatePath of [
      'AI_HANDOFF\\.md',
      'agent_notes\\.md',
      'ORIGINAL_REQUEST\\.md',
      '^\\.agents/',
      '^\\.codex/',
    ]) {
      expect(exporter).toContain(privatePath);
    }
    expect(exporter).toContain('PRIVATE KEY');
    expect(exporter).toContain('github_pat_');
  });

  it('builds a modern self-contained Windows setup without model downloads', () => {
    const definition = read('installer/Monarch.iss');
    expect(definition).toContain('#define AppVersion "0.1.5"');
    expect(definition).toContain('WizardStyle=modern');
    expect(definition).toContain('PrivilegesRequired=lowest');
    expect(definition).toContain('ArchitecturesInstallIn64BitMode=x64compatible');
    expect(definition).toContain('installer\\offline-payload\\app\\*');
    expect(definition).toContain('installer\\offline-payload\\runtime\\*');
    expect(definition).toContain('installer\\offline-payload\\environment\\*');
    expect(definition).toContain('payload-manifest.json');
    expect(definition).toContain('E:\\Programs\\Monarch');
    expect(definition).toContain('D:\\Programs\\Monarch');
    expect(definition).toContain("GetFinalizeParameters('')");
    expect(definition).not.toContain('GetBootstrapParameters');
    expect(definition).not.toContain('WizardIsTaskSelected');
    expect(definition).not.toContain('InstallSmallModel');
    expect(definition).not.toContain('InstallVoiceStt');
    expect(definition).not.toContain('InstallVoiceTts');
    expect(definition.match(/Filename: "\{sys\}\\WindowsPowerShell/g)).toBeNull();
    expect(definition).toContain('function RunCriticalStep');
    expect(definition).toContain('procedure FinalizeOfflinePayload');
    expect(definition).toContain('procedure CurStepChanged');
    expect(definition).toContain('function GetCustomSetupExitCode');
    expect(definition).toContain('CriticalExitCode := 20');
    expect(definition).toContain('CriticalExitCode := 21');
    expect(definition).toContain('AfterInstall: FinalizeOfflinePayload');
    expect(definition).toContain('Monarch.next.exe');
    expect(definition).toContain('GetLauncherSwapParameters');
    expect(definition).toContain('versions\\{#AppVersion}');
    expect(definition).toContain('CloseApplications=no');
  });

  it('refuses to package private development history', () => {
    const builder = read('installer/build-installer.ps1');
    expect(builder).toContain('Test-PrivateSource');
    expect(builder).toContain('Refusing to package an unfiltered source tree');
    expect(builder).toContain('scripts\\export-public.ps1');
    expect(builder).toContain('.monarch-public-snapshot');
    expect(builder).toContain('scripts\\build-runtime-bundle.mjs');
    expect(builder).toContain('dist\\monarch-server.mjs');
    expect(builder).toContain('build-offline-payload.ps1');

    const dryRun = read('scripts/upload-dry-run.ps1');
    expect(dryRun).toContain('^installer/out($|[-/])');
    expect(dryRun).toContain('^installer/offline-payload($|/)');
  });

  it('builds the installer runtime on GitHub before Inno Setup packages it', () => {
    const workflow = read('.github/workflows/windows-installer.yml');
    expect(workflow).toContain('actions/setup-node@v7');
    expect(workflow).toContain('node-version-file: .node-version');
    expect(workflow).toContain('npm ci --no-audit --no-fund');
  });

  it('ships a portable Oscar environment template', () => {
    const envExample = read('oscar/.env.example');
    expect(envExample).not.toContain('E:\\Monarch');
    expect(envExample).not.toContain('C:\\Users\\');
    expect(envExample).toContain('OSCAR_PORT=7861');
  });
});
