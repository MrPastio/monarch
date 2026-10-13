import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ASTRA_MAX_SOURCE_PREVIEW_MODE,
  createAstraMaxDesktopBridge,
  resolveAstraMaxSourceModelSelection,
  resolveAstraMaxSourcePreviewMode,
} from '../../desktop/electron/astra-max-desktop-bridge.mjs';

describe('Astra MAX source-preview desktop bridge', () => {
  it('is source-only, exact-switch and disabled in isolated desktop modes', () => {
    const argv = ['electron.exe', '.', '--astra-max-preview'];
    expect(resolveAstraMaxSourcePreviewMode({ argv, isPackaged: false })).toBe(ASTRA_MAX_SOURCE_PREVIEW_MODE);
    expect(resolveAstraMaxSourcePreviewMode({ argv: argv.slice(0, 2), isPackaged: false })).toBeNull();
    expect(resolveAstraMaxSourcePreviewMode({ argv, isPackaged: true })).toBeNull();
    expect(resolveAstraMaxSourcePreviewMode({ argv, isPackaged: false, isolatedMode: true })).toBeNull();
    expect(resolveAstraMaxSourceModelSelection({ argv, previewMode: ASTRA_MAX_SOURCE_PREVIEW_MODE }))
      .toEqual({ preference: 'automatic', previewAcknowledged: false });
    expect(resolveAstraMaxSourceModelSelection({ argv: [...argv, '--astra-max-qwen-preview'],
      previewMode: ASTRA_MAX_SOURCE_PREVIEW_MODE }))
      .toEqual({ preference: 'automatic', previewAcknowledged: false });
    expect(resolveAstraMaxSourceModelSelection({ argv: [...argv, '--astra-max-qwen-preview'], previewMode: null }))
      .toEqual({ preference: 'automatic', previewAcknowledged: false });
  });

  it('does not load storage or expose a credential while the preview is off', async () => {
    const loadHost = vi.fn();
    const bridge = createAstraMaxDesktopBridge({ mode: null, versionRoot: 'E:\\version',
      dataRoot: 'E:\\data', safeStorage: {}, loadHost });
    const status = await bridge.status();
    const configured = await bridge.configure({ apiKey: 'gsk_should_never_be_used_123456789', acknowledgements: {
      nonLocalProcessing: true, selectedContext: true, providerTerms: true,
    } });
    expect(status).toMatchObject({ available: false, state: 'off', nextAction: 'none' });
    expect(configured).toEqual(status);
    expect(loadHost).not.toHaveBeenCalled();
    expect(JSON.stringify({ status, configured })).not.toContain('gsk_');
  });

  it('authors consent in main and returns only a bounded setup view', async () => {
    const configure = vi.fn(async () => ({ state: 'ready', connectionVerified: false, title: 'Ключ MAX сохранён',
      detail: 'Доступ проверится при первой задаче.', nextAction: 'none' }));
    const loadHost = vi.fn(async () => ({ setupView: async () => ({ state: 'not-configured',
      title: 'Подключи MAX', detail: 'Monarch пошагово поможет подключить облачные модели.', nextAction: 'connect' }),
    configure }));
    const bridge = createAstraMaxDesktopBridge({ mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      versionRoot: 'E:\\version', dataRoot: 'E:\\data', safeStorage: {}, loadHost,
      now: () => Date.parse('2026-09-04T16:30:00.000Z') });
    expect(await bridge.status()).toMatchObject({ available: true, state: 'not-configured', models: [
      { id: 'gpt-oss-120b', label: 'GPT OSS 120B' },
    ] });
    const result = await bridge.configure({ apiKey: ' gsk_preview_fixture_123456789012345 ', acknowledgements: {
      nonLocalProcessing: true, selectedContext: true, providerTerms: true,
    } });
    expect(result).toMatchObject({ available: true, state: 'ready', connectionVerified: false,
      title: 'Ключ MAX сохранён' });
    expect(loadHost).toHaveBeenCalledTimes(1);
    expect(loadHost).toHaveBeenCalledWith(expect.objectContaining({
      modelPreference: 'automatic', previewAcknowledged: false,
    }));
    expect(configure).toHaveBeenCalledWith({
      apiKey: 'gsk_preview_fixture_123456789012345',
      consent: {
        agreementVersion: 'monarch.astra-max.groq-consent.2026-09-04.v1', providerId: 'groq',
        acceptedAt: '2026-09-04T16:30:00.000Z', nonLocalProcessingAcknowledged: true,
        selectedContextAcknowledged: true, providerTermsAcknowledged: true,
      },
    });
    expect(Object.keys(bridge)).toEqual(['providers', 'selectProvider', 'listProviderModels', 'listStoredProviderModels', 'configureProvider', 'updateProviderModel', 'setReasoningEffort', 'verifyProvider', 'verify', 'status', 'configure']);
    expect(JSON.stringify(result)).not.toMatch(/gsk_|sha256|credential|runtime/iu);
  });

  it('carries the chosen reasoning depth to a host loaded before or after the choice', async () => {
    const setReasoningEffort = vi.fn();
    const loadHost = vi.fn(async () => ({ setupView: async () => ({ state: 'ready', nextAction: 'none' }), setReasoningEffort }));
    const bridge = createAstraMaxDesktopBridge({ mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      versionRoot: 'E:\version', dataRoot: 'E:\data', safeStorage: {}, loadHost });
    expect(await bridge.setReasoningEffort('low')).toEqual({ ok: true });
    expect(loadHost).not.toHaveBeenCalled();
    await bridge.status();
    expect(setReasoningEffort).toHaveBeenLastCalledWith('low');
    expect(await bridge.setReasoningEffort(null)).toEqual({ ok: true });
    expect(setReasoningEffort).toHaveBeenLastCalledWith(undefined);
    expect(await bridge.setReasoningEffort('extreme')).toEqual({ ok: false });
    expect(setReasoningEffort).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete disclosure without touching the protected host', async () => {
    const configure = vi.fn();
    const bridge = createAstraMaxDesktopBridge({ mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      versionRoot: 'E:\\version', dataRoot: 'E:\\data', safeStorage: {},
      loadHost: async () => ({ setupView: vi.fn(), configure }) });
    const result = await bridge.configure({ apiKey: 'gsk_preview_fixture_123456789012345', acknowledgements: {
      nonLocalProcessing: true, selectedContext: false, providerTerms: true,
    } });
    expect(result).toMatchObject({ state: 'not-configured', title: 'Проверь подключение' });
    expect(configure).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects a retired Qwen preference before host loading: %s', previewAcknowledged => {
    const loadHost = vi.fn();
    expect(() => createAstraMaxDesktopBridge({ mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      versionRoot: 'E:/version', dataRoot: 'E:/data', safeStorage: {}, loadHost,
      modelSelection: { preference: 'qwen-3.8-27b', previewAcknowledged } }))
      .toThrow('astra-max-desktop:model-selection');
    expect(loadHost).not.toHaveBeenCalled();
  });

  it('wires only status and setup through the trusted desktop preload', () => {
    const main = readFileSync('desktop/electron/main.mjs', 'utf8');
    const preload = readFileSync('desktop/electron/preload.cjs', 'utf8');
    expect(main).toContain('resolveAstraMaxSourcePreviewMode');
    expect(main).toContain('resolveAstraMaxSourceModelSelection');
    expect(main).toContain("path.join(workspaceRoot, 'runtime', 'astra-max-preview', 'version')");
    expect(main).toContain("ipcMain.handle('monarch:astra-max-status'");
    expect(main).toContain("ipcMain.handle('monarch:astra-max-configure'");
    expect(main).toContain('assertTrustedMainRenderer(event)');
    expect(main).toContain('startAstraMaxModelServer');
    expect(main).toContain('host: await astraMaxDesktopBridge.preparedModelHost()');
    expect(preload).toContain("status: () => ipcRenderer.invoke('monarch:astra-max-status')");
    expect(preload).toContain("configure: (request) => ipcRenderer.invoke('monarch:astra-max-configure', request)");
    expect(preload).toContain("listStoredProviderModels: id => ipcRenderer.invoke('monarch:astra-max-stored-models', id)");
    expect(preload).toContain("updateProviderModel: request => ipcRenderer.invoke('monarch:astra-max-update-model', request)");
    expect(main).toContain("ipcMain.handle('monarch:astra-max-stored-models'");
    expect(main).toContain("ipcMain.handle('monarch:astra-max-update-model'");
    expect(preload).not.toContain('astraMax.decideRead');
    expect(preload).not.toContain('preparedModelHost');
    expect(preload).not.toContain('/internal/astra/v3/model-turns');
    expect(preload).not.toContain('ASTRA_MAX_PROVIDER_AGREEMENT_VERSION');
  });
});

