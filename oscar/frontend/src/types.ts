export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatImageAttachment {
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  data_base64: string;
  name: string;
  size_bytes: number;
}

export interface UiMessage extends ChatMessage {
  id: string;
  imageAttachments?: ChatImageAttachment[];
  sources?: ChatSource[];
  toolResults?: WorkspaceToolResult[];
  pending?: boolean;
  streamEvents?: StreamEvent[];
  streamStatus?: string;
  streamTokens?: number;
  streamStartedAt?: number;
  streamUpdatedAt?: number;
  streamCorrected?: boolean;
  streamOk?: boolean;
  usage?: Record<string, string | number | boolean>;
}

export type StreamEventKind = 'status' | 'research' | 'search' | 'source' | 'tool' | 'token' | 'replace' | 'done' | 'error';

export interface StreamEvent {
  kind: StreamEventKind;
  label: string;
  detail?: string;
  at: number;
  count?: number;
}

export interface ChatSource {
  id: number;
  title: string;
  url?: string | null;
  excerpt: string;
  score?: number | null;
}

export interface ChatRequest {
  messages: ChatMessage[];
  incognito?: boolean;
  image_attachments?: ChatImageAttachment[];
  web_search?: boolean;
  use_memory: boolean;
  allow_tools?: boolean;
  reasoning_effort: 'low' | 'medium' | 'high';
  research_mode?: 'auto' | 'off' | 'deep';
  requested_model?: string;
  model_selection_source?: 'auto' | 'user-explicit' | 'voice-router' | 'fallback' | 'recovery';
  deep_thinking_consent?: 'allow' | 'deny';
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  access?: {
    sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy: 'on-request' | 'never';
  };
}

export interface ChatRoutePreview {
  selected_model: string;
  fallback_model?: string | null;
  auto_selected: boolean;
  deep_thinking: boolean;
  requires_confirmation: boolean;
  web_search: boolean;
  search_reason: string;
  research_mode: 'off' | 'standard' | 'deep';
  research_reason: string;
  research_score: number;
  ram_available_gb?: number | null;
  estimated_ram_required_gb?: number | null;
  projected_ram_available_gb?: number | null;
  ram_warning?: 'none' | 'caution' | 'critical';
  ram_warning_message?: string | null;
}

export interface MemoryStats {
  documents: number;
  chunks: number;
  updated_at?: string | null;
}

export interface HardwareInfo {
  gpu_name?: string | null;
  gpu_memory_total_mb?: number | null;
  gpu_memory_used_mb?: number | null;
  driver_version?: string | null;
  cuda_available: boolean;
  torch_version?: string | null;
  bf16_supported?: boolean | null;
  ram_total_gb?: number | null;
  ram_available_gb?: number | null;
}

export interface EnvironmentSnapshot {
  paths?: {
    workspace_root?: string;
    configured_workspace_root?: string;
    current_working_directory?: string;
    oscar_root?: string;
    backend_package?: string;
    generated_dir?: string;
    data_dir?: string;
    models_dir?: string;
  };
  system?: {
    os?: string;
    release?: string;
    version?: string;
    machine?: string;
    python?: string;
    python_executable?: string;
  };
  installed?: Record<string, {
    installed?: boolean;
    path?: string | null;
    version?: string | null;
  }>;
  models?: string[];
  hardware?: {
    gpu_probe?: string | null;
    ram_total_gb?: number | null;
    ram_available_gb?: number | null;
  };
}

export interface ModelStatus {
  loaded: boolean;
  mock: boolean;
  fallback_active?: boolean;
  runtime_mode?: string | null;
  active_tier?: string | null;
  model_path: string;
  gemma_models_dir?: string | null;
  gemma_main_model_path?: string | null;
  gemma_model_path?: string | null;
  gemma_partial_path?: string | null;
  gemma_vision_path?: string | null;
  gemma_draft_model_path?: string | null;
  gemma_model_ready?: boolean;
  gemma_vision_ready?: boolean;
  gemma_draft_ready?: boolean;
  gemma_draft_mode?: string | null;
  speculative_decoding?: boolean;
  speculative_status?: string | null;
  gemma_vision_runtime_status?: string | null;
  gemma_vision_note?: string | null;
  available_tiers?: Record<string, boolean>;
  llama_cpp_version?: string | null;
  gpu_offload_available?: boolean;
  gpu_policy?: string;
  device_map?: Record<string, string> | null;
  gpu_memory_gb: number;
  cpu_memory_gb: number;
  default_temperature?: number;
  default_top_p?: number;
  repetition_penalty?: number;
  no_repeat_ngram_size?: number;
  offload_dir: string;
  last_error?: string | null;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  ingested: boolean;
  chars: number;
  ingestion_status?: 'pending' | 'page' | 'snippet' | 'blocked' | 'failed' | 'skipped';
  status_detail?: string;
}

export type ToolKind = 'workspace' | 'memory' | 'environment';
export type ToolAction = 'read' | 'write' | 'append' | 'replace' | 'mkdir' | 'list' | 'search' | 'copy' | 'move' | 'trash' | 'restore' | 'remember' | 'environment';
export type WorkspaceAction = 'read' | 'write' | 'append' | 'replace' | 'mkdir' | 'list' | 'search' | 'copy' | 'move' | 'trash' | 'restore';

export interface WorkspaceActionRequest {
  action: WorkspaceAction;
  path?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  query?: string;
  target_path?: string;
  overwrite?: boolean;
  recursive?: boolean;
  limit?: number;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size_bytes?: number | null;
}

export interface WorkspaceMatch {
  path: string;
  line: number;
  preview: string;
}

export interface WorkspaceToolResult {
  ok: boolean;
  kind: ToolKind;
  action: ToolAction;
  summary: string;
  path?: string | null;
  query?: string | null;
  content?: string | null;
  bytes?: number | null;
  entries?: WorkspaceEntry[];
  matches?: WorkspaceMatch[];
  details?: EnvironmentSnapshot | Record<string, unknown> | null;
  error?: string | null;
}
