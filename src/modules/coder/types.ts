export type CoderProjectSource = 'created' | 'imported';

export interface CoderProject {
  id: string;
  name: string;
  root: string;
  source: CoderProjectSource;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface CoderProjectRegistryV1 {
  version: 1;
  activeProjectId: string | null;
  projects: CoderProject[];
}

export type CoderModelId =
  | 'qwen3-coder-30b-a3b-instruct'
  | 'deepseek-coder-v2-lite-instruct';

export type CoderRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CoderRunEventKind =
  | 'status'
  | 'model'
  | 'assistant'
  | 'tool-start'
  | 'tool-result'
  | 'context-compacted'
  | 'error';

export interface CoderRunEvent {
  id: string;
  sequence: number;
  kind: CoderRunEventKind;
  createdAt: string;
  title: string;
  detail: string;
  capabilityId?: string;
  ok?: boolean;
  output?: unknown;
  error?: string;
}

export interface CoderContextSummary {
  goal: string;
  decisions: string[];
  modifiedFiles: string[];
  commands: string[];
  tests: string[];
  failures: string[];
  pending: string[];
  activeSkills: string[];
  lastAssistantSummary: string;
  compactedThroughSequence: number;
}

export interface CoderContextMetrics {
  budgetTokens: number;
  estimatedPromptTokens: number;
  reservedOutputTokens: number;
  retainedRecentEvents: number;
  totalEvents: number;
  compactions: number;
  modelCalls: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
}

export interface CoderRun {
  id: string;
  projectId: string;
  projectName?: string;
  projectRoot?: string;
  prompt: string;
  model: CoderModelId;
  fallbackModel: CoderModelId;
  status: CoderRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  answer: string;
  error: string;
  iteration: number;
  maxIterations: number;
  cancelled: boolean;
  events: CoderRunEvent[];
  summary: CoderContextSummary;
  context: CoderContextMetrics;
}

export interface CoderProjectSnapshot {
  project: CoderProject;
  entries: Array<{ path: string; type: 'file' | 'directory'; sizeBytes?: number }>;
  git: {
    available: boolean;
    repository: boolean;
    branch: string;
    status: string[];
  };
}
