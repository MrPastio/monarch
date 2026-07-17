import type { MonarchModuleManifest } from '../../core';

export const profileManifest: MonarchModuleManifest = {
  id: 'profile',
  name: 'Monarch Identity',
  version: '0.1.0',
  kind: 'system',
  description: 'Local profile store for Monarch identity, style preferences, boundaries, and adaptive summary.',
  owns: ['profile', 'preferences', 'style rules', 'boundaries', 'identity'],
  permissions: ['read', 'write'],
  events: [
    'profile.activated',
    'profile.updated',
  ],
  capabilities: [
    {
      id: 'profile.read',
      moduleId: 'profile',
      title: 'Read profile',
      description: 'Read the local Monarch profile.',
      risk: 'read',
      routing: {
        aliases: ['show profile', 'read profile', 'monarch profile'],
        keywords: ['profile', 'identity', 'preferences', 'style', 'boundaries'],
        examples: ['show Monarch profile'],
        intentKinds: ['profile.read'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'profile.update',
      moduleId: 'profile',
      title: 'Update profile',
      description: 'Update local Monarch profile fields.',
      risk: 'write',
      routing: {
        aliases: ['update profile', 'save preference', 'remember preference'],
        keywords: ['profile', 'update', 'preference', 'style', 'boundary', 'trait'],
        examples: ['update profile preference tone=concise'],
        intentKinds: ['profile.write'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          displayName: { type: 'string' },
          adaptiveSummary: { type: 'string' },
          traits: { type: 'array' },
          styleRules: { type: 'array' },
          boundaries: { type: 'array' },
          preferences: { type: 'object' },
        },
        additionalProperties: false,
      },
    },
  ],
};
