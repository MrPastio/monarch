import { describe, expect, it, vi } from 'vitest';
import { submitOscarAstraInputHttp, type AstraOscarHttpContext } from '../../src/app/astra-oscar-http';
import type { OscarTurnCoordinator } from '../../src/oscar-turn/coordinator';
import type { OscarTurnV1 } from '../../src/oscar-turn/types';

const actor = { source: 'desktop' as const, id: `sha256:${'a'.repeat(64)}` };
const context: AstraOscarHttpContext = {
  enabled: true,
  loopback: true,
  authenticatedActor: () => actor,
};
const turn = (kind: 'agent' | 'read') => ({
  id: 'oscar_turn_owned',
  source: 'desktop',
  conversationId: 'conversation_owned',
  inputMessageId: 'input_owned',
  request: { astra: { actor, goal: { kind } } },
}) as unknown as OscarTurnV1;
const body = {
  version: 1,
  conversationId: 'conversation_owned',
  inputMessageId: 'input_owned',
  input: { kind: 'decide', decision: {
    approvalId: 'approval_owned',
    approvalDigest: `sha256:${'b'.repeat(64)}`,
    messageId: 'decision_owned',
    decision: 'reject',
  } },
};

describe('Oscar Astra input HTTP contract', () => {
  it('passes an exact generic Agent decision to the V3 coordinator', async () => {
    const submitAstraInput = vi.fn().mockResolvedValue({ ok: true });
    const result = await submitOscarAstraInputHttp({ submitAstraInput } as unknown as OscarTurnCoordinator,
      turn('agent'), body, context);
    expect(result).toEqual({ ok: true });
    expect(submitAstraInput).toHaveBeenCalledWith('oscar_turn_owned', 'desktop', body.input);
  });

  it('does not expose input on a read-only Astra goal', async () => {
    await expect(submitOscarAstraInputHttp({ submitAstraInput: vi.fn() } as unknown as OscarTurnCoordinator,
      turn('read'), body, context)).rejects.toMatchObject({ statusCode: 409, code: 'astra-input-unsupported' });
  });
});
