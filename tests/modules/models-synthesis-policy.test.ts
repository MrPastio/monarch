import { describe, expect, it, vi } from 'vitest';
const { complete, select } = vi.hoisted(() => ({ complete: vi.fn(), select: vi.fn() }));
vi.mock('../../src/modules/models/runtime-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/modules/models/runtime-client')>(),
  completeWithModelRole: complete, selectModelForInputAsync: select,
}));
vi.mock('../../src/modules/models/model-catalog', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/modules/models/model-catalog')>(),
  readModelCatalog: async () => ({ root: 'synthetic', exists: false, updatedAt: '', models: [] }),
}));
import { ModelsModule } from '../../src/modules/models';
import type { MonarchExecutionRequest } from '../../src/core';

describe('source-bound synthesis selected model', () => {
  it('rejects a batch audit that reports only totals instead of summarizing every inspected file', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn().mockResolvedValue({
      ok: true,
      rawText: 'Я просмотрел 2 файла. Прочитанные форматы: txt, md. Непрочитанных форматов нет.',
      role: 'gemma4-fast',
      adapter: 'isolated',
    });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: {
        request: 'Перескажи все файлы на рабочем столе.',
        observationIds: ['batch_1'],
        observations: [batchObservation()],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' },
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'model-synthesis-coverage-unavailable' });
    expect(completionProvider).toHaveBeenCalledTimes(2);
    expect(completionProvider.mock.calls[0]![1]).toMatchObject({
      responseFormat: 'json',
      responseJsonSchema: { properties: { files: { minItems: 2, maxItems: 2 } } },
    });
    expect(completionProvider.mock.calls[0]![1].responseJsonSchema.properties.files.items.properties)
      .not.toHaveProperty('evidenceExcerpt');
  });

  it('accepts and deterministically renders exactly one grounded entry per inspected file', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn().mockResolvedValue({
      ok: true,
      rawText: JSON.stringify({
        overview: 'На рабочем столе почему-то только один файл.',
        files: [
          { relativePath: 'note-one.txt', summary: 'Проект ORBIT почти закончен, две проверки ещё ожидают.' },
          { relativePath: 'image.png', summary: 'Содержимое изображения недоступно для чтения.' },
        ],
      }),
      role: 'gemma4-fast',
      adapter: 'isolated',
    });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: {
        request: 'Перескажи все файлы на рабочем столе.',
        observationIds: ['batch_1'],
        observations: [batchObservation()],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ sourceObservationIds: ['batch_1'] });
    expect((result.output as any).rawText).toContain('Аудит файлов завершён частично. Проверено файлов: 2; содержимое прочитано: 1; без чтения содержимого: 1.');
    expect((result.output as any).rawText).not.toContain('почему-то только один файл');
    expect((result.output as any).rawText).toContain('- note-one.txt: Проект ORBIT почти закончен, две проверки ещё ожидают.');
    expect((result.output as any).rawText).toContain('Основание: «Проект ORBIT: семь проверок завершено, две ожидают.»');
    expect((result.output as any).rawText).toContain(
      '- image.png: содержимое не прочитано; формат PNG; причина: бинарный или пока неподдерживаемый формат.',
    );
    expect((result.output as any).rawText).not.toContain('E:\\SyntheticDesktop');
    const modelInput = JSON.stringify(completionProvider.mock.calls[0]![1].messages);
    expect(modelInput).toContain('note-one.txt');
    expect(modelInput).not.toContain('E:\\\\SyntheticDesktop');
    expect(modelInput).not.toContain('sha256');
    expect(modelInput).not.toContain('modifiedMs');
  });

  it('retries only a malformed chunk and combines every exact file once', async () => {
    complete.mockReset(); select.mockReset();
    const observation = batchObservation();
    const output = (observation.structuredData as any).output;
    output.items = Array.from({ length: 13 }, (_, index) => ({
      relativePath: `folder/file-${String(index + 1).padStart(2, '0')}.txt`,
      format: 'txt',
      status: 'read',
      content: `Файл ${index + 1}: подтверждённое содержимое для многостраничного аудита.`,
      ...(index === 0 ? { synthesisContentTruncated: true } : {}),
    }));
    output.coverage = {
      totalFiles: 13, pageStart: 0, pageEnd: 13, returnedFiles: 13, readFiles: 13,
      metadataOnlyFiles: 0, skippedFiles: 0, remainingFiles: 0, enumerationSkipped: 0,
      enumerationComplete: true, paginationComplete: true,
    };
    let completionCall = 0;
    const completionProvider = vi.fn().mockImplementation(async (_catalog, completionRequest) => {
      completionCall += 1;
      const user = completionRequest.messages.find((entry: any) => entry.role === 'user')?.content || '';
      const start = user.indexOf('{"observationIds"');
      const end = user.indexOf('\n\nReturn exactly one JSON object', start);
      const evidence = JSON.parse(user.slice(start, end));
      const files = evidence.observations[0].files as Array<{ relativePath: string; content: string }>;
      return {
        ok: true,
        role: 'gemma4-fast',
        adapter: 'isolated',
        rawText: JSON.stringify({
          overview: 'Chunk complete.',
          files: files.map((file) => ({
            relativePath: file.relativePath,
            summary: `Подтверждено содержимое ${file.relativePath}.`,
          })).slice(0, completionCall === 3 ? -1 : undefined),
        }),
      };
    });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: {
        request: 'Перескажи все файлы на рабочем столе.', observationIds: ['batch_1'], observations: [observation],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' },
      },
    });
    expect(result.ok).toBe(true);
    expect(completionProvider).toHaveBeenCalledTimes(5);
    expect(completionProvider.mock.calls.map((call) => call[1].responseJsonSchema.properties.files)).toEqual([
      expect.objectContaining({ minItems: 4, maxItems: 4 }),
      expect.objectContaining({ minItems: 4, maxItems: 4 }),
      expect.objectContaining({ minItems: 4, maxItems: 4 }),
      expect.objectContaining({ minItems: 4, maxItems: 4 }),
      expect.objectContaining({ minItems: 1, maxItems: 1 }),
    ]);
    expect(completionProvider.mock.calls.map((call) => call[1].maxTokens)).toEqual([1280, 1280, 1280, 1280, 768]);
    const text = (result.output as any).rawText as string;
    expect(text).toContain('Проверено файлов: 13');
    expect(text).toContain('пересказ по ограниченному фрагменту: 1');
    expect(text.match(/^- folder\/file-/gmu)).toHaveLength(13);
  });

  it('discards an ungrounded model summary and retains deterministic Kernel evidence', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn().mockResolvedValue({ ok: true, role: 'gemma4-fast', adapter: 'isolated',
      rawText: JSON.stringify({ overview: 'Проверено два файла.', files: [
        { relativePath: 'note-one.txt', summary: 'Обычный ORBITAL файл.' },
        { relativePath: 'image.png', summary: 'Файл изображения.' },
      ] }) });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Перескажи все файлы на рабочем столе.', observationIds: ['batch_1'],
        observations: [batchObservation()],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' } },
    });
    expect(result.ok).toBe(true);
    expect(completionProvider).toHaveBeenCalledTimes(1);
    expect((result.output as any).rawText).toContain('пересказ модели не прошёл проверку');
    expect((result.output as any).rawText).toContain('Основание: «Проект ORBIT: семь проверок завершено, две ожидают.»');
    expect((result.output as any).rawText).not.toContain('Обычный ORBITAL');
  });

  it('accepts one exact answer across contiguous pages of the same Desktop snapshot', async () => {
    complete.mockReset(); select.mockReset();
    const [first, second] = splitBatchObservations();
    const completionProvider = vi.fn().mockResolvedValue({ ok: true, role: 'gemma4-fast', adapter: 'isolated',
      rawText: JSON.stringify({ overview: 'Учтены обе страницы.', files: [
        { relativePath: 'note-one.txt', summary: 'ORBIT: семь проверок завершено, две ожидают.' },
        { relativePath: 'image.png', summary: 'Изображение доступно только как метаданные.' },
      ] }) });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Перескажи все файлы на рабочем столе.', observationIds: ['batch_1', 'batch_2'],
        observations: [first, second],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' } },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ sourceObservationIds: ['batch_1', 'batch_2'] });
  });

  it('rejects a snapshot switch before asking a model to synthesize', async () => {
    complete.mockReset(); select.mockReset();
    const [first, second] = splitBatchObservations();
    ((second.structuredData as any).output).snapshotId = 'forged-snapshot';
    const completionProvider = vi.fn();
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Перескажи все файлы на рабочем столе.', observationIds: ['batch_1', 'batch_2'],
        observations: [first, second] },
    });
    expect(result).toMatchObject({ ok: false, error: 'incomplete-synthesis-binding' });
    expect(completionProvider).not.toHaveBeenCalled();
  });

  it('rejects a read-status file with missing content before model synthesis', async () => {
    complete.mockReset(); select.mockReset();
    const observation = batchObservation();
    delete (((observation.structuredData as any).output.items[0]) as Record<string, unknown>).content;
    const completionProvider = vi.fn();
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Перескажи все файлы на рабочем столе.', observationIds: ['batch_1'],
        observations: [observation] },
    });
    expect(result).toMatchObject({ ok: false, error: 'incomplete-synthesis-binding' });
    expect(completionProvider).not.toHaveBeenCalled();
  });

  it('rejects reordered or mismatched observation ids before model synthesis', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn();
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Перескажи все файлы на рабочем столе.', observationIds: ['another_id'],
        observations: [batchObservation()] },
    });
    expect(result).toMatchObject({ ok: false, error: 'incomplete-synthesis-binding' });
    expect(completionProvider).not.toHaveBeenCalled();
  });

  it('drops an absolute inspection root from model prose without failing the whole audit', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn().mockResolvedValue({ ok: true, role: 'gemma4-fast', adapter: 'isolated',
      rawText: JSON.stringify({ overview: 'Корневая папка: E:\\SyntheticDesktop.', files: [
        { relativePath: 'note-one.txt', summary: 'Корневая папка E:\\SyntheticDesktop, работа почти завершена.' },
        { relativePath: 'image.png', summary: 'Доступны только метаданные.' },
      ] }) });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Перескажи все файлы на рабочем столе.', observationIds: ['batch_1'],
        observations: [batchObservation()],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' } },
    });
    expect(result.ok).toBe(true);
    expect(completionProvider).toHaveBeenCalledTimes(1);
    expect((result.output as any).rawText).not.toContain('E:\\SyntheticDesktop');
    expect((result.output as any).rawText).toContain('пересказ модели не прошёл проверку');
  });

  it('uses the configured completion boundary without a second transport or selector', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn().mockResolvedValue({ ok: true, rawText: 'Grounded answer', role: 'gemma4-fast', adapter: 'isolated' });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Summarize', observationIds: ['read_1'], observations: [{ id: 'read_1', content: 'Synthetic fact' }],
        modelPolicy: { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'exact' } },
    });
    expect(result.ok).toBe(true);
    expect(completionProvider).toHaveBeenCalledTimes(1);
    expect(completionProvider.mock.calls[0]![1]).toMatchObject({ role: 'gemma4-fast', purpose: 'agent-response', fallbackRoles: [] });
    expect(complete).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it('preserves the stable MAX failure code while keeping the friendly detail in the summary', async () => {
    complete.mockReset(); select.mockReset();
    const completionProvider = vi.fn().mockResolvedValue({
      ok: false,
      role: 'max-gpt-oss-120b',
      adapter: 'groq-max',
      errorCode: 'astra-max-native:not-configured',
      error: 'Открой Настройки → MAX: проверь ключ выбранного сервиса и согласие на отправку данных.',
    });
    const result = await new ModelsModule('synthetic', { completionProvider }).executeCapability({
      id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
      createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
      input: { request: 'Summarize', observationIds: ['read_1'], observations: [{ id: 'read_1', content: 'Synthetic fact' }],
        modelPolicy: { requestedRole: 'max-gpt-oss-120b', selectionSource: 'user-explicit', fallback: 'exact' } },
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'astra-max-native:not-configured',
      summary: 'Открой Настройки → MAX: проверь ключ выбранного сервиса и согласие на отправку данных.',
    });
    expect(completionProvider).toHaveBeenCalledTimes(1);
  });

  it.each(['gemma4-fast', 'qwen3.8-27b-pro'])(
    'preserves the runtime-bound exact selection instead of running an automatic selector: %s', async requestedRole => {
    complete.mockReset().mockResolvedValue({ ok: true, rawText: 'Grounded answer', role: 'gemma4-fast', adapter: 'test' });
    select.mockReset().mockResolvedValue({ role: 'qwen3.8-27b-pro' });
    const module = new ModelsModule('synthetic');
    const result = await module.executeCapability({ id: 'execution', intentId: 'task', moduleId: 'models',
      capabilityId: 'models.agent.synthesize', createdAt: new Date().toISOString(), requestedBy: 'agent-runtime',
      executionMode: 'agent-runtime', input: { request: 'Summarize observed facts', observationIds: ['read_1'],
        observations: [{ id: 'read_1', content: 'Synthetic fact' }],
        modelPolicy: { requestedRole, selectionSource: 'user-explicit', fallback: 'exact' } },
    } as MonarchExecutionRequest, {} as any);
    expect(result.ok).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(complete.mock.calls[0]![1]).toMatchObject({ role: requestedRole, requestedModel: requestedRole,
      selectionSource: 'user-explicit', fallbackRoles: [], purpose: 'agent-response', agentSessionId: 'task' });
  });

  it.each([null, { requestedRole: 'remote-unknown', selectionSource: 'user-explicit', fallback: 'exact' },
    { requestedRole: 'gemma4-fast', selectionSource: 'auto', fallback: 'exact' },
    { requestedRole: 'gemma4-fast', selectionSource: 'user-explicit', fallback: 'allow' }])(
    'rejects invalid model bindings before selection or generation: %j', async modelPolicy => {
      complete.mockReset(); select.mockReset();
      const result = await new ModelsModule('synthetic').executeCapability({
        id: 'execution', intentId: 'task', moduleId: 'models', capabilityId: 'models.agent.synthesize',
        createdAt: '', requestedBy: 'agent-runtime', executionMode: 'agent-runtime',
        input: { request: 'Summarize', observationIds: ['read_1'], observations: [{ id: 'read_1' }], modelPolicy },
      });
      expect(result).toMatchObject({ ok: false, error: 'invalid-synthesis-model-policy' });
      expect(complete).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });
});

