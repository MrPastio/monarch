# Oscar public-search grounding — 2026-09-08 Codex

## Problem and change
The ordinary phrase `сколько градусов в варне сейчас` missed the freshness detector. MAX additionally bypassed the Python search path even when the Turn carried explicit web/deep modifiers and consumed consent, and its prompt said search had not run.

Both TypeScript preflight and Python freshness/search planning now recognize conversational weather queries, with one shared positive/negative fixture (geometry, hardware, cooking and body temperature stay outside that rule). This is routing evidence, never permission to send data or execute local effects.

MAX answers now retrieve bounded public evidence through the existing Oscar WebSearchService before calling the exact selected MAX provider. The authenticated `/api/search/context` endpoint always uses transient retrieval: no memory ingestion, including persistent chats. Standard retrieval uses one question; deep uses up to three bounded evidence queries and deduplicates up to 14 sources. This is source collection and synthesis, not the local model's iterative deliberation loop. Existing SSRF filtering, redirect and page-size limits remain in force. Search has a 75-second server budget and cancels on client disconnect; client Stop is propagated. No local model fallback is introduced.

The model receives explicitly untrusted source data, date/freshness instructions and citation instructions. Source cards precede the answer. Empty, failed or cancelled retrieval never proceeds to an ungrounded current-data completion. App-wide internet-off and exact Turn data-egress consent remain required. Only the current submitted question is sent to public search; attachments, remembered information and history are not used as search text.

## Verification
- Focused TypeScript run: 183 passed; final disposition/coordinator/native pilot/runtime-bundle recheck: 186 passed.
- Expanded TypeScript run: 1407/1411 passed initially. Two failures were outdated copy assertions, now updated and passed. Two native pilot tests passed on a serialized rerun; no native execution changes were made.
- Final Python research/SSRF/transient endpoint tests: 83 passed. Expanded Python run: 361 passed, 14 skipped, one pre-existing prompt-string mismatch. The same failure was reproduced from a separate HEAD source snapshot (`baseline-result.txt`).
- TypeScript typecheck and runtime build passed.
- Real public search through source returned five weather sources without memory access.
- Copied installed 0.3.0.16 bundle HTTP preflight routes the exact user phrase to public search. Installed Python 3.11.9 plus shipped dependency environment executed the actual new endpoint and returned five real sources; module path verified under 0.3.0.16, memory access prohibited by the harness.
- MAX host/transport/provider tests use synthetic provider responses and verify exact-model source delivery, no-consent, failure, empty results and cancellation. No user key was read and no paid user-account completion was executed.

Evidence: `<qa-artifact-root>/oscar-web/` (tests.json, recheck.json, live-search.json, installed-route.json, installed-live-search.json, baseline-result.txt).

## Remaining boundaries
Web pages may be stale or disagree; successful retrieval does not prove the final model will interpret every source correctly. The installed user's complete real-provider answer remains to be exercised after restart. Conversational follow-ups that omit the subject still need broader contextual research routing. Safe, provider credentials, data stores, local execution authority, selected-file pilot and prior installations must remain untouched.
