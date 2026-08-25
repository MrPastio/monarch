export const OSCAR_CANCELLED_SUMMARY = 'Задача остановлена. Новые действия и повторные шаги не будут запущены.';

export function presentOscarHistoryContent(content, outcome) {
  return String(outcome || '').trim().toLowerCase() === 'cancelled'
    ? OSCAR_CANCELLED_SUMMARY
    : String(content || '');
}

export function appendUnhydratedLocalAssistant(existingMessages, hydratedMessages) {
  const hydrated = Array.isArray(hydratedMessages) ? hydratedMessages : [];
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const localAssistant = existing.at(-1);
  if (
    localAssistant?.role !== 'assistant'
    || localAssistant.pending
    || !String(localAssistant.content || '').trim()
  ) {
    return hydrated;
  }

  const localTurnId = String(localAssistant.turnId || '').trim();
  const alreadyHydrated = hydrated.some((message) => sameOscarMessage(localAssistant, message));
  if (alreadyHydrated) return hydrated;
  if (hydrated.length === 0) return existing;

  const localUserIndex = findLocalUserIndex(existing, localTurnId);
  const localUser = localUserIndex >= 0 ? existing[localUserIndex] : null;
  if (!localUser) return hydrated;
  const hydratedUser = [...hydrated].reverse().find((message) => message.role === 'user');
  const matchingUser = hydrated.some((message) => sameOscarMessage(localUser, message))
    || (!localTurnId
      && String(localUser.content || '').trim()
      && String(localUser.content || '').trim() === String(hydratedUser?.content || '').trim());
  if (matchingUser) return [...hydrated, localAssistant];

  // The outbox can still be behind both messages when a terminal event arrives.
  // Preserve the local turn pair only when the hydrated page has a stable
  // overlap with the same conversation; unrelated history stays isolated.
  const historicalLocalMessages = existing.slice(0, localUserIndex);
  const sameConversation = historicalLocalMessages.some((localMessage) => (
    hydrated.some((message) => sameOscarMessage(localMessage, message))
  ));
  return sameConversation
    ? [...hydrated, localUser, localAssistant]
    : hydrated;
}

export function isHydratedOscarFailure(outcome) {
  return String(outcome || '').trim().toLowerCase() === 'failed';
}

export function resolveHydratedOscarMessageLabel(message) {
  if (message?.role === 'user') return 'ты';
  return formatOscarModelLabel(message?.model_tier);
}

export function formatOscarModelLabel(value) {
  switch (String(value || '').toLowerCase()) {
  case 'gemma4-fast':
  case 'weak':
  case 'gemma_low':
    return 'Fast';
  case 'gemma4-balanced':
  case 'medium':
  case 'gemma':
  case 'gemma_high':
  case 'vision':
    return 'Medium';
  case 'gemma4-deepthinking':
  case 'powerful':
  case 'reasoning':
  case 'gemma4-31b':
  case 'qwen3.8-27b-pro':
    return 'Pro';
  case 'system':
    return 'Monarch';
  default:
    return '';
  }
}

export function resolveOscarHistoryListState({
  busy = false,
  error = '',
  conversationCount = 0,
  visibleCount = 0,
  queryActive = false,
} = {}) {
  const total = Math.max(0, Number(conversationCount) || 0);
  const visible = Math.max(0, Number(visibleCount) || 0);
  const historyError = String(error || '').trim();
  if (busy && total === 0) return { kind: 'loading', historyError: '' };
  if (historyError && total === 0) return { kind: 'unavailable', historyError };
  if (total === 0) return { kind: 'empty', historyError: '' };
  if (queryActive && visible === 0) return { kind: 'no-results', historyError };
  return { kind: 'ready', historyError };
}

function findLocalUserIndex(messages, turnId) {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (!turnId || String(message.turnId || '').trim() === turnId) return index;
  }
  return -1;
}

function sameOscarMessage(left, right) {
  if (!left || !right || left.role !== right.role) return false;
  const leftIds = stableOscarMessageIds(left);
  const rightIds = new Set(stableOscarMessageIds(right));
  if (leftIds.some((id) => rightIds.has(id))) return true;
  const leftTurnId = String(left.turnId || '').trim();
  const rightTurnId = String(right.turnId || '').trim();
  return Boolean(leftTurnId && leftTurnId === rightTurnId);
}

function stableOscarMessageIds(message) {
  return [message?.id, message?.clientMessageId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}
