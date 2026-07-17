# Oscar Module

Oscar is the Monarch-native compatibility surface for the integrated `oscar` local agent inside the Monarch workspace.

The first version keeps the local Oscar Python backend as an adapter inside the workspace. The important part is that Monarch now owns the stable capability contract, routing, permissions, audit, and Astra agent cards.

## Capabilities

- `oscar.status` - read configured project/backend/model/memory status.
- `oscar.model.unload` - release loaded model weights and CUDA/CPU memory from the backend.
- `oscar.backend.stop` - stop the local backend process tree when full memory release is needed.
- `oscar.chat.local` - local chat without web search.
- `oscar.chat.web` - chat with web search, confirmation-bound.
- `oscar.memory.search` - search existing Oscar memory through the backend.
- `oscar.search.ingest` - run Oscar search and ingest, confirmation-bound.

## Environment

- `OSCAR_PROJECT_ROOT` defaults to `<Monarch workspace>\oscar`.
- `OSCAR_MODEL_PATH` defaults to `<Monarch workspace>\gemma_models\Gemma_12B\gemma-4-12B-it-Q4_K_M.gguf`.
- `OSCAR_API_BASE` defaults to `http://127.0.0.1:7861`.
- `OSCAR_API_TIMEOUT_MS` defaults to `30000` for status and short backend requests.
- `OSCAR_CHAT_TIMEOUT_MS` defaults to `300000` for local chat, because the first built-in model load can take several minutes.
- `OSCAR_AUTO_START` defaults to `true` when `OSCAR_API_BASE` is not overridden and starts `oscar\.venv\Scripts\python.exe -m uvicorn oscar_agent.main:app` on demand.
- `OSCAR_GEMMA_MODELS_DIR` defaults to `<Monarch workspace>\gemma_models` and contains the Gemma 4 size profiles.

## Port Direction

The backend now lives inside the main Monarch project folder. Native Monarch implementations can still replace it capability by capability while preserving these IDs and schemas where possible.
