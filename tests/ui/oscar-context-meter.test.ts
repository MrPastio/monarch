import { describe, expect, it } from 'vitest';
import {
  formatOscarContextTokenCount,
  resolveOscarContextMeterState,
} from '../../src/ui/public/modules/oscar-context-meter.js';

describe('Oscar context meter', () => {
  it('does not invent usage before real telemetry exists', () => {
    expect(resolveOscarContextMeterState(null)).toEqual({
      hasTelemetry: false,
      percent: 0,
      remainingPercent: 100,
      total: 0,
      used: 0,
      usage: 'unknown',
      contextTrimmed: false,
      droppedMessages: 0,
    });
  });

  it('derives fill, severity and compaction details from backend telemetry', () => {
    expect(resolveOscarContextMeterState({
      context_tokens: 8192,
      input_tokens: 7168,
      context_trimmed: true,
      dropped_messages: 3,
    })).toEqual({
      hasTelemetry: true,
      percent: 88,
      remainingPercent: 12,
      total: 8192,
      used: 7168,
      usage: 'high',
      contextTrimmed: true,
      droppedMessages: 3,
    });
  });

  it('formats compact token values without replacing the source numbers', () => {
    expect(formatOscarContextTokenCount(258_000)).toContain('258');
    expect(formatOscarContextTokenCount(94)).toBe('94');
  });
});
