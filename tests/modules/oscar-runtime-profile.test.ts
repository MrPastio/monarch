import { describe, expect, it, vi } from 'vitest';
import { hasWorkingNvidiaRuntime } from '../../src/modules/oscar/runtime-profile';

describe('installed Oscar runtime profile', () => {
  it('does not mistake a driver file for a working NVIDIA device', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '', stderr: 'no device' } as never));
    expect(hasWorkingNvidiaRuntime({
      platform: 'win32',
      fileExists: () => true,
      run,
    })).toBe(false);
    expect(run).toHaveBeenCalled();
  });

  it('selects CUDA only after nvidia-smi reports a real device', () => {
    expect(hasWorkingNvidiaRuntime({
      platform: 'win32',
      fileExists: () => true,
      run: () => ({ status: 0, stdout: 'NVIDIA RTX, 999.1\n' } as never),
    })).toBe(true);
  });

  it('never probes NVIDIA on non-Windows platforms', () => {
    const run = vi.fn();
    expect(hasWorkingNvidiaRuntime({ platform: 'linux', run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
