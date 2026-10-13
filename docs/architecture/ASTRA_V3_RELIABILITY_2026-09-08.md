# Astra V3: current priorities and reliability corrections

2026-09-08, Codex. Reviewed current handoff, implementation ledger, ordinary Oscar disposition/Turn runtime, native MAX client/server, cloud provider and installed pointer (0.3.0.14 before this pass). Historical readiness notes are not current product certification.

| Priority | Observed gap | Action in this pass |
| --- | --- | --- |
| 1 | Body read / JSON decode errors escaped the bounded MAX error namespace; structured disposition could turn a transport failure into generic clarification | Normalize interrupted/invalid replies, close readers, preserve original typed error. No retry or provider fallback |
| 1 | Host timeout only aborted a signal; an abort-ignoring operation could leave the HTTP request waiting and report cancellation | Deliver bounded provider-timeout promptly, retain busy slot until physical completion, suppress late/double writes |
| 1 | Already cancelled input or a late result from an abort-ignoring host could reach completion assembly | Check cancellation before dispatch and after host completion |
| 1 | Regex-safe exception messages were not a semantic public-error allowlist | Export only declared public failure codes; suppress arbitrary provider exception strings |
| 1 | Safety refusal copy claimed no action occurred, despite possible previous steps; retired-model copy assumed Groq-only MAX | Preserve prior-step truth and describe current multiprovider settings accurately |
| 2 | Real provider multi-step file/terminal acceptance previously stopped at quota | Still requires actual model/account acceptance; this pass uses deterministic provider faults and real loopback transport, not credentials |
| 2 | Prepared selected-file ABI remains Groq-only, images unsupported | Explicit supported boundary preserved. Extending requires exact provider/capability/consent binding and complete acceptance, not an alias or hidden fallback |
| 2 | Generic planning, arbitrary multistep computer use and normative durable-scheduler gates remain incomplete | Do not upgrade readiness from UI or focused transport tests; retain existing Oscar/Kernel ownership |

Normal startup health, synthetic transport/Kernel tests, real-model task completion and signed release acceptance are separate evidence layers. There is no new second executor or separate task panel. No Safe files or provider credentials are read in this work.

Evidence reports are placed under `<qa-artifact-root>`. See the latest handoff for exact test totals, installed version and live health result.
