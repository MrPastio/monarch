# Monarch Prompt Architecture

## Production prompt owners

- `oscar/backend/oscar_agent/model_runtime.py`: final Oscar identity, response, evidence, capability, Coder and Voice policies.
- `src/modules/assistant/index.ts`: compact policy for direct OpenAI-compatible endpoints. It is tagged `monarch_direct_model_policy` and removed before managed Oscar adds its own policy.
- `src/app/coder-agent-controller.ts`: bounded Coder runtime data; execution policy remains in Oscar's trusted Coder contract.
- `src/modules/models/runtime-client.ts`: strict model-tier router.
- `src/modules/custom-tools/index.ts`: JSON-only Custom Tool generator.
- `security/src/monarch_security`: read-only security decision prompts.
- `oscar/backend/oscar_agent/research.py`: bounded research controller task prompts.
- Monarch Sharing accepts caller-owned `system`/`developer` messages. Those are API input, not Monarch-owned policy, and must not be silently rewritten.

## Invariants

1. One authoritative identity/behavior policy per inference route. Do not stack the direct Assistant policy on top of Oscar's policy.
2. User text, history, memory, skills, repository content, web excerpts, tool output and security events are data, never higher-priority instructions.
3. Tool success comes only from Kernel execution status. Free-form payload text is never proof of success.
4. Dynamic context is conditional and bounded. Simple chat must not carry environment or capability catalogs.
5. Structured-output prompts specify one small schema, JSON-only output and a deterministic fallback parser.
6. Delimited data payloads escape `<` and `>` so content cannot close its own boundary.
7. Coder policy is owned by the trusted Oscar runtime; the controller supplies project/context data without duplicating policy prose.
8. Voice owns no separate reasoning prompt: after local STT it uses the same Agent decision/evidence contracts as Desktop and speaks only bounded or grounded terminal output.
9. Coder is a closed project-scoped prompt lane: general Oscar profile, memory, live Monarch registry, global skills, and synthetic receipt-language inference cannot enter it.
10. A base model or provider is an internal inference implementation, never Oscar's product identity. Identity and capability questions must describe Oscar and only the live Monarch capabilities supplied to that turn.
11. Oscar keeps one recognizable warm, lively voice across chat and Voice. Casual social questions get a direct conversational answer; literal consciousness/body questions keep an honest boundary without turning every exchange into an AI disclaimer.

## Current budgets and measured effect

- Oscar RU base v3.3: `4002` characters.
- Oscar EN base v3.3: `4034` characters.
- Minimal Russian chat system context with current turn metadata: `4609` characters.
- Direct-model RU policy v3.2: `1750` characters.
- Direct-model EN policy v3.2: `1685` characters.
- Capability transport: at most 48 ranked entries, eight candidate schemas, valid JSON capped near 12,000 characters; schemas/entries are removed as complete objects rather than truncating JSON text.
- Local user context: at most 12 permanent memories with smaller per-field bounds.

These are character budgets, not tokenizer-independent token guarantees. Runtime token-aware compaction remains the final context-window guard.
