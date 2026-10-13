# MAX provider connections

2026-09-07, Codex. Owner request: multiple popular providers, simple MAX menu,
full connection management in settings, friendly Russian copy across the UI.

## Implemented boundary

Twelve settings cards: Groq, OpenAI, Anthropic Claude, Google Gemini, OpenRouter,
DeepSeek, Mistral, xAI, Together AI, Fireworks AI, Cerebras and NVIDIA.
Each connection has one independently encrypted host-only key and a model name.
Groq preserves GPT OSS 120B plus its existing safeguard route and old record.
Other providers use fixed host-owned endpoints, native Anthropic Messages or
OpenAI-compatible chat, with provider-specific JSON formatting. Arbitrary URLs,
provider tools, automatic provider/model fallback and silent local fallback are
not accepted. OpenRouter forwarding remains within that explicitly selected service.

The role contains provider and exact case-sensitive model identity. It survives
ordinary Turn routing, agent decision policy, persisted task validation and the
authenticated native host response binding. A changed configured model rejects
the old request. Runtime child processes receive no provider key. Kernel retains
effects/approval/Safe authority; local terminal Full Access remains required.

New providers screen both input and output in the same selected service. The
original response schema is validated locally even when remote enforcement is
only JSON mode. Refusals, tool calls, malformed or truncated replies, oversized
responses and cancellation fail closed. There is no automatic paid retry.
Connection verification sends a synthetic structured reply before committing the
encrypted replacement; UI discloses the possible charge and additional task calls.

Settings have service-specific key/terms/privacy links, explicit three-part consent,
advanced model name, connection verification and explicit selection. Only the
non-secret preferred provider id is stored in browser preferences. Key entry is
cleared after submission, editor close and leaving settings. Composer stays a
single MAX mode switch with a link to settings. Animations respect reduced motion.

## Verification and limitations

- TypeScript and runtime bundles pass.
- Full agent-v3/runtime-bundle and focused UI run: 1053/1053 pass.
- Adjacent agent/routing and UI-language run: 355/355 pass (overlaps the full run).
- Edge/Playwright: actual source markup/CSS/module with synthetic desktop bridge,
  1120px and 360px, 12 cards, consent -> save -> exact selected role, empty key
  field after submit, no page/console errors, no horizontal overflow, zero running
  animations with reduced motion. This fixture is not live provider acceptance.
- Encrypted-store/provider/native-loopback composition tested with synthetic keys:
  connection isolation, rejected replacement preservation, mismatched consent,
  provider/model binding, malformed/truncated/tool-bearing output and no fallback.
- Reports/screenshots: `<qa-artifact-root>/max-providers-20260907`.
- Real accounts for the eleven new providers have not been supplied/tested.
  Suggested model names may change; verification must succeed before saving.
- Native text and ordinary document attachments use the new route. Images remain
  unsupported. The separate selected-file prepared-model ABI remains Groq-only;
  UI rejects unsupported selections clearly before dispatch, never reroutes to Groq.
- No production-readiness claim for Astra V3, signed installer or publication.

## API references checked

- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Claude compatibility and native API](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [DeepSeek JSON](https://api-docs.deepseek.com/guides/json_mode/)
- [Mistral JSON](https://docs.mistral.ai/studio/conversations/structured-output/json_mode)
- [xAI structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [Together structured outputs](https://docs.together.ai/docs/inference/chat/structured-outputs)
- [Fireworks structured outputs](https://docs.fireworks.ai/structured-responses/structured-response-formatting)
- [Cerebras structured outputs](https://inference-docs.cerebras.ai/capabilities/structured-outputs)
- [NVIDIA APIs](https://docs.api.nvidia.com/nim/reference/llm-apis)

Preserve other agents' shared dirty work, old installed versions, all user data,
Safe and credentials. Do not label synthetic replies live cloud acceptance.


## 2026-09-08: visible model selection
The connection dialog always shows a native keyboard-accessible model selector. An explicit Load models action sends only the entered key to the selected provider through a trusted main-process IPC; it does not persist credentials or send a conversation. The host owns every URL, rejects redirects, bounds time/response/pages, returns model id/label DTOs, and does not expose upstream errors. A catalog entry is not proof of MAX schema compatibility: the existing paid verify-before-save flow remains mandatory. Closing or changing the key invalidates late UI responses. Groq retains its GPT OSS admission rule. No manual model-id input remains.

Catalog protocols: OpenAI-compatible `/models` for OpenAI, OpenRouter, DeepSeek, Mistral, xAI, Together, Cerebras and NVIDIA; native Claude `/v1/models` with cursor; native Gemini `/v1beta/models` with generation-method filtering; Fireworks public account catalog with serverless/chat metadata. Catalog filtering is conservative, not exhaustive capability certification. Defaults remain visible if loading fails; no silent model fallback during execution.

Primary protocol references checked 2026-09-08:
- https://platform.claude.com/docs/en/api/models/list
- https://ai.google.dev/gemini-api/docs/openai
- https://docs.fireworks.ai/api-reference/list-models
- https://docs.together.ai/reference/models

Validation uses synthetic responses, not real account credentials. Real catalog/account acceptance is still required for each service.
