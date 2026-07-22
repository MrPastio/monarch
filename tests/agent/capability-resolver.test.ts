import { describe, expect, it } from 'vitest';
import type { MonarchCapability } from '../../src/core/contracts';
import { resolveAgentCapabilities } from '../../src/agent/capability-resolver';

function capability(id: string, risk: MonarchCapability['risk'] = 'read'): MonarchCapability {
  return {
    id,
    moduleId: id.split('.')[0] || 'workspace',
    title: id,
    description: `Capability ${id}`,
    risk,
    routing: { keywords: id.split('.') },
  };
}

describe('agent capability resolver', () => {
  it('returns a bounded relevant candidate window with diagnostics', () => {
    const capabilities = [
      capability('workspace.files.read'), capability('workspace.files.list'), capability('workspace.files.search'),
      capability('workspace.files.write', 'write'), capability('workspace.root.get'), capability('models.chat.complete'),
      capability('security.status'), capability('studio.history.list'), capability('custom-tools.auto-create', 'execute'),
      capability('safe.status'),
    ];
    const result = resolveAgentCapabilities({
      goal: 'Read workspace files and write a report',
      source: 'api',
      capabilities,
      minimum: 5,
      maximum: 6,
    });
    expect(result.cards).toHaveLength(6);
    expect(result.cards.map((card) => card.id)).toContain('workspace.files.read');
    expect(result.cards.map((card) => card.id)).not.toContain('custom-tools.auto-create');
    expect(result.diagnostics.excluded).toContainEqual({
      capabilityId: 'custom-tools.auto-create',
      reason: 'automatic-create-and-execute-chain-forbidden',
    });
  });

  it('excludes runtime-unready and source-forbidden capabilities but keeps ready degraded runtimes', () => {
    const unavailable = capability('models.deep.run');
    unavailable.agent = { requiredRuntime: ['deep'], supportedSources: ['desktop'] };
    const degraded = capability('models.fast.run');
    degraded.agent = { requiredRuntime: ['fast'], supportedSources: ['api'] };
    const result = resolveAgentCapabilities({
      goal: 'run model', source: 'api', capabilities: [unavailable, degraded], minimum: 1, maximum: 2,
      runtimeAvailability: [
        { runtimeId: 'deep', state: 'configured', ready: false, health: 'unknown' },
        { runtimeId: 'fast', state: 'degraded', ready: true, health: 'degraded', message: 'slow' },
      ],
    });
    expect(result.cards.map((card) => card.id)).toEqual(['models.fast.run']);
    expect(result.cards[0]?.warnings.join(' ')).toContain('slow');
  });

  it('excludes effectful capabilities without a cooperative cancellation contract', () => {
    const unsafeWrite = capability('workspace.files.write', 'write');
    unsafeWrite.agent = { cancellation: 'unsupported' };
    const safeRead = capability('workspace.files.read');
    const result = resolveAgentCapabilities({
      goal: 'read a file and then write a report',
      source: 'api',
      capabilities: [unsafeWrite, safeRead],
      minimum: 1,
      maximum: 2,
    });

    expect(result.cards.map((card) => card.id)).toEqual(['workspace.files.read']);
    expect(result.diagnostics.excluded).toContainEqual({
      capabilityId: 'workspace.files.write',
      reason: 'effectful-capability-cancellation-unsupported',
    });
  });
});
