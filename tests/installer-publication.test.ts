import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), 'utf8');

describe('Windows installer and public snapshot boundary', () => {
  it('bootstraps missing runtimes without embedding machine-specific paths', () => {
    const bootstrap = read('installer/bootstrap.ps1');
    expect(bootstrap).toContain('Monarch requires Windows 10 or Windows 11 (64-bit).');
    expect(bootstrap).toContain('CurrentMajorVersionNumber');
    expect(bootstrap).toContain('Python.Python.3.11');
    expect(bootstrap).toContain('--source winget');
    expect(bootstrap).toContain('Refresh-ProcessPath');
    expect(bootstrap).toContain('Get-Python311RegistryCandidates');
    expect(bootstrap).toContain('HKEY_CURRENT_USER\\Software\\Python\\PythonCore');
    expect(bootstrap).toContain('scripts\\ensure-node.ps1');
    expect(bootstrap).toContain('npm.cmd');
    expect(bootstrap).toContain('--include=dev');
    expect(bootstrap).toContain('--ignore-scripts=false');
    expect(bootstrap).toContain('node_modules\\electron\\dist\\electron.exe');
    expect(bootstrap).toContain('node_modules\\electron\\install.js');
    expect(bootstrap).toContain('Install-ElectronRuntime -Node $node -Root $root');
    expect(bootstrap).toContain('Electron ready:');
    expect(bootstrap).toContain('oscar\\scripts\\install.ps1');
    expect(bootstrap).toContain('security\\scripts\\setup_runtime.ps1');
    expect(bootstrap).not.toContain('C:\\Users\\anton');
    expect(bootstrap).not.toContain('E:\\Monarch');
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

  it('builds a modern Windows setup with optional large models', () => {
    const definition = read('installer/Monarch.iss');
    expect(definition).toContain('#define AppVersion "0.1.3"');
    expect(definition).toContain('WizardStyle=modern');
    expect(definition).toContain('PrivilegesRequired=lowest');
    expect(definition).toContain('ArchitecturesInstallIn64BitMode=x64compatible');
    expect(definition).toContain('tmp\\*');
    expect(definition).toContain('Name: "smallmodel"');
    expect(definition).toContain('Name: "voicestt"');
    expect(definition).toContain('Name: "voicetts"');
    expect(definition).toContain('E:\\Programs\\Monarch');
    expect(definition).toContain('D:\\Programs\\Monarch');
    expect(definition).toContain('Parameters: "{code:GetBootstrapParameters}"');
    expect(definition).toContain("WizardIsTaskSelected('smallmodel')");
    expect(definition).toContain("WizardIsTaskSelected('voicestt')");
    expect(definition).toContain("WizardIsTaskSelected('voicetts')");
    expect(definition).toContain("Result := Result + ' -InstallSmallModel'");
    expect(definition).toContain("Result := Result + ' -InstallVoiceStt'");
    expect(definition).toContain("Result := Result + ' -InstallVoiceTts'");
    expect(definition.match(/Filename: "\{sys\}\\WindowsPowerShell/g)).toHaveLength(1);
  });

  it('refuses to package private development history', () => {
    const builder = read('installer/build-installer.ps1');
    expect(builder).toContain('Test-PrivateSource');
    expect(builder).toContain('Refusing to package an unfiltered source tree');
    expect(builder).toContain('scripts\\export-public.ps1');
    expect(builder).toContain('.monarch-public-snapshot');
  });

  it('ships a portable Oscar environment template', () => {
    const envExample = read('oscar/.env.example');
    expect(envExample).not.toContain('E:\\Monarch');
    expect(envExample).not.toContain('C:\\Users\\');
    expect(envExample).toContain('OSCAR_PORT=7861');
  });
});
