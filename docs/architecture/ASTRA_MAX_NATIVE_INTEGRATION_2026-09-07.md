# MAX: native integration, 2026-09-07

Owner scope: finish MAX in one pass. The owner explicitly waived the previous
30%-used/70%-remaining stop for this pass. No installer or publication requested.

## Implemented

- Normal Electron enables MAX setup without the preview command-line switch.
  Diagnostic/isolated desktop modes remain off. Setup itself never selects cloud.
- GPT OSS 120B / Qwen 3.8 27B explicit selection in the existing Oscar composer;
  Safety GPT OSS 20B screens input and output. Qwen keeps preview acknowledgement.
- First-use disclosure, Groq key link, model availability, connection verification,
  replacement-key flow. Invalid replacement cannot overwrite a working record.
- Consent validated before networking; credential stays in encrypted main-only
  storage. Preload exposes status/configuration/verification only.
- Authenticated bounded loopback native completion, Stop/disconnect cancellation,
  fixed provider endpoint, no provider tools, redirects, retries or local fallback.
  Runtime bootstrap capability is consumed, not inherited by tool/Python children.
- Ordinary answer, agent planning/execution and synthesis carry the MAX role.
  Closed execution transport decodes inputJson before existing capability/Kernel
  validation; no model-provided permission, effect or success authority.
- Selected-file analysis and approved drafts choose a model client by retained
  model digest within the same scheduler/Kernel. Local route remains independent.
  Memory-bearing work cannot select the cloud client; automatic memory and
  personality are not exported by ordinary MAX answer/decision composition.
- Correct Groq GPT OSS parameter: include_reasoning=false, not reasoning_format.
  Runtime build emits both monarch-server.mjs and astra-max-electron.mjs.

## Evidence

- Final combined regression: 16 suites / 414 tests PASS; source TSC PASS.
  Built `<repo-root>/dist/monarch-server.mjs` and `astra-max-electron.mjs`; executable
  help smoke PASS. No installer. Native bootstrap child test confirms the
  consumed capability still serves MAX but is absent from child environments.

- Combined 13 suites / 324 tests passed before the final small bootstrap hardening.
- Subsequent 2 focused suites / 16 tests passed; source TypeScript passed.
- Real loopback + actual MAX host/provider code + synthetic Groq + ordinary model
  decision provider: planning, execution parameters, text answer, both model IDs,
  Safety block, authorization/origin rejection, Stop, no local fallback.
- Product test: optional MAX alongside a deliberately unavailable local endpoint
  reached approved draft write and selected-file analysis through the real
  prepared client, same Kernel and coordinator. Groq itself was simulated.
- Rendered Edge CLI session at http://127.0.0.1:52842 used actual source MAX modal
  and setup module: all-consent gate, GPT/Qwen selection, preview gate, local
  deselection, change key, no retained input key; console errors/warnings zero.
  Fixture: D:/Monarch-test-tmp-astra-v3/max-native-ui-20260907, marked .owner.
  This was not the installed full application or real cloud acceptance.

## Remaining acceptance / constraints

- Real Groq key absent at checked native/source-preview settings locations.
  Only existence was checked; no Safe contents or credentials were read.
  Need owner to enter the key inside the updated Monarch UI, never chat.
- Real provider responses, quality, free-tier rate limits, latency and installed
  application acceptance remain unverified. Do not claim fully operational MAX
  or general Astra production readiness from these synthetic checks.
- Image transfer is explicitly rejected in this text-only integration. Qwen
  itself supports vision; the restriction is Monarch's current transport.
- This patch does not solve the pre-existing finite retained-task cohorts or
  all generic-agent/CU readiness gaps. Do not erase their negative evidence.
- `<installed-app-root>`, Safe and user data were not modified. No installer produced.

## API sources checked

- https://console.groq.com/docs/structured-outputs
- https://console.groq.com/docs/reasoning
- https://console.groq.com/docs/model/qwen/qwen3.8-27b

Next: real
ordinary-chat and selected-file acceptance with a user-entered key in the new
build. Preserve explicit consent, local/cloud separation and existing shared work.
