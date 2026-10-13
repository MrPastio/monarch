import { astraJournalJson, type AstraJson, type AstraJournalAllocation, type AstraJournalCommit } from './journal';

/** Host-only ingress facts sharing the initial task's atomic commit and capacity.
 * Not accepted from a model proposal or serialized HTTP task request. */
export interface AstraTaskSourceAdmission { records: Array<{ streamId: string; checkpoint: AstraJson; events: AstraJson[] }> }
export function prepareAstraTaskSourceAdmission(admission: AstraTaskSourceAdmission | undefined, taskId: string,
  reservationId: string, protectedStreams: string[]): { commits: AstraJournalCommit[]; allocations: AstraJournalAllocation[] } {
  const records = admission?.records ?? [];
  if (records.length > 4 || new Set(records.map(item => item.streamId)).size !== records.length || records.some(item =>
    protectedStreams.includes(item.streamId) || Buffer.byteLength(astraJournalJson(item.checkpoint)) > 32768
    || Buffer.byteLength(astraJournalJson(item.events)) > 4096)) throw Error('astra-task:source-record-budget');
  return { commits: records.map((item, index) => ({ ...item, requestId: 'source_' + taskId + '_' + index,
    expectedRevision: 0, reservationId })), allocations: records.map(item => ({ streamId: item.streamId,
    commits: 1, eventBytes: 4096, checkpointBytes: 32768 })) };
}
