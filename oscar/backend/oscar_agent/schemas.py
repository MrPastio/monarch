import base64
import binascii
import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Role = Literal["system", "user", "assistant"]
MAX_CHAT_MESSAGE_CHARS = 20_000
MAX_CHAT_MESSAGES = 64
MAX_CAPABILITY_SCHEMA_CHARS = 8192
MAX_RESOURCE_ID_CHARS = 64
MAX_ROUTE_HINT_CHARS = 160
MAX_SEARCH_QUERY_CHARS = 2048
MAX_WORKSPACE_PATH_CHARS = 2048
MAX_WORKSPACE_TEXT_CHARS = 512 * 1024


class ChatMessage(BaseModel):
    role: Role
    content: str = Field(min_length=1, max_length=MAX_CHAT_MESSAGE_CHARS)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        require_non_blank_text(value)
        return value


ImageMimeType = Literal["image/png", "image/jpeg", "image/webp"]
MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024


def require_non_blank_text(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("text must not be blank")
    return cleaned


class ChatImageAttachment(BaseModel):
    mime_type: ImageMimeType
    data_base64: str = Field(min_length=1, max_length=12 * 1024 * 1024)
    name: str = Field(default="image", max_length=120)
    size_bytes: int = Field(default=0, ge=0, le=MAX_CHAT_IMAGE_BYTES)

    @field_validator("data_base64")
    @classmethod
    def validate_base64(cls, value: str) -> str:
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("image attachment must contain valid base64") from exc
        if len(raw) > MAX_CHAT_IMAGE_BYTES:
            raise ValueError("image attachment exceeds size limit")
        return value

    def as_data_url(self) -> str:
        return f"data:{self.mime_type};base64,{self.data_base64}"


class ChatSource(BaseModel):
    id: int
    title: str
    url: str | None = None
    excerpt: str
    score: float | None = None


class ChatRouteHint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intentKind: str | None = Field(default=None, max_length=MAX_ROUTE_HINT_CHARS)
    modelTier: str | None = Field(default=None, max_length=MAX_ROUTE_HINT_CHARS)
    riskHint: str | None = Field(default=None, max_length=MAX_ROUTE_HINT_CHARS)
    language: str | None = Field(default=None, max_length=MAX_ROUTE_HINT_CHARS)

    @field_validator("intentKind", "modelTier", "riskHint", "language")
    @classmethod
    def validate_hint(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ChatSkillContext(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=1536)
    instructions: str = Field(min_length=1, max_length=24000)
    source: str = Field(default="", max_length=512)
    explicit: bool = False

    @field_validator("name", "instructions")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        return require_non_blank_text(value)

    @field_validator("description", "source")
    @classmethod
    def trim_context_text(cls, value: str) -> str:
        return value.strip()


class ChatCapabilityContext(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    module: str = Field(min_length=1, max_length=80)
    system: str = Field(default="Monarch System", max_length=120)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=800)
    risk: str = Field(default="read", max_length=40)
    inputSchema: dict[str, Any] | None = None

    @field_validator("id", "module", "system", "title", "risk")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        return require_non_blank_text(value)

    @field_validator("description")
    @classmethod
    def trim_context_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("inputSchema")
    @classmethod
    def validate_input_schema(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        try:
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise ValueError("inputSchema must be JSON serializable") from exc
        if len(encoded) > MAX_CAPABILITY_SCHEMA_CHARS:
            raise ValueError("inputSchema exceeds size limit")
        return value


class ChatAccessContext(BaseModel):
    sandboxMode: Literal["read-only", "workspace-write", "danger-full-access"] = "workspace-write"
    approvalPolicy: Literal["on-request", "never"] = "on-request"


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_CHAT_MESSAGES)
    conversation_id: str | None = Field(default=None, max_length=MAX_RESOURCE_ID_CHARS)
    # Incognito conversations retain only this in-flight request. They may use
    # existing memory as read-only context, but never write chat or memory data.
    incognito: bool = False
    image_attachments: list[ChatImageAttachment] = Field(default_factory=list, max_length=3)
    # None means "auto": Oscar decides from the request whether fresh web
    # context is required. True/False remain available for API callers that
    # need an explicit override.
    web_search: bool | None = None
    # Auto promotes evidence-heavy, multi-step analytical requests into a
    # bounded plan/search/synthesis/verification pipeline. Off and deep are
    # explicit user overrides; neither grants additional action authority.
    research_mode: Literal["auto", "off", "deep"] = "auto"
    use_memory: bool = True
    allow_tools: bool = True
    reasoning_effort: Literal["low", "medium", "high"] = "low"
    max_new_tokens: int = Field(default=65_536, ge=32, le=262_144)
    temperature: float = Field(default=0.3, ge=0.0, le=1.5)
    top_p: float = Field(default=0.9, ge=0.1, le=1.0)
    requested_model: str | None = Field(default=None, max_length=MAX_ROUTE_HINT_CHARS)
    model_selection_source: Literal["auto", "user-explicit", "fallback", "recovery"] = "auto"
    deep_thinking_consent: Literal["allow", "deny"] | None = None
    route: ChatRouteHint | None = None
    skills: list[ChatSkillContext] = Field(default_factory=list, max_length=3)
    capabilities: list[ChatCapabilityContext] = Field(default_factory=list, max_length=80)
    access: ChatAccessContext | None = None

    @model_validator(mode="after")
    def validate_user_message(self) -> "ChatRequest":
        if not any(message.role == "user" for message in self.messages):
            raise ValueError("messages must include a user message")
        return self

    @field_validator("conversation_id")
    @classmethod
    def validate_conversation_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("conversation_id must not be blank")
        return cleaned

    @field_validator("requested_model")
    @classmethod
    def validate_requested_model(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ChatResponse(BaseModel):
    answer: str
    outcome: Literal["completed", "action-proposed"] = "completed"
    conversation_id: str | None = None
    sources: list[ChatSource] = Field(default_factory=list)
    tool_results: list["WorkspaceToolResult"] = Field(default_factory=list)
    action_proposals: list[dict[str, Any]] = Field(default_factory=list)
    usage: dict[str, int | bool | str] = Field(default_factory=dict)


class VoiceHistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=800)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        return require_non_blank_text(value)


class VoiceFastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=1200)
    language: str | None = Field(default=None, max_length=32)
    history: list[VoiceHistoryMessage] = Field(default_factory=list, max_length=8)

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return require_non_blank_text(value)

    @field_validator("language")
    @classmethod
    def validate_language(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        return cleaned or None


class VoiceFastResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    model: Literal["gemma4-fast"] = "gemma4-fast"
    generation_ms: float = Field(ge=0)


class VoiceRealtimeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=600)
    kind: Literal["weather", "web-search"]
    language: str | None = Field(default=None, max_length=32)
    location: str | None = Field(default=None, min_length=1, max_length=120)
    history: list[VoiceHistoryMessage] = Field(default_factory=list, max_length=8)

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return require_non_blank_text(value)

    @field_validator("language")
    @classmethod
    def validate_language(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        return cleaned or None

    @field_validator("location")
    @classmethod
    def validate_location(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("location contains control characters")
        cleaned = " ".join(value.split())
        if not cleaned or not any(char.isalnum() for char in cleaned):
            raise ValueError("location must contain a letter or number")
        return cleaned


class VoiceRealtimeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    model: Literal["none", "gemma4-fast", "open-meteo"] = "gemma4-fast"
    kind: Literal["weather", "web-search"]
    source_count: int = Field(ge=0, le=3)
    search_ms: float = Field(ge=0)
    generation_ms: float = Field(ge=0)


class ChatRoutePreview(BaseModel):
    selected_model: str
    fallback_model: str | None = None
    auto_selected: bool = True
    deep_thinking: bool = False
    requires_confirmation: bool = False
    web_search: bool = False
    search_reason: str = "not-needed"
    research_mode: Literal["off", "standard", "deep"] = "standard"
    research_reason: str = "not-needed"
    research_score: float = Field(default=0.0, ge=0.0, le=1.0)
    ram_available_gb: float | None = None
    estimated_ram_required_gb: float | None = None
    projected_ram_available_gb: float | None = None
    ram_warning: Literal["none", "caution", "critical"] = "none"
    ram_warning_message: str | None = None


MemoryEntryType = Literal[
    "user_preference",
    "project_decision",
    "architecture_note",
    "active_bug",
    "fixed_bug",
    "technical_debt",
    "temporary_task",
    "module_state",
    "handoff_note",
    "diagnostic_note",
    "planning_note",
]
MemoryCategory = Literal[
    "preference",
    "profile",
    "project",
    "instruction",
    "other",
    "user_preference",
    "project_decision",
    "architecture_note",
    "active_bug",
    "fixed_bug",
    "technical_debt",
    "temporary_task",
    "module_state",
    "handoff_note",
    "diagnostic_note",
    "planning_note",
]


class ConversationCreate(BaseModel):
    title: str = Field(default="Новый чат", max_length=160)


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    archived: bool | None = None


class ConversationMessageUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=20000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        return require_non_blank_text(value)


class ConversationMessageCreate(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20000)
    token_count: int | None = Field(default=None, ge=0)
    elapsed_ms: int | None = Field(default=None, ge=0)
    model_tier: str | None = Field(default=None, max_length=80)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        return require_non_blank_text(value)


class MemoryItemCreate(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    category: MemoryCategory = "other"
    type: MemoryEntryType | None = None
    title: str | None = Field(default=None, max_length=160)
    tags: list[str] = Field(default_factory=list, max_length=12)
    priority: float | None = Field(default=None, ge=0.0, le=1.0)
    expires_at: datetime | None = None
    related_files: list[str] = Field(default_factory=list, max_length=24)
    related_modules: list[str] = Field(default_factory=list, max_length=16)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        return require_non_blank_text(value)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("tags", "related_files", "related_modules")
    @classmethod
    def validate_string_list(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item.strip()]


class MemoryItemUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=4000)
    category: MemoryCategory | None = None
    type: MemoryEntryType | None = None
    title: str | None = Field(default=None, max_length=160)
    tags: list[str] | None = Field(default=None, max_length=12)
    priority: float | None = Field(default=None, ge=0.0, le=1.0)
    expires_at: datetime | None = None
    related_files: list[str] | None = Field(default=None, max_length=24)
    related_modules: list[str] | None = Field(default=None, max_length=16)
    closed: bool | None = None
    enabled: bool | None = None

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return require_non_blank_text(value)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("tags", "related_files", "related_modules")
    @classmethod
    def validate_optional_string_list(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [item.strip() for item in value if item.strip()]


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=MAX_SEARCH_QUERY_CHARS)
    max_results: int = Field(default=5, ge=1, le=10)
    fetch_pages: bool = True

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        cleaned = require_non_blank_text(value)
        if len(cleaned) < 2:
            raise ValueError("search query must be at least 2 characters")
        return cleaned


class SearchResult(BaseModel):
    title: str
    url: str
    snippet: str = ""
    ingested: bool = False
    chars: int = 0
    ingestion_status: Literal["pending", "page", "snippet", "blocked", "failed", "skipped"] = "pending"
    status_detail: str = ""


ToolKind = Literal["workspace", "memory", "environment"]
ToolAction = Literal["root", "read", "write", "append", "replace", "mkdir", "list", "search", "copy", "move", "trash", "restore", "remember", "environment"]
WorkspaceAction = Literal["read", "write", "append", "replace", "mkdir", "list", "search", "copy", "move", "trash", "restore"]


class WorkspaceActionRequest(BaseModel):
    action: WorkspaceAction
    path: str = Field(default="", max_length=MAX_WORKSPACE_PATH_CHARS)
    content: str = Field(default="", max_length=MAX_WORKSPACE_TEXT_CHARS)
    old_text: str = Field(default="", max_length=MAX_WORKSPACE_TEXT_CHARS)
    new_text: str = Field(default="", max_length=MAX_WORKSPACE_TEXT_CHARS)
    query: str = Field(default="", max_length=MAX_SEARCH_QUERY_CHARS)
    target_path: str = Field(default="", max_length=MAX_WORKSPACE_PATH_CHARS)
    overwrite: bool = False
    recursive: bool = False
    limit: int = Field(default=80, ge=1, le=200)

    @model_validator(mode="after")
    def validate_action_contract(self) -> "WorkspaceActionRequest":
        if self.action == "search":
            self.query = require_non_blank_text(self.query)
        return self


class WorkspaceBatchRequest(BaseModel):
    actions: list[WorkspaceActionRequest] = Field(min_length=1, max_length=12)
    stop_on_error: bool = False


class WorkspaceEntry(BaseModel):
    path: str
    name: str
    type: Literal["file", "directory"]
    size_bytes: int | None = None


class WorkspaceMatch(BaseModel):
    path: str
    line: int
    preview: str


class WorkspaceToolResult(BaseModel):
    ok: bool
    kind: ToolKind = "workspace"
    action: ToolAction
    summary: str
    path: str | None = None
    query: str | None = None
    content: str | None = None
    bytes: int | None = None
    entries: list[WorkspaceEntry] = Field(default_factory=list)
    matches: list[WorkspaceMatch] = Field(default_factory=list)
    details: dict[str, Any] | None = None
    error: str | None = None


class WorkspaceBatchResponse(BaseModel):
    ok: bool
    summary: str
    results: list[WorkspaceToolResult]


class MemoryStats(BaseModel):
    documents: int
    chunks: int
    memories: int = 0
    active_memories: int = 0
    conversations: int = 0
    updated_at: datetime | None = None


class HardwareInfo(BaseModel):
    gpu_name: str | None = None
    gpu_memory_total_mb: int | None = None
    gpu_memory_used_mb: int | None = None
    driver_version: str | None = None
    cuda_available: bool = False
    torch_version: str | None = None
    bf16_supported: bool | None = None
    ram_total_gb: float | None = None
    ram_available_gb: float | None = None


class ModelStatus(BaseModel):
    loaded: bool
    mock: bool
    fallback_active: bool = False
    runtime_mode: str = "auto"
    active_tier: str | None = None
    active_context_tokens: int = 0
    last_context_window: dict[str, int | bool] = Field(default_factory=dict)
    model_path: str
    gemma_models_dir: str | None = None
    gemma_main_model_path: str | None = None
    gemma_model_path: str | None = None
    gemma_partial_path: str | None = None
    gemma_vision_path: str | None = None
    gemma_draft_model_path: str | None = None
    gemma_model_ready: bool = False
    gemma_vision_ready: bool = False
    gemma_draft_ready: bool = False
    gemma_draft_mode: str | None = None
    speculative_decoding: bool = False
    speculative_status: str = "disabled"
    gemma_vision_runtime_status: str = "unknown"
    gemma_vision_note: str | None = None
    available_tiers: dict[str, bool] = Field(default_factory=dict)
    llama_cpp_version: str | None = None
    gpu_offload_available: bool = False
    gpu_policy: str = "required"
    device_map: dict[str, str] | None = None
    load_strategy: str | None = None
    load_attempts: list[str] = Field(default_factory=list)
    allow_cpu_offload: bool = True
    cpu_fallback: bool = True
    try_gpt_oss_on_low_vram: bool = False
    gpu_memory_gb: float
    cpu_memory_gb: float
    default_temperature: float
    default_top_p: float
    repetition_penalty: float
    no_repeat_ngram_size: int
    attention_implementation: str
    offload_dir: str
    last_error: str | None = None
