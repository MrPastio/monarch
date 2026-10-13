# Monarch Astra V3 — external audit disposition

Статус: **evidence/review ledger, non-normative**. Current architecture status: **CONVERGENCE DRAFT — `agent-core-read.v1` SCHEMA LAB ONLY; NOT READY FOR GENERAL IMPLEMENTATION PLANNING**.  
Исходный ledger: 2026-08-24. Последняя adjudication revision: 2026-08-26.  
Объект: Astra V3 Runtime, Protocol V1, Migration plan, original three-pass review, external advisory batches и representative live Monarch baseline.  
Ограничение: product/runtime code и production Monarch Safe не менялись и не исследовались.

---

## 1. Внешние источники и вес

| Source | Полнота | SHA-256 | Роль в adjudication |
|---|---:|---|---|
| Grok Build, xAI | 534 lines, findings 1–320 | `41f405e9cc49d4ed9fbe3b252959d5fd80af58d7fdacd43636571ccdbde10315` | сильный counterexample finder; каждое утверждение принято только после source verification |
| ChatGPT 5.6 Pro, first audit | 463 lines, A01–L23 = 200 findings | `9354c5acc6c72f49f3d1a1c65e71201579fcf0d796515dd2c1b7e0a54ac6d819` | строгий ABI/status audit |
| Qwen3.8 | 970 lines, findings 1–425 | `4d6d6912317a5eb9e5208017f787ed3068f68256b50fd35630acd4de6ebeb158` | широкий checklist; duplicates/preferences/existing coverage filtered |
| ChatGPT 5.6 Pro, comparative adjudication | 1050 lines | `e4cf253e1b5d18cf0888716c8b9b8bf466d1c1ce97912fbfc5b8357ced1b2586` | приоритетный final adjudicator по указанию пользователя; не заменяет local source check |
| Grok Build, second batch | 528 lines, findings 1–240 | `d19bcbffd6ed9547ce5067d29d4bcda761f649d654eebaff0cc5364795824ad3` | cautious counterexample inventory; severity/repetitions independently rechecked |
| Claude Sonnet 5, second batch | 67 lines, CL-01–CL-19 | `61b391d381a54e546aa9bb71820bcc88af15b4e3f609bdc146f22be06173934d` | compact convergence/process/security critique |
| Qwen3.8, second batch | 611 lines, findings 1–180 | `2a117329739a601ce6fa4a7323975e6f2547f1494eb0739eaf7f7ad589e805ad` | broad checklist; date/signature/future-feature overclaims filtered |
| ChatGPT 5.6 Pro, second batch | 245 lines, findings 1–100 | `0ca35130c4c064b671c103b478f283fb9399fd48f6cc11464e6d988feb207e15` | primary second-batch adjudication input per user instruction; 0 P0, 59 P1, 38 P2, 3 P3 claimed, each locally verified |

Пользователь отдельно указал, что ChatGPT имеет авторитет, а к Grok нужно относиться осторожнее. Поэтому Grok не получил автоматический приоритет из-за количества или уверенного тона. Comparative ChatGPT оценил Grok как сильный counterexample source, но его overstatements всё равно отклонены ниже. Имена/версии моделей — self-identification из attachments и не проверялись как vendor provenance; adjudication опирается на содержание, hashes и local source, не на бренд.

Дополнительный внешний чат не отправлялся. Пользователь разрешил Firefox и обязательное disclosure «Codex действует с разрешения пользователя», но bridge к открытому Firefox не подключился. Подменять его другим browser surface не стали; две уже полученные проверки ChatGPT, включая сравнительную, дали достаточный независимый adjudication input.

---

## 2. Метод проверки

Каждый внешний пункт прошёл один из путей:

1. exact contradiction искался в source docs;
2. claim о current Monarch проверялся по repository entrypoints/contracts/tests;
3. duplicate сводился к одному root cause, но сохранял coverage range;
4. preference не повышался до defect без violated invariant/counterexample;
5. future effect/child/provider gap становился explicit blocker, а не выдуманным premature ABI;
6. architecture-only correction не называлась implementation closure.

Live baseline snapshot для этого прохода:

- branch `codex/site_monarch`, HEAD `06ef7d956e18e10f9bb40ada1d0118db0e7ad15d` at second-batch adjudication;
- `OscarTurnCoordinator.submit()` остаётся ordinary ingress и сам выполняет reconciliation;
- `src/agent/agent-loop.ts` — 6721 physical lines по текущему file count и продолжает импортировать operational goal binding/Kernel adapter;
- `workspace.storage.audit` хранит `logicalBytes: number`, суммирует JS numbers и пишет `mutationsObserved: 0`;
- current coordinator formatting снова переводит `logicalBytes` через `Number(...)`;
- Action Ledger states остаются `authorized|executing|completed|failed`, interrupted execution не имеет V3 frozen/reconciliation ABI;
- Kernel adapter/approval/receipt/Turn outbox/CAS/recovery mechanisms существуют и должны сохраняться.

Этого достаточно, чтобы подтвердить архитектурные причины, но не чтобы заявить V3 executable readiness.

---

## 3. Severity и disposition rubric

| Mark | Meaning |
|---|---|
| P0 | active/authorized design path допускает Kernel/Safe/authority bypass, destructive data loss или false verified без защитного gate |
| P1 | первый разрешаемый scope нельзя однозначно/безопасно реализовать; ABI противоречив, false completion реален или migration создаёт dual truth |
| P2 | non-first-slice/future feature blocker, conformance/liveness gap или важная ambiguity без текущего authority path |
| P3 | maintainability, terminology, process evidence или optional hardening |
| `corrected-normative` | source architecture изменена; executable closure ещё нужна |
| `accepted-gate` | finding реален, но закрывается generated schema/fixture/test/ADR до enablement |
| `accepted-blocker` | feature явно disabled до отдельной full closure |
| `partial` | core risk реален, но severity/causal claim/empirical wording завышены |
| `rejected-existing` | source уже содержит требуемый invariant/test, counterexample не проходит |
| `rejected-preference` | возможный дизайн, но не обязательная коррекция без product/threat-model need |

Количество пунктов не используется как severity signal. Один exact counterexample важнее ста повторов.

---

## 4. Consolidated root-cause disposition