it('forwards the runtime state location to the main-only loader', async () => {
  const runtimeEnvironment = { MONARCH_STATE_ROOT: 'E:/runtime-state' };
  const loadHost = vi.fn(async () => ({ setupView: async () => ({ state: 'not-configured' }) }));
  const bridge = createAstraMaxDesktopBridge({ mode: 'native-desktop', versionRoot: 'E:/version',
    dataRoot: 'E:/max-credentials', runtimeWorkspaceRoot: 'E:/workspace', runtimeEnvironment,
    safeStorage: {}, loadHost });
  await bridge.status();
  expect(loadHost).toHaveBeenCalledWith(expect.objectContaining({
    runtimeEnvironment, runtimeWorkspaceRoot: 'E:/workspace', dataRoot: 'E:/max-credentials',
  }));
});

it('catalog lookup rejects extra fields and returns no raw error or key', async () => {
  const listProviderModels = vi.fn(async () => { throw Error('synthetic-key-12345678901234567890'); });
  const bridge = createAstraMaxDesktopBridge({ mode: 'native-desktop', versionRoot: 'E:/version', dataRoot: 'E:/data', safeStorage: {}, loadHost: async () => ({ listProviderModels }) });
  const input = { providerId: 'openai', apiKey: 'synthetic-key-12345678901234567890' };
  expect(await bridge.listProviderModels({ ...input, url: 'https://example.com' })).toMatchObject({ ok: false });
  expect(listProviderModels).not.toHaveBeenCalled();
  const result = await bridge.listProviderModels(input); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(input.apiKey);
});

