import type { OscarClient } from '../modules/oscar/client';
import { AstraMemoryRecallAdmission, type AstraRecallPolicy } from '../agent-v3/memory-recall-admission';
import type { LocalOwnerDevSettingsStore } from '../settings/owner-dev';

/** Explicit host composition only. Does not create a client, discover credentials,
 * start a backend, enable a feature, or substitute for the task's live policy gate.
 * The caller retains the authoritative consent/revision policy across restart. */
export function createAstraOscarMemoryPorts(client: Pick<OscarClient, 'retrieveAgentMemoryContext' | 'readMemoryContextValidity'>,
  policy: () => AstraRecallPolicy, timeoutMs = 500) {
  return {
    admission: new AstraMemoryRecallAdmission({ policy, timeoutMs,
      retrieve: async (query, signal) => {
        const result = await client.retrieveAgentMemoryContext(query, signal);
        // Legacy recall is readable as history, but cannot enter this live path.
        if (!result || typeof result !== 'object' || !('validityToken' in result)
          || typeof result.validityToken !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(result.validityToken)) {
          throw Error('astra-oscar-memory-live-token-required');
        }
        return result;
      } }),
    readValidity: (signal: AbortSignal) => client.readMemoryContextValidity({ type: 'chat' }, signal),
  };
}

/** Uses the existing settings owner; no parallel settings file or polling cache.
 * Changes must flow through that owner's revisioned writes. */
export function createAstraOscarMemoryFromSettings(client: Pick<OscarClient, 'retrieveAgentMemoryContext' | 'readMemoryContextValidity'>,
  settings: Pick<LocalOwnerDevSettingsStore, 'snapshotWithRevision'>, timeoutMs = 500) {
  const policy = (): AstraRecallPolicy => {
    const snapshot = settings.snapshotWithRevision();
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.value.diagnostic) {
      return { enabled: false, revision: 'invalid' };
    }
    return { enabled: snapshot.value.memoryEnabled === true && snapshot.value.zeroRetentionEnabled === false,
      revision: 'dev_' + snapshot.revision };
  };
  return { ...createAstraOscarMemoryPorts(client, policy, timeoutMs),
    isCurrent: () => { try { return policy().enabled; } catch { return false; } } };
}
