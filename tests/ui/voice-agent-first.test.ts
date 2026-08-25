import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { oscarManifest } from '../../src/modules/oscar/manifest';
import { voiceManifest } from '../../src/modules/voice/manifest';

describe('Voice Agent-first surface', () => {
  it('keeps Voice as STT/TTS transport and exposes no private decision or execution loop', () => {
    const capabilityIds = voiceManifest.capabilities.map((capability) => capability.id);

    expect(capabilityIds).toContain('voice.transcribe.prepare');
    expect(capabilityIds).toContain('voice.transcribe.audio');
    expect(capabilityIds.some((id) => id.startsWith('voice.mode.'))).toBe(false);
  });

  it('submits one common Agent Turn after transcription', () => {
    const source = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );

    expect(source).toContain('executeVoiceAgentTask(text, controller.signal)');
    expect(source).toContain("surface.dataset.lane = 'agent'");
    expect(source).not.toContain('classifyVoiceModeText');
    expect(source).not.toContain('dispatchVoiceModeTurn');
    expect(source).not.toContain('respondVoiceModeFast');
    expect(source).not.toContain('respondVoiceModeRealtime');
  });

  it('leaves no dedicated Voice answer lane in the Oscar bridge or backend', () => {
    const capabilityIds = oscarManifest.capabilities.map((capability) => capability.id);
    const backendSource = readFileSync(
      new URL('../../oscar/backend/oscar_agent/main.py', import.meta.url),
      'utf8',
    );
    const promptCatalog = readFileSync(
      new URL('../../oscar/backend/oscar_agent/prompt_catalog.py', import.meta.url),
      'utf8',
    );

    expect(capabilityIds.some((id) => id.startsWith('oscar.voice.'))).toBe(false);
    expect(backendSource).not.toContain('/api/voice/fast');
    expect(backendSource).not.toContain('/api/voice/realtime');
    expect(promptCatalog).not.toContain('oscar.voice.fast');
    expect(promptCatalog).not.toContain('oscar.voice.realtime');
  });
});
