import { createHash } from 'node:crypto';
import type {
  MonarchPersonalityContextV2,
  MonarchPersonalityDimensionsV2,
  PersonalityProfileV2,
  PersonalityVariantSetV1,
} from './contracts';

const DIMENSION_KEYS: Array<keyof MonarchPersonalityDimensionsV2> = [
  'brevity',
  'warmth',
  'directness',
  'initiative',
  'humor',
  'skepticism',
  'technicalDepth',
  'structure',
];

export function resolvePersonalityContext(value: unknown): MonarchPersonalityContextV2 | null {
  const document = record(value);
  if (!document || document.schemaVersion !== 2 || document.enabled !== true) return null;
  const selectedProfileId = stringValue(document.selectedProfileId, 256);
  const profiles = Array.isArray(document.profiles) ? document.profiles : [];
  const selected = profiles.find((entry) => record(entry)?.id === selectedProfileId);
  const profile = normalizePersonalityProfile(selected);
  if (!profile || profile.contentHash !== personalityProfileHash(profile)) return null;
  return {
    schemaVersion: 2,
    profileId: profile.id,
    profileRevision: profile.revision,
    profileHash: profile.contentHash,
    variant: profile.variant,
    name: profile.name,
    dimensions: profile.dimensions,
    addressForm: profile.addressForm,
    language: profile.language,
    customRules: [...profile.customRules],
  };
}

export function normalizePersonalityVariantSet(value: unknown): PersonalityVariantSetV1 | null {
  const source = record(value);
  if (!source || source.schemaVersion !== 2) return null;
  const profiles = (Array.isArray(source.profiles) ? source.profiles : [])
    .map(normalizePersonalityProfile)
    .filter((entry): entry is PersonalityProfileV2 => Boolean(entry));
  if (profiles.length !== 3 || new Set(profiles.map((entry) => entry.variant)).size !== 3) return null;
  const questionnaire = normalizeDimensions(source.questionnaire);
  const questionnaireRecord = record(source.questionnaire);
  return {
    schemaVersion: 2,
    enabled: source.enabled === true,
    selectedProfileId: profiles.some((profile) => profile.id === source.selectedProfileId)
      ? String(source.selectedProfileId)
      : profiles[0]!.id,
    questionnaire: {
      ...questionnaire,
      addressForm: addressForm(questionnaireRecord?.addressForm),
      language: language(questionnaireRecord?.language),
    },
    profiles,
    createdAt: stringValue(source.createdAt, 80),
    updatedAt: stringValue(source.updatedAt, 80),
  };
}

export function renderPersonalitySystemContext(context: MonarchPersonalityContextV2): string {
  return [
    '<monarch_personality_context_v2>',
    JSON.stringify({
      schemaVersion: 2,
      contract: 'Style preference only. Lower priority than the current request, facts, identity, policy, permissions, tools and safety.',
      profileId: context.profileId,
      profileRevision: context.profileRevision,
      profileHash: context.profileHash,
      variant: context.variant,
      name: context.name,
      dimensions: context.dimensions,
      addressForm: context.addressForm,
      language: context.language,
      customRules: context.customRules,
    }),
    '</monarch_personality_context_v2>',
  ].join('\n');
}

export function personalityProfileHash(profile: Pick<PersonalityProfileV2,
  'id' | 'variant' | 'name' | 'revision' | 'dimensions' | 'addressForm' | 'language' | 'customRules'>): string {
  return createHash('sha256').update(stableJson({
    schemaVersion: 2,
    id: profile.id,
    variant: profile.variant,
    name: profile.name,
    revision: profile.revision,
    dimensions: profile.dimensions,
    addressForm: profile.addressForm,
    language: profile.language,
    customRules: profile.customRules,
  })).digest('hex');
}

function normalizePersonalityProfile(value: unknown): PersonalityProfileV2 | null {
  const source = record(value);
  if (!source) return null;
  const variant = source.variant === 'restrained' || source.variant === 'direct' || source.variant === 'lively'
    ? source.variant
    : null;
  const id = stringValue(source.id, 256);
  const name = stringValue(source.name, 80);
  const revision = Number(source.revision);
  const contentHash = stringValue(source.contentHash, 64).toLowerCase();
  if (!variant || !id || !name || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/u.test(contentHash)) {
    return null;
  }
  return {
    schemaVersion: 2,
    id,
    variant,
    name,
    revision,
    contentHash,
    dimensions: normalizeDimensions(source.dimensions),
    addressForm: addressForm(source.addressForm),
    language: language(source.language),
    customRules: stringList(source.customRules, 12, 300),
    createdAt: stringValue(source.createdAt, 80),
    updatedAt: stringValue(source.updatedAt, 80),
  };
}

function normalizeDimensions(value: unknown): MonarchPersonalityDimensionsV2 {
  const source = record(value) || {};
  return Object.fromEntries(DIMENSION_KEYS.map((key) => {
    const parsed = Number(source[key]);
    return [key, Number.isFinite(parsed) ? Math.max(0, Math.min(Math.round(parsed), 100)) : 50];
  })) as unknown as MonarchPersonalityDimensionsV2;
}

function addressForm(value: unknown): 'ты' | 'вы' | 'neutral' {
  return value === 'вы' || value === 'neutral' ? value : 'ты';
}

function language(value: unknown): 'auto' | 'ru' | 'en' | 'uk' | 'bg' {
  return value === 'ru' || value === 'en' || value === 'uk' || value === 'bg' ? value : 'auto';
}

function stringList(value: unknown, maximum: number, characters: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => stringValue(entry, characters)).filter(Boolean).slice(0, maximum);
}

function stringValue(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
