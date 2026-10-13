import { astraDraftContentFingerprint } from '../../../src/agent-v3/draft-content-acceptance';
import { modelReadDigest } from '../../../src/agent-v3/model-read-task-state';
import type { AstraTaskHttpRequest, AstraTaskSourceContext, AstraCreateCatalogSelection } from '../../../src/app/astra-task-facade';
export const literalContent = 'SYNTHETIC LITERAL 🟠';
export const draftContent = 'Hello, Astra!';
export type FixtureTaskKind = 'read' | 'literal' | 'draft' | 'constrained' | 'required' | 'literal-input';
export function fixtureRequest(kind: FixtureTaskKind, suffix = kind): AstraTaskHttpRequest {
  const text = kind === 'read' ? 'Read selected.txt and report observed byte count.' : kind === 'literal'
    ? 'Create literal.txt with the selected literal content.' : kind === 'literal-input'
      ? 'Create draft.txt with the exact content of my next bound reply, including empty content and all whitespace.' : kind === 'required'
      ? 'Create a new greeting in draft.txt. The recipient and tone still need clarification.' : 'Create draft.txt containing exactly Hello, Astra!';
  return { version: 1, clientRequestId: 'request_' + suffix, conversationId: 'owned_conversation', inputMessageId: 'message_' + suffix,
    text, selectionId: kind, privacyMode: 'persistent' };
}
export function readSelection(selectionId: string, context: AstraTaskSourceContext) {
  if (selectionId !== 'read' || context.text !== fixtureRequest('read').text) throw Error('owned-read-selection');
  return { authority: 'observe' as const, revision: 1, digest: modelReadDigest('owned-http-read'),
    requirements: [{ id: 'first', relativePath: 'selected.txt', maxBytes: 8192 }] };
}
export function createSelection(selectionId: string, context: AstraTaskSourceContext): AstraCreateCatalogSelection {
  if (!['literal', 'draft', 'constrained', 'required', 'literal-input'].includes(selectionId) || context.text !== fixtureRequest(selectionId as FixtureTaskKind).text) throw Error('owned-create-selection');
  const base = { authority: 'exclusive-create' as const, revision: 1, digest: modelReadDigest('owned-http-create-' + selectionId), timeoutMs: 5000 };
  return selectionId === 'literal' ? { ...base, kind: 'literal', basename: 'literal.txt', content: literalContent }
    : selectionId === 'literal-input' ? { ...base, kind: 'literal-input', basename: 'draft.txt', maxBytes: 4096,
      requiredInput: { kind: 'literal-content', id: 'file_bytes', question: 'Enter exact content; an empty answer creates an empty file.', maxUtf8Bytes: 4096 } }
    : { ...base, kind: 'draft', basename: 'draft.txt', maxBytes: 8192,
      ...(['constrained', 'required'].includes(selectionId) ? { contentRequirement: { kind: 'exact-utf8' as const, ...astraDraftContentFingerprint(draftContent) } } : {}),
      ...(selectionId === 'required' ? { requiredInput: { kind: 'draft-guidance' as const, id: 'greeting_details',
        question: 'Who is the greeting for, and what tone should it use?', maxUtf8Bytes: 128 } } : {}) };
}
