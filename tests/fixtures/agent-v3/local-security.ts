import path from 'node:path';
import { SecurityModule } from '../../../src/modules/security';
import { AgentActionGuard } from '../../../src/modules/security/agent-guard';
import type { SecurityClient } from '../../../src/modules/security/client';

/** Actual TypeScript Security/Agent Guard with its normal unavailable-Python
 * fallback. No canned allow verdict, production profile/config or helper process.
 * Every named path belongs to the caller's marked synthetic workspace. */
export function isolatedLocalSecurity(root: string): SecurityModule {
  const unavailableTransport = {
    available: false,
    config: { projectRoot: path.join(root, 'security'), configPath: path.join(root, 'security', 'unused.toml'),
      pythonPath: path.join(root, 'no-python.exe'), timeoutMs: 1000 },
    backgroundBenchmarkStatus: () => null,
    dispose: () => {},
  } as unknown as SecurityClient;
  return new SecurityModule(unavailableTransport, new AgentActionGuard(root, { localReadOnlyRoots: [] }));
}