it('stored catalog and model update never accept a renderer key', async () => {
  const secret = 'synthetic-key-12345678901234567890';
  const listStoredProviderModels = vi.fn(async () => [{ id: 'gpt-4.1', label: 'GPT 4.1' }]);
  const updateProviderModel = vi.fn(async () => [{ id: 'openai', model: 'gpt-4.1-mini' }]);
  const selectedProviderId = vi.fn(async () => 'groq');
  const beforeSelectionChange = vi.fn();
  const afterSelectionChange = vi.fn();
  const bridge = createAstraMaxDesktopBridge({
    mode: 'native-desktop', versionRoot: 'E:/version', dataRoot: 'E:/data', safeStorage: {},
    beforeSelectionChange, afterSelectionChange,
    loadHost: async () => ({ listStoredProviderModels, updateProviderModel, selectedProviderId }),
  });
  expect(await bridge.listStoredProviderModels({ providerId: 'openai', apiKey: secret })).toMatchObject({ ok: false });
  expect(listStoredProviderModels).not.toHaveBeenCalled();
  expect(await bridge.listStoredProviderModels('openai')).toEqual({ ok: true, models: [{ id: 'gpt-4.1', label: 'GPT 4.1' }] });
  expect(await bridge.updateProviderModel({ providerId: 'openai', modelId: 'gpt-4.1-mini', apiKey: secret }))
    .toMatchObject({ ok: false, detail: 'Выбери модель из списка.' });
  expect(updateProviderModel).not.toHaveBeenCalled();
  expect(await bridge.updateProviderModel({ providerId: 'openai', modelId: 'gpt-4.1-mini' }))
    .toMatchObject({ ok: true, selectedProviderId: 'groq' });
  expect(updateProviderModel).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'gpt-4.1-mini' });
  expect(beforeSelectionChange).not.toHaveBeenCalled();
  expect(afterSelectionChange).not.toHaveBeenCalled();
  selectedProviderId.mockResolvedValue('openai');
  expect(await bridge.updateProviderModel({ providerId: 'openai', modelId: 'gpt-4.1' })).toMatchObject({ ok: true });
  expect(beforeSelectionChange).toHaveBeenCalledTimes(1);
  expect(afterSelectionChange).toHaveBeenCalledTimes(1);
});
