import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeGitHubStatus, parseGitHubRepositories } from '../../src/ui/public/modules/github-settings.js';

const html = readFileSync('src/ui/public/index.html', 'utf8');
const source = readFileSync('src/ui/public/modules/github-settings.js', 'utf8');
const preload = readFileSync('desktop/electron/preload.cjs', 'utf8');
const main = readFileSync('desktop/electron/main.mjs', 'utf8');

describe('GitHub settings surface', () => {
  it('normalizes only a bounded secret-free public projection', () => {
    expect(normalizeGitHubStatus({ connected: true, login: 'owner', token: 'must-not-render',
      repositories: ['owner/project', '../escape'], permissions: { read: true, issues: false, pullRequests: true, admin: true } }))
      .toEqual({ connected: true, login: 'owner', repositories: ['owner/project'],
        permissions: { read: true, issues: false, pullRequests: true } });
    expect(parseGitHubRepositories('owner/one\nowner/two')).toEqual(['owner/one', 'owner/two']);
    expect(parseGitHubRepositories('owner/one, OWNER/ONE')).toBeNull();
  });

  it('uses trusted Desktop IPC and does not persist the token in renderer storage', () => {
    expect(html).toContain('id="github-connect-form"');
    expect(html).toContain('специальных команд и фраз-активаторов нет');
    expect(html).toContain('Слияние, удаление, релизы и изменение веток Monarch не умеет');
    expect(source).toContain('window.monarchDesktop?.integrations');
    expect(source).toContain("integrations.connect('github', input)");
    expect(source).toContain("token.value = ''");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(preload).toContain("ipcRenderer.invoke('monarch:integration-connect', { serviceId, input })");
    expect(main).toContain('registerServiceIntegrationIpc({ ipcMain');
    expect(main).toContain("id: 'github', envPrefix: 'MONARCH_GITHUB_HOST'");
  });
});
