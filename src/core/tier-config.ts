import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MonarchTierConfig {
  tiers: Record<string, {
    keywords: string[];
    minLength: number;
  }>;
  scoring: MonarchTierScoring;
  tierPriority: string[];
}

export interface MonarchTierScoring {
  thresholds: {
    medium: number;
    powerful: number;
  };
  weights: MonarchTierScoringWeights;
}

export interface MonarchTierScoringWeights {
  lengthDivisor: number;
  lengthCap: number;
  multipart: number;
  context: number;
  freshness: number;
  structuredOutput: number;
  metaBase: number;
  metaDepth: number;
  metaActionDepth: number;
  metaDomainDepth: number;
  metaKnowledgeDepth: number;
  action: number;
  domain: number;
  knowledge: number;
  depth: number;
  highImpact: number;
  socialDamping: number;
}

export const DEFAULT_TIER_CONFIG: MonarchTierConfig = {
  tiers: {
    reasoning: {
      keywords: [
        'подумай пошагово',
        'deep reasoning',
        'сложная логика',
        'математическое доказательство',
        'докажи',
        'solve rigorously',
        'prove rigorously',
        'step by step',
      ],
      minLength: 0,
    },
    powerful: {
      keywords: [
        'refactor',
        'debug',
        'typescript',
        'javascript',
        'python',
        'api',
        'json schema',
        'архитектур',
        'безопасност',
        'security',
        'router',
        'runtime',
      ],
      minLength: 300,
    },
    medium: {
      keywords: [
        'объясни',
        'почему',
        'как',
        'расскажи',
        'опиши',
        'напиши',
        'what is',
        'why',
        'explain',
        'how',
      ],
      minLength: 100,
    },
    weak: {
      keywords: [],
      minLength: 0,
    },
  },
  scoring: {
    thresholds: { medium: 0.3, powerful: 0.6 },
    weights: {
      lengthDivisor: 1200,
      lengthCap: 0.12,
      multipart: 0.12,
      context: 0.08,
      freshness: 0.12,
      structuredOutput: 0.08,
      metaBase: 0.02,
      metaDepth: 0.22,
      metaActionDepth: 0.08,
      metaDomainDepth: 0.06,
      metaKnowledgeDepth: 0.04,
      action: 0.1,
      domain: 0.15,
      knowledge: 0.06,
      depth: 0.26,
      highImpact: 0.18,
      socialDamping: -0.1,
    },
  },
  tierPriority: ['reasoning', 'powerful', 'medium', 'weak'],
};

let cachedTierConfig: MonarchTierConfig | null = null;
let warnedMissingTierConfig = false;

export function readTierConfig(): MonarchTierConfig {
  if (cachedTierConfig) {
    return cachedTierConfig;
  }
  const configPath = findSharedTierConfigPath();
  if (!configPath) {
    warnMissingTierConfigOnce();
    cachedTierConfig = DEFAULT_TIER_CONFIG;
    return cachedTierConfig;
  }
  try {
    cachedTierConfig = mergeTierConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    warnMissingTierConfigOnce();
    cachedTierConfig = DEFAULT_TIER_CONFIG;
  }
  return cachedTierConfig;
}

export function matchesTierKeyword(text: string, tier: string): boolean {
  const lowered = text.toLowerCase();
  const keywords = readTierConfig().tiers[tier]?.keywords || [];
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

export function readTierScoringConfig(): MonarchTierScoring {
  return readTierConfig().scoring;
}

function mergeTierConfig(value: unknown): MonarchTierConfig {
  if (!value || typeof value !== 'object') {
    return DEFAULT_TIER_CONFIG;
  }
  const record = value as Partial<MonarchTierConfig>;
  const tiers = { ...DEFAULT_TIER_CONFIG.tiers };
  if (record.tiers && typeof record.tiers === 'object') {
    for (const [tier, config] of Object.entries(record.tiers)) {
      if (!tiers[tier] || !config || typeof config !== 'object') {
        continue;
      }
      tiers[tier] = {
        keywords: Array.isArray(config.keywords) ? config.keywords.map(String) : tiers[tier].keywords,
        minLength: typeof config.minLength === 'number' ? config.minLength : tiers[tier].minLength,
      };
    }
  }
  return {
    tiers,
    scoring: mergeScoringConfig(record.scoring),
    tierPriority: Array.isArray(record.tierPriority)
      ? record.tierPriority.map(String)
      : DEFAULT_TIER_CONFIG.tierPriority,
  };
}

function mergeScoringConfig(value: unknown): MonarchTierScoring {
  const fallback = DEFAULT_TIER_CONFIG.scoring;
  if (!value || typeof value !== 'object') return fallback;
  const record = value as Partial<MonarchTierScoring>;
  const thresholds: Partial<MonarchTierScoring['thresholds']> = record.thresholds ?? {};
  const weights: Partial<MonarchTierScoringWeights> = record.weights ?? {};
  return {
    thresholds: {
      medium: typeof thresholds.medium === 'number' ? thresholds.medium : fallback.thresholds.medium,
      powerful: typeof thresholds.powerful === 'number' ? thresholds.powerful : fallback.thresholds.powerful,
    },
    weights: {
      lengthDivisor: readScoringWeight(weights, 'lengthDivisor', fallback),
      lengthCap: readScoringWeight(weights, 'lengthCap', fallback),
      multipart: readScoringWeight(weights, 'multipart', fallback),
      context: readScoringWeight(weights, 'context', fallback),
      freshness: readScoringWeight(weights, 'freshness', fallback),
      structuredOutput: readScoringWeight(weights, 'structuredOutput', fallback),
      metaBase: readScoringWeight(weights, 'metaBase', fallback),
      metaDepth: readScoringWeight(weights, 'metaDepth', fallback),
      metaActionDepth: readScoringWeight(weights, 'metaActionDepth', fallback),
      metaDomainDepth: readScoringWeight(weights, 'metaDomainDepth', fallback),
      metaKnowledgeDepth: readScoringWeight(weights, 'metaKnowledgeDepth', fallback),
      action: readScoringWeight(weights, 'action', fallback),
      domain: readScoringWeight(weights, 'domain', fallback),
      knowledge: readScoringWeight(weights, 'knowledge', fallback),
      depth: readScoringWeight(weights, 'depth', fallback),
      highImpact: readScoringWeight(weights, 'highImpact', fallback),
      socialDamping: readScoringWeight(weights, 'socialDamping', fallback),
    },
  };
}

function readScoringWeight(
  weights: Partial<MonarchTierScoringWeights>,
  key: keyof MonarchTierScoringWeights,
  fallback: MonarchTierScoring,
): number {
  return typeof weights[key] === 'number' ? weights[key] : fallback.weights[key];
}

function findSharedTierConfigPath(): string {
  const candidates = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ];
  for (const candidate of candidates) {
    let current = path.resolve(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      const configPath = path.join(current, 'shared', 'tier-config.json');
      if (existsSync(configPath)) {
        return configPath;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return '';
}

function warnMissingTierConfigOnce(): void {
  if (warnedMissingTierConfig) {
    return;
  }
  warnedMissingTierConfig = true;
  console.warn('Monarch tier config is unavailable; using built-in fallback tier config.');
}
