import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonarchExecutionRequest, MonarchKernelContext } from '../../src/core';
import { AssistantModule } from '../../src/modules/assistant';
import * as runtimeClient from '../../src/modules/models/runtime-client';

vi.mock('../../src/modules/models/runtime-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/modules/models/runtime-client')>(),
  completeWithModelRole: vi.fn(),
}));

const completeWithModelRole = vi.mocked(runtimeClient.completeWithModelRole);

describe('assistant completion terminal truth', () => {
  beforeEach(() => {
    completeWithModelRole.mockReset();
  });

  it('keeps partial text but fails the execution when the model reports truncation', async () => {
    completeWithModelRole.mockResolvedValue({
      ok: false,
      role: 'weak',
      attemptedRoles: ['weak'],
      adapter: 'test-runtime',
      rawText: 'Частичный ответ',
      error: 'model-output-truncated',
      degraded: true,
      finishReason: 'length',
      truncated: true,
      streamCompleted: true,
    });

    const result = await new AssistantModule().executeCapability(
      assistantRequest('intent_partial_completion'),
      createContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'model-output-truncated',
      output: {
        mode: 'assistant-reply-prepared',
        reply: 'Частичный ответ',
        error: 'model-output-truncated',
        degraded: true,
        finishReason: 'length',
        truncated: true,
        streamCompleted: true,
      },
    });
  });

  it('fails with a bounded code instead of converting a thrown runtime error to success', async () => {
    completeWithModelRole.mockRejectedValue(new Error('sensitive runtime detail'));

    const result = await new AssistantModule().executeCapability(
      assistantRequest('intent_runtime_exception'),
      createContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'assistant-model-error',
      output: {
        mode: 'assistant-reply-prepared',
        error: 'assistant-model-error',
      },
    });
    expect(JSON.stringify(result)).not.toContain('sensitive runtime detail');
  });
});

function assistantRequest(intentId: string): MonarchExecutionRequest {
  return {
    id: `exec_${intentId}`,
    intentId,
    moduleId: 'assistant',
    capabilityId: 'assistant.reply',
    input: { text: 'Дай полный ответ' },
    createdAt: new Date(0).toISOString(),
    requestedBy: 'desktop',
  };
}

function createContext(): MonarchKernelContext {
  return {
    emit: vi.fn(async () => ({
      id: 'event_1',
      type: 'assistant.token',
      source: 'assistant',
      createdAt: new Date(0).toISOString(),
    })),
    audit: vi.fn(),
    requestPermission: vi.fn(),
    execute: vi.fn(async () => ({ ok: true, summary: 'empty context', output: {} })),
    getCapability: vi.fn(),
    listCapabilities: vi.fn(() => []),
    listModules: vi.fn(() => []),
    listEvents: vi.fn(() => []),
    listAudit: vi.fn(() => []),
    listRecentIntentJobs: vi.fn(() => []),
    getPermissionProfile: vi.fn(() => ({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    })),
  } as unknown as MonarchKernelContext;
}
