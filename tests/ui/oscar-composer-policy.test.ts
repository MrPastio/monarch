import { describe, expect, it } from 'vitest';
import { resolveOscarRequestedModel } from '../../src/ui/public/modules/oscar-composer-policy.js';

describe('Oscar composer model policy', () => {
  it('keeps manual model selection inactive until Intelligence is enabled', () => {
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: false,
      modelSelection: 'gemma4-fast',
    })).toBe('');
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: true,
      modelSelection: 'gemma4-fast',
    })).toBe('gemma4-fast');
  });

  it('keeps Deep Thinking independent and higher priority than Intelligence', () => {
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: false,
      modelSelection: 'gemma4-fast',
      deepThinking: 'gemma4-deepthinking',
    })).toBe('gemma4-deepthinking');
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: true,
      modelSelection: 'gemma4-balanced',
      deepThinking: 'gemma4-31b',
    })).toBe('gemma4-31b');
  });

  it('leaves automatic model routing without an explicit override', () => {
    expect(resolveOscarRequestedModel({ intelligenceEnabled: true, modelSelection: 'none' })).toBe('');
    expect(resolveOscarRequestedModel({ intelligenceEnabled: true, modelSelection: 'auto' })).toBe('');
  });
});
