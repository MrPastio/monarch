import { describe, expect, it } from 'vitest';
import { compileSimplifiedVoiceCommand } from '../../src/modules/voice/simplified-command';

describe('Simplified Voice command compiler', () => {
  it.each(['Оскар', 'Oscar!', 'эй, Оскар', 'Ооскаар'])('recognizes wake-only variant %s', (text) => {
    expect(compileSimplifiedVoiceCommand(text)).toMatchObject({ kind: 'wake', spokenText: 'Слушаю.' });
  });

  it('strips the wake word and compiles a deterministic device capability', () => {
    expect(compileSimplifiedVoiceCommand('Оскар, открой музыку')).toMatchObject({
      kind: 'capability',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'музыку' },
      risk: 'device-control',
    });
  });

  it('supports fast read-only status without an Agent turn', () => {
    expect(compileSimplifiedVoiceCommand('который час')).toMatchObject({
      kind: 'capability',
      capabilityId: 'device.system.time.get',
      input: { kind: 'time' },
      card: 'status',
    });
  });

  it('compiles bounded weather and exchange queries without a chat or Agent turn', () => {
    expect(compileSimplifiedVoiceCommand('покажи погоду завтра')).toMatchObject({
      kind: 'information', feature: 'weather', period: 'tomorrow', card: 'weather',
    });
    expect(compileSimplifiedVoiceCommand('сколько 100 долларов в гривнах')).toMatchObject({
      kind: 'information', feature: 'exchange-rate', currency: 'USD', amount: 100, card: 'exchange-rate',
    });
  });

  it('does not silently hand unknown, unconfigured provider, or destructive requests to the full Voice agent', () => {
    expect(compileSimplifiedVoiceCommand('расскажи про квантовую физику')).toMatchObject({ kind: 'handoff', reason: 'unsupported-command' });
    expect(compileSimplifiedVoiceCommand('покажи новости')).toMatchObject({ kind: 'handoff', reason: 'information-provider-not-configured' });
    expect(compileSimplifiedVoiceCommand('очисти корзину')).toMatchObject({ kind: 'handoff', reason: 'destructive-command-not-simplified' });
  });
});
