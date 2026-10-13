import { createHmac } from 'node:crypto';
import type { AstraTaskHttpRequest } from '../../../src/app/astra-task-facade';
import type { AstraSelectedTargetSnapshot } from '../../../src/app/astra-source-goal-compiler';
export type CompiledFixtureKind = 'compiled-read' | 'compiled-literal' | 'compiled-reply';
export const compiledFixtureContent = 'Содержимое из typed source 🟠\r\n';
export function compiledFixtureTargets(): AstraSelectedTargetSnapshot {
  return { selectionId: 'selected_targets', conversationId: 'owned_conversation', revision: 1,
    actor: { id: 'sha256:' + createHmac('sha256', 'owned-create-api').update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' },
    targets: [{ id: 'file', relativePath: 'selected.txt', access: 'observe', maxBytes: 8192, timeoutMs: 5000 },
      { id: 'new_file', relativePath: 'draft.txt', access: 'exclusive-create', maxBytes: 4096, timeoutMs: 5000 }] };
}
export function compiledFixtureRequest(kind: CompiledFixtureKind): AstraTaskHttpRequest {
  return { version: 1, clientRequestId: 'request_' + kind, conversationId: 'owned_conversation', inputMessageId: 'message_' + kind,
    text: kind === 'compiled-read' ? 'Прочитай выбранный файл.' : 'Создай новый файл draft.txt с указанным содержимым.',
    selectionId: 'selected_targets', privacyMode: 'persistent', goal: kind === 'compiled-read' ? { kind: 'observe', targets: ['file'] }
      : { kind: 'create', target: 'new_file', content: kind === 'compiled-literal' ? { kind: 'literal', text: compiledFixtureContent } : { kind: 'reply' } } };
}
