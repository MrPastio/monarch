import { randomUUID } from 'node:crypto';
import type {
  MonarchAgentCapabilitySource,
  MonarchExecutionResult,
  MonarchKernel,
} from '../../src/core';

export async function executeTypedCapability(
  kernel: MonarchKernel,
  capabilityId: string,
  input: Record<string, unknown> = {},
  options: { confirmed?: boolean; source?: MonarchAgentCapabilitySource } = {},
): Promise<MonarchExecutionResult> {
  const capability = kernel.getCapability(capabilityId);
  if (!capability) throw new Error(`Unknown test capability: ${capabilityId}`);
  const suffix = randomUUID();
  return kernel.execute({
    id: `exec_typed_test_${suffix}`,
    intentId: `intent_typed_test_${suffix}`,
    moduleId: capability.moduleId,
    capabilityId,
    input,
    createdAt: new Date(0).toISOString(),
    requestedBy: 'typed-capability-test',
    source: options.source || 'smoke',
    confirmed: options.confirmed === true,
  });
}
