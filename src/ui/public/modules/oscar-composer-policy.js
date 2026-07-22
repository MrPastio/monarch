export function resolveOscarRequestedModel({
  intelligenceEnabled = false,
  modelSelection = 'none',
  deepThinking = 'none',
} = {}) {
  if (deepThinking && deepThinking !== 'none') {
    return deepThinking;
  }
  if (!intelligenceEnabled) {
    return '';
  }
  if (modelSelection && modelSelection !== 'none' && modelSelection !== 'auto') {
    return modelSelection;
  }
  return '';
}