function batchObservation(): Record<string, unknown> {
  return {
    id: 'batch_1',
    capabilityId: 'workspace.files.inspect-batch',
    status: 'success',
    evidence: [{ evidenceClass: 'kernel-observation', reference: 'kernel:batch_1' }],
    structuredData: {
      output: {
        schemaVersion: 'monarch.workspace-files-inspect-batch.v1',
        root: 'E:\\SyntheticDesktop',
        snapshotId: 'snapshot_1',
        items: [
          { path: 'E:\\SyntheticDesktop\\note-one.txt', relativePath: 'note-one.txt', name: 'note-one.txt',
            sizeBytes: 64, modifiedMs: 1, sha256: 'a', format: 'txt', status: 'read',
            content: 'Проект ORBIT: семь проверок завершено, две ожидают.' },
          { path: 'E:\\SyntheticDesktop\\image.png', relativePath: 'image.png', name: 'image.png',
            sizeBytes: 128, modifiedMs: 1, sha256: 'b', format: 'png', status: 'metadata-only',
            reason: 'binary-or-unsupported-format' },
        ],
        skips: [{ path: 'E:\\SyntheticDesktop\\image.png', reason: 'binary-or-unsupported-format' }],
        coverage: {
          totalFiles: 2, pageStart: 0, pageEnd: 2, returnedFiles: 2, readFiles: 1,
          metadataOnlyFiles: 1, skippedFiles: 0, remainingFiles: 0, enumerationSkipped: 0,
          enumerationComplete: true, paginationComplete: true,
        },
        nextCursor: null,
        complete: true,
      },
    },
  };
}

function splitBatchObservations(): [Record<string, unknown>, Record<string, unknown>] {
  const first = structuredClone(batchObservation());
  const second = structuredClone(batchObservation());
  const firstOutput = (first.structuredData as any).output;
  const secondOutput = (second.structuredData as any).output;
  firstOutput.items = [firstOutput.items[0]];
  firstOutput.skips = [];
  firstOutput.coverage = { ...firstOutput.coverage, pageStart: 0, pageEnd: 1, returnedFiles: 1,
    readFiles: 1, metadataOnlyFiles: 0, remainingFiles: 1, paginationComplete: false };
  firstOutput.nextCursor = 'cursor-page-2';
  firstOutput.complete = false;
  second.id = 'batch_2';
  secondOutput.items = [secondOutput.items[1]];
  secondOutput.coverage = { ...secondOutput.coverage, pageStart: 1, pageEnd: 2, returnedFiles: 1,
    readFiles: 0, metadataOnlyFiles: 1, remainingFiles: 0, paginationComplete: true };
  return [first, second];
}
