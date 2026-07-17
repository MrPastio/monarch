# Monarch Sharing

Monarch Sharing exposes local models to applications through an OpenAI-compatible loopback API. Gemma and Super Fast Qwen chat models are available through `/v1/chat/completions`; installed Qwen3-TTS checkpoints are listed separately at `/v1/audio/models` and synthesize honest WAV responses at `/v1/audio/speech`.

Qwen TTS never appears as a chat model. Requests stay local, use the existing bearer token, and cannot supply arbitrary model or reference-audio paths. The short-lived TTS worker frees its GPU allocation after each WAV response.

The managed default endpoint is `http://127.0.0.1:7861/v1`. Authentication uses the Oscar bearer token stored in `secrets/oscar_token.txt`; module status never returns the token itself.

Public MVP endpoints:

- `GET /v1/models`
- `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- streaming chat completions through OpenAI-style SSE

The detailed contract and examples live in `docs/modules/SHARING.md`.

The live shell exposes a dedicated **Sharing** page with runtime status, one-click managed backend start, Base URL/API-key copy actions, model selection, and ready-to-paste Python, Node.js, PowerShell, and generic connection presets. The API key is copied by the trusted Desktop bridge and is never rendered or returned by module capabilities.
