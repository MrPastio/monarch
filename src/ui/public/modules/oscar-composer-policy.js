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

export function resolveModelReasoningEffort(modelSelection = '', preference = 'auto') {
  // The person's explicit depth wins; `auto` keeps the per-model default.
  if (['low', 'medium', 'high'].includes(preference)) return preference;
  // A connected service keeps its own default depth.
  if (String(modelSelection).startsWith('max-cloud:')) return undefined;
  if (['max-gpt-oss-120b', 'max-qwen-3.8-27b'].includes(modelSelection)) return 'medium';
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