| ID | Root gap | External anchors | Disposition | Normative result / remaining gate |
|---|---|---|---|---|
| X01 | PASS 3/P1=0 и general readiness завышены | GPT A06–A11/L23; Grok 22; comparative final | corrected-normative | status withdrawn; only compiled schema/fixture lab + isolated benchmark allowed; shadow needs later go/no-go |
| X02 | source authority/export provenance | GPT A02–A04/B01/L22 | corrected + accepted-gate | Protocol owns ABI; Runtime/Migration/Review roles fixed; canvas generated with source manifest/hashes |
| X03 | undefined canonical JSON/Unicode/time/decimal/hash domains | Grok 7–9/27/29; GPT B08–B15/D07–D09 | corrected-normative | RFC 8785/JCS, strict JSON, UTF-8/NFC rules, exact numeric grammars, UTC ms, monotonic clock evidence, domain-separated SHA-256 |
| X04 | core types/commands/events not compileable/closed | Grok 14/42; GPT B02–B07/F03; Qwen 21–50 | corrected + accepted-gate | exact core allowlist + closed command/event payload union; Engine/workflow/effects removed from base; generated package mandatory |
| X05 | Goal not bound to exact Admission | GPT E04; comparative blocker 3 | corrected-normative | admission ID/body/candidate/input fingerprint in Goal source/body digest |
| X06 | follow-up bypasses persisted semantic admission | Grok 5; comparative 1.6/blocker 4 | corrected-normative | every follow-up gets full admission; only byte-identical nonsemantic change may steer |
| X07 | mixed multi-clause per-capability cutover | comparative 1.7/blocker 5; GPT E01 | corrected-normative | independent rows + one homogeneous V3 operational cohort; V2/split variants absent from core/migration plan |
| X08 | one Interaction assumed one Execution | Grok 32; comparative 1.14 | corrected-normative | ordered `executionLinks[]`, deprecated singular compatibility only when count=1 |
| X09 | `declared-subset` ambiguous | Grok 1; GPT E07; comparative 1.4 | corrected-normative | generic subset/mapping removed from core; exact full input only; paths never prefix |
| X10 | model can weaken required/partial/predicate/authority | Grok 16; comparative 1.13/blocker 10 | corrected-normative | core compilation is deterministic local only; model field/egress absent; future assistance needs separate profile |
| X11 | Goal partial policy/global ordering/conditional claims weak | GPT E08–E12; Qwen useful DAG/range findings | corrected-normative | per-requirement partial + overall gate, DAG validation, inclusive range, conditional claim graph, selector/template registry rules |
| X12 | target/path/authority algebra arbitrary JSON/string | Grok 26–30; GPT E06/I06 | corrected-normative | typed target binding, handle-derived Windows identity/reparse fence, `AuthorityScopeV1` intersection with `safeAuthority=none` |
| X13 | Invocation states/events/fields contradict | Grok 11/31; GPT C01–C05; comparative blocker 6 | corrected-normative | one state enum/events; no Invocation `verified`; pre/post-dispatch cancellation and old Goal revision rules fixed |
| X14 | terminal delivery states/certificate mandatory mismatch | Grok 12; GPT C09/C10; comparative blocker 7 | corrected-normative | `pending|applied|acknowledged|rejected`; certified/noncertified outcome union; receiver inbox semantics fixed |
| X15 | taxonomy/Goal/Execution/presentation states diverge | Grok 37–40; GPT C08/C11–C13 | corrected-normative | mapping table; `presenting` removed from Execution state; answer-only has no certificate; terminal retry creates new Execution |
| X16 | Evidence “graph” was a bag/runtime-owned verified alias | Grok 13; GPT H/I authority findings; comparative 8.1 | corrected-normative | core snapshot commits one immutable node ref/body digest and no edge record; only Projector-derived Application/Kernel read evidence is accepted |
| X17 | multiple settled attempts/conflicting evidence nondeterministic | Grok 9–10; GPT H07; comparative blocker 8 | corrected-normative | core admits exactly one Invocation + one node; retry creates a new linked Execution; zero/two/conflicting inputs deny and timestamp/convenient selection does not exist |
| X18 | certification race/duplicate/stale body | GPT D03–D06/H; comparative 8.2–8.4/blocker 9 | corrected-normative | immutable assessment refs/time/selector sets; dedicated structured certification-key domain; once-created byte-stable envelope + terminal commit |
| X19 | uncertified operational stream/prose/scalars | Grok 17/18; GPT F05/H presentation; comparative blockers 14–15 | corrected-normative | driver deltas private; Host owns finite public statuses; closed EvidenceView/StructuredResult schemas only |
| X20 | Catalog/inspect/search drift and trust | Grok 21; GPT E14–E18 | corrected core / accepted future blocker | `agent-catalog.v1` is unavailable; core has no snapshot/search/inspect/receipt and binds one exact static contract directly |
| X21 | context overflow/compaction could drop authority | Grok 23; GPT K10/K11 | corrected-normative | non-droppable context minimum; fail `context-capacity-insufficient`, never silent drop/reinspection |
| X22 | storage worker self-asserts completeness / dual truth | Grok 2; GPT J11–J13; comparative 1.8/blocker 11 | corrected-normative | raw walker disposition + Kernel accounting proof; Projector alone derives `walk-completed-without-local-error`; temporal completeness never implied |
| X23 | Safe inside requested root makes “whole disk” false | Grok 3; comparative 1.9 | corrected-normative | Kernel deny-before-enumeration; walker sees no protected identity/name/count; public disclosure only generic `policy-restricted`; fixture root only |
| X24 | default temporal intent undefined | Grok 4; GPT J14; comparative blocker 12 | corrected-normative | current/stable/interval intent table; ambiguity clarifies; no silent downgrade |
| X25 | snapshot/stable proof/output/disclosures incomplete | GPT J01–J05; comparative 8.7/blockers 13–14 | scope-reduced + accepted future blocker | core temporal ABI is interval-only with detector unsupported; current/stable intent blocks before Execution; future snapshot/detector profile needs its own schema/proof/comparator fixtures |
| X26 | `logicalBytes` product/metric/path semantics misleading | Grok 27–29; GPT J06–J18 | corrected-normative | metric `logical-namespace-entry-bytes.v2`, handle/volume identity, no-follow reparse, exact interval wording, wider fault corpus gate |
| X27 | legacy outcome vs certificate taxonomy | Grok 6; comparative blocker 16 | corrected-normative | explicit `legacy-*`, no synthetic certificate/V3 verified; only real current reassessment can upgrade |
| X28 | `request-wait`/wake liveness incomplete | Grok 24–25; comparative 1.17 | corrected-normative | typed condition, finite expiry/policy/outcome; catalog/credential/policy/provider wakes; unchanged fingerprint not progress |
| X29 | approval preview/arm/dispatch race | Grok 20; GPT G04–G11; Qwen preview finding | corrected + accepted-blocker | shown template/preview digest pinned; true arm mechanism and atomic current-policy dispatch remain hard gates; required-arm unavailable |
| X30 | effect dispatch ownership/frozen executable semantics incomplete | GPT G01–G03; comparative effect blockers 18–20 | accepted-blocker | choose one physical/co-located/formal-outbox owner before effect ABI; implementation digest is provenance, not executable retention |
| X31 | in-process network fence false/provider ingress absent | Grok 19; GPT F09–F17; comparative blockers 22–23 | corrected + accepted-blocker | OS-confined broker, endpoint/credential/data-lineage policy, attempt+ingress lifecycle; provider disabled until threat tests |
| X32 | protected refs expose equality/no crypto/multi-user model | GPT I08–I10; comparative blocker 24 | corrected + accepted-blocker | opaque refs, envelope target, per-Windows-principal isolation, ACL/key/backup/erasure; same-user/admin/OS outside basic digest trust |
| X33 | Incognito absolute no-residue/zeroization overclaim | Grok 35; GPT I01–I05 | partial + corrected/blocker | core rejects operational Incognito; future profile needs exhaustive generated port inventory; OS residual limits disclosed |
| X34 | recovery retention/erasure/quota unresolved | GPT I13; comparative blocker 25 | accepted-blocker | existing RecoveryCase retained; effects wait for separate privacy/erasure/pressure ADR and fixtures |
| X35 | migration rollback/dual truth/flags invalid | GPT L01–L09/L18; Grok 34 | corrected + accepted-gate | additive-store rollback reader, no raw shadow parse/V4→V3 mirror; compatible accepted package identity; schema before atomic feature set |
| X36 | disk-full/backup/repair/export/admin authority | Qwen useful findings; GPT D10/L08–L10 | corrected + accepted-gate | reserve/emergency outcome journal, degraded mode, consistent backup, typed privileged admin commands; fault corpus required |
| X37 | child typed reduce invents evidence/future child races | Grok 36; GPT K01–K06 | accepted-blocker | children disabled; simple selection only; typed reduce needs derivation EvidenceNode recipe/edges/retention |
| X38 | jobs/compaction/timezone/retention incomplete | GPT K07–K11; Qwen related ranges | accepted-blocker | feature manifest/dependency gate keeps them unavailable until their own ABI/fixtures; not a first shadow blocker |
| X39 | threat model/security/release thresholds absent | GPT L14–L21; Qwen 306–375/421–425 | accepted-blocker/gate | effects require threat model; accessibility moved into effect arm gate; corpus digests/thresholds needed before release claims |
| X40 | product terminology collapses meanings | Qwen useful glossary finding; GPT C12/J09 | corrected-normative | protocol glossary forbids legacy→verified, interval→current, logical→allocated, permit→sent, unknown→cancelled |
| X41 | review process diverges instead of converging | Claude CL-01–CL-04; GPT2 100 | accepted/corrected | one core slice; broad prose audit cycle ends; next reviewer inspects generated artifacts/results |
| X42 | base core and future extensions were mixed | GPT2 95/99–100; Grok2 36/38 | corrected-normative | exact `agent-core-read.v1`; Engine/effects/provider/privacy/plugins/children/jobs/compaction unavailable in separate profiles |
| X43 | Runtime/Protocol manual mirrors drift | Grok2 11; GPT2 schema-owner findings | corrected + gate | Protocol sole ABI; major Runtime mirrors removed; generated schemas/TS required before closure |
| X44 | refs/domains/counters/limits/parser/array semantics not closed | Grok2 14–18/38–39; GPT2 canonical/ref findings | corrected + gate | strict parser, exact manifest/domain/ref/counter/array rules; numeric limits await measured manifest fixture |
| X45 | admission source/candidate/cohort provenance ambiguous | Grok2 18/21–22/38/51; GPT2 admission findings | corrected-normative | message-byte source, discriminated candidates/source, runtime feature/cohort evidence; no model/V2/split core branch |
| X46 | Goal sources/minimum/selectors/typed predicates/model path incomplete | Grok2 15–16/27; GPT2 Goal findings | corrected-normative | retained minimum/compiler body+implementation, typed selector/literal, exact input, deterministic local compilation only |
| X47 | capability contract/workflow/legacy mapping could invent semantics | Grok2 9/11/25/33/54; GPT2 96 | corrected/blocker | one closed capability instance; generic compatibility/workflow interpreters removed; legacy diagnostic only |
| X48 | commands/events/state vocabulary lacked payload closure | Grok2 12–13/28–32/41; GPT2 ABI findings | corrected + gate | exact two-command/closed core-event union and producer matrix; reserved extension names not enabled ABI |
| X49 | singular Interaction state cannot project many executions/mixed rows | Grok2 7/42; GPT2 interaction findings | corrected-normative | small Interaction lifecycle + independently ordered answer/execution/recovery rows and links |
| X50 | Invocation/dispatch had two-store atomic owner | Grok2 8; GPT2 dispatch findings | corrected core / effect blocker | schema-lab appender owns transition+stable attempt+one in-memory port step; no product outbox/durability claim; effect/product owner/co-location/outbox ADR mandatory |
| X51 | Approval/Arm validity exceeds declared threat scope | Claude CL-05; Grok2 31; GPT2 approval findings | accepted-blocker | Approval is extension-only; trusted-human mechanism, authorization lifecycle and attacker/anchor model precede effects |
| X52 | recovery/frozen executable semantics and retention incomplete | Claude CL-08/CL-16; GPT2 recovery findings | corrected + blocker | digest is provenance, not binary retention; incompatible recovery blocks; retention/pressure remains effect ADR |
| X53 | evidence graph/attempt selection lacked transitive commitment | GPT2 65–67; Grok2 evidence findings | corrected-normative | exact singleton graph/selection/assessment tuples carry node, Invocation and body refs/digests transitively; no ambient ID lookup or retry graph |
| X54 | assessment/certificate/terminal policy had ambient inputs/key mismatch | GPT2 68–73; Grok2 6 | corrected + gate | selector/time/ref fence, denial union, dedicated key body/domain, byte-stable envelope; terminal-policy corpus remains gate |
| X55 | presentation result undefined/driver controlled public prose | GPT2 74–75/79; Grok2 46–49; Claude CL-14 | corrected/blocker | closed EvidenceView/StructuredResult; operational driver text private; deterministic exact renderer core |
| X56 | Engine identifiers/features/cancel/fences disagree | Grok2 28; GPT2 76–80 | corrected design / unavailable | feature union and cancel literal aligned; whole Engine profile excluded from core pending separate schema |
| X57 | provider entities/egress/ingress/broker ABI incomplete | Claude CL-06; GPT2 81–86 | accepted-blocker | provider extension remains unavailable; platform support/fallback is product decision, not weakened confinement |
| X58 | privacy ports/encrypted/multi-user model incomplete | Grok2 19/48; GPT2 87; Claude CL-07/CL-17 | corrected/blocker | core persistent fixture only; exhaustive Incognito/encrypted manifests and per-Windows-principal isolation required |
| X59 | storage finish identity/temporal guards/coverage/proof/exact rendering incomplete | Grok2 1–5/23–27/43/55; GPT2 88–94 | corrected + gate | finish volume, guarded proof union, raw walker + bounded accounting proof, end-to-end decimal string, supported-matrix benchmark |
| X60 | protected/Safe boundary could disclose or enumerate before denial | Claude CL-12; Grok2 4/53 | corrected core / effect blocker | Kernel deny-before-enumeration + generic disclosure; every future filesystem effect must prove same handle gate |
| X61 | V2 fallback can revive known false completion | Grok2 10/50/52; GPT2 96 | corrected-normative | no V2 in core; coexistence defaults block absent capability-specific exact equivalence; storage has none |
| X62 | historical `0.5.0`/`1.0.0` scope and thresholds contradicted | Grok2 35–36; GPT2 95/98; Qwen2 related | superseded by owner decision + gate | target release is exactly Monarch `0.3.0`; readiness still follows enabled manifests with denominators/support matrix |
| X63 | product journal/backup/restore ABI preceded backend evidence | Claude CL-09/CL-10; GPT2 97–98; Grok2 35 | corrected + gate | isolated parser/store durability/latency/backup benchmark precedes V4/product ABI |
| X64 | future extensions looked protocol-ready because prose/types existed | GPT2 99; Qwen2 future-feature ranges | corrected-normative | explicit extension-only banners/profiles; prose name/event cannot enable feature |
| X65 | digest trust was confused with hostile-local tamper/supply-chain protection | Claude CL-05/CL-18; GPT2 86; Qwen2 signing claims | partial + blocker | core claim limited to trusted writer; same-user/admin/OS and package/update anchor require threat decision; signatures not universally mandated |
| X66 | deterministic NLU/fast invocation owner/scalability unclear | Grok2 20–22; Claude CL-11 | partial + corrected/gate | one bounded pure matcher/direct deterministic host; latency/conflict/RU-EN corpus required; broader NLU remains future scope |
| X67 | all effects shared one retry/reversibility model | Claude CL-13; GPT2 61–64 | accepted-blocker | effects need risk/idempotency retry tiers and separate compensation protocol; core read unaffected |
| X68 | “independent” review and convergence undefined | Claude CL-01–CL-04; GPT2 process findings | corrected-process | reviewer must not create artifact and must inspect exact diff/generated package/hashes/output; advisory prose review is not gate |
| X69 | plugin ecosystem decision was accidental | Claude CL-19; GPT2 trust findings | accepted-open-decision | `agent-plugins.v1` explicitly undecided/unavailable pending trust/legal/sandbox/revocation product decision |
| X70 | dates/model identity/provenance/status hygiene | Qwen2 date claim; all attachment headers | partial/rejected/corrected | 2026-08-26 is actual environment date; model labels remain unverified self-ID; original/revision dates and attachment hashes recorded |
| X71 | allowlist still referenced unlisted authority/compiler bodies | independent core PASS1 P1-01 | corrected-normative | all core semantic refs resolve to allowlisted bodies; compiler-contract pseudo-object replaced by the exact matcher descriptor ref/body/hash; raw implementation identity has a separate non-semantic hash type |
| X72 | static core still depended on Catalog/Activation/Decision | independent core PASS1 P1-02 | corrected-normative | Catalog/Activation/Plan/Decision sections explicitly future; core trace is direct Admission → Goal → static capability → Invocation |
| X73 | closed event map lacked exact lifecycle/stream closure | independent core PASS1 P1-03 | corrected + gate | event oneOf now binds payload, producer and stream owner; full positive/negative Invocation events include output rejection and noncertified terminals |
| X74 | KernelReceipt had digest without durable result reference | independent core PASS1 P1-04 | corrected-normative | completed receipt requires resolvable result + accounting refs before publication; failed/cancelled/unknown branches forbid invented results; crash matrix mandatory |
| X75 | IEEE conversion could alias underflow/fraction to safe integer | independent core PASS1 P1-05 | corrected-normative | authority integers are admitted from raw lexical tokens before conversion; `1e-400` and rounded fractional aliases are mandatory negative vectors |
| X76 | Windows path digest did not define one alias-independent identity body | independent core PASS1 P1-06 | corrected-normative | exact volume/path identity bodies and domains; display/time excluded; drive/extended/GUID aliases compare only by handle-derived identity digest |
| X77 | AuthorityScope arrays/path targets lacked canonical-set rules | independent core PASS1 P1-07 | corrected-normative | explicit unique sort registry covers every scope array/path target plus assessment/presentation/storage sets |
| X78 | JSON Schema was implicitly expected to compare sibling timestamps | independent core PASS1 P1-08 | corrected-normative | schema validates shape only; pinned Certifier temporal comparator owns integer epoch ordering/freshness |
| X79 | Migration Phase 1 leaked product persistence beyond Phase 0 manifest | independent core PASS1 P1-09 | corrected-process | separate unavailable `agent-product-facade.v1`, generated manifest/backend/downgrade gate and explicit go/no-go precede any product write |
| X80 | follow-up ownership/CAS could still look like in-place Goal mutation | independent core PASS1 P2-01 | corrected-normative | follow-up targets Interaction with expected revision, receives persisted admission/disposition and any semantic change creates a new linked Execution/Goal |
| X81 | raw goal appeared owned twice | independent core PASS1 P2-02 | corrected-normative | accepted-command/Interaction is sole raw-message owner; Goal carries only exact retained command/admission refs+digests |
| X82 | permanent dedupe tombstone had no product capacity/pressure gate | independent core PASS1 P2-03 | corrected-core + future product gate | core has no dedupe tombstone/compacted receipt/rollover branch and retains the complete record + byte-identical receipt for one fixed generation; a product backend must separately prove a client-visible generation fence, old-retry rejection, rollover, capacity, backup and fail-closed pressure without ID reuse |
| X83 | copy canvas became stale after normative edits | independent core PASS1 P2-04 | accepted-process | generated canvas is intentionally invalid until final source freeze; final generator verify and deterministic re-run are mandatory |
| X84 | matcher descriptor/result boundary was self-referential or required an unlisted sealing body | focused core PASS2 P1-01 + local counterexample | corrected-normative; PASS3 pending | allowlisted `GoalMatcherResultV1` is pure and ID/time/handle-free; Application sealing is a machine-checked ordinal projection, descriptor input/output schemas are exact and committed admission is never reparsed |
| X85 | ref/content/schema/digest algebra and schema bootstrap were ambiguous | focused core PASS2 P1-02 | corrected-normative; PASS3 pending | closed instance/json-schema/opaque-byte refs, one schema-selected content identity, exact schema ID/version/meta-schema agreement, implementation hashes and full cross-schema endpoints; no fictitious opaque schema digest |
| X86 | event union/state/receipt/terminal atomicity was not fully discriminated | focused core PASS2 P1-03 | corrected-normative; PASS3 pending | closed variant IDs, state rules and commit invariants bind receipt-link, Invocation terminal, Goal block and certificate suffixes; post-dispatch cancel/fail require exact receipts; dispatch uses a structured domain key |
| X87 | core still imported Activation/Engine/DAG/retry/product-store semantics | focused core PASS2 P1-04 | corrected-normative; PASS3 pending | core has direct deterministic host, one Invocation, one EvidenceNode and no edge/retry/scheduler/lease/Engine/product outbox; indeterminate blocks product import pending another profile |
| X88 | Admission→Goal could widen target/authority/policy/temporal/partial/claim semantics | focused core PASS2 P1-05 + local counterexamples; reopened PASS3 P1-01 | post-PASS3 corrected-normative; generated artifact gate | exact matcher-result→Admission and GoalAdmissionBinding relations now include the closed candidate-legality matrix: no negated/prohibited/unknown/target-ambiguous/temporal-ambiguous-current-stable clause may coexist with execution, positive ambiguity is empty and exactly one positive candidate is selected |
| X89 | Evidence/selector/proof chain lost refs or trusted worker-owned derived truth | focused core PASS2 P1-06 + local counterexamples; reopened PASS3 P1-02 | post-PASS3 corrected-normative; generated artifact gate | singleton refs remain; storage proof now binds observed depth/path/I/O, exact entry/I/O/return/terminal budget equations, positive cadence, cancellation gap, terminal checks and typed limit witness to the one retained budget profile before completion |
| X90 | current/stable requests could silently become an interval/partial Execution | focused core PASS2 P1-07 | corrected-normative; PASS3 pending | persisted clauses/drafts/candidates distinguish explicit interval, current, stable and ambiguity; only explicit interval is executable and partial widening requires explicit admitted user intent |
| X91 | certificate→EvidenceView→StructuredResult was not a closed lossless projection | focused core PASS2 P1-08 | corrected-normative; PASS3 pending | certificate embeds Goal/admission/context/frozen locale/presentation contract; built-in projection relations bind status/fields/unresolved/refs/locale and exact empty artifact tuples through deterministic templates |
| X92 | residual P2 ownership/order/ID/producer/privacy hygiene could re-open core | focused core PASS2 P2-01..05 | corrected/gated; PASS3 pending | accepted-command store is sole raw owner; bootstrap ordering fixed; 128-bit IDs reject 130-bit aliases; Application owns certification commit; operational Incognito remains unavailable and production Safe is excluded |
| X93 | manifest named state/commit guards without a pinned finite evaluator boundary | local strict closure after PASS2 | corrected-normative; PASS3 pending | callback-free finite relation algebra, exact guard rows and generic resolver/rule-evaluator implementation hash; no manifest callback, clock/network/model or physical-store dependency |
| X94 | content identity was conflated with a repeated digest occurrence and inline schemas could require an impossible result field | local strict closure after PASS2 | corrected-normative; PASS3 pending | pure per-schema content-identity registry is separate from occurrence rules; the then-67/current-66 exact allowlist has a disjoint domain cover, self-omission rules and schema-document bootstrap |
| X95 | retry/crash could bind an accepted command to current locale/features/capability or require an unrepresentable compacted receipt | local strict closure after PASS2 | corrected-normative; PASS3 pending | accepted context pins RuntimeFeatureSet→sole capability/matcher/policy/recipe/presentation chain before receipt; retry reconstructs from the original context and full retained receipt, with no core compaction/tombstone response |
| X96 | generic immutable refs could hide unlisted diagnostic/attachment schemas or leak authority through metadata | local strict closure after PASS2 | corrected-normative; PASS3 pending | store-issued instance/json-schema/opaque branches, exact length/classification/content identity, diagnostic/artifact purpose restrictions and resolver-side authority recheck |
| X97 | claim/presentation projection still allowed package-chosen rows, dropped unresolved denials or artifact injection | local strict closure after PASS2 | corrected-normative; PASS3 pending | exact 28 private claims, exact 28 allowed/16 required presentation keys, deterministic templates, lossless unresolved tuple and empty artifact arrays |
| X98 | denial/error unions allowed semantically impossible code/detail/ID/retry combinations | local strict closure after PASS2 | corrected-normative; PASS3 pending | exact CompletionDenial and AgentProtocolError expansion tables; recovery classification never authorizes an automatic retry |
| X99 | incomplete traversal could omit or contradict its abort reason while diagnostics selected public truth | local strict closure after PASS2 | corrected-normative; PASS3 pending | completed is proof-abort absent/output `none`; incomplete repeats one exact enumerated non-`none` code; projector—not diagnostic bytes—owns the branch |
| X100 | completion retry could allocate a new command ID or assess against a second wall clock | local strict closure after PASS2 | corrected-normative; PASS3 pending | request freezes one assessment time/attestation and `completionCommitCommandId`; assessment/certificate repeat them exactly, terminal observability time cannot affect verdict, and retry is byte-identical |
| X101 | command receipt required accepted IDs/time/fingerprint while also representing pre-admission rejection | local strict closure after PASS2 | corrected-normative; PASS3 pending | durable receipt is accepted-only and atomically co-committed with dedupe + first Interaction event; parse/auth/feature/capacity/conflict failures return direct closed ProtocolError with no invented command/receipt fact |
| X102 | partial evidence could retain typed bindings while every claim required complete observation, without stating whether those bindings were satisfied | local strict closure after PASS2 | corrected-normative; PASS3 pending | extraction and claim satisfaction are distinct; partial values may be disclosed only with one coalesced unresolved denial/status and never count as verified claims |
| X103 | completion request-freeze and later certificate commit could reuse one command ID for two different commit fingerprints; other core event branches still inherited optional command ownership | local strict closure after PASS2 | corrected-normative; PASS3 pending | every core event requires command ID; request-freeze ID is stable and distinct from the reserved terminal-commit ID, which alone repeats on assessment/certification/terminal suffix |
| X104 | accepted receipt was not mechanically bound to the first Interaction commit and could name another event/revision/time | local strict closure after PASS2 | corrected-normative; PASS3 pending | accepted event names exact dedupe/receipt refs; fixed projection proves one-event all-or-none command+dedupe+receipt+event commit and every command/fingerprint/interaction/revision/event/time equality |
| X105 | one two-locale template globally required 16 claim values, so a valid blocked certificate with no values was deterministically unrenderable | local strict closure after PASS2 | corrected-normative; PASS3 pending | six locale×verdict templates; verified/partial require 16 data keys, blocked requires none + unresolved; current core has exact 54-row localized denial map after unreachable freshness-row removal and one-pass missing-key→blocked convergence |
| X106 | accepted RuntimeFeatureSet pinned capability/matcher but not Completion Certifier/terminal policy, allowing an upgrade-time verdict-policy swap | local strict closure after PASS2 | corrected-normative; PASS3 pending | FeatureSet now pins certifier contract; GoalAdmissionBinding/Goal/assessment repeat it and its terminal policy, with no current-registry substitution |
| X107 | core called its content/event store in-memory while completed Result Admission promised `fsync`, falsely implying an already selected durable backend | local strict closure after PASS2 | corrected-boundary; PASS3 pending | core proves resolvable-before-receipt ordering only; durable write/fsync/atomic visibility is an explicit future backend fault-test gate |
| X108 | prose “crash” fixtures could be misread as real process/power-loss durability evidence from an in-memory simulator | local strict closure after PASS2 | corrected-boundary; PASS3 pending | simulator cuts prove protocol retained-state replay only; real kill/fsync/power-loss/restore evidence belongs to the backend-specific harness |
| X109 | core prose exposed `command.lookup` although the exact manifest had no such query schema/operation | local strict closure after PASS2 | corrected-normative; PASS3 pending | no lookup endpoint exists; only exact resubmission of the original closed submit/follow-up command may recover a retained receipt |
| X110 | follow-up decision used independent relation/reason/optional-target fields and admitted impossible or authority-confusing combinations | local strict closure after PASS2 | corrected-normative; PASS3 pending | exact five-branch oneOf; valid targets are same-Interaction provenance only, while outside target exists solely in the typed rejection branch and is never dereferenced |
| X111 | selector value type and canonical encoding were independent unions, admitting cross-row combinations with no deterministic TypedValue projection | local strict closure after PASS2 | corrected-normative; PASS3 pending | six-branch selector oneOf plus exact Selector/Literal→TypedValue conversion table; object branch is only the fixed storage exclusion summary |
| X112 | non-generic matcher/walker/projector/certifier/renderer implementation hashes did not explicitly define dependency-complete loaded artifact boundaries | local strict closure after PASS2 | corrected-normative; PASS3 pending | every first-party executable hash covers the loaded bundled module plus lock-selected embedded dependencies; declarative inputs stay external to avoid self-hashing |
| X113 | public ProtocolError could disclose a protected cause through code or free-form text | local strict closure after PASS2; reopened PASS3 P1-04 | post-PASS3 corrected-privacy; generated artifact gate | core error has no server-authored message/path/cause; protected and ordinary denied paths share the exact `path-ineligible/policy/after-user/no-diagnostic` authority tuple and only a cause-independent local UI template may render it |
| X114 | optional diagnostic refs remained legal for every ProtocolError and could re-identify a protected-boundary denial by ref presence | local strict closure after PASS2 | corrected-privacy; PASS3 pending | exact 24-row error expansion now fixes diagnostic pair forbidden/optional; all auth/policy/path/input errors forbid diagnostics, and path denials are presence-indistinguishable |
| X115 | `not-found` had no authorization-before-existence rule and could become an aggregate-ID enumeration oracle | local strict closure after PASS2 | corrected-privacy; PASS3 pending | namespace authorization precedes lookup; foreign IDs produce generic unauthorized independent of existence, and `not-found` is only for an already authorized namespace |
| X116 | event sequence/revision genesis was implicit, allowing two stores to choose 0- vs 1-based authority cursors/digests | local strict closure after PASS2 | corrected-normative; PASS3 pending | absent aggregate is virtual 0/0; first stored event/commit is 1/1; later commits increment revision once and event sequence contiguously, with zero-based commitIndex |
| X117 | `event-commit` hashed an anonymous array outside manifest endpoints, while core `stream-prefix` relied on a nonexistent snapshot schema | local strict closure after PASS2 | corrected-normative; PASS3 pending | allowlisted `CommitGroupDigestBodyV1` + exact 40-variant result rule; rolling prefix/snapshot removed from core and deferred to a separately generated product facade |
| X118 | schema-lab prose called an in-memory accepted receipt “durable”, allowing simulator atomicity to be misread as process/filesystem/power-loss proof | local strict closure after PASS2 | corrected-boundary; PASS3 pending | receipt now means authoritative retained-state admission in the lab; only a separately fault-tested selected backend may expose the same receipt as product-durable acceptance |
| X119 | opaque raw-byte identity used a schema-looking `monarch.*` version literal that was intentionally absent from the exact manifest | local strict closure after PASS2 | corrected-normative; PASS3 pending | raw bytes now use the explicit non-schema digest-version literal `opaque-bytes.v1`; it cannot be mistaken for an unlisted runtime schema |
| X120 | all event variants carried `payloadDigest` and registered `event-payload`, but the exact manifest source/result rules were absent | local strict closure after PASS2 | corrected-normative; PASS3 pending | exact 40-row payload rule bijection now covers every closed event branch; commit-body projection may only inherit an already validated payload/digest pair |
| X121 | terminal command/certificate retained only `assessmentInputDigest`, requiring a ghost digest lookup or ambient stream search during recovery | local strict closure after PASS2 | corrected-normative; PASS3 pending | request, assessment body, commit command and certificate now retain one exact assessment-input ref+digest; the dedicated occurrence/binding rules make it directly resolvable |
| X122 | renderer grammar did not explicitly forbid substituted denial/value bytes from re-entering token or Markdown/HTML interpretation | local strict closure after PASS2 | corrected-security; PASS3 pending | templates are parsed once, denial text is brace-free, substitutions are inert plain text and final output is never reparsed as markup/code |
| X123 | digest rules named a source endpoint but did not explicitly choose the `schemaVersion` header argument for nested pointers | local strict closure after PASS2 | corrected-normative; PASS3 pending | every instance rule now derives schema version from the exact source-schema manifest entry and profile ID from the frozen canonicalization profile; only schema bootstrap/raw bytes are explicit exceptions |
| X124 | `execution.failed:internal-error` could terminalize `running` after dispatch without a receipt and strand a nonterminal Invocation | local strict closure after PASS2 | corrected-truth; PASS3 pending | internal error is certifying-only; assessment-input failure requires an exact settled Invocation; any receiptless post-dispatch outcome remains indeterminate/nonterminal |
| X125 | `execution.blocked:noncertified` was a legal standalone transition from queued/running, so it could strand Invocation or mislabel post-dispatch budget exhaustion | local strict closure after PASS2; PASS3 P2-01 found one stale diagram arrow | post-PASS3 corrected-truth; generated artifact gate | noncertified block is only an immediate reason-equal suffix of `goal.blocked` or pre-dispatch `invocation.rejected`; the stale `queued -> blocked` prose edge was removed and generated transition fixtures remain authoritative |
| X126 | changing server-derived installation generation could make an old raw client request ID look absent/new because the public command had no generation fence | local strict closure after PASS2 | corrected-idempotency-boundary; PASS3 pending | core has one fixed fixture generation and no rollover; future product rollover requires a versioned client-visible generation fence and explicit old-request rejection before dedupe lookup |
| X127 | pre-admission capacity failure had no legal exact ProtocolError row and could be mislabeled user budget/internal error | local strict closure after PASS2 | corrected-error-closure; PASS3 pending | added the sole `storage-capacity-exceeded/storage/after-runtime/no-diagnostic` row; capacity failure creates no command/receipt/Interaction fact |
| X128 | two legal `partial-evidence` denial rows existed without an exact Goal-gate selection rule | local strict closure after PASS2 | corrected-verdict-closure; PASS3 pending | `allow-disclosed` selects the no-detail row and partial verdict; forbidden partial selects only `partial-not-admitted` and blocked; both rows for one node are illegal |
| X129 | parser needed `TransportLimitProfileV1` to know limits for parsing itself, and its runtime counter semantics/profile equality were incomplete | local strict closure after PASS2; reopened PASS3 P1-03 | post-PASS3 corrected-bootstrap; generated artifact gate | hashed finite bootstrap ceilings remain; runtime profile now fixes complete payload, root depth, total nested members/items, per-string UTF-8, ref occurrences, commit events and schema-closure documents, while manifest/capability bind the same retained profile ref/content identity |
| X130 | opaque/random/reference/semantic ID fields lacked one exact schema/variant/path application map | PASS3 P1-05 | post-PASS3 corrected-normative; generated artifact gate | manifest now retains `OpaqueIdProfileV1` with exact kind/prefix/owner registry and exhaustive concrete `idFieldRules`; package generation independently expands every schema branch and requires exact set equality, owner termination and canonical 128-bit vectors before lab conformance |
| X131 | product release, runtime family and pre-existing Astra module could become one ambiguous version/authority namespace | owner decision; post-PASS3 Claude/GPT naming risk | corrected-boundary | product train is exactly Monarch `0.3.0`; runtime family is Astra V3; existing `src/modules/astra` is Astra Skills `0.1.0`, a bounded discovery/context component with no execution, policy, evidence or completion authority; Protocol V1, wire `monarch.agent-task.v3` and future Store V4 remain independent axes |
| X132 | capability output, Projector and Certifier each appeared able to own the `TypedValueV1` wrapper | Grok advisory; GPT comparative confirmed P1 | corrected-normative; generated fixture gate | capability emits canonical decimal string; Projector validates raw output/proof and derives evidence facts; Certifier alone creates the typed claim binding; wrapper at capability/Evidence layer is rejected |
| X133 | flagship wording asked current storage use while the executable profile measured one interval namespace-entry metric | Grok advisory; GPT comparative confirmed P1 | corrected-product-contract | interval request must explicitly name disposable root, one pass and `logical-namespace-entry-bytes.v2`; current/stable/physical/storage-usage language clarifies or blocks and can never silently route to this capability |
| X134 | one receipt clock literal diverged from the closed clock-class/profile vocabulary | Grok advisory; GPT comparative | corrected-normative | receipt and evidence use the same exact `kernel-local-attested` literal and equality fixture |
| X135 | time-limit proof could accept bytes returned by an I/O operation that completed after the limit | Grok advisory; GPT comparative/full audit | corrected-normative | operation and return are charged before accumulator mutation; a late return discards metadata/value and emits typed `time-limit/io-return` witness |
| X136 | a committed Goal could remain `queued` with no legal progress owner, while accepted Interaction lacked a durable continuation owner | Grok advisory; GPT full audit | corrected core + mandatory product gate | core Goal admission and `invocation.prepared` are one commit, so no retained core boundary ends queued; product receipt exposure requires durable accepted-work continuation/inbox/recovery before any read path |
| X137 | pinned historical implementation hash did not preserve executable bytes/runtime identity across upgrade | Claude strategic risk; GPT full audit | accepted mandatory product gate | product profile must retain/reproduce dependency-complete package bytes plus process/platform generation for every accepted work item, or expose an explicit terminal product outcome before receipt; ambient current implementation substitution is forbidden |
| X138 | dispatch could rely on policy frozen at acceptance and miss a stricter current revocation ceiling | GPT full audit | corrected-normative + product fixture gate | dispatch intersects accepted authority with current revocation/deny ceiling immediately before side effect/read open; a new deny blocks, while a new grant cannot widen accepted scope |
| X139 | crash after physical dispatch but before durable receipt had no honest product state or retry owner | GPT full audit | accepted mandatory product gate | selected product backend needs co-located commit or physical outbox plus receiptless-unknown reconciliation; core never fabricates failure/success and never blindly redispatches an indeterminate attempt |
| X140 | product facade/store/recovery was described as optional despite being required before real user-visible reads | GPT comparative/full audit | corrected migration boundary | `agent-product-facade.v1` and product-read foundations are mandatory before Phase 2/3 product read; schema lab remains isolated and cannot expose a product-durable receipt |
| X141 | lexical/path-prefix protection could be bypassed by a hard-link or other alias to a protected object | GPT full audit | corrected-security; Windows corpus gate | deny-before-enumeration is object-identity/alias aware; a disposable protected fixture reached through any external alias is denied, while production Monarch Safe is never a fixture or inspection target |
| X142 | reparse-point and unmaterialized cloud-placeholder rules overlapped without deterministic precedence | GPT full audit | corrected-normative; filesystem matrix gate | protected alias wins first, unmaterialized placeholder returns partial without hydration second, other reparse is excluded third, ordinary entry fourth; unknown combinations fail closed |
| X143 | monotonic clock evidence could be reused across OS reboot where continuity is unknowable | GPT full audit | corrected-truth | same-boot process recovery may resume with attested continuity; OS reboot or unknown boot continuity invalidates the old temporal assessment and requires a new Execution/reassessment path |
| X144 | blocked certificate/result could retain observed typed scalars even when claims were unresolved | Grok advisory; GPT full audit | corrected-privacy/truth | blocked assessment, view and result carry no claim bindings or data-bearing presentation keys; only exact denial tuples may render |
| X145 | parser rule rejected U+FEFF anywhere, including a valid code point inside a JSON string | GPT full audit | corrected-parser | only a leading transport BOM is rejected as BOM; U+FEFF inside a syntactically valid JSON string is ordinary string content, while grammar still rejects it outside strings |
| X146 | TypeScript intersections combined with `additionalProperties:false` could generate schemas that reject all valid closed variants | GPT full audit | corrected-codegen gate | every closed structural union must compile to flattened `oneOf` object branches; naive `allOf`/intersection emission is forbidden and covered by positive/negative compiler fixtures |
| X147 | Phase 0 remained too monolithic and matcher/walker correctness could share one implementation common mode | Claude/Qwen strategic critique; GPT full audit | corrected migration/evidence gate | Phase 0 is split into canonical/event/storage/completion/evidence packages; artifact review uses a different schema library/oracle, synthetic filesystem properties, RU/EN/voice corpora and harmful-FP/recall/clarification/unsupported metrics |
| X148 | real product lifecycle omitted command query/attach/cancel, bounded queues, rollover, ACL, backup/admin and support/platform contracts | GPT full audit; Qwen useful operations findings | accepted mandatory product gate | no product read ships until those owners, schemas and fault/upgrade/support matrices exist; input CAS is separate from event store and storage/privacy boundaries are explicit |
| X149 | migration expanded capabilities before extracting loop seams and future jobs reused ambiguous string-concatenation hashing | GPT full audit | corrected migration/future boundary | extract minimum AgentLoop seams before capability expansion; scheduler/timer/lease is a prerequisite profile; future job fire identity uses structured `JobFireKeyBodyV1` with a domain-separated digest |
| X150 | protocol breadth, raw implementation pinning and canonical-hash overhead could exceed a small-team delivery/maintenance budget | Claude/Qwen strategic critique; GPT comparative | accepted measurable release gate, severity reduced | retain the certifier/truth boundary, but stage only the read slice; benchmark CPU/latency/memory/rotation on supported Windows hardware and simplify only from measured evidence; unavailable profiles do not enter Monarch `0.3.0` by implication |
| X151 | canonical trace used impossible `interaction.routed(agent, …)` payload outside the closed route enum | Grok exact quote; GPT confirmed | corrected-normative | trace now uses `aggregateRoute=execution-only`, exact candidate digest and `cohortDecision=single-v3`; fixture rejects the old shape |
| X152 | prose/TypeScript/generated schemas formed a circular codegen authority with no single machine source | GPT 5.6 primary; Grok/Qwen corroboration | corrected architecture; artifact gate | canonical `ProtocolDefinitionV1` is sole input under a small pinned bootstrap compiler/schema; generated outputs never feed back and require independent structural + semantic oracle |
| X153 | one generic rule evaluator and compound relation labels hid executable semantics; runtime ref closure lacked depth/object/edge/byte bounds | GPT 5.6 primary | corrected-normative; artifact gate | split identity-binding and state-commit engines; labels compile to finite primitive programs; exact expected ref closure is bounded before fetch/allocation and rejects cycles/extras |
| X154 | `queued`, optional parent Goal/claim condition/freshness and unconstrained signed decimal claims leaked unowned core semantics | GPT/Grok exact source findings | corrected-normative | no queued state, atomic preparing→preparing→running commit, Goal revision literal 1, follow-up provenance owner, unconditional core claims and unsigned/minimum-zero decimal predicates |
| X155 | core accepted Incognito/encrypted hints and attachments that it could neither persist safely nor interpret | GPT primary; Grok corroboration | corrected ingress | non-persistent privacy and nonempty attachments fail before accepted command/receipt/Interaction; fingerprint/payload attachments are exact empty tuples |
| X156 | Interaction↔Execution link, local certificate trust and settled-Invocation semantics could be read as dual/stronger truth | GPT primary | corrected ownership/trust | `execution.created.interactionId` is sole core link owner; certificate/view/result repeat local trusted-writer issuer; settled port output may still yield later evidence-integrity Execution failure |
| X157 | Windows storage profile omitted exact filesystem/root/alias/enumeration/name/path support semantics | GPT/Grok; local Microsoft API verification | corrected-normative; hardware gate | first slice is non-root non-reparse direct local fixed NTFS only; pins `FILE_ID_EXTD_DIR_INFO` long names, one forward iterator, strict UTF-16→UTF-8 relative paths and rejects UNC/mapped/SUBST/virtual/non-NTFS/reparse roots |
| X158 | walker self-attested completeness and lacked independent exhaustion/resource observation | GPT primary; Qwen strategic | corrected architecture; artifact gate | separate Kernel-supervised broker owns handle observations, iterator/I/O/resource counters; walker owns frontier; Projector verifies; lab transcript oracle is independent; per-I/O/RAM/frontier/handle/batch/response budgets are closed |
| X159 | cloud placeholders, first I/O errors and concurrent namespace mutation had inconsistent continuation/count semantics | GPT/Grok | corrected-normative | first error/placeholder aborts immediately, additive reparse/cloud equation is exact, no selective continuation, and each one-pass broker frame occurrence is only an interval observation |
| X160 | product revocation ended at pre-dispatch and omitted deadlines, known-bad packages and post-certificate correction | GPT primary; Qwen/Grok product findings | accepted mandatory product gate | checks occur at continuation/dispatch/around I/O/before evidence/certification/delivery; package quarantine, start-by/deadline, immutable certificate invalidation/correction and user notice are required before cohort |
| X161 | Content/Package/Clock/Revocation/Protected-Identity/Workspace-Grant and delivery/retention owners were implicit | GPT primary | corrected ownership; product gate | all owners are explicit; delivery reauth, retention/erasure/export, backup encryption/RPO/RTO, quarantine quotas and accessibility fallback are release blockers |
| X162 | migration assumed full V4 and built product foundation before proving a minimal current-runtime seam | GPT primary; Qwen complexity critique | corrected migration | Phase 0E compares additive V3, evidence/certificate sidecar and V4; pure simulator then no-behavior-change AgentLoop seam precede product foundation; least-complex passing lane wins |
| X163 | no quantitative complexity ceiling, real-hardware early gate or kill rule constrained the second-system design | Qwen strategic; GPT confirmed | accepted measurable no-go gate | freeze 66 schemas/40 variants/8 guard labels/28 claims/16 data keys, ratify performance/resource/RPO/RTO on supported low/median hardware and kill a lane/slice that needs dual truth or misses thresholds |
| X164 | review could weight model brand/count and structural parity above reproducible semantics | GPT primary; owner ranking preference normalized | corrected process | evidence/counterexample/exact source path determines verdict; model label only prioritizes manual queue; artifact review includes targeted semantic negatives and is not PASS 4 |
| X165 | several critiques overstated digest, BigInt, fail-closed and legal implications | Qwen/Grok broad claims | rejected/reduced | digests remain useful deterministic identity/corruption/replay bindings under trusted writer, BigInt exactness is required, fail-closed permits per-profile rollout, and AGPL is a provenance/legal gate—not evidence of idea contamination |
| X166 | these post-PASS3 edits could be mistaken for independently closed architecture | all three new audits | status retained | no active P0 demonstrated, frozen PASS 3 stays FAIL P0=0/P1=5/P2=1, no PASS 4; only generated definition/schemas/programs/fixtures/benchmarks plus independent artifact review can close corrections |

