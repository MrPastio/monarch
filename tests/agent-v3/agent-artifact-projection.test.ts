import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectAstraAgentFileArtifacts } from '../../src/app/astra-task-facade';

describe('Astra V3 Agent artifact projection', () => {
  it('projects a stable Telegram-safe file artifact only from a verified Kernel readback', () => {
    const reference = 'E:\\Workspace\\reports\\result.txt';
    const readbackSha256 = 'a'.repeat(64);
    const expectedId = 'agent_artifact_' + createHash('sha256')
      .update(JSON.stringify([4, 'workspace.files.write', reference, readbackSha256]))
      .digest('hex').slice(0, 48);

    expect(projectAstraAgentFileArtifacts([{
      round: 4,
      capabilityId: 'workspace.files.write',
      reason: 'Create the requested report.',
      state: 'observed',
      ok: true,
      output: { path: reference, bytes: 12, verified: true, readbackSha256 },
    }])).toEqual([{
      id: expectedId,
      label: 'result.txt',
      kind: 'file',
      reference,
      checksum: `sha256:${readbackSha256}`,
    }]);
  });

  it('rejects model claims, failed effects and malformed readback receipts', () => {
    expect(projectAstraAgentFileArtifacts([
      { round: 1, capabilityId: 'workspace.files.write', reason: 'Claim only', state: 'proposed',
        output: { path: 'E:\\Workspace\\claim.txt', verified: true, readbackSha256: 'b'.repeat(64) } },
      { round: 2, capabilityId: 'workspace.files.write', reason: 'Failed', state: 'failed', ok: false,
        output: { path: 'E:\\Workspace\\failed.txt', verified: true, readbackSha256: 'c'.repeat(64) } },
      { round: 3, capabilityId: 'workspace.files.write', reason: 'Unverified', state: 'observed', ok: true,
        output: { path: 'E:\\Workspace\\unverified.txt', verified: false, readbackSha256: 'd'.repeat(64) } },
      { round: 4, capabilityId: 'workspace.files.write', reason: 'Bad digest', state: 'observed', ok: true,
        output: { path: 'E:\\Workspace\\bad.txt', verified: true, readbackSha256: 'not-a-digest' } },
    ])).toEqual([]);
  });
});
