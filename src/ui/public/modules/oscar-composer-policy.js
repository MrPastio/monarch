export function resolveOscarRequestedModel({
  intelligenceEnabled = false,
  modelSelection = 'none',
} = {}) {
  if (!intelligenceEnabled) {
    return '';
  }
  if (modelSelection && modelSelection !== 'none' && modelSelection !== 'auto') {
    return normalizeOscarModelSelection(modelSelection);
  }
  return '';
}

export function resolveModelReasoningEffort(modelSelection = '') {
  return normalizeOscarModelSelection(modelSelection) === 'qwen3.8-27b-pro'
    ? 'high'
    : 'low';
}

export function normalizeOscarModelSelection(modelSelection = '') {
  const normalized = String(modelSelection || '').trim().toLowerCase();
  if (['gemma4-deepthinking', 'gemma4-31b', 'powerful', 'reasoning', 'pro', 'extra'].includes(normalized)) {
    return 'qwen3.8-27b-pro';
  }
  return normalized;
}