The older `PASS3 pending` cells in X84–X129 are historical pre-freeze dispositions. §5.11 is the authoritative PASS 3 result: X113/X125/X129 failed the explicit matrix, X88/X89 were reopened by broader counterexamples, and X130 was added. X131–X166 are post-PASS3 advisory adjudications, not PASS 4; every source correction remains gated on generated-artifact review.

---

## 5. Coverage ledger by source

### 5.1. Grok 1–320

All 320 numbered entries were read. The strongest P1 block (1–36) is accounted item-by-item:

| Grok items | Result |
|---|---|
| 1, 3–8, 10–14, 16–18, 21, 23–32, 34 | core accepted and normatively corrected in X03–X28/X35 |
| 19–20, 36 | accepted as provider/arm/child blockers; feature disabled rather than pretending closure |
| 2 | core policy-relative completeness accepted; empirical “almost never complete” wording rejected |
| 9 | free-text unresolved detail problem fixed; UUID evidence ID alone does not break determinism, so original severity reduced |
| 15 | matcher-monolith risk retained, but “matcher code inevitably recreates monolith” rejected; registered pure capability matcher + central bounds chosen |
| 22 | scope/readiness communication risk accepted via status fence; broad release gates and narrow RFC are not a logical contradiction by themselves |
| 33 | catalog visibility defect was unproven; architecture nevertheless makes synth Application-only/non-catalog to remove ambiguity |
| 35 | app-managed residue risk accepted; absolute OS-level no-residue claim rejected/corrected |

