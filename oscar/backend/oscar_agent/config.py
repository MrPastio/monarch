import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MONARCH_CONFIG_ROOT = os.getenv("MONARCH_CONFIG_ROOT", "").strip()
SETTINGS_ENV_FILE = (
    Path(MONARCH_CONFIG_ROOT) / "config" / "oscar" / ".env"
    if MONARCH_CONFIG_ROOT
    else PROJECT_ROOT / ".env"
)
DEFAULT_CORS_ORIGINS = [
    "http://localhost:4317",
    "http://127.0.0.1:4317",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
    "http://oscar.local",
    "https://oscar.local",
]


def default_model_path() -> Path:
    return PROJECT_ROOT.parent / "gemma_models" / "Gemma_12B" / "gemma-4-12B-it-Q4_K_M.gguf"


def default_api_token() -> str | None:
    token_file = PROJECT_ROOT.parent / "secrets" / "oscar_token.txt"
    if token_file.exists():
        try:
            return token_file.read_text(encoding="utf-8").strip().lstrip("\ufeff")
        except Exception:
            pass
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OSCAR_", env_file=SETTINGS_ENV_FILE, extra="ignore")

    app_name: str = "Oscar Local Agent"
    model_path: Path = Field(default_factory=default_model_path)
    data_dir: Path = Field(default=PROJECT_ROOT / "data")
    db_path: Path = Field(default=PROJECT_ROOT / "data" / "memory" / "oscar_memory.sqlite3")
    offload_dir: Path = Field(default=PROJECT_ROOT / "data" / "offload")
    gemma_models_dir: Path = Field(default=PROJECT_ROOT.parent / "gemma_models")
    coder_models_dir: Path = Field(default=PROJECT_ROOT.parent / "runtime" / "coder" / "models")
    # Monarch Sharing exposes the two small Qwen GGUFs as explicit Super Fast
    # chat models and the installed Qwen3-TTS checkpoints through its separate
    # speech endpoint. Keeping both roots explicit prevents a client request
    # from ever selecting an arbitrary model path.
    sharing_qwen_models_dir: Path = Field(
        default=PROJECT_ROOT.parent / "runtime" / "voice" / "models" / "voice-lite"
    )
    sharing_tts_models_dir: Path = Field(
        default=PROJECT_ROOT.parent / "runtime" / "voice" / "models"
    )
    sharing_tts_python: Path = Field(
        default=PROJECT_ROOT.parent / "runtime" / "voice" / ".venv" / "Scripts" / "python.exe"
    )
    gemma_high_model_filename: str = "gemma-4-12B-it-Q4_K_M.gguf"
    gemma_high_vision_filename: str = "mmproj-BF16_12B.gguf"
    gemma_low_model_filename: str = "gemma-4-E2B-it-Q5_K_M.gguf"
    gemma_low_vision_filename: str = "mmproj-BF16_E2B.gguf"
    gemma_speculative_decoding: bool = True
    gemma_draft_mode: str = "mtp"
    gemma_draft_num_pred_tokens: int = 4
    gemma_draft_gpu_layers: int = 8
    # 4096 keeps the tested 30-layer 12B profile inside an 8 GiB RTX 4060
    # (about 7.1 GiB total VRAM in the desktop app). 8192 can terminate the
    # native CUDA process before Python gets a chance to retry fewer layers.
    gemma_context_tokens: int = 4096
    gemma4_fast_context_tokens: int = 4096
    gemma4_balanced_context_tokens: int = 4096
    gemma4_deep_context_tokens: int = 8192
    gemma4_31b_context_tokens: int = 8192
    qwen3_coder_context_tokens: int = 16384
    deepseek_coder_context_tokens: int = 16384
    gemma_gpu_layers: int = 20
    gemma4_fast_gpu_layers: int = 99
    gemma4_balanced_gpu_layers: int = 30
    gemma4_deep_gpu_layers: int = 18
    gemma4_31b_gpu_layers: int = 15
    qwen3_coder_gpu_layers: int = 12
    deepseek_coder_gpu_layers: int = 20
    require_gpu_offload: bool = True
    api_token: str | None = Field(default_factory=default_api_token)
    disable_api_token: bool = False
    trust_remote_code: bool = False
    relevance_threshold: float = -0.8

    mock_model: bool = False
    mock_fallback: bool = True
    auto_unload_after_generation: bool = True
    # Large hybrid llama.cpp models can terminate the Windows process while
    # native CUDA objects are destroyed in-place. Recycling after the response
    # is flushed releases the same memory without dropping the final payload.
    recycle_backend_after_generation: bool = True
    suppress_llama_logs: bool = True
    allow_cpu_offload: bool = True
    cpu_fallback: bool = True
    try_gpt_oss_on_low_vram: bool = False
    load_strategy: str = "auto"
    gpu_memory_gb: float = 6.0
    cpu_memory_gb: float = 24.0
    cpu_threads: int = 10
    attention_implementation: str = "eager"

    default_reasoning_effort: str = "low"
    default_max_new_tokens: int = 65_536
    default_temperature: float = 0.3
    default_top_p: float = 0.9
    repetition_penalty: float = 1.08
    no_repeat_ngram_size: int = 4
    inference_queue_timeout_seconds: float = 120.0
    max_context_chars: int = 12000
    retrieval_k: int = 6
    memory_min_overlap: int = 2

    search_top_k: int = 5
    fetch_timeout_seconds: float = 12.0
    max_fetch_bytes: int = 5 * 1024 * 1024
    max_page_chars: int = 18000
    chunk_chars: int = 1400
    chunk_overlap: int = 180

    workspace_root: Path = Field(default=PROJECT_ROOT.parent)
    workspace_generated_dir: Path = Field(default=PROJECT_ROOT.parent / "artifacts" / "generated")
    workspace_max_read_bytes: int = 256 * 1024
    workspace_max_write_bytes: int = 512 * 1024
    workspace_search_file_bytes: int = 256 * 1024

    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.offload_dir.mkdir(parents=True, exist_ok=True)
        self.gemma_models_dir.mkdir(parents=True, exist_ok=True)
        self.coder_models_dir.mkdir(parents=True, exist_ok=True)
        self.workspace_generated_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
