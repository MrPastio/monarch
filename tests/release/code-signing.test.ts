import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) =>
  readFile(path.join(process.cwd(), relativePath), 'utf8');

describe('Monarch Authenticode signing contract', () => {
  it('signs the launcher before its payload hash is recorded', async () => {
    const payload = await read('installer/build-offline-payload.ps1');
    const sign = payload.indexOf('Invoke-MonarchSignFile -Config $signingConfig -Path $launcherPath');
    const hash = payload.indexOf('sha256 = Get-Sha256Hex -Path $launcherPath');
    expect(sign).toBeGreaterThan(0);
    expect(hash).toBeGreaterThan(sign);
    expect(payload).toContain('$launcherPath = Join-Path $output "Monarch.exe"');
  });

  it('lets Inno sign the setup and uninstaller only when signing is configured', async () => {
    const definition = await read('installer/Monarch.iss');
    expect(definition).toMatch(/#ifdef MonarchSigned\s+SignTool=monarch\s+SignedUninstaller=yes\s+#endif/);
    const build = await read('installer/build-installer.ps1');
    expect(build).toContain('"/Smonarch=$signCommand", "/DMonarchSigned=1"');
    // Quotes must go through Inno's $q, not literal quotes (PS 5.1 splits them).
    expect(build).toContain('`$q$signScript`$q -Path `$f');
    expect(build.indexOf('Get-MonarchSigningConfig')).toBeLessThan(build.indexOf('export-public.ps1'));
    expect(build).toContain('Assert-MonarchSignature -Config $signingConfig -Path $setup');
  });

  it('requires timestamped SHA-256 signatures from the configured certificate', async () => {
    const module = await read('installer/code-signing.ps1');
    expect(module).toContain('"/fd", "SHA256"');
    expect(module).toContain('"/td", "SHA256"');
    expect(module).toContain('TimeStamperCertificate');
    expect(module).toContain('SignatureStatus]::Valid');
    expect(module).toContain('File was signed by an unexpected certificate');
    expect(module).toContain('MONARCH_SIGN_REQUIRED');
  });

  it('keeps signing secrets out of the repository and wires them into the stable release', async () => {
    const workflow = await read('.github/workflows/release-stable.yml');
    expect(workflow).toContain('MONARCH_SIGN_COMMAND: ${{ secrets.MONARCH_SIGN_COMMAND }}');
    expect(workflow).toContain("MONARCH_SIGN_REQUIRED: ${{ vars.MONARCH_SIGN_REQUIRED || '0' }}");
    const module = await read('installer/code-signing.ps1');
    expect(module).not.toMatch(/\/p\s|\.pfx/i);
  });
});