Grok 37–160 (P2) and 161–320 (P3) are not treated as 284 independent blockers. They were normalized across state projection, event/schema completeness, query/error limits, driver/catalog/context, approval/recovery, provider/privacy, child/job/compaction, migration/testing/performance/document quality. Every distinct violated invariant maps to X01–X40 or to a disabled future feature gate. Repeated demand for another enum/event/test does not create a new root finding. Design-only options without counterexample remain preferences.

Grok had no live repository access. Assertions about current `agent-loop`, Action Ledger, storage audit and routing were therefore accepted only where the local checks in §2 confirmed them.

### 5.2. First ChatGPT A01–L23 (200 findings)

All IDs are covered without gaps:

| ID range | Count | Disposition summary |
|---|---:|---|
| A01–A12 | 12 | status/evidence limitations accepted; live baseline refreshed; three-pass/P1=0 withdrawn; namespace glossary added |
| B01–B18 | 18 | single ABI owner/canonical profile/core DTO/schema manifest fixed; exhaustive generated schemas/limits remain mandatory gate; unconditional journal signature not assumed |
| C01–C17 | 17 | Invocation/delivery/events/taxonomy/retry/egress state contradictions corrected; user button cannot resolve unknown effect truth |
| D01–D14 | 14 | durable owners, source refs, assessment CAS/atomic commit/idempotency/policy arrays, commit/stream digests, source/admission time, repair/IPC/dedupe scope corrected or gated |
| E01–E20 | 20 | clauses/admission/target/partial/constraints/conditions/selectors/templates/catalog/inspect/workflow implementation identity corrected; memory/image/untrusted features unavailable without manifest |
| F01–F17 | 17 | decision/engine/bidirectional DTO and streaming fixed; driver identity/resume/provider network/ingress/credential/retry gaps become provider hard gate |
| G01–G20 | 20 | executable semantics/Ledger/approval/arm/dispatch/reconciliation concerns accepted; no effect cohort authorized |
| H01–H17 | 17 | graph edges, deterministic selection, assessment fence, atomic/idempotent certificate, typed value retention and presentation fence corrected |
| I01–I13 | 13 | residual Incognito limits, handle Safe fence, protected crypto target and retention/erasure blockers made explicit; generic Safe access still none |
| J01–J18 | 18 | entire storage contract rewritten around policy scope, volume identity, discriminated temporal proof, counters/errors/budgets and truthful metric wording |
| K01–K11 | 11 | child/job/compaction are disabled future features; typed reduce cannot invent evidence; each needs full manifest/retention/time semantics |
| L01–L23 | 23 | migration rollback/cohort/flags/backup/disk/release status corrected; thresholds/corpus/compatibility/threat evidence remain gates, not claimed complete |

