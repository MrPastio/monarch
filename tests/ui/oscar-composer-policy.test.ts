import { describe, expect, it } from 'vitest';
import {
  resolveModelReasoningEffort,
  resolveOscarRequestedModel,
} from '../../src/ui/public/modules/oscar-composer-policy.js';

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

  it('exposes one Pro choice and migrates retired model values to it', () => {
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: true,
      modelSelection: 'gemma4-fast',
      deepThinking: 'gemma4-deepthinking',
    })).toBe('gemma4-fast');
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: true,
      modelSelection: 'gemma4-deepthinking',
    })).toBe('qwen3.8-27b-pro');
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: true,
      modelSelection: 'gemma4-31b',
    })).toBe('qwen3.8-27b-pro');
    expect(resolveOscarRequestedModel({
      intelligenceEnabled: true,
      modelSelection: 'qwen3.8-27b-pro',
    })).toBe('qwen3.8-27b-pro');
  });

  it('derives heavy reasoning internally from the selected model', () => {
    expect(resolveModelReasoningEffort('gemma4-fast')).toBe('low');
    expect(resolveModelReasoningEffort('gemma4-balanced')).toBe('low');
    expect(resolveModelReasoningEffort('gemma4-deepthinking')).toBe('high');
    expect(resolveModelReasoningEffort('gemma4-31b')).toBe('high');
    expect(resolveModelReasoningEffort('qwen3.8-27b-pro')).toBe('high');
  });

  it('leaves automatic model routing without an explicit override', () => {
    expect(resolveOscarRequestedModel({ intelligenceEnabled: true, modelSelection: 'none' })).toBe('');
    expect(resolveOscarRequestedModel({ intelligenceEnabled: true, modelSelection: 'auto' })).toBe('');
  });
});
