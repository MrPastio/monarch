import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecurityClient, type SecurityCommandResult, type SecurityCommandRunOptions } from '../../src/modules/security/client';

const securityProjectRoot = path.join(tmpdir(), 'monarch-security-client-tests');
const temporaryDataRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDataRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CapturingSecurityClient extends SecurityClient {
  calls: Array<{ args: string[]; options: SecurityCommandRunOptions }> = [];

  override async run(args: string[], options: SecurityCommandRunOptions = {}): Promise<SecurityCommandResult> {
    this.calls.push({ args, options });
    return {
      ok: true,
      exitCode: 0,
      args,
      stdout: '',
      stderr: '',
      jsonLines: [],
    };
  }
}

describe('SecurityClient command normalization', () => {
  it('keeps direct numeric arguments inside the Python CLI contract', async () => {
    const client = await createCapturingClient();

    await client.stop(Number.POSITIVE_INFINITY, '483920');
    await client.tailAudit(Number.POSITIVE_INFINITY);
    await client.incidents(Number.POSITIVE_INFINITY);
    await client.listQuarantine();
    await client.isolateFile({ targetPath: 'E:\\Downloads\\sample.exe', incidentId: 'inc-1' });
    await client.restoreQuarantine({ quarantineId: 'q-1' });
    await client.listResponses(Number.POSITIVE_INFINITY);
    await client.proposeResponse({
      incidentId: 'inc-1',
      action: 'isolate',
      scope: { path: 'E:\\Downloads\\sample.exe' },
      rationale: ['test'],
      proposedBy: 'llm',
      ttlSeconds: Number.POSITIVE_INFINITY,
    });
    await client.evaluateResponse('proposal-1');
    await client.approveResponse('proposal-1', '483920');
    await client.listResponseActions();
    await client.responseServiceStatus();
    await client.pinStatus();
    await client.setPin({ newPin: '483920', confirmation: '483920' });
    await client.verifyPin('483920');
    await client.recoverPin({ recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE', newPin: '739105', confirmation: '739105' });
    await client.networkCenter(Number.POSITIVE_INFINITY);
    await client.setNetworkProfileTrust('0123456789abcdef01234567', true);
    await client.setNetworkProfileTrust('0123456789abcdef01234567', false);
    await client.scanPath({
      targetPath: 'E:\\Monarch',
      recursive: true,
      limit: Number.POSITIVE_INFINITY,
      noLlm: true,
    });
    await client.scanSystem({
      noLlm: true,
      includeFiles: true,
      includeInstalls: false,
      fileLimit: -10,
      summaryOnly: true,
    });
    await client.generateReport({
      noLlm: true,
      includeFiles: true,
      includeInstalls: false,
      fileLimit: Number.NaN,
      summaryOnly: true,
    });
    await client.updateIncident({
      incidentId: 'inc-1',
      status: 'dismissed',
      reason: 'known safe',
    });

    expect(client.calls[0].args).toEqual(['stop', '--wait', '300', '--confirm', '--request-stdin']);
    expect(client.calls[0].options.timeoutMs).toBe(303000);
    expect(client.calls[0].args.join(' ')).not.toContain('483920');
    expect(JSON.parse(String(client.calls[0].options.stdinPayload))).toMatchObject({
      pin: '483920',
      purpose: 'security.protection.stop',
    });
    expect(client.calls[1].args).toEqual(['tail-audit', '--lines', '1000']);
    expect(client.calls[2].args).toEqual(['incidents', '--limit', '1000']);
    expect(client.calls[3].args).toEqual(['quarantine-list']);
    expect(client.calls[4].args).toEqual(['quarantine-isolate', 'E:\\Downloads\\sample.exe', '--incident-id', 'inc-1', '--confirm-isolate']);
    expect(client.calls[5].args).toEqual(['quarantine-restore', 'q-1', '--confirm-restore']);
    expect(client.calls[6].args).toEqual(['responses', '--limit', '1000']);
    expect(client.calls[7].args).toContain('3600');
    expect(client.calls[7].args).toContain('{"path":"E:\\\\Downloads\\\\sample.exe"}');
    expect(client.calls[8].args).toEqual(['evaluate-response', 'proposal-1']);
    expect(client.calls[9].args[0]).toBe('approve-response');
    expect(client.calls[9].args[1]).toBe('proposal-1');
    expect(client.calls[9].args).toContain('--confirm-approval');
    expect(client.calls[9].args).toContain('--request-stdin');
    expect(client.calls[10].args).toEqual(['response-actions']);
    expect(client.calls[11].args).toEqual(['response-service-status']);
    expect(client.calls[12].args).toEqual(['pin-status']);
    expect(client.calls[13].args[0]).toBe('pin-set');
    expect(client.calls[13].args[1]).toBe('--request-stdin');
    expect(client.calls[14].args[0]).toBe('pin-verify');
    expect(client.calls[15].args[0]).toBe('pin-recover');
    expect(client.calls[15].args.join(' ')).not.toContain('AAAA-BBBB');
    expect(client.calls[15].args.join(' ')).not.toContain('739105');
    expect(client.calls[16].args).toEqual(['network-center', '--limit', '1000']);
    expect(client.calls[17].args).toEqual(['network-profile-trust', '--profile-id', '0123456789abcdef01234567', '--confirm']);
    expect(client.calls[18].args).toEqual(['network-profile-untrust', '--profile-id', '0123456789abcdef01234567', '--confirm']);
    expect(client.calls[19].args).toContain('10000');
    expect(client.calls[20].args).toContain('1');
    expect(client.calls[21].args).toContain('100');
    expect(client.calls[22].args).toEqual([
      'incident-update', '--incident-id', 'inc-1', '--status', 'dismissed', '--reason', 'known safe', '--confirm',
    ]);
  });

  it('keeps emergency PIN out of process arguments and uses the child stdin pipe', async () => {
    const client = await createCapturingClient();
    await client.emergencyStatus();
    const result = await client.resolveEmergency({ decision: 'release', pin: '483920' });
    expect(client.calls[0].args).toEqual(['emergency-status']);
    expect(client.calls[1].args[0]).toBe('emergency-resolve');
    expect(client.calls[1].args).toContain('--confirm-emergency');
    expect(client.calls[1].args).toContain('--request-stdin');
    expect(client.calls[1].args.join(' ')).not.toContain('483920');
    expect(result.args).toContain('--request-stdin');
    expect(JSON.parse(String(client.calls[1].options.stdinPayload))).toEqual({ pin: '483920' });
  });

  it('adds PIN authorization only to the off profile transition', async () => {
    const client = await createCapturingClient();

    await client.setProfile('maximum');
    await client.setProfile('off', '483920');

    expect(client.calls[0]).toMatchObject({
      args: ['profile-set', '--level', 'maximum', '--confirm'],
      options: { timeoutMs: 12000 },
    });
    expect(client.calls[0].options.stdinPayload).toBeUndefined();
    expect(client.calls[1].args).toEqual([
      'profile-set', '--level', 'off', '--confirm', '--request-stdin',
    ]);
    expect(client.calls[1].args.join(' ')).not.toContain('483920');
    expect(JSON.parse(String(client.calls[1].options.stdinPayload))).toMatchObject({
      pin: '483920',
      purpose: 'security.profile.off',
    });
  });

  it('persists the Action Guard reaction independently from the sensor profile', async () => {
    const client = await createCapturingClient();

    await client.setModelPolicy({ enabled: true, actionGuardReaction: 'observe' });

    expect(client.calls[0]).toMatchObject({
      args: ['model-policy-set', '--enabled', 'true', '--reaction', 'observe', '--confirm'],
      options: { timeoutMs: 30000 },
    });
  });
});

async function createCapturingClient(): Promise<CapturingSecurityClient> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'monarch-security-client-data-'));
  temporaryDataRoots.push(dataRoot);
  return new CapturingSecurityClient({
    projectRoot: securityProjectRoot,
    dataRoot,
    pythonPath: 'python',
  });
}