### 5.3. Qwen 1–425

All numbered ranges were read and normalized:

| Qwen range | Topic | Result |
|---|---|---|
| 1–20 | architecture/process | status/provenance/severity corrected; repetitions merged |
| 21–50 | types/schemas | core accepted; generated package/schema manifest gate |
| 51–75 | value/digest semantics | canonical/time/hash/path corrections X03/X12 |
| 76–100 | Goal/routing | admission, model floor, partial/DAG/mixed clauses corrected |
| 101–120 | catalog/contracts | exact schema/index/inspect/trust corrected or gated |
| 121–140 | invocation/effects | Invocation fixed; effects explicitly blocked |
| 141–160 | approval/arm | preview binding fixed; real arm/atomic dispatch blocked pending review |
| 161–175 | recovery/cancel | existing guards preserved; retention/privacy blockers explicit |
| 176–190 | journal/storage | commit/stream/repair/limits schema gate |
| 191–205 | evidence/certification | graph/fence/selection/atomic certificate corrected |
| 206–225 | `logicalBytes`/temporal | storage contract rewritten |
| 226–240 | presentation | operational stream/EvidenceView/template truth fence corrected |
| 241–255 | privacy/secrets | bounded Incognito claim/protected refs; encrypted/Safe stay restricted |
| 256–270 | provider/egress | broker/ingress/credential target; provider disabled until gate |
| 271–290 | child/jobs/compaction | future feature blockers, not first RFC |
| 291–305 | migration/compatibility | cohort/legacy/rollback corrected |
| 306–325 | testing/acceptance | kept as executable closure requirements, not prose proof |
| 326–340 | performance/scale | measurable release gates; no invented numbers in architecture |
| 341–360 | security/trust | threat model/driver/IPC/protected-store hard gates |
| 361–375 | product risks | glossary/disclosure/scope status corrected |
| 376–390 | logical contradictions | deduplicated into X01–X40 |
| 391–400 | event list | schema-manifest rule; prose name cannot enable feature |
| 401–420 | implementation risks | mapped to closure tests/disabled features |
| 421–425 | repeated top blockers | duplicates of prior roots, no extra independent count |

