import type { MonarchModuleManifest } from '../../core';

export const voiceManifest: MonarchModuleManifest = {
  id: 'voice',
  name: 'Monarch Voice',
  version: '1.0.0',
  kind: 'runtime',
  description: 'Local STT/TTS transport for the common Oscar Turn and Agent Runtime.',
  owns: ['voice transport', 'speech', 'stt', 'tts', 'microphone'],
  permissions: ['read', 'execute'],
  events: [
    'voice.activated',
    'voice.bridge.started',
    'voice.bridge.stopped',
    'voice.bridge.event',
    'voice.transcribe.completed',
    'voice.transcribe.ready',
  ],
  capabilities: [
    {
      id: 'voice.status',
      moduleId: 'voice',
      title: 'Voice status',
      description: 'Show configured voice bridge commands and running state.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'voice.transcribe.prepare',
      moduleId: 'voice',
      title: 'Prepare local voice transcription',
      description: 'Warm the local streaming STT transport without loading a separate conversational model.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'voice.transcribe.audio',
      moduleId: 'voice',
      title: 'Transcribe recorded audio',
      description: 'Transcribe a short recorded audio clip through a configured local one-shot STT command.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          audioBase64: { type: 'string' },
          mimeType: { type: 'string' },
          language: { type: 'string' },
          durationMs: { type: 'number' },
        },
        required: ['audioBase64'],
        additionalProperties: false,
      },
    },
    {
      id: 'voice.transcribe.stream.start',
      moduleId: 'voice',
      title: 'Start direct PCM transcription',
      description: 'Open a bounded local streaming STT session without persisting raw audio.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['ru-RU', 'uk-UA', 'bg-BG', 'en-US'] },
          sampleRate: { type: 'number', minimum: 8000, maximum: 48000 },
        },
        required: ['language', 'sampleRate'],
        additionalProperties: false,
      },
    },
    {
      id: 'voice.transcribe.stream.push',
      moduleId: 'voice',
      title: 'Push direct PCM audio',
      description: 'Decode one ordered, bounded PCM16 batch in the resident local STT worker.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 24, maxLength: 160 },
          sequence: { type: 'number', minimum: 0 },
          pcmBase64: { type: 'string', minLength: 4, maxLength: 98304 },
        },
        required: ['sessionId', 'sequence', 'pcmBase64'],
        additionalProperties: false,
      },
    },
    {
      id: 'voice.transcribe.stream.finish',
      moduleId: 'voice',
      title: 'Finish direct PCM transcription',
      description: 'Finalize the resident local STT stream and return its transcript and latency telemetry.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 24, maxLength: 160 },
          captureStoppedAtEpochMs: { type: 'number', minimum: 0 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      id: 'voice.transcribe.stream.cancel',
      moduleId: 'voice',
      title: 'Cancel direct PCM transcription',
      description: 'Release a local streaming STT session without retaining raw PCM or a transcript.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 24, maxLength: 160 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      id: 'voice.bridge.start',
      moduleId: 'voice',
      title: 'Start voice bridge',
      description: 'Start a configured STT or TTS bridge process.',
      risk: 'execute',

      inputSchema: {
        type: 'object',
        properties: {
          bridge: { type: 'string' },
        },
        required: ['bridge'],
        additionalProperties: false,
      },
    },
    {
      id: 'voice.bridge.stop',
      moduleId: 'voice',
      title: 'Stop voice bridge',
      description: 'Stop a managed STT or TTS bridge process.',
      risk: 'execute',

      inputSchema: {
        type: 'object',
        properties: {
          bridge: { type: 'string' },
        },
        required: ['bridge'],
        additionalProperties: false,
      },
    },
  ],
};
