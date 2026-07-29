import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const contract = JSON.parse(
  readFileSync(
    path.join(root, 'assets', 'voice', 'reference-provenance.json'),
    'utf8',
  ),
) as {
  status: string;
  generationEvidence: {
    sourceContractSha256: string | null;
    generatorSha256: string | null;
    manifestSha256: string | null;
  };
  voices: Array<{
    artifact: {
      status: string;
      sha256: string | null;
      bytes: number | null;
      durationSeconds: number | null;
      sampleRateHz: number | null;
    };
  }>;
};

describe('synthetic voice reference release gate', () => {
  it('requires verified evidence and exact promoted WAV readback', () => {
    expect(contract.status).toBe('verified');
    expect(contract.generationEvidence.sourceContractSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(contract.generationEvidence.generatorSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(contract.generationEvidence.manifestSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const voice of contract.voices) {
      expect(voice.artifact.status).toBe('verified');
      expect(voice.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(voice.artifact.bytes).toBeGreaterThan(44);
      expect(voice.artifact.durationSeconds).toBeGreaterThan(0);
      expect(voice.artifact.sampleRateHz).toBeGreaterThan(0);
    }
    const output = execFileSync(
      'python',
      ['tools/generate-voice-references.py', 'verify-release'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    expect(JSON.parse(output)).toEqual({ ok: true, release: 'verified' });
  });
});