Comparative ChatGPT specifically rejected/overstated Qwen items 93, 95, 111, 119, 125, 128, 150, 173, 184, 196, 249, 262, 264, 268, 270, 279, 300, 331, 332, 346–347 and 356 because source already had the relevant invariant or the claimed mandatory field was not necessary. Those rejections are preserved; fixes above do not concede the false causal claim.

The following were retained as design preferences, not defects: mandatory TLA+/Alloy/XState, `corrupt` in every entity, mandatory catalog refresh event, decimal-range predicate, hard maximum Goal revisions, minimum arm delay, mandatory file-path selector, event for every admin state, unconditional local-journal signatures, provider enum for every reason, mutable partial command and persistence of every answer chunk.

Useful Qwen-only additions accepted: Goal DAG/dangling validation, JSON Schema 2020-12, privileged repair/export audit, inclusive integer range, digest of actually shown approval preview, disk-full behavior and product glossary.

### 5.4. Comparative ChatGPT adjudication

Accepted as controlling consolidated list:

- 17 pre-shadow blockers: core schema package; canonical profile; Goal/admission/follow-up; mixed cohort; Invocation/delivery; deterministic evidence; assessment fence; model non-weakening; storage scope/default temporal/proofs/disclosures; streaming truth; legacy mapping; focused regression review;
- 9 additional pre-effect blockers: Ledger/dispatch; frozen executable semantics; atomic authorization; real arm; OS egress; ingress; protected refs; recovery/privacy; threat model.

This pass corrects the source architecture for the first 16 and records the 17th as the mandatory next independent action after generated fixtures. Effect blockers remain hard-disabled, which is the only honest architecture-only closure.

### 5.5. Grok second batch 1–240

All 240 numbered items were read. Disposition by complete ranges:

| Range | Result |
|---|---|
| 1–10 (claimed P0) | exact contradictions accepted as X41–X61, but severity reduced where the path was already forbidden; temporal/coverage/trace/answer-certificate/row/dispatch/mapping/V2 issues were corrected |
| 11–75 (claimed P1) | compile/schema/source/selector/path/privacy/fast-path/state/storage/release findings normalized into X43–X63; generic/future surface demands became blockers or were removed from core |
| 76–210 (claimed P2) | liveness/Approval/Engine/provider/children/jobs/compaction/admin/compatibility items grouped by disabled profile; no prose name was treated as product-ready ABI |
| 211–240 (claimed P3) | useful mirror/canvas/parser/process hygiene accepted; repetitions/style preferences did not become independent defects |

Grok’s exact source contradictions were valuable. Claims that every future missing enum/test is a current P1/P0, or that a forbidden extension path is an active bypass, were rejected as severity inflation. The count “240” is coverage, not 240 independent blockers.

### 5.6. Claude CL-01–CL-19

| IDs | Result |
|---|---|
| CL-01–CL-04 | accepted process correction: scope reduced to one core; text-only audit loop ends; artifact reviewer independence/convergence defined |
| CL-05 | accepted for effects, not core: digests are trusted-writer consistency only; effect approval awaits attacker/authenticated-anchor decision |
| CL-06–CL-07 | accepted product consequences for future provider/Incognito; they do not justify weakening confinement/privacy wording |
| CL-08 | accepted: implementation digest is provenance, not automatic historical executable retention |
| CL-09–CL-10 | accepted: isolated backend/durability/latency benchmark precedes product journal ABI |
| CL-11–CL-13 | partial/accepted blockers: bounded matcher/direct host + corpus for core; broader NLU, Safe effect gates and risk-tiered retry/compensation stay extension work |
| CL-14 | accepted by removing driver-selected public operational text/free-form rationale from core; Engine remains unavailable |
| CL-15 | rejected as defect: singleton invariant fields are deliberate explicit fail-closed constants |
| CL-16–CL-19 | accepted blockers/open decisions for retention, OS-principal isolation, supply-chain threat model and plugin ecosystem |

### 5.7. Qwen second batch 1–180

All numbered items were read. Coverage: 1–10 process/status; 11–35 cross-document contradictions; 36–70 ABI; 71–90 security; 91–105 performance; 106–120 migration; 121–135 testing; 136–150 terminology; 151–170 edge cases; 171–180 implementation/organization. Distinct violated invariants map to X41–X70 or an explicitly unavailable extension. Repeated requests for exact limits/algorithms remain executable fixture/benchmark gates rather than invented numbers.

