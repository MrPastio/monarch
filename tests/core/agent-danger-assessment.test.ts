import { describe, expect, it } from 'vitest';
import { assessAgentDanger, dangerResponseForMode } from '../../src/core/agent-danger-assessment';
import type { MonarchRiskVector } from '../../src/core/contracts';

const localDeviceVector: MonarchRiskVector = {
  effect: 'device',
  scope: 'system',
  reversibility: 'reversible',
  externality: 'local',
  privilege: 'user',
  data: 'public',
  novelty: 'known-capability',
};

describe('AgentDangerAssessmentV1', () => {
  it('keeps an explicitly requested application open on the immediate low-risk path', () => {
    const assessment = assessAgentDanger({
      request: {
        capabilityId: 'device.app.open',
        input: { app: 'Telegram' },
        originatingUserText: 'Открой Telegram',
        proposalSource: 'model-tool-call',
      },
      risk: 'device-control',
      riskVector: localDeviceVector,
      source: 'desktop',
    });

    expect(assessment).toMatchObject({
      schemaVersion: 'monarch.agent-danger-assessment.v1',
      band: expect.stringMatching(/minimal|low/),
    });
    expect(assessment.dangerProbability).toBeLessThanOrEqual(39);
    expect(dangerResponseForMode('guard', assessment.dangerProbability)).toBe('allow');
    expect(dangerResponseForMode('observe', assessment.dangerProbability)).toBe('observe');
  });

  it('raises remote-source risk and scores arbitrary shell execution above a local app open', () => {
    const desktop = assessAgentDanger({
      request: {
        capabilityId: 'system.shell.run',
        input: { executable: 'powershell.exe', args: ['-Command', 'Get-Date'], cwd: 'E:\\Agent-QA' },
        originatingUserText: 'Выполни Get-Date в терминале',
        proposalSource: 'model-tool-call',
      },
      risk: 'execute',
      riskVector: { ...localDeviceVector, effect: 'execute', novelty: 'arbitrary-code', reversibility: 'compensatable' },
      source: 'desktop',
    });
    const telegram = assessAgentDanger({
      request: {
        capabilityId: 'system.shell.run',
        input: { executable: 'powershell.exe', args: ['-Command', 'Get-Date'], cwd: 'E:\\Agent-QA' },
        originatingUserText: 'Выполни Get-Date в терминале',
        proposalSource: 'model-tool-call',
      },
      risk: 'execute',
      riskVector: { ...localDeviceVector, effect: 'execute', novelty: 'arbitrary-code', reversibility: 'compensatable' },
      source: 'telegram',
    });

    expect(desktop.dangerProbability).toBeGreaterThan(39);
    expect(telegram.dangerProbability).toBeGreaterThan(desktop.dangerProbability);
  });

  it.each([
    ['guard', 0, 'allow'], ['guard', 39, 'allow'],
    ['guard', 40, 'enhanced-readback'], ['guard', 69, 'enhanced-readback'],
    ['guard', 70, 'confirm'], ['guard', 89, 'confirm'], ['guard', 90, 'block'], ['guard', 100, 'block'],
    ['strict', 0, 'allow'], ['strict', 19, 'allow'],
    ['strict', 20, 'enhanced-readback'], ['strict', 49, 'enhanced-readback'],
    ['strict', 50, 'confirm'], ['strict', 79, 'confirm'], ['strict', 80, 'block'], ['strict', 100, 'block'],
    ['off', 100, 'allow'], ['observe', 100, 'observe'],
  ] as const)('maps %s score %i to %s at exact boundaries', (mode, score, response) => {
    expect(dangerResponseForMode(mode, score)).toBe(response);
  });
});
