// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

document.body.innerHTML = '<div id="models-page-list"></div>';
const { state } = await import('../../src/ui/public/modules/state.js');
const { renderModelManager } = await import('../../src/ui/public/modules/model-manager.js');

function provisioned(role: string, patch: Record<string, unknown> = {}) {
  return {
    role, kind: 'chat', label: role, summary: role, description: null, beta: false, recommendedRamGb: 8,
    installed: false, complete: false, phase: 'idle', expectedBytes: 1000, downloadedBytes: 0, progress: 0,
    warning: null, manualInstall: [], components: [{ id: `${role}.text`, role, phase: 'idle', progress: 0, downloadedBytes: 0, expectedBytes: 1000 }],
    ...patch,
  };
}

function setState(fast: Record<string, unknown>, activeRoles: string[] = []) {
  state.data = {
    runtime: { snapshot: { modules: [] } },
    models: { models: [
      { role: 'gemma4-fast', label: 'Gemma 4 Fast', status: 'missing', totalSize: '1 ГБ' },
      { role: 'gemma4-balanced', label: 'Gemma 4 Balanced', status: 'missing', totalSize: '8 ГБ' },
    ] },
    modelRuntime: { entries: [] },
    components: {
      schemaVersion: 2,
      models: [provisioned('gemma4-fast', fast), provisioned('gemma4-balanced')],
      extras: [],
      onboarding: { hardware: { ramTotalGb: 16 } },
      activeInstall: activeRoles.length ? { source: 'settings', roles: activeRoles } : null,
    },
    recentEvents: [],
  } as never;
}

const card = (role: string) => document.querySelector(`[data-model-card="${role}"]`)!;

describe('Models page during a download', () => {
  beforeEach(() => { document.querySelector('#models-page-list')!.innerHTML = ''; });

  it('updates the progress in place without rebuilding the memory bars or closing details', () => {
    setState({ phase: 'downloading', downloadedBytes: 100, progress: 0.1 }, ['gemma4-fast']);
    renderModelManager();
    const bar = card('gemma4-fast').querySelector('.model-ram-bar');
    const details = card('gemma4-balanced').querySelector('details')!;
    details.open = true;
    expect(card('gemma4-fast').querySelector('[data-model-cancel="gemma4-fast"]')?.textContent).toBe('Остановить');

    setState({ phase: 'downloading', downloadedBytes: 500, progress: 0.5 }, ['gemma4-fast']);
    renderModelManager();
    expect(card('gemma4-fast').querySelector('.model-ram-bar')).toBe(bar);
    expect(card('gemma4-balanced').querySelector('details')!.open).toBe(true);
    expect(card('gemma4-fast').querySelector('progress')?.getAttribute('value')).toBe('50');
  });

  it('offers to continue a stopped download and to delete what is on disk', () => {
    setState({ phase: 'idle', downloadedBytes: 400, progress: 0.4 });
    renderModelManager();
    expect(card('gemma4-fast').querySelector('[data-model-install="gemma4-fast"]')?.textContent).toBe('Продолжить');
    expect(card('gemma4-fast').querySelector('[data-model-remove="gemma4-fast"]')).not.toBeNull();
    expect(card('gemma4-fast').textContent).toContain('Загрузка на паузе');
    expect(card('gemma4-balanced').querySelector('[data-model-remove]')).toBeNull();
  });

  it('marks a waiting download as queued with a way to drop it', () => {
    setState({ phase: 'downloading', downloadedBytes: 10, progress: 0.01 }, ['gemma4-fast', 'gemma4-balanced']);
    renderModelManager();
    expect(card('gemma4-balanced').querySelector('.status-text')?.textContent).toBe('в очереди');
    expect(card('gemma4-balanced').querySelector('[data-model-cancel="gemma4-balanced"]')?.textContent).toBe('Убрать из очереди');
  });
});