Two important overclaims are explicitly rejected: the environment date really is **2026-08-26**, so 2026 document dates are not suspicious; unconditional journal signatures are not universally mandatory. Authenticated signing/MAC is required only if the chosen attacker profile needs hostile-writer resistance. Many children/jobs/provider/compaction complaints correctly show those designs are incomplete, but they are not core blockers after profile separation.

### 5.8. ChatGPT second batch 1–100

All 100 findings were read: 1–8 normative ABI; 9–17 canonicalization/versioning; 18–32 admission/Goal; 33–43 capability/catalog/workflow; 44–55 journal/state/events; 56–64 Invocation/Approval/effects/recovery; 65–75 Evidence/Certifier/Presentation; 76–87 Engine/provider/privacy; 88–94 storage; 95–100 migration/release/complexity. Its reported severity distribution was P0=0, P1=59, P2=38, P3=3. Per user instruction it is the primary second-batch adjudication input, but every accepted result above was independently located in source/current code.

The decisive corrections at that historical batch were: profile split; exact manifest/closed events; deterministic Goal; one read dispatch owner; transitive evidence/assessment fence; dedicated certification key/stable envelope; closed presentation; storage walker/proof/volume/temporal rewrite; no V2 fallback; then-unassigned release boundary; backend benchmark before product ABI. The release part is superseded by the 2026-08-26 owner decision assigning Monarch `0.3.0`; readiness gates remain unchanged. Future-profile findings remain blockers, not fake “fixed” claims.

### 5.9. Independent core regression PASS 1

После local adjudication отдельный read-only agent, не редактировавший документы, получил только exact current core sources and an adversarial brief. Result before the corrections X71–X83:

```text
P0: 0
P1: 9
P2: 4
readiness: normative red-work/parser-store benchmark only;
           no claim of a conformant schema lab, simulator or shadow
```

Все 13 пунктов были source-confirmed, а не приняты по авторитету reviewer. Наиболее ценные новые counterexamples: raw JSON `1e-400`/rounded fractional token can become a safe host number before validation; completed receipt carried `resultDigest` without a durable result ref; JSON Schema cannot prove sibling timestamp order; `failed/cancelled/unknown` receipt and rejected output had no coherent result/lifecycle branch. Они исправлены в Protocol, Runtime/Migration fences and X71–X83. PASS 1 не закрывает свои же edits; после final source regeneration нужен новый blind PASS 2. PASS 3 запускается только если PASS 2 найдёт новый P1/regression, максимум три прохода по просьбе пользователя.

### 5.10. Independent core regression PASS 2

PASS 2 получил новый frozen object и не редактировал его. Source hashes на момент проверки:

```text
Protocol    8d38010afe1798debc208cd0dc1b290c6aee79e30f9bec136547d97900d6ed1c
Runtime     5558831b42ea02c3d1b6891bf620b7cdf1db8936caac86c50d90a3ce9b44cde6
Migration   4a250d26b941498fc96279e502f6e3dc1c6d7b8df26e4f23ae642f8631c84c29
Disposition 8cfd951b9e6acf6a785ca07028214bc52cd09c02fd24cf9098c1d71c292df8c8
Review      2ab40d91aadd39fc9f089252cbb6b9e923fe8b1eda2993b1cfb51a5c806ac68b
Canvas      774e529be61b133b0c87cf650bf72d0202a1ff4ba76d8d3b1502dc5a22832ec9
```

Canvas был byte-verbatim `5/5`, 454667 bytes; это доказывало parity экспорта, не correctness. Verdict до последующих author corrections:

```text
FAIL — source architecture not closed for a conformant schema package
P0: 0
P1: 8
P2: 5
```

P1: matcher descriptor/result self-reference; incomplete ref/content/digest algebra; недискриминированная event/receipt terminal closure; accidental Activation/Engine/DAG core imports; Admission→Goal widening; lost Evidence body refs; current/stable→interval downgrade; lossy certificate→view→result projection. P2: duplicate raw-goal ownership, migration ordering, noncanonical 130-bit ID aliases, wrong certification producer wording and Incognito leakage. Они mapped to X84–X92 and source-corrected. Local counterexamples during closure produced X93–X129 rather than being hidden under the PASS 2 label.

PASS 2 не может independently close author edits made after its frozen hashes. A third and final blind prose pass is therefore mandatory over the regenerated source+canvas object. После PASS 3 новый prose pass не запускается: any later correction remains explicitly open until generated schemas, fixtures and artifact-level independent review.

### 5.11. Independent core regression PASS 3 — final prose pass

PASS 3 получил read-only frozen object после всех X93–X129 pre-freeze corrections и не редактировал его. Exact hashes:

```text
Protocol    687dca80f29e00714fa109ffdbfe5c337ea22cc49fb7c3b132f95ab27c2cce6e
Runtime     6f49a782d75d820d6b46f825cbea7265d56f331b6b05ed2262a84d8328107a96
Migration   9afec3cd66b6058402337354083041034753169c2da4186cb3744fd2117c6f32
Disposition 197f2d4e8ae49078726deaa8e0cd4d5e96d9a28533339bf430500c13e6b1e9ff
Review      3bc8d00e4c0fd700d035e151b8290cc226a606a2d52c7c928c0fc6c01f5f782d
Canvas      b71542f70438bd160a6afc77407e243aae6f8a6db5cab8a0e578be17c5712a54
```

Canvas был byte-verbatim `5/5`, 615539 bytes. Это снова доказывает только export parity. Frozen-source verdict:

```text
FAIL — not closed for a conformant schema-lab artifact
P0: 0
P1: 5
P2: 1
```

| PASS 3 ID | Severity | Confirmed counterexample | Post-PASS3 source disposition |
|---|---:|---|---|
| P3-P1-01 | P1 | positive execution candidate мог ссылаться на negated/prohibited/target-ambiguous clause или arbitrary ambiguity code | X88 reopened; closed candidate-legality matrix, singleton matched unknown code, empty positive ambiguity and sole selected positive candidate added across Protocol/Runtime/Migration |
| P3-P1-02 | P1 | completed storage proof не доказывал depth/path/time/I/O ceilings или nonzero cancellation cadence/check coverage | X89 reopened; exact observed facts, check equations, terminal markers, typed limit witness and negative fixtures added |
| P3-P1-03 | P1 | transport limits не фиксировали total-vs-per-object counts, root depth, duplicate refs, schema closure or manifest/capability profile identity | X129 reopened; counters and one retained-profile equality made normative |
| P3-P1-04 | P1 | free-form public ProtocolError `message` мог вывести Safe path despite closed code tuple | X113 reopened; server-authored message/path/cause removed from core ABI; cause-independent local rendering only |
| P3-P1-05 | P1 | bare string IDs had no exact field-pointer application map | new X130; retained exhaustive schema/variant/path profile plus independently expanded endpoint-set equality is mandatory |
| P3-P2-01 | P2 | stale diagram still showed `queued -> blocked` while exact transition table forbade it | X125 reopened; arrow removed and negative fixture retained |

PASS 3's explicit X93–X129 matrix passed every row except X113 (P1), X125 (P2) and X129 (P1); its broader attack also reopened X88/X89 and produced X130. Canvas parity passed `5/5`. The corrections in the last column were made **after** the frozen hashes, so PASS 3 cannot independently close them. Per the user's maximum-three-pass instruction, this is the final prose pass: there is no PASS 4. Remaining closure moves to generated schemas, concrete profile instances/maps, fixtures, compiler output and an independent artifact-level review.

### 5.12. Post-PASS3 external advisory batch — 2026-08-26 (not PASS 4)

Пять новых ответов прочитаны полностью и adjudicated against exact local source. Model/version labels below are self-identification from attachments, not independently verified vendor provenance.

| Self-identified reviewer | Attachment SHA-256 | Size | Adjudication role |
|---|---|---:|---|
| Claude Sonnet 5 | `b0534067a7916a998021401c4eeaf45245dd8b30dc43af076a35711a8a169949` | 69 lines / 22,767 bytes | strategic feasibility, maintenance and second-system pressure; claimed inability to verify hashes was disproved locally |
| Qwen3.7 | `f95c916729e5b85061cf94d807e80c92937a9342d8fcd15f1a7da77de4bb14f5` | 56 lines / 17,491 bytes | broad complexity/performance critique; unavailable-feature and unmeasured orders-of-magnitude claims were filtered |
| Grok Build | `519b822e85f5619421bf5beba50f1e93beae61137c2808521704a1e0860882dc` | 309 lines / 26,731 bytes | strongest quote-first counterexamples; severity and every conclusion independently rechecked with extra caution |
| GPT-5.6 Pro comparative adjudication | `9c1cc76155a652ebdf5748c58104aa9b23b4813acf5b867bc9795eaae7c5b736` | 498 lines / 35,037 bytes | highest-weight external ranking per owner instruction; confirmed Grok's two central P1 contradictions and rejected several overclaims |
| GPT-5.6 Pro full audit | `7034d436c216a58c97537b0fb3a8aad305840cb3122792cd5ab0e834ea0886ec` | 181 lines / 43,773 bytes | broad product-lifecycle, recovery, path/privacy, parser/codegen and migration review |

At intake, local normative sources exactly matched the candidate hashes quoted by Grok:

```text
Runtime     5da7390c059c507d37a16caf17ec9879f1782b208f71eb7b5ea600c772fdb9d6
Protocol    74e95cfde8bd4570aa62b94c5e6171c4c3dea5379b0da0579f4c9f3d5ee40ab0
Migration   5237ae7c077afafad382fca94c15b51fd90b9aff912139538a224f525792a345
Review      ae29b6feb48c5bece03e74f47792a338374c14878371fd2ff67787c09d3ebd61
Disposition 6a9afe43642d6b54a3abb5d3c502c2c27789aa25255b2f72bfb64d9f7b02f2d3
```

This proves the audited source identity, not correctness. External canvas hashes were not promoted to current authority; the local generator/manifest remains the only export-parity check and must be rerun after every source edit.

Adjudication result:

- no active P0 was demonstrated;
- confirmed source contradictions and product-read omissions map to X132–X149 and were corrected or made mandatory pre-read gates;
- the owner decision is now explicit: Monarch `0.3.0` is the release train, Astra V3 is the runtime family, and Astra Skills is a non-authoritative existing component (X131);
- Claude/Qwen feasibility concerns map to measurable staging/benchmark gates (X147/X150), not to deletion of Certifier, integrity identities or recovery contracts before evidence exists;
- Grok was the strongest technical finder in this batch, but its severity, presentation-key, replay and readiness claims were not accepted without exact counterexamples;
- ChatGPT's comparative authority influenced ranking, never replaced local source verification.

This batch is advisory adjudication over post-PASS3 prose, **not a fourth independent pass**. It does not change the frozen PASS 3 verdict and cannot declare current P1=0. The next independent closure object is generated schemas/types/profile instances/fixtures plus benchmark evidence, as already required by §6.

---

### 5.13. Post-PASS3 external advisory batch 2 — machine source, Win32 broker and product lifecycle

Три новых ответа прочитаны полностью and adjudicated against exact local source. Reviewer/model labels are attachment self-identification, not verified vendor provenance; brand never overrides a counterexample.

| Self-identified reviewer | Attachment SHA-256 | Exact size | Coverage |
|---|---|---:|---|
| OpenAI ChatGPT GPT-5.6 Pro | `8500aebc3fa27f2fd1acaec799ca6a768c393a1c5ef4619a393703314e6d1631` | 429 lines / 51,327 bytes | all numbered findings 1–200; primary ranking input per owner preference, independently source-checked |
| Grok Build, xAI | `7f658a9c7c9b8731ad3467c9e45ffac52f6ed7ed8799b0997e83e84bc7c565c9` | 197 lines / 21,860 bytes | all claimed P1/P2 items; quote-first route/storage findings retained, severity and broad conclusions rechecked cautiously |
| Qwen architectural audit | `7c6501bd5b6e78a825c2a8d6abc46d7268bfbd46839488adcbe16b60a667931e` | 194 lines / 40,600 bytes | all sections A–E; complexity/real-hardware/migration-order pressure retained, broad impossibility claims filtered |

Complete disposition:

- **confirmed and source-corrected:** illegal routed trace, codegen circularity, compound evaluator ambiguity, ref-graph bounds, core state/optional-field leakage, ingress privacy/attachments, link/trust wording, exact local-NTFS/Win32 path and enumeration profile, broker-owned completion proof, first-error/cloud/mutation semantics;
- **accepted as mandatory product gates:** package/revocation/deadline/correction, explicit cross-cutting owners, delivery authorization/accessibility, retention/erasure/RPO/RTO, three-option persistence ADR, complexity/hardware/kill budgets;
- **needs generated-artifact review:** all machine definition/compiler/rule-program/schema parity, finite matcher automaton, graph-limit fixtures, broker transcript oracle/resource equations and selected-store fault results;
- **rejected or severity-reduced:** “cryptography is decorative”, “BigInt is unnecessary”, “fail-closed prevents rollout”, “AGPL ideas contaminate architecture”, mandatory duplicate Interaction link owner, and the claim that settled Invocation plus later evidence-integrity Execution failure is contradictory.

Local verification also confirmed that the selected Win32 extended directory record exposes the long name/FileId without the short-name fields of the `BOTH` record; this informed X157 but does not constitute implementation evidence. No runtime code, product store, user root or production Monarch Safe was read or changed.

Result: X151–X166. No active P0 was demonstrated. These are author source corrections after frozen PASS 3, so current status is still **correction candidate, not independently closed**. The next closure object is the exact `ProtocolDefinitionV1` + generated package/rule programs/fixtures and three-candidate real-hardware benchmark, reviewed structurally and semantically by a non-author.

---

### 5.14. Focused correction-patch regression review — not PASS 4

После batch 2 один отдельный read-only reviewer проверил только внесённые correction seams against the current five source documents. Он не редактировал файлы, не запускал runtime/product code и не читал/не перечислял production Monarch Safe. Это обязательная проверка патча, а не четвёртый полный prose pass и не artifact-level closure.

| ID | Confirmed patch regression | Exact correction |
|---|---|---|
| X167 | `resident-memory-limit` использовал отдельный `allocation-admission`, но proof имел rejected flags/equation только для entry/I/O, позволяя ложный flag или недоказанный budget check | все memory-growing allocations привязаны к exact existing entry/I/O/return/terminal checkpoints; rejected flags имеют закрытую per-checkpoint projection |
| X168 | верхняя migration strategy ставила mandatory product foundation раньше Phase 0E persistence decision, хотя later gate требовал обратный порядок | measured additive-V3/sidecar/V4 ADR перенесён перед simulator/seam/foundation sequence; выбранный cohort остаётся после foundation |
| X169 | core follow-up relation `queued-answer` обещал очередь/liveness owner вне allowlisted execution profile | relation стала non-operational `answer-only`; core ничего не queue-ит, product answer row требует отдельный facade ABI |
| X170 | explicit handle-close equation действовала только на completed, а timeout/kill не имел доказательства terminal resource cleanup | one-dispatch broker job получает closed graceful-exit vs forced-job-termination proof; timeout требует armed kill-on-close, Kernel-observed exit, zero post-exit handles and no session reuse |
| X171 | “known non-virtual bus” пропускал iSCSI/другие network/ambiguous device classes | support matrix допускает только `{Ata,Sata,Nvme,Sas,RAID}` and denies every other current/future `STORAGE_BUS_TYPE` literal before Execution |

После исправлений focused reviewer не нашёл нового actionable regression в проверенных canonical-source, manifest/count, event/state, ingress, broker/accounting, trust, migration-order и complexity boundaries. Mechanical source checks оставались `66` unique/sorted schemas with `47+19=66` identity cover, `40` unique event-payload rows and `28` unique claim rows. Это закрывает только X167–X171 на уровне текущего текста. Оно не меняет frozen PASS 3 `FAIL (P0=0,P1=5,P2=1)`, не доказывает generated output semantics и не разрешает shadow/product implementation. Canvas regeneration/parity после exact source freeze остаётся export check, не correctness proof.

---

## 6. Current verdict and allowed next action

```text
DESIGN DIRECTION: STRONG
GENERAL ASTRA V3 / MONARCH 0.3.0 IMPLEMENTATION PLANNING: NO
CORE-READ GENERATED SCHEMA/FIXTURE LAB: YES
ISOLATED PARSER/STORE DURABILITY+LATENCY BENCHMARK: YES
PURE FIXTURE SIMULATOR: AFTER GENERATED PACKAGE
FINAL PROSE PASS ON FROZEN SOURCE: FAIL — P0=0, P1=5, P2=1
POST-PASS3 SOURCE CANDIDATE: CORRECTED, NOT INDEPENDENTLY CLOSED
ANY SHADOW workspace.storage.audit RFC: NO UNTIL ARTIFACT REVIEW + SEPARATE GO/NO-GO
ANY PRODUCT PERSISTENCE LANE / ENFORCING USER VERDICT: NO
CATALOG / PRODUCT FACADE / ENGINE / INCOGNITO / ENCRYPTED / PLUGINS / CHILDREN / JOBS / COMPACTION: UNAVAILABLE
WRITE / DEVICE / COMPUTER USE / EXTERNAL EFFECTS: NO
PRODUCTION MONARCH SAFE ACCESS: NO
CLAIM “KNOWN OPEN P1=0”: WITHDRAWN
```

`CORE-READ GENERATED SCHEMA/FIXTURE LAB: YES` means permission to create and test that isolated artifact, not a claim that it already exists or conforms. The third/last prose pass is complete and failed its frozen candidate; all six findings were source-corrected afterward, but those edits are intentionally **not** labeled independently closed. No fourth prose pass will be used to manufacture a P1=0 claim.

Current schema-lab prerequisites:

1. retain one canonical `ProtocolDefinitionV1`, compile its exact 66-schema JSON Schema 2020-12 + TypeScript + primitive rule-program package and prove one-way definition/output provenance;
2. pin six parser/JCS/schema/digest/identity-binding/state-commit engines, exact transport/ref-graph counters, exhaustive opaque-ID map, numeric limits and cross-language vectors;
3. publish canonical/hash/path/local-NTFS broker/storage/evidence/certificate/presentation fixtures and digests, including independent semantic counterexamples;
4. prove finite matcher automaton/admission→Goal equality, no model/V2/split/attachment/nonpersistent ingress path, broker-owned traversal/exhaustion/resource proof, volume/temporal denial, message-free ProtocolError privacy and byte-stable local-trust certificate retry;
5. compare additive V3, sidecar and V4 durability/latency/resource/backup behavior only on disposable `E:` data and supported real hardware; retain product persistence as blocked unless one least-complex candidate passes ratified thresholds;
6. perform focused independent review by a reviewer who did not create the artifacts, then update this ledger.

Only after those artifacts pass may a separate review decide whether to authorize a shadow RFC. Nothing in this ledger authorizes product code, any persistence lane, live user roots or an enforcing runtime path.

---

## 7. 2026-08-28 live-agent critique disposition and architecture correction

Four reports in `Monarch-agent-reports` were treated as untrusted external critique and checked against current checkout code and stores. Their central conclusion is accepted: current V3 names several V2 truth failures but a one-read schema lab cannot fix routing, local-model ABI, recovery after receipts, composite workflows, context efficiency or broad agent functionality.

Verified current facts:

- the historical store still has 40/78 failed tasks and 23 failures before any tool, but it is a 2026-08-25 checkout snapshot rather than current installed telemetry;
- `сколько у меня папок на диске E` still routes to answer because the current target regex does not match `диске E`;
- `respond` with benign `capabilityId` and `complete` without runtime-owned empty `artifactIds` still fail current parsing;
- current context limits are no longer the old 4000-character ceiling: Balanced is bounded at 32000 chars and Fast targets 3600, so the report's P11 number is historical even though product compaction remains absent;
- current parser already normalizes a bounded plan wrapper and some plan metadata, so the report's P2 must not be read as “no canonicalization exists”;
- the latest complete real-model adaptive artifact is not approved (holdout 95.83%, one wrong effect, −2.08 percentage-point regression, warm p95 10.206 s), and no completed full-task benchmark artifact was found.

Disposition:

- **accepted root problem:** product closure was too narrow and schema-centered;
- **accepted live fixes as V2 compatibility priorities:** lane, decision canonicalization, preflight/runtime-after-receipt recovery, typed completion/workflows, failure mapping and zombie reconciliation;
- **corrected stale claims:** current context ceilings and existing bounded parser normalizations;
- **rejected shortcut:** importing unfinished V3 into product or treating prompt changes as fixes;
- **architecture action:** add normative `MONARCH_ASTRA_V3_AGENT_CORE.md`,
  `astra-core-experience.v1`, P01–P20 and the A01–A35 corpus (A31–A35 added after
  red-team PASS2 for conditional download, steering/cancel/resume and product-lane
  identity); demote read-only closure to substrate; require four capability packs
  plus current-model full-task/fault/efficiency acceptance for Monarch `0.3.0` Astra
  branding.

This is an author correction based on live evidence, not an independent fourth prose pass. Product runtime, persistence, UI verdict and Monarch Safe remain untouched and unauthorized.
