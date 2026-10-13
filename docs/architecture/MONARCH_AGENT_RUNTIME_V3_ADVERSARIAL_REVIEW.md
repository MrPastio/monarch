# Monarch Astra V3 — adversarial review log

Статус: historical internal three-pass review + two external-audit corrections + completed focused core three-pass series; реализации нет. Прежний PASS 3 verdict **superseded**.  
Дата начала: 2026-08-24. Последняя correction: 2026-08-26.  
Объект:

- `MONARCH_AGENT_RUNTIME_V3.md`;
- `MONARCH_AGENT_PROTOCOL_V1.md`;
- `MONARCH_AGENT_RUNTIME_V3_MIGRATION.md`;
- live Turn/Agent/Kernel/store contracts и representative tests.

Первоначальный review и поздняя focused core series выполнялись отдельными read-only агентами максимум в три последовательных прохода каждая; между проходами автор исправлял документы. Focused PASS 3 теперь завершён и остаётся последним prose pass: дальнейшая независимая проверка разрешена только над generated artifacts/fixtures/results, не как четвёртая атака той же прозы. Production Monarch Safe не читается и не перечисляется.

---

## 1. Правила disposition

- `accepted-fixed` — finding принят, normative contract изменён, closure проверяется следующим проходом.
- `accepted-blocker` — finding принят, но оставлен explicit implementation blocker/ADR; architecture не притворяется закрытой.
- `rejected` — допускается только с code/protocol counter-evidence.
- `deferred` — не означает закрыт; нужен owner/release boundary.

P0/P1 не могут быть скрыты в «open question» без решения, если они делают первый implementation RFC небезопасным или логически невозможным.

---

## 2. PASS 1

### 2.1. Verdict

```text
FAIL — not ready for implementation planning
P0: 0
P1: 12
P2: 3
```

Все 15 findings приняты. Ни один не отклонён и не понижен автором.

### 2.2. Findings and dispositions

| ID | Severity | Root cause / counterexample | Disposition | Normative change | Closure gate |
|---|---:|---|---|---|---|
| AR3-P1-01 | P1 | `logicalBytes` как JS/JSON number округляется выше `2^53`; selector/digest доказывает уже искажённое значение | accepted-fixed | `TypedValueV1`, `integer-decimal` canonical base-10 encoding, safe-number denial, bigint target, metric definition digest | `2^53-1`, `2^53`, `2^53+1`, max u64 и worker→journal→certificate→UI round-trip |
| AR3-P1-02 | P1 | pending/approved approval generation 1 после crash невозможно использовать generation 2 | accepted-fixed | approval принадлежит stable invocation authorization revision; activation generation только runner fence; recovery revalidates frozen snapshot | kill pending; kill after approve/before dispatch; lease expiry; exactly one dispatch/new card |
| AR3-P1-03 | P1 | arm/expiry/revoke lifecycle не замкнут, snapshot не содержит сравниваемых policy/goal/scope facts | accepted-fixed | full `ApprovalAuthorizationSnapshot`; `arm-request/issued`, `expired`, `revoked`; one-use server attestation; timer wake | stale goal/schema/policy/scope/principal, arm reuse, expiry/restart, headless job |
| AR3-P1-04 | P1 | recovery использует digest/latest manifest без frozen idempotency/reconciliation body; current ledger generic-fails interrupted action | accepted-fixed + implementation blocker | content-addressed `EffectSemanticsSnapshot`; historical retention; Action Ledger V2/bridge required before first V3 effect | upgrade/manifest removal at every invocation boundary; recovery only from frozen contract |
| AR3-P1-05 | P1 | generic consent ID не связан с provider/terms/data/context; local→cloud swap может exfiltrate context | accepted-fixed | server-owned `ProviderExecutionGrant`; exact per-call `EgressManifest/EgressReceipt`; provider/terms/goal/revoke binding | driver/provider/terms swap, revoke, child/attachment/memory additions, stale resume token |
| AR3-P1-06 | P1 | public envelope позволял client заявить surface/principal/privacy | accepted-fixed | public `AgentClientCommandInput` отделён от server `AcceptedCommandContext`; fingerprint includes attested auth epoch/scope | source/principal/origin spoof, API→Incognito, cross-surface cancel/approval, auth replay |
| AR3-P1-07 | P1 | `verified-observation` от runtime/provider мог закрыть read claim без Kernel evidence authority | accepted-fixed | claim-specific accepted authorities; first slice only Application/Kernel read receipts; provider/child evidence requires admitted chain | fabricated engine observation, wrong authority/input/contract, provider without grant |
| AR3-P1-08 | P1 | decision в той же generation не был связан с context/submit/boundary; buffered pre-steer action мог пройти | accepted-fixed | `NormalizedDecisionEnvelope` with submit/session sequence, exact context/goal/plan/catalog digests and steering/compaction epochs; CAS before prepare | reordered buffered decision around steer/goal/compaction always stale |
| AR3-P1-09 | P1 | terminal `cancelled` одновременно допускал indeterminate effect и запрещал late truth correction | accepted-fixed | `cancellation-pending -> reconciling -> blocked-indeterminate`; nonterminal visible recovery case; cancelled only when no unknown dispatch | non-cooperative effect, late receipt, unsupported reconcile, cancel+restart |
| AR3-P1-10 | P1 | Incognito обещал memory-only task и одновременно durable effect recovery/ledger residue | accepted-fixed | V3 Incognito foundation строго answer + bounded local reads; no mutation/external egress; explicit new persistent Interaction required | incognito write/external denied; state-root scan shows no effect record/payload; read remains ephemeral |
| AR3-P1-11 | P1 | migration обещала глобальный zero duplicate external effect при честно признанном indeterminate | accepted-fixed | gate заменён на один admitted Monarch Kernel dispatch attempt; no second dispatch after ambiguity; provider retry only with idempotency protocol | fault proxy after remote commit/before response; separate Monarch/provider attempt counters |
| AR3-P1-12 | P1 | `disposition.ts` мог выбрать answer до Goal Compiler — второй semantic owner | accepted-fixed | shared `InteractionIntentAdmission` and matcher candidate set consumed by disposition + Goal Compiler; unknown operational → Execution/clarify/block | ordinary Desktop/API RU/EN paraphrase, negation, multi-clause and unknown-operational corpus |
| AR3-P2-01 | P2 | certificate хранил digest без replayable typed value/ref; crash+GC ломал presentation | accepted-fixed | canonical bounded value inline or immutable protected ref + retention pin; deterministic body separate from envelope | kill/GC between certificate and message reproduces exact response without tool rerun |
| AR3-P2-02 | P2 | child evidence не выражалось GoalClaim; creation-time parent revision делала concurrent delivery stale | accepted-fixed | `DelegatedClaimBinding`, lineage/claim/child certificate/inbox/aggregation binding; consume current revision + delivery-ID dedupe | unrelated child rejected; two concurrent children; crash apply-before-ack |
| AR3-P2-03 | P2 | terminal saga не имела formal receiver inbox/apply/ack contract | accepted-fixed | stable AggregateDelivery, source sequence/fingerprint, atomic receiver inbox + outcome row/message outbox, idempotent ack | fault at sender commit/send/receiver apply/ack/message persistence boundaries |

### 2.3. Additional contradictions closed during PASS 1 revision

1. Engine descriptor now advertises `cancellationAcknowledgement`; `cancel()` returns typed receipt.
2. Historical rule limited determinism to assessment body. Second external correction superseded it: certificate ID/time are created once under a dedicated key and retries return the byte-identical stored envelope.
3. Historical revision made `partial` explicit through `allowPartial`; external correction later replaced that global boolean with per-requirement `partialPolicy` + overall Goal gate so model/follow-up cannot weaken it.
4. Compaction chose one rule: strict revision/source-digest fence; concurrent semantic change supersedes result.
5. One physical aggregate appender now owns event IDs/sequence/revision; producer is provenance only.
6. Multi-event commit revision semantics are fixed: one revision per command commit, contiguous event sequences with commit index/size.

### 2.4. Strengths explicitly preserved

- Kernel/Application-only effect authority.
- Model completion and presentation are not completion truth.
- Exact capability/input/selector/freshness binding and no-substitution.
- Interaction/Execution aggregates linked by durable outbox/inbox, not big-bang merge.
- Journal-first V4 only after shadow/cutover; no dual authoritative writes.
- Legacy data readable; active task never migrates mid-flight.
- Safe non-discovery/encrypted answer-only; no production Safe traversal.
- Driver SDK types do not become persisted ABI.
- Raw evidence survives compaction.
- Fault/packaged/installed/rollback evidence remains release-gated.
- Child authority only narrows; approval is not inherited.

### 2.5. PASS 1 readiness after author revision

Не заявляется. Все findings имеют `accepted-fixed`, но считаются закрытыми только если независимый PASS 2 не найдёт internal contradiction или missing field/state в revised contracts.

---

## 3. PASS 2

### 3.1. Verdict

```text
FAIL — not ready for implementation planning
P0: 0
P1: 6
P2: 2
PASS 1 closure: CLOSED 10 / PARTIAL 5 / OPEN 0
```

Все восемь PASS 2 findings приняты; ни один не отклонён.

### 3.2. Findings and dispositions

| ID | Severity | Root cause | Disposition | Normative change | Closure gate |
|---|---:|---|---|---|---|
| PASS2-P1-01 | P1 | Lossless `logicalBytes` не доказывал point-in-time truth при concurrent mutations; legacy всегда писал `mutationsObserved=0` | accepted-fixed | storage measurement разделён на traversal coverage и temporal consistency; interval observation никогда не current snapshot; snapshot/stable proof formalized | concurrent create/truncate/rename/delete/hardlink → snapshot/stable proof либо interval/partial/stale, без fake current total |
| PASS2-P1-02 | P1 | Pre-send EgressReceipt называл разрешение фактом transmission; revoke/partial/crash не выражались | accepted-fixed | `EgressAdmissionPermit` отделён от `EgressAttempt`; send-start CAS/revoke linearization; outcomes not-started/started/completed/failed/unknown; provider ack separate | crash before first byte, revoke race, partial stream, transport failure/unknown, retry |
| PASS2-P1-03 | P1 | `blocked-indeterminate` не имел outgoing transitions/commands/retention; вечные sensitive pins | accepted-fixed | formal RecoveryCase commands/state machine, late correction delivery, permanently-unknown, orthogonal acknowledge/archive, full-evidence deadline + no-auto-GC tombstone + quotas | unsupported reconcile, late receipt after restart/archive, retention expiry, repeated wake, storage-pressure attack |
| PASS2-P1-04 | P1 | Incognito read мог оставить durable Evidence/receipt/certificate/ref/log residue | accepted-fixed | one `IncognitoStorageProfileV1` injected into every journal/evidence/receipt/cert/artifact/context/cache/log port; no-persist capability gate | local read + renderer failure/cancel/crash/shutdown, full permitted state/log-root residue scan |
| PASS2-P1-05 | P1 | Intent candidate digest не имел persisted body/ABI; crash+matcher upgrade возвращал raw reparse | accepted-fixed | full `InteractionIntentAdmissionV1` schema/body/ref, input/context fingerprint, registry/body refs, clauses/negation/targets/candidates/route, retention; disposition/Goal only consume admission | crash/upgrade before Execution; byte-identical candidates, V3 raw parsers unreachable |
| PASS2-P1-06 | P1 | Approval API требовал pending и armed одновременно; no-arm approve/deny deadlock | accepted-fixed | Approval remains pending until resolve; ArmAttestation separate entity; no-arm approve, pending deny, atomic arm consume, independent expiry/revoke | no-arm approve, pending/armed-equivalent deny, arm consume/reuse, expiry/revoke/crash/headless denial |
| PASS2-P2-01 | P2 | Arbitrary integer encoding был искусственно ограничен max u64 | accepted-fixed | upper bound removed; optional range predicate; arbitrary-precision sum | max u64, max u64+1, sum beyond operand bound |
| PASS2-P2-02 | P2 | Replay мог применить prefix multi-event commit | accepted-fixed | commit ID/digest/index/size; full group buffering/checksum before projection; corrupt tail quarantined after prior verified commit | truncate/kill every byte boundary, missing middle/tail, inconsistent group, exact duplicate group |

### 3.3. PASS 1 closure carried forward

- CLOSED in PASS 2 and preserved: P1-01, P1-02, P1-04, P1-06, P1-07, P1-08, P1-11, P2-01, P2-02, P2-03.
- PARTIAL findings P1-03, P1-05, P1-09, P1-10, P1-12 are addressed by PASS2-P1-06, P1-02, P1-03, P1-04 and P1-05 revisions respectively.
- `EgressReceipt` terminology removed from normative contract; permit is not transmission truth.
- Exact integer is now arbitrary precision, while temporal truth is a separate required claim axis.

### 3.4. Readiness after author revision

Не заявляется до final PASS 3. PASS 3 должен искать только незакрытые blocker contradictions/regressions в fixed object, а не расширять architecture scope.

---

## 4. PASS 3

### 4.1. Historical independent verdict (superseded)

PASS 3 выполнил тот же независимый read-only reviewer после полной авторской коррекции PASS 2. Он перечитал все четыре architecture/review документа полностью, точечно сверил representative live baseline, не менял файлы, не запускал тесты и не читал/не перечислял Production Monarch Safe.

```text
HISTORICAL VERDICT: READY FOR IMPLEMENTATION PLANNING
P0: 0
P1: 0
P2: 4 open ADR/schema gaps at review time
PASS 2 closure: CLOSED 8 / PARTIAL 0 / OPEN 0
```

Reviewer отдельно подтвердил, что четыре P2 не восстанавливают прежние P1 failure traces: false current-total, unauthorized egress, dead RecoveryCase и approval deadlock нормативно запрещены.

### 4.2. PASS 3 findings and final dispositions

| ID | Severity | Найденный разрыв | Disposition после review | Normative correction | Mandatory conformance gate |
|---|---:|---|---|---|---|
| PASS3-P2-01 | P2 | Runtime объявлял raw `/audit/logicalBytes` string, Protocol — `TypedValueV1` внутри capability output | superseded-owner-correction | единственный capability ABI — canonical decimal string; Projector валидирует raw/proof и выводит derived facts, а Certifier один создаёт TypedValue claim binding; один `outputSchemaDigest` | shared raw JSON fixture через capability → selector → receipt → evidence → certificate → renderer; capability/Evidence wrapper and Projector-owned wrap reject |
| PASS3-P2-02 | P2 | explicit interval + detected mutation допускал два terminal verdict | accepted-fixed-post-review | complete explicit interval certifies only exact observed-window sum даже при detected mutation, с обязательным non-snapshot/mutation disclosure; current/stable с тем же receipt только partial/blocked | одна decision-table fixture suite для Goal Compiler, Certifier и deterministic renderer |
| PASS3-P2-03 | P2 | Runtime state `resolved-on-late-receipt` отсутствовал в Protocol enum; обещанный erasure command не имел ABI | accepted-fixed-post-review | canonical state только `resolved`, discriminator `resolution.kind='late-receipt'` + exact evidence ref/digest; `recovery.erase-data` explicitly unsupported in V1 | permanent-unknown → archive → restart → late receipt; tombstone сохраняет binding, old row получает correction, не rewrite |
| PASS3-P2-04 | P2 | ArmAttestation был логическим понятием без durable entity/CAS ABI; оставалось слово armed как Approval state | accepted-fixed-post-review | `ArmAttestationV1` получил bindings/timestamps/state/revision; Approval и Arm — child entities одного Execution aggregate; outer + entity CAS; atomic consume+approve | concurrent approve, expiry/revoke vs consume, crash after issue, auth-epoch change, pending deny without arm |

`accepted-fixed-post-review` означает: finding принят без спора и исправлен в normative docs после последнего независимого прохода. Это не притворяется четвёртой независимой проверкой; его closure доказывается обязательными fixtures первого соответствующего RFC.

### 4.3. PASS 2 closure matrix

| PASS 2 ID | PASS 3 result | Сохранённая гарантия |
|---|---|---|
| PASS2-P1-01 | CLOSED | coverage и temporal consistency независимы; current total без snapshot/fence запрещён |
| PASS2-P1-02 | CLOSED | EgressAdmissionPermit не transmission truth; EgressAttempt имеет send-start/revoke/outcome |
| PASS2-P1-03 | CLOSED | RecoveryCase имеет выходы, late correction, bounded full evidence и no-auto-GC tombstone |
| PASS2-P1-04 | CLOSED | IncognitoStorageProfile охватывает все persistence/log/cache ports |
| PASS2-P1-05 | CLOSED | persisted InteractionIntentAdmission — единственный candidate set, raw reparse после crash запрещён |
| PASS2-P1-06 | CLOSED | Approval остаётся pending до resolution; arm отдельный; no-arm approve и pending deny определены |
| PASS2-P2-01 | CLOSED | integer-decimal arbitrary precision, искусственного u64 ceiling нет |
| PASS2-P2-02 | CLOSED | replay применяет только полную проверенную multi-event commit group |

### 4.4. Regression verdict and boundary

PASS 3 сохранил ключевые PASS 1 invariants: только Application/Kernel исполняет effects; model/presentation не создают completion truth; public client не attest-ит principal/surface/privacy; approval authorization не равен runner generation; effect semantics frozen; external exactly-once не обещается; Decision связан с context/steering envelope; Incognito не оставляет durable read residue; child authority только сужается; terminal cross-aggregate delivery идемпотентна; migration не создаёт dual authoritative writes; legacy data остаются readable; Safe boundary не ослаблена.

Исторический PASS 3 status, позднее опровергнутый внешними аудитами:

```text
SUPERSEDED — NOT CURRENT
historical known open P0 blockers: 0
historical claimed open P1 blockers: 0 (not independently proven after later edits)
PASS 3 P2 ambiguities: 4 accepted and normatively corrected after review
production implementation/cutover authorization: NO
```

Это был третий и последний проход **первоначального** reviewer. После него автор внёс четыре normative edits, а четыре внешних ответа нашли незакрытые P1 ABI/semantic gaps. Поэтому запрет «четвёртого прохода» отменён как критерий качества: новый полный бесконечный аудит не нужен, но focused independent regression review изменённых schemas/fixtures обязателен до enforcing implementation.

---

## 5. First external audit correction — 2026-08-24 (historical, superseded by §6)

Полный evidence/disposition ledger: `MONARCH_AGENT_RUNTIME_V3_EXTERNAL_AUDIT_DISPOSITION.md`.

Проверены четыре независимых ответа: Grok Build, ChatGPT 5.6 Pro, Qwen3.8 и сравнительный ChatGPT 5.6 Pro. Последний ответ использован как приоритетный adjudicator по явному указанию пользователя, но каждое принятое замечание дополнительно сверено с source docs и representative live Monarch baseline. Grok принят только там, где есть exact counterexample; Qwen отфильтрован от повторов/preferences/уже закрытых пунктов.

Verdict at that time:

```text
ARCHITECTURE DRAFT — NOT READY FOR GENERAL IMPLEMENTATION PLANNING
previous P1=0: withdrawn
allowed next step: schema closure + one disposable shadow-only workspace.storage.audit RFC
production V4/enforcing terminal/effects/provider egress: forbidden
focused independent regression review after final schemas/fixtures: mandatory
```

Confirmed root gaps corrected in normative docs: canonical/hash/path profile; compileable core ABI; admission-bound Goal/follow-up; mixed-clause cohort; model non-weakening; Invocation/delivery convergence; multiple Execution links; evidence graph/selection/assessment fence/atomic idempotent certificate; certified presentation boundary; policy-relative storage scope/temporal proof/default intent; legacy mapping; finite waits/wake reasons; effect/provider/protected-ref blockers.

Это document-only closure, не executable proof. Ни один finding не считается implementation-closed до generated schemas, fixtures, fault tests и focused independent regression review.

---

## 6. Second external audit correction — 2026-08-26

Полностью прочитаны ещё четыре attachments: Grok 1–240, Claude CL-01–CL-19, Qwen 1–180 и ChatGPT 1–100. Exact hashes/range-by-range disposition находятся в external ledger. По указанию пользователя ChatGPT использован как приоритетный adjudication input, Grok — осторожно; local source remained decisive.

Second batch доказал, что первый correction всё ещё смешивал закрытие core и будущих features. Поэтому:

- V3 разделён на один closure target `agent-core-read.v1` и unavailable extension profiles;
- ручные ABI mirrors удаляются/заменяются generated package, а first manifest стал exact schema allowlist;
- core не имеет model/V2/split/Engine/Approval/provider/Incognito/encrypted/plugin/child/job/compaction variants;
- Interaction стал row-oriented; answer-only не имеет Execution/certificate;
- read dispatch имеет одного будущего store owner; effect atomicity оставлена blocker, не обещание 2PC;
- generic subset/compatibility/workflow mapping removed;
- Evidence snapshot commits body digests, assessment fence получил refs/selector/time, certification key/domain and retry-stable envelope;
- storage coverage enum replaced by raw walker disposition + Kernel accounting proof + projector-derived walk verdict; finish volume/temporal guards/protected pre-enumeration and exact integer path closed in prose schema;
- historical review state: release version was unassigned; owner decision on 2026-08-26 later fixed Monarch `0.3.0`, while backend/latency benchmark still precedes product journal ABI;
- text-only broad audit cycle ends; next independence gate requires exact generated artifacts/results.

Historical claims that Incognito port coverage, optional split, generic legacy mapping, `complete-relative-to-policy`, random certificate envelope and broad Protocol V1 were “closed” are no longer current. Their replacement is profile separation or an explicit unavailable blocker.

```text
CURRENT STATUS: CONVERGENCE DRAFT — CORE SCHEMA LAB ONLY
GENERAL IMPLEMENTATION PLANNING: NO
ALLOWED: generated manifest/schemas/types/fixtures + isolated parser/store benchmark
SHADOW: NO until artifact review and separate go/no-go
PRODUCT V4 / USER V3 VERIFIED / EFFECTS / PROVIDER / PRIVACY EXTENSIONS: NO
NEXT INDEPENDENT REVIEW: generated artifacts, hashes, fixtures, benchmark/test output and source diff
```

Это по-прежнему document-only architecture correction. Даже accepted-fixed finding не является runtime proof.

---

## 7. Focused independent core regression — 2026-08-26

После second-batch correction новый независимый read-only agent получил exact current Runtime/Protocol/Migration/disposition sources, не создавал их и не имел write task. Это отдельная серия, не «PASS 4» исторического reviewer.

### 7.1. PASS 1 verdict before corrections

```text
P0: 0
P1: 9
P2: 4
CONFORMANT SCHEMA LAB: NO
SIMULATOR/SHADOW: NO
```

PASS 1 подтвердил: unlisted authority refs; accidental Catalog/Activation/Decision dependency; incomplete closed event map; missing durable result ref; pre-conversion numeric aliasing; undefined path identity digest; missing set canonicalization; impossible JSON-Schema sibling-time claim; Phase 1 product-facade leak. P2 covered follow-up CAS/ownership wording, duplicate raw-goal ownership, unbounded dedupe tombstone pressure and stale generated canvas.

### 7.2. Author corrections

- compiler pseudo-contract removed in favor of the exact allowlisted matcher ref/body plus distinct `raw-sha256` implementation hash;
- core Catalog/Activation/Plan/Decision/Product Facade explicitly unavailable;
- event schema binds exact payload, producer and stream; Invocation creation/positive/negative transitions form a closed one-of;
- completed Kernel receipt owns resolvable result/accounting refs, while failed/cancelled/unknown forbid invented output; rejected output has a terminal integrity branch;
- raw numeric token admission precedes IEEE conversion and includes underflow/fraction/overflow counterexamples;
- Windows path identity hashes one exact handle-derived identity body, not display spelling/time;
- every authority/presentation/assessment set has explicit sort/duplicate rules;
- pinned Certifier comparator, not JSON Schema, owns cross-field time order;
- Phase 1 is gated behind a separate unavailable `agent-product-facade.v1` manifest/backend/go-no-go;
- accepted-command store is sole raw message owner; product dedupe capacity/pressure is a hard future gate.

These are source corrections only. PASS 1 cannot validate edits made because of PASS 1. A new blind PASS 2 must inspect the regenerated exact source object. PASS 3 is conditional on a new P1/regression and remains the maximum third pass requested by the user.

---

## 8. Focused independent core regression PASS 2 — 2026-08-26

PASS 2 был выполнен тем же read-only independent task только над новым frozen object; reviewer не редактировал source и не читал/не перечислял production Monarch Safe. Frozen normative hashes:

```text
Protocol  8d38010afe1798debc208cd0dc1b290c6aee79e30f9bec136547d97900d6ed1c
Runtime   5558831b42ea02c3d1b6891bf620b7cdf1db8936caac86c50d90a3ce9b44cde6
Migration 4a250d26b941498fc96279e502f6e3dc1c6d7b8df26e4f23ae642f8631c84c29
Disposition 8cfd951b9e6acf6a785ca07028214bc52cd09c02fd24cf9098c1d71c292df8c8
Review    2ab40d91aadd39fc9f089252cbb6b9e923fe8b1eda2993b1cfb51a5c806ac68b
Canvas    774e529be61b133b0c87cf650bf72d0202a1ff4ba76d8d3b1502dc5a22832ec9
```

Canvas на том объекте был byte-verbatim `5/5`, 454667 bytes; это доказывало export parity, не correctness.

### 8.1. PASS 2 verdict before corrections

```text
FAIL — source architecture not closed for a conformant schema package
P0: 0
P1: 8
P2: 5
```

| ID | Severity | Confirmed counterexample | Disposition after source check |
|---|---:|---|---|
| F2-P1-01 | P1 | matcher body/ref was self-referential or required an unlisted authority body | accepted-fixed: finite descriptor + allowlisted pure matcher result and checked result→Admission sealing |
| F2-P1-02 | P1 | digest/ref manifest could not express cross-schema results and path/scope identities | accepted-fixed: source/result endpoints, content-identity rules, scope/path bodies/domains and schema bootstrap agreement |
| F2-P1-03 | P1 | event type could mismatch payload/producer/stream and post-dispatch terminal could omit receipt | accepted-fixed: closed event/commit projections, exact variant/state/commit rules and receipt-discriminated terminals |
| F2-P1-04 | P1 | Runtime/Migration imported unavailable Activation/Engine/DAG into core | accepted-fixed: direct host, one Invocation/node, no edge/retry/lease/Engine/product-store claim |
| F2-P1-05 | P1 | minimum and Goal could agree on a wider feature/capability/target/scope than Admission | accepted-fixed: GoalAdmissionBinding relation covers accepted→narrowed scope, target/input/policy/budget/temporal/partial/claims |
| F2-P1-06 | P1 | assessment snapshot retained Evidence IDs/digests but not resolvable body refs | accepted-fixed: singleton graph/selection/assessment tuples retain node/Invocation refs+digests |
| F2-P1-07 | P1 | current/stable request could reach interval Execution and certified partial | accepted-fixed: temporal meaning persisted before Goal; only explicit interval is executable |
| F2-P1-08 | P1 | view/result could change certificate status/fields/artifacts | accepted-fixed: certificate→view→result projection relations, frozen locale/contract and exact empty artifact tuples |
| F2-P2-01 | P2 | Runtime wording still implied a second raw Goal owner | accepted-fixed: accepted-command/Interaction only; Goal retains refs/digests |
| F2-P2-02 | P2 | top-level migration order contradicted detailed facade/simulator gates | accepted-fixed: parser/schema/artifact review precede simulator and any optional product facade |
| F2-P2-03 | P2 | 26 Crockford digits admitted noncanonical 130-bit aliases | accepted-fixed: first digit `0..7`, canonical 128-bit fixtures |
| F2-P2-04 | P2 | `completion.certified` provenance was assigned to pure Certifier despite Application-created envelope | accepted-fixed: Application owns certification/terminal commit; Certifier owns only deterministic assessment |
| F2-P2-05 | P2 | future Incognito prose leaked eligibility into unavailable core | accepted-fixed/fenced: operational Incognito remains a separate unavailable profile |

### 8.2. Additional author corrections exposed while closing PASS 2

- schema documents now have an exact instance/json-schema/opaque-byte ref algebra, schema ID/version/meta-schema agreement and non-recursive implementation identity boundary;
- generic command/event/commit TypeScript helpers cannot become permissive generated schemas; command receipts and terminal branches are structural unions;
- pure matcher output is separated from random IDs/time/store refs/handle resolution, with one machine-checked ordinal sealing relation;
- persisted admission now owns explicit temporal and partial intent, while capability owns the exact required claim-template set;
- walker implementation is pinned by the capability contract rather than self-declared in proof;
- Evidence source timestamps, accounting/clock bindings and fixed Safe non-count disclosure are exact; production Safe remains outside every fixture;
- core object-valued TypedValue is only the allowlisted fixed storage exclusion summary; artifact/protected branches remain absent;
- Interaction core lifecycle, future Scheduler/Recovery sections and schema-lab dispatch/store claims were re-fenced.

### 8.3. Status after author corrections

PASS 2 findings are source-corrected but not independently closed by their own author edits. Because PASS 2 found new P1 regressions, the user-authorized third and final blind prose pass is mandatory over a newly frozen source+canvas object. There will be no fourth prose pass: any post-PASS3 correction remains an explicit generated-schema/fixture closure gate.

### 8.4. Additional strict closure before the PASS 3 freeze

While resolving the PASS 2 counterexamples, local cross-document checks exposed thirty-seven adjacent gaps that were not credited to the reviewer and therefore remain separately traceable:

1. state/commit guard names lacked one pinned callback-free finite evaluator boundary;
2. content identity had to be separated from digest-field occurrences, including inline schemas with no result field and an exact 67-schema domain cover;
3. accepted command replay had to retain the original RuntimeFeatureSet→capability/matcher/policy/recipe/presentation chain across package/locale/auth changes, with no impossible compacted-receipt branch;
4. diagnostic and attachment refs needed exact opaque purpose/classification rules and resolver-side authority checks;
5. the storage capability needed one fixed 28-claim private suite and exact 28-allowed/16-required presentation-key contract;
6. CompletionDenial and AgentProtocolError needed closed semantic expansion tables rather than independent enum cross-products;
7. completed/incomplete storage proof needed exact output/proof `abortReason` agreement independent of diagnostic bytes;
8. completion request, assessment and certificate needed one frozen assessment time/attestation plus one `completionCommitCommandId` across retry; terminal event observability time cannot affect verdict;
9. a command receipt could not honestly carry `acceptedAt`/fingerprint/command IDs while also representing failures before accepted context existed, so the durable ABI had to become accepted-only with direct ProtocolError pre-admission/conflict responses;
10. partial observed values and `requireCompleteObservation=true` needed an explicit extraction-versus-satisfaction rule so a useful partial field could never masquerade as a verified claim;
11. request-freeze and terminal assessment needed distinct command IDs so one idempotency key could not name two different commits; every other core event branch also needed mandatory command ownership;
12. accepted receipt needed a mechanical all-or-none projection to its exact singleton first Interaction commit, otherwise event/revision/time fields could name unrelated durable facts;
13. one global data-bearing template made a legitimate blocked certificate with no claim values unrenderable, requiring verdict-specific templates and a complete closed denial-message map;
14. accepted RuntimeFeatureSet pinned execution semantics but not the Completion Certifier/terminal policy, permitting a package upgrade to change verdict policy before assessment;
15. an in-memory schema fixture simultaneously promised result-object `fsync`, conflating ordering/resolvability proof with an unselected product backend's durability guarantee;
16. “crash” needed to mean a deterministic simulator cut, not evidence that a real process/filesystem/database survived kill or power loss;
17. `command.lookup` was ghost ABI outside the exact submit/follow-up manifest and had to become ordinary exact-command retry semantics;
18. follow-up relation/reason/target fields needed a closed union to reject impossible combinations and prevent a user-cited foreign Execution ID from becoming authority;
19. selector `valueType` and `canonicalEncoding` were independent unions and needed a six-row oneOf plus exact TypedValue conversion semantics;
20. executable hashes outside the five generic engines needed dependency-complete loaded artifact boundaries rather than implicit package/file identity;
21. public `protected-boundary` ProtocolError contradicted the generic deny-before-enumeration privacy invariant and had to collapse into ordinary `path-ineligible`;
22. globally optional diagnostic refs could still distinguish the protected case, so diagnostic presence needed an exact per-error policy with all path/auth/policy rows forbidden;
23. `not-found` needed authorization-before-existence semantics to avoid an aggregate-ID enumeration oracle;
24. stream sequence/revision genesis needed exact 1-based stored counters and zero-based commit indices to prevent store/digest divergence;
25. `event-commit` used an anonymous non-schema array and `stream-prefix` depended on ghost snapshot ABI, requiring one allowlisted commit-group body and removal of rolling prefix from core.
26. schema-lab accepted-receipt wording conflated in-memory atomic retained state with real process/filesystem/power-loss durability, requiring an explicit product-backend fault gate before receipt exposure.
27. opaque raw-byte identity used a schema-looking `monarch.*` version literal outside the exact manifest, requiring a clearly non-schema digest-version literal.
28. every event carried `payloadDigest`, but the registered `event-payload` domain had no exact 40-variant manifest source/result rules.
29. terminal assessment/certificate recovery had only an assessment-input digest, forcing an unmanifested digest lookup or ambient stream search instead of one retained ref+digest chain.
30. substituted denial/value bytes could be reparsed as template or Markdown/HTML content unless renderer tokenization and output semantics were explicitly one-pass plain text.
31. digest-rule source pointers did not explicitly determine the digest header's schema-version argument, leaving nested payload hashing implementation-dependent.
32. a receiptless `internal-error` from `running` could terminalize after dispatch and strand an active/unknown Invocation; terminal failure needed exact lifecycle fences.
33. a standalone noncertified block from queued/running could strand Invocation or turn post-dispatch budget exhaustion into a false terminal without its typed Goal/Invocation prefix.
34. server-only installation-generation rollover could reinterpret an old client retry as a new-scope command because the public request carried no generation fence.
35. pre-admission dedupe/receipt capacity failure promised a closed ProtocolError but had no legal exact error row.
36. two legal partial-evidence denial rows lacked a deterministic admitted-partial versus forbidden-partial selection rule.
37. runtime resource limits were needed to parse their own profile, leaving a pre-profile allocation/bootstrap cycle.

These are author corrections, not PASS 2 closure. They are recorded as X93–X129 in the external ledger and are explicit adversarial targets for PASS 3.

---

## 9. Focused independent core regression PASS 3 — final prose pass

PASS 3 was read-only, received the complete frozen six-file source/export object and did not edit it or inspect/list production Monarch Safe. Frozen hashes:

```text
Protocol    687dca80f29e00714fa109ffdbfe5c337ea22cc49fb7c3b132f95ab27c2cce6e
Runtime     6f49a782d75d820d6b46f825cbea7265d56f331b6b05ed2262a84d8328107a96
Migration   9afec3cd66b6058402337354083041034753169c2da4186cb3744fd2117c6f32
Disposition 197f2d4e8ae49078726deaa8e0cd4d5e96d9a28533339bf430500c13e6b1e9ff
Review      3bc8d00e4c0fd700d035e151b8290cc226a606a2d52c7c928c0fc6c01f5f782d
Canvas      b71542f70438bd160a6afc77407e243aae6f8a6db5cab8a0e578be17c5712a54
```

Canvas parity was `5/5`, 615539 bytes. That is export evidence only. Verdict on the frozen object:

```text
FAIL — source architecture not closed for a conformant schema-lab artifact
P0: 0
P1: 5
P2: 1
```

### 9.1. Confirmed findings

| ID | Severity | Frozen-source failure | Disposition after exact source verification |
|---|---:|---|---|
| PASS3-P1-01 | P1 | an operational candidate could cite a negated/prohibited/target-ambiguous clause or carry arbitrary ambiguity and still project to Execution | confirmed; reopens X88; post-PASS3 source adds one closed candidate-legality matrix across pure result, Admission and Goal binding |
| PASS3-P1-02 | P1 | completed accounting proof did not prove depth/path/time/I/O ceilings or effective cancellation cadence/check coverage | confirmed; reopens X89; post-PASS3 source adds observed facts, exact check equations, terminal markers, nonzero cadence and typed limit witness |
| PASS3-P1-03 | P1 | transport counting left total/per-object, root depth, duplicate refs, schema closure and manifest/capability profile equality ambiguous | confirmed; reopens X129; post-PASS3 source fixes every counter and one retained-profile identity |
| PASS3-P1-04 | P1 | free-form public `AgentProtocolErrorV1.message` could disclose a Safe path despite closed code/diagnostic rows | confirmed; reopens X113; post-PASS3 source removes server-authored message/path/cause and permits only cause-independent local rendering |
| PASS3-P1-05 | P1 | opaque IDs remained bare strings without an exact schema/variant/path application map | confirmed; new X130; post-PASS3 source requires a retained exhaustive field map and independent expanded-endpoint set equality |
| PASS3-P2-01 | P2 | Execution prose diagram retained `queued -> blocked` although the exact state/guard table rejected it | confirmed; reopens X125; stale edge removed |

### 9.2. Regression matrix and final pass boundary

PASS 3 evaluated X93–X129 explicitly. Every row passed except X113 (`FAIL/P1`), X125 (`FAIL/P2`) and X129 (`FAIL/P1`). Its broader attack reopened X88/X89 and created X130. Deferred backend/shadow/effect/provider/Safe gates were correctly treated as unavailable boundaries, not active core defects.

All six findings above were source-corrected after the frozen review. Those edits are author corrections, not independent PASS 3 closure. The user capped this series at three independent passes, so **PASS 3 is final and there will be no fourth prose pass**. The truthful current status is therefore:

```text
known P0 in the frozen PASS 3 source: 0
frozen PASS 3 verdict: FAIL (P1=5, P2=1)
post-PASS3 source: correction candidate, not independently closed
allowed next evidence: generated schemas/types/profile instances/ID map/fixtures + isolated benchmark
schema-lab conformance claim: NO until artifact-level independent review
shadow/product/runtime authorization: NO
```

---

## 10. Post-PASS3 external advisory adjudication — not PASS 4

После final PASS 3 owner supplied five additional audits self-identified as Claude Sonnet 5, Qwen3.7, Grok Build and two GPT-5.6 Pro reviews. They were source-checked and normalized into X131–X150 in `MONARCH_AGENT_RUNTIME_V3_EXTERNAL_AUDIT_DISPOSITION.md` §5.12.

The strongest confirmed corrections were: one Certifier-owned `TypedValueV1` boundary; explicit interval/metric semantics for the flagship read request; one clock literal; in-flight time-limit accounting; atomic Goal→prepared core progress; mandatory product continuation/package/revocation/outbox/recovery foundations; object-alias protection; deterministic cloud/reparse precedence; cross-boot reassessment; no blocked scalar leakage; correct BOM/U+FEFF parsing; flattened closed-union codegen; migration decomposition and product lifecycle gates.

This review also records the owner naming decision: the target release train is Monarch `0.3.0`, the runtime family is Astra V3, and the pre-existing module is Astra Skills `0.1.0` with no runtime authority. Version assignment is not a readiness claim.

No fourth prose pass was created. The frozen PASS 3 verdict remains `FAIL (P0=0, P1=5, P2=1)` and post-review edits remain a correction candidate. Independent closure now moves to generated artifacts, concrete fixtures, supported-platform benchmarks and a reviewer who did not author them.

---

## 11. Post-PASS3 advisory batch 2 — machine source, broker proof and migration pressure

Three further attachment audits (self-identified GPT-5.6 Pro, Grok Build and Qwen) were read in full and mapped to X151–X166. This is advisory intake, **not PASS 4**. GPT was used as the first ranking queue per owner instruction, Grok was treated cautiously, and every accepted point still required an exact local counterexample.

Confirmed source corrections:

- impossible `interaction.routed(agent, …)` trace replaced with its closed payload;
- one canonical `ProtocolDefinitionV1` becomes the only codegen input under a small bootstrap trust root;
- compound relations compile to finite primitive programs split across identity-binding and state-commit engines; runtime ref graphs gain depth/object/edge/byte ceilings;
- core removes `queued`, optional parent/condition/freshness leakage, nonempty attachments and nonpersistent privacy admission; Goal revision is literal `1` and decimal facts are nonnegative;
- Interaction↔Execution link and local trusted-writer certificate semantics each have one explicit owner;
- storage support is narrowed to a direct local fixed NTFS non-reparse directory, pinned to long-name `FILE_ID_EXTD_DIR_INFO` enumeration and exact path/name rules;
- a separate supervised filesystem broker owns observations, iterator exhaustion and I/O/resource accounting; first error/cloud placeholder aborts immediately and live mutation is only an interval observation;
- product design gains package quarantine/revocation at every lifecycle fence, start-by/deadline, certificate correction/user notice, explicit cross-cutting owners, delivery reauthorization, retention/erasure/RPO/RTO and accessibility fallback;
- migration compares additive V3, sidecar and V4, inserts a no-behavior-change AgentLoop seam after the pure simulator, and adds quantitative complexity/hardware kill gates.

Rejected/reduced claims remain explicit: deterministic digests are not “decorative” within the trusted-writer model; exact BigInt byte totals are necessary; fail-closed profiles do not prohibit incremental rollout; AGPL creates a provenance/legal boundary rather than proven idea contamination; and a settled port output may consistently lead to a later evidence-integrity Execution failure.

No runtime/product/Safe change was made by this adjudication. The source now contains author corrections only. Closure requires the exact machine definition, generated schemas/programs/fixtures, independent semantic counterexamples and the measured three-candidate persistence report; byte-verbatim Canvas parity still cannot establish correctness.

---

## 12. Focused correction-patch regression review — not PASS 4

Один independent read-only reviewer проверил текущие correction seams, не изменяя source и не касаясь runtime/product/production Monarch Safe. Он подтвердил пять новых локальных regressions и после их исправления не нашёл другого actionable regression в заданном patch scope:

1. resident-memory refusal был отвязан от exact entry/I/O/return/terminal check accounting;
2. summary migration order ставил mandatory product foundation раньше своего Phase 0E persistence decision;
3. `queued-answer` обещал core queue без owner/liveness protocol;
4. forced broker termination не имел terminal zero-handle/process-exit proof;
5. open-ended “known bus” пропускал iSCSI и другие не заявленные device classes.

Current source maps these to X167–X171: memory allocations use the existing named checkpoint equations; the three-store measured ADR precedes simulator/seam/foundation; informational follow-up is `answer-only`; one-dispatch broker state is a closed graceful/forced union with timeout-mandatory Kernel-observed forced exit; and local NTFS admission has the finite `{Ata,Sata,Nvme,Sas,RAID}` bus allowlist with all other literals denied.

This is a patch regression review, not a fourth frozen prose pass and not a generated-artifact review. Frozen PASS 3 remains `FAIL (P0=0,P1=5,P2=1)`. The corrections remain source-level candidates until the one-way generated package, semantic negative fixtures and real store/hardware evidence receive independent artifact review.

---

## 13. Phase 0A authored implementation evidence — not independent closure

The first non-product machine artifact now exists: a sole candidate `ProtocolDefinitionV1`, pinned bootstrap schema/compiler trust root, strict parser/canonicalizer, exact inventory closure, deterministic registry/provenance/gap outputs and six cross-language byte/digest vectors. The exact opaque-ID kind registry is `23/23`; closed structural AST/codegen emits `22/66` canonical schemas; the partial field map covers `117/117` currently reachable ID endpoints. `ImmutableContentRefV1` remains the exact flattened union and `selectedVariantRef` projects one branch with full dangling/cycle rejection. Generated `AuthorityScopeV1`, `RuntimeFeatureSetV1`, `StorageTraversalBudgetProfileV2`, `CompletionTerminalPolicyV1` and `CompletionCertifierContractV1` retain their prior closure. The leaf-first assessment slice adds an exact four-row `StorageExclusionSummaryV2` tuple, closed six-branch `TypedValueLiteralV1`/`TypedValueV1` unions, the exact inclusion/exclusion/temporal leaves and `WorkspaceStorageAuditInputV2`. The input freezes display-only requested-root provenance, canonical root identity, interval temporal class and selected private instance refs to the exact policy/budget bodies. Generated `$ref` resolution is independently exercised; missing targets, cycles, tuple reorder/substitution/omission/extension, wrong ref-branch selection, policy/temporal literal/field drift and cross-branch encoding drift fail.

The compiler additionally emits `22/66` schema-body digest rows into a dedicated candidate and generated registry. Each row binds exact schema ID/version/root `$id`, canonical bytes, raw audit SHA and the §2.1.1 domain-separated digest under `monarch-jcs-utf8-v1`; an independent Python stdlib oracle reconstructs the full length-prefixed preimage, proves all `22/22` raw/semantic pairs distinct and rejects coordinated raw-SHA substitution. The finite candidate binding set now contains `25` programs / `93` instructions. Its new callback-free `assert-projected-domain-digest` is limited to one direct closed retained target schema, an exhaustive sorted mapping of every required property and either a byte-identical direct source field domain or target-valid literal. It closes `CanonicalWindowsPathV1.identityDigest` over only the four-field `CanonicalWindowsIdentityBodyV1`; display path, observation time, outer schema version, optional members and arbitrary selectors cannot enter. Node and independent Python reject member omission/reorder, source/literal/target widening, duplicate result and coordinated candidate/registry mutation. The Python oracle executes four value cases: correct/incorrect identity projection and correct/incorrect Workspace repeated equality. Existing exact ref, self-digest, canonical-set and TypedValue rules remain closed.

`AgentCapabilityContractV1` is the 22nd retained schema document. Its closed AST fixes the only core capability, all nested implementation identities/versions, the read-only execution ceiling, three schema descriptors, exact policy/profile refs and the 28-member claim suite. The isolated materializer validates one 26,885-byte candidate body, recomputes matcher and capability domain-separated self-digests, performs 55 semantic binding checks and rejects 50 structural/semantic mutations. A11 then binds that exact body through Admission, Goal, Evidence and Completion, raising the shared lineage to seven artifacts, 57 checks and 39 rejected lineage mutations. This is deliberately not retained-instance authority: Store-issued refs are zero; output/EvidenceNode schemas, claim bodies and recipe are still absent; `phase1aPromotionReady=false`.

The retained semantic-ID substrate is now finite rather than prose-defined: five exact profiles close the 28 claim-template members, their one-to-one selector IDs, singleton `storage.audit.requirement.v1`, six locale/verdict presentation-template IDs and `clause.<nearest-array-index>.v1` with canonical unsigned decimal and the global ordinal ceiling `99999`. The compiler and independent Python endpoint oracle reject profile/member reorder, add/remove/substitution, owner-path drift, wider ordinal patterns and a coordinated definition/candidate/registry member substitution. Synthetic positive endpoints prove exact pinned-member and ordinal acceptance. The retained `AgentCapabilityContractV1` schema now exercises `2/5` profiles through its exact 28 claim-template members and singleton requirement ID. A separate isolated body materializer validates one candidate contract and its self-digests/semantic relations, but Store-issued refs and cross-body owner/projection bindings remain open.

The previously missing direct schema-digest operation remains separate from instance refs and the new projection operation. The production candidate intentionally has no direct-schema instruction among its `25/93`: CompletionCertifier's two fields are not bound until the actual input/body schemas are materialized.

The Event owner audit exposed two compiler-algebra gaps before any false 40-branch materialization. First, copying one common envelope into 40 Event branches and again into 40 CommitEvent branches would make parity a review convention. The new finite `objectVariantTemplate` macro accepts only one direct closed common object plus `2..64` sorted, disjoint branch deltas; it materializes ordinary flattened branches and then passes the existing discriminator/ref/ID validators. `ImmutableContentRefV1` proves zero ABI drift: emitted bytes remain exactly `2773` with SHA-256 `c05ec88fc9c50f9f27e22bb18e2979d1e77990204efd7736e75b0389d789eda1`. Second, `causationId` cannot be a single-owner reference because its exact domain is command-or-event. `reference-union` now requires `2..256` sorted owner-rule IDs, every chain terminating at a retained random owner, at least two opaque kinds and the exact compiler-derived canonical prefix-union regex. Redundant same-kind lists, reorder, dangling/non-random owners and regex widening fail in both Node and independent Python. Neither primitive claims Event closure.

The deeper owner relation is now materialized as one finite source table rather than patched random rows: exactly 40 sorted event variants and 30 sorted ordered commit shapes, at most three events per shape, `commitId` owned by the first occurrence, and `commandId` split into 25 first-event/internal owners plus five retained owners (two accepted AgentCommand branches and three CompletionCommitAssessment verdict branches). Its trace policy requires causation on all 44 occurrences: two accepted-command ingress references, 28 prior-retained-event references and 14 immediately previous same-commit references, with matching correlation propagation from the sole accepted-submit root. The canonical grammar digest is `sha256:0d883c35cacaef141bb0d11f444bd9e118f982c5fe89952e965f6c6bafceb9a5`. Node rejects shape reorder, event-order drift, owner substitution, optional causation, fresh suffix correlation and root substitution. The independent Python oracle recomputes the occurrence/trace rows and rejects coordinated definition/candidate/registry drift against its separately pinned digest.

The Event ABI is no longer a handwritten 40×2 mirror. One pinned `eventSchemaSource` (`sha256:7f947dd2d9ea398cac7a0162f16909e1c50367d2ce297e5150af670292e7798a`) contains 40 variants / 45 payload branches, including five presence-disjoint diagnostic unions and twelve Invocation transition payloads. The compiler emits 40 causation-required AgentEvent plus 40 CommitEvent candidate branches and proves 40 exact projections with only `/commitDigest` removed and `/schemaVersion` replaced. A separately implemented Python reconstruction rejects source, projection and coordinated candidate drift. The expanded pure candidate simulator exercises five accepted schema instances, eleven rejected structural mutations, three ordinary binding checks/rejections, the CommitGroup cases below and two positive/seven negative trace-relation cases.

The owner grammar expands to 44 concrete occurrences rather than 40 unique variants. The generated binding map proves 30 `commitId` allocations + 14 intra-commit references, 25 internal `commandId` allocations + 11 intra-commit references + eight retained-command references, 44 `eventId` allocations, 44 stream↔payload aggregate equalities and 44 payload-digest rule selections. The repeated `invocation.receipt-linked` rows remain distinct by `(shapeId,eventIndex)`.

The CommitGroup is also no longer an implicit generic wrapper. A generated candidate embeds the exact 40 CommitEvent branches, exact `1..64` cardinality and all 30 ordered branch-index shapes, then declares same-stream/revision/command/commit/size, size=count, index=array-position and contiguous-sequence invariants plus the full-instance `event-commit.v1` digest result across all 40 AgentEvent `/commitDigest` endpoints. Independent reconstruction pins its `93325`-byte schema at `sha256:c8400477db55c101d3460c8d115c0ed878638521f46a229eecf074246b2b8134`. The simulator rejects empty/extra-property groups, size/index/sequence/command/order drift and a single-event digest substitution. Its first red run also caught a cross-event reason-code mismatch in the test shape, demonstrating that ordered shape alone cannot replace branch payload validation.

An attempted direct registry promotion was stopped by a deeper endpoint-expansion audit. The three candidate documents do not add a small envelope-only map: each has `240` envelope/stream endpoints, `79` direct payload endpoints and 58 embedded refs; every `ImmutableContentRefV1` expands through three retained branches to nine concrete endpoints. Exact closure is therefore `841` rows per schema and `2523` across Event/CommitEvent/CommitGroup. The initially assumed two-branch/six-endpoint ref model failed red against the retained AST, and the final compiler derives nine before comparing to the independent oracle. The same pass caught that protocol variants containing `:` could not be used as legal field-rule routes; it now emits and independently reconstructs 40 collision-checked mappings such as `completion.certified:blocked` → `completion.certified.blocked`, retaining the source ID and branch index. A later adversarial pass closed the source-level payload ambiguity: the pinned 79-row grammar has only two aggregate-creating random owners, 75 direct references, one semantic requirement endpoint and one five-member same-kind decision-owner set. Its mechanical projection through all embedded refs emits exactly `601` payload endpoints per document and `1803` total; coordinated candidate mutations are rejected by the independent Python reconstruction. A dedicated `reference-set` primitive now accepts only 2..256 sorted terminal owners of one exact opaque kind and rejects mixed-kind/singleton/reordered/widened sets in both implementations. The next dependency audit replaced the remaining prose owner assumptions with a 17-row exact grammar: 15 derived Event/envelope roots, two support bridges, 15 terminal random owners, 11 owner schemas, nine opaque kinds and depth one, pinned at `sha256:07fc6aeadb862ba1305e3278975485497f02cefbc04dae24a1bc1d7efc005a7c`. Both compilers reject root removal, import substitution, reorder, dangling references and kind widening. This prevents a dangerously plausible false green based on current unrelated `117/117`, but does not close registry ownership: complete structural and ID/binding surfaces for those 11 schemas, the 720 envelope/stream endpoints, occurrence-contextual rules and all three Event documents remain open.

The atomic-promotion audit then joined every ingress/layered source before retained mutation and found another superficially plausible false green: ingress had four candidate documents but six root structural variants, while the compiler reported the document count under `structuralVariantCount`. The independent oracle derived 51 combined variants rather than the claimed 49 and the production compiler was corrected; the oracle was not weakened to accept the old count. The pinned preflight now proves an exact 16-document, 11-owner, five-support, five-boundary, 1089-ID-row and 16-schema-body-digest owner inventory. A later dependency audit proved that this is an inventory boundary, not a promotable cohort: every retained ID-rule target schema must already be materialized, but AgentEvent is absent from retained authority and those 16 documents, while all three Event documents depend back on owner schemas. Owner-only promotion, Event-only promotion and standalone Event-import bindings are therefore rejected; the only admitted topology is a joint `19`-document / `3612`-endpoint CAS cohort. The stdlib oracle rebuilds all 158 direct and 931 projected owner rows, independently counts `24` direct plus `4` projected Event imports converging on two aggregate owners, pins all 16 schema-body digests and rejects both a candidate ID substitution and coordinated source/candidate/registry/topology weakening. The result intentionally remains `promotionReady=false`: complete Event lowering, completion bindings and Store-issued ProtocolSchemaRefs have not been materialized, and partial application is defined to produce zero retained-authority change.

The first machine-readable owner-schema surface slice now closes the ingress-command source without pretending to retain it. Its independently pinned source digest is `sha256:9167e07972df7c14aadecdedc1b487886ab09a176ffe57e05b0b2b99a9fc35b1`: four exact submit/follow-up documents with six root variants cover `AgentClientCommandV1`, accepted `AgentCommandV1`, two payload supports and the retained AcceptedContext dependency. Mechanical expansion yields `25` direct plus `16` retained projections (`41` concrete endpoints): `8` random, `14` reference, `3` same-kind reference-set and `5` Event aggregate imports. The review found and removed an unfenced trace-link channel before materialization: public client branches now reject both correlation and causation; the trusted adapter allocates accepted-submit correlation after authentication/dedupe reservation, accepted follow-up copies the retained target-Interaction root, and accepted commands carry no causation. Nine Node mutation classes and an independent Python reconstruction reject correlation/causation smuggling, attachment widening, branch/ref/set/projection drift, row reorder and coordinated candidate changes. A separate pure simulator accepts `4` exact schema instances, rejects `13` structural mutations, passes `2` projection bindings and rejects `6` binding mutations. Five imports still terminate in candidate AgentEvent owners, so the four documents, their `41` endpoints and the current `21123`-byte artifact (`sha256:2055774e8b24907a3ff41f22d3fff29be487aca396d89295c2e9b4c631929f99`) remain outside the retained registry.

The next pass disproved the earlier fear that the remaining owner documents form an indivisible structural cycle. The exact graph source (`sha256:55d89496fb8e8c8a7a20f413dde27d0d2498abde271bfcdc44e00a3986753b64`) derives the nine remaining owners from the retained 11-schema grammar minus the two ingress owners, adds three required support documents and four already retained boundary schemas, then closes all direct `$ref` edges. Independent Tarjan reconstruction agrees on `16` nodes / `16` edges / `16` singleton SCCs / `0` cyclic SCCs and three non-retained topological layers. The first layer contains nine structurally leaf documents; CompletionAssessmentBody and CompletionCommitAssessment form layer two; CompletionCertificate is the final structural layer. Five Node attack classes reject reorder, edge removal/dangling substitution, role drift and layer substitution; the Python oracle rejects a coordinated definition/candidate/registry edge removal against its own exact table. The current `5357`-byte artifact is `sha256:6fc4092543309f543f6838108f5944fa030ec60228d3eda74798653a65b6fcd8`. This result changes implementation order, not readiness: the graph deliberately contains no claim that the complete ID endpoint/owner/binding surface is closed, so materialized owner/support/ID/binding counts remain zero.

The new pure Invocation simulator independently derives the twelve lifecycle transitions plus the receipt-link fact from the Event source. A successful path reaches `settled@5`, allocates one stable `dispatchAttemptId`, recomputes the frozen dispatch key and records exactly one port call across idempotent retry. It also accepts the three known/unknown post-dispatch terminals, two pre-dispatch terminals and output rejection, while rejecting eleven stale-CAS, revision-jump, skipped-authorization, changed-key, receipt-lineage/disposition and illegal-terminal mutations. This is reducer evidence only: no product runtime, process crash or persistence was touched.

This closes mechanical source/projection/occurrence/group/trace derivation, not the retained registry: conversion of trace owner sets into exhaustive opaque-ID/binding programs and promotion of all three Event schemas remain open. `InvocationV1`, dispatch-key and receipt structural schemas are not materialized merely because their finite reducer simulation passes. The blocker is `event-schema-registry-and-id-binding-materialization-incomplete`, and `conformanceReady=false` remains mandatory.

The next pass closes owner-side rule-ID allocation without pretending to promote anything. A domain-separated rule-ID source (`sha256:7dd49249dee514a6a35574f884b6458cce462cb60f8eee9e0fef2645f82a2d79`) deterministically assigns full-SHA-256 IDs to all 1089 owner endpoints and five explicit external-owner anchors. The result is `1094/1094` unique IDs, zero endpoint/digest/retained collisions and zero unresolved owners. It lowers 119 scalar endpoint references and 11 owner sets with 24 members, preserves 16 references to two retained rule IDs, and resolves every candidate/import/retained chain to opaque-random authority. Exact classifications are `542` random, `135` reference, `11` reference-set, `8` authenticated-external and `393` semantic. A potential defect was investigated and rejected rather than patched: abstract Evidence `/id` and dotted accepted-command variants belong to the retained logical owner namespace and are intentional grammar imports; rewriting them to candidate structural endpoints would collapse an authority boundary before atomic promotion. The independently implemented Python oracle recomputes framing, all IDs, imports, path conversion, classifications, chains, provenance and registry equality. Ten definition-level attacks plus generated collision/substitution/import/removal/retained-mutation/coordinated-weakening attacks fail closed. The candidate artifact is `719744` bytes / `sha256:e351cbe60ed67570e16013f04d75556eb0f0042201c34b9a06f2eea3d7a2d111`; `promotionReady=false` and `retainedMutationApplied=false` remain mandatory.

The rejected standalone-binding route exposed one additional concrete defect before it could enter authority. CommitGroup's 601 projected payload rows were attributed to nonexistent `monarch.commit-group.v1` and omitted the enclosing array location. Both implementations now require `monarch.commit-group-digest-body.v1` with the exact prefix `property:events / each-array-item`; the corrected three-schema projection artifact is `1240797` bytes / `sha256:257a09cdbbd2b53e0637fa17df9c4cf318036eae4f00d4e580845f2a284b752f`. Four new definition attacks reject standalone Event-import smuggling, owner-only promotion, a `3611` joint-endpoint count and CommitGroup-prefix drift; the independent atomic oracle separately rejects a weakened candidate topology. This is a genuine correction, not evidence that the Event trio is retained.

The joint lowering pass then tested whether the topology could be converted into actual finite rules without hiding occurrence context inside a scalar owner. It produces `3612` candidate rules and independently reconciles both former Event imports, but discovers two additional dotted logical `messageId` authorities; the exact generated set is therefore `3617/3617`, not the initially tempting `3615`. All 720 envelope/stream and 1803 payload/ref endpoints are covered, exactly 841 per Event document. A second plausible false green was rejected: CommitEvent/CommitGroup scalar projection rules cannot reference an AgentEvent owner whose classification is itself a set or union, because the retained scalar-reference resolver terminates only through scalar references. Ninety-six such projections are now flattened to the identical terminal set/union, while exact projection equality remains a separate binding obligation. The final mix is `633 random / 1898 reference / 35 set / 120 union / 8 authenticated-external / 918 semantic`; every chain terminates in random authority. The 40 causation rules retain the schema-exact 42-owner command-or-Event union, while occurrence programs supply the stronger per-row relation; correlation, repeated command/commit and diagnostic stream rules are independently reconstructed. The `2060078`-byte candidate (`sha256:c6c5b43adab4567f18b855555f9bc52c17489a7c697ab04ee1a21390118915fb`) stays below strict parser ceilings. A separate Python implementation rebuilds allocation and classification and rejects ID substitution, causation-set removal, CommitGroup-prefix mutation and logical-import omission. This closes candidate ID rules, not equality/digest/frozen-copy bindings, retained schemas or Store authority.

The next pass attacked the separate equality/occurrence claim instead of treating those rule IDs as executable bindings. The retained 25-program language cannot express object projection, occurrence lookup, ordered multi-event equality or shared commit digest without semantic widening, so it was not silently modified. A candidate-only executable layer now lowers the verified Event sources to `114` programs / `1376` instructions: 40 projection, 44 occurrence and 30 commit-shape programs. It contains 749 exact JSON-value equalities (640 direct parity), 99 fresh allocator checks, 44 payload digests, 28 prior-event ID plus 28 correlation lookups, 30 exact variant/count/index/sequence/shared-digest programs and 150 same-commit equality checks. The `503503`-byte artifact is `sha256:d73a1032632e2b43eb82895a775d11d25da04baf8e82373de652105264954c8e`; its source identity is `sha256:d88fc136290e6d7cbe5bc52b5356359a5ddd52240a8943a241a349b59ac1b228`. A composed independent Python implementation reconstructs all programs from separately verified lower-level artifacts, executes seven linked instructions/programs over the three-event `invocation-failed` commit and rejects seven payload/projection/allocation/causation/stream/sequence/digest mutations. Four direct artifact attacks reject omission, occurrence-owner substitution, digest-result truncation and readiness escalation. This closes Event-specific bindings only as candidate evidence; the following pass closes Completion-specific candidates, while retained authority and Store CAS remain open.

The Completion pass then attacked the remaining claim→selector→presentation and frozen-copy claims rather than accepting the layered simulator as executable authority. A separate candidate set contains `9` programs / `151` instructions: request-freeze, three verdict assessments, commit-freeze, certificate-freeze and three terminal suffixes. The exact inventory includes `84` byte-equal copies, `20` immutable-ref resolutions, all 28 selector mappings, the 16 required presentation keys, private TypedValue classification, verdict policy, four digest domains, once-only command/certificate allocation, retry byte identity and the adjacent two-event terminal commit. Its `68887`-byte artifact is `sha256:3c9044b18a8c42923a7efafc9e853955f9c7ee975d9091ed1f7e94ef9561fa75`; source identity is `sha256:c153a1412f2783200f8bb65d22d59d4e36f166f0da455d9e5b4ad09a97260e98`. The independent Python implementation reconstructs all nine programs from definition sources, executes all nine across blocked/partial/verified fixtures and rejects `10` artifact plus `12` semantic mutations. Four direct tests additionally reject selector substitution, commit-freeze omission, certificate digest weakening and readiness escalation. This closes Completion bindings only as candidate evidence; retained authority remains unchanged.

The next adversarial question was whether a passing binding artifact hid a Store transaction hole. A disposable filesystem lab on `E:` exercises `12` scenarios: issued refs, schema/digest binding, CAS single-winner, byte-stable replay, key/body conflict, three pre-commit failpoints, response loss after committed state, ref substitution and split terminal commit. It proves clean logical rollback before state replacement and exactly-once recovery after it. It does not claim OS/process/power-loss durability and reports `powerLossDurabilityProven=false`; no product persistence or Monarch Safe was touched.

The following attack targeted an implicit-language trap: Event and Completion had executable candidates but no one artifact that forced every engine to accept the same operations, scopes and endpoint roles. The new combined candidate ABI pins both program artifacts and closes exactly `123` programs / `1527` instructions / `26` operations, eight scope kinds, 13 endpoint roles and 2519 endpoint references. Unknown/missing operands, role widening, coercion, skipped instructions, source substitution and every partial activation fail before authority change. Its `16362`-byte artifact is `sha256:d7751f2e914be4d0c221b171f5a391ab28bc00b96ec35a5a2445f0026e33e6be`, with self-digest `sha256:2819ef38d4f3264ae64e84e898ab1c0aacbfc23dda5b7277772d7e8e82015721`; the separate Python oracle rejects 12 direct attacks. This closes a candidate ABI, not retained `BindingProgramV1` compatibility.

The final pass replaced the logical Store model with a disposable SQLite cohort database. `WAL`, `synchronous=FULL`, foreign keys, `integrity_check`, reopen and backup are exercised with the real `19/3612/123/1527` candidate volume and 19 Store-issued candidate schema refs. Forced worker termination after schema, rule and program insertion leaves epoch zero and no partial rows; termination after commit-before-response replays one identical receipt; two independent processes produce one authority advance for both same-request replay and conflicting same-epoch CAS. Partial cohorts, stale epoch, idempotency-body conflict and missing-schema foreign key fail. The `36842`-byte harness is `sha256:0ebd24f3f501c3451bac823c1183f340510978fc30133c0f07103465ef9ca39e` and truthfully reports process-crash proof only. A lab-only meta-schema digest and unretained role/rule IDs mean `retainedProtocolSchemaRefsIssued=0`; power loss, torn writes and retained promotion remain open.

The capability-schema pass exposed a classification error that structural validity alone would have hidden: matcher, binding-program and digest-rule IDs were being treated as authenticated external tokens. They now use the exact semantic rule `protocol-rule-identifier` with the closed `(binding-program|digest-rule|matcher)` namespace and `v1|v2` suffix; Node and the separately implemented endpoint oracle reject relabelling or regex widening. The A11 capability materializer still uses a one-rule `synthetic-schema-witness-only` matcher, so the evidence explicitly carries `matcherFunctionalSemanticsValidated=false` and `capabilityOperationalSemanticsValidated=false`. Its `55` semantic checks, `50` rejected body mutations and the shared lineage's `57` checks / `39` rejected mutations prove schema, digest and cross-stage binding only, not intent-selection or execution quality. A second concrete contract defect was fixed in the same pass: matcher, target-resolver, walker, filesystem-broker and adapter hashes now all use `raw-sha256`, matching `ImplementationHashV1` and Admission's byte-equal matcher binding; the prior `sha256` spelling made that binding unsatisfiable.

The next adversarial pass then read the A11 command rather than only its cross-stage digests. The old «Сколько байт занято на тестовом диске?» fixture was invalid for the interval-only capability: it implied point-in-time/current truth and provided no literal absolute Windows target, yet the lineage still passed because it never evaluated text. The corrected fixture names the disposable root and explicitly requests one complete interval observation, not a snapshot. A pure deterministic matcher-policy simulator and separately implemented Python verifier agree on eleven exact cases (`2 execution / 6 clarify / 2 blocked / 1 not-applicable`), replay identity and NFC/whitespace metamorphisms. They also prevent another false closure by reporting exactly four representation gaps: the retained matcher is still a synthetic schema witness; its accepting outcome cannot represent informational/not-applicable; its action algebra cannot emit an informational candidate; and its candidate-code algebra cannot encode a prohibition block. Candidate policy behavior therefore passes, while retained matcher and capability operational semantics remain false and Phase 1A remains blocked.

The representation follow-up does not patch those gaps into retained V1. One additive V2 ABI candidate uses no semantic regex, only finite normalized lexeme classes plus a literal path-token grammar. It distinguishes informational-answer from zero-candidate not-applicable and adds explicit informational/not-applicable/block actions. Matcher-owned `operation-prohibited|matcher-input-limit-exceeded` blocking is separate from application-owned `capability-unavailable|target-ineligible` eligibility downgrade. The first candidate revision was rejected despite passing its initial twelve cases: one scalar outcome could not encode Protocol-authorized informational+operational `mixed-rows`, and global lexical facts let «что такое интервальное наблюдение?» contaminate the temporal meaning of an independent current-state request. A path-internal dot also exposed naive sentence splitting, while a separate partial-policy sentence exposed over-isolation. A later executable-projection pass found two more false greens: application eligibility failures were incorrectly treated as clarify codes, and the policy route `answer|execution` was being confused with Admission's exact `answer-only|execution-only` aggregate vocabulary. The corrected contract has fourteen ordered operational rows, one orthogonal informational dimension, eight exhaustive base projections and four application downgrade projections. Clause-scoped facts exclude informational-only segments, include non-informational policy modifiers and recognize a period boundary only before whitespace/end. Ambiguous double negation now clarifies rather than silently executing, a Cyrillic drive-letter confusable fails the ASCII target grammar, and quoted/trailing-punctuation targets plus separate modifier clauses keep deterministic routing. Node and independently implemented Python now agree on `20/20` policy cases (`1 answer / 2 blocked / 8 clarify / 5 execution / 3 mixed-rows / 1 not-applicable`), deterministic/NFC/whitespace checks, four V1 gaps versus zero candidate-V2 representation gaps, four exact downgrade cases and `22` digest-recomputed weakening/readiness attacks. The candidate is `12965` canonical bytes / `sha256:2d95bae3a15ed062fb0d4b2f5bc13d640ac947a4a925392ac75e7c31215b8d1f`; evidence digest is `sha256:45df76b857adacdae400eb0e61e091c571f3c17f731576e786442bc447f10904`. It requires an atomic CapabilityContract V2 + Descriptor V2 + Result V2 + Admission V2 materialization/promotion and forbids any V1 reinterpretation. No matcher implementation or retained schema exists, so representation closure does not raise matcher, capability, Phase 1A or product readiness.

The next closure attack rejected the apparent three-schema atomic boundary itself. `AgentCapabilityContractV1` embeds the V1 descriptor identity, actions and outcomes, and the retained RuntimeFeatureSet binding asserts `monarch.agent-capability-contract.v1`; Descriptor/Result/Admission V2 cannot activate coherently without CapabilityContract V2. Attempted content regeneration found a second undercount: changing the owner inside `semantic-id.claim-template-member.v1` or `semantic-id.requirement-member.v1` would redefine immutable `.v1` identities. Both require new V2 IDs. Exact traversal finds `167` occurrences across seven replaced identities (`136+11+20`); the profiles account for 31 total occurrences—two definitions and 29 downstream references. The same sixteen generated artifacts and fifteen surfaces are affected. A later endpoint derivation attack disproved mechanical rule copying: all 56 current Capability V1 rules are invalidated, but V2 has exactly 55 endpoints because Descriptor V2 removes `matcher.ruleTable[].ruleId`; the obsolete rule must retire. Node and independent Python reproduce the widened closure and reject `17` attacks. The `7207`-canonical-byte closure is `sha256:da3a1f429ed0041f7929c396fc085b0e9a7e176fbcd0b617b2ca30ef068c7b8e`; evidence is `sha256:de1c0b5cc286544c328d8c3aa62df9066d943c352c9277da1357504dac4394b1`. Activation requires a new RuntimeFeatureSet generation and one Store epoch advance, while committed V1 Admissions and semantic-profile identities remain byte-stable V1 replays. This exact closure remains the immutable pre-materialization snapshot, not promotion evidence.

The schema-shape pass then materialized the exact four-AST cohort without treating generated output as authority or changing retained registry/ID/binding/Store state. CapabilityContract V2 preserves every V1 frame/policy field but replaces the embedded matcher copy with the sole Descriptor V2 ref; Descriptor V2 pins all seven finite ABI sections; Result V2 and Admission V2 expose the same informational/blocked/capability/unknown branches, explicit mixed outcomes and zero-candidate not-applicable. Widened closure provenance changes source/artifact identity while leaving all four schema pins unchanged: source is `3413` canonical bytes / `sha256:6ce9bb978e44921c897f038d47667cd44237812beacdaa9a46cc72c92c8df757`; artifact is `43773` / `sha256:2e709aa8ccdb93ce669109c6cbfe99f97b1c33e95aec8ceb4aba2a5ede531650`; evidence is `sha256:42a7a2b33bacf22b7b604dc089d3565d4b39d1db28810387469c4a5b6fe450a6`. Node rejects `17` semantic mutations and independent Python rejects `19`. This closes schema shape only: authority regeneration, Store cohort and matcher implementation remain false.

The executable projection pass then materialized the missing finite Result V2→Admission V2 program without retaining it. Seventeen operations cover eight base outcomes plus four application eligibility downgrades; target resolution occurs exactly twice and only after positive capability drafts. The projection forbids resolver/capability output after eligibility failure, preserves informational evidence in mixed downgrades and keeps not-applicable candidate-free. Node rejects `24` output/program mutations and independent Python rejects `18` source mutations. Widened provenance yields source `7136` canonical bytes / `sha256:2ba41637e41fbedd99d82eb057cb32ef5f66958138999e58dd4a3b3dbb8185ef`; evidence is `sha256:1fa65b01175fc34fb2b80fce31b5e1dc93170023881f7ecafede97863106ffbd`. No retained binding program, authority surface, Store state or matcher implementation was created.

The next attack targeted regeneration drift rather than schema shape. A single non-retained package represents all 15 surfaces as a topological DAG and binds four schema pins, 12 projection cases, seven exact identity substitutions and all 16 invalidated Phase 0A artifacts. The two new semantic-profile substitutions forbid owner mutation beneath retained `.v1` IDs, and the Capability rule obligation requires 55 candidate endpoints plus explicit retirement of the obsolete V1 rule. Actual-body probing found a DAG inversion: the first layer cannot generate RuntimeFeatureSet because manifest, capability-instance and Store-issued refs do not yet exist. It now emits only the binding program; the final layer may emit only a non-retained generation plan, and an early-generation mutation fails closed. Source is `14411` canonical bytes / `sha256:6390e1c850e16aa2f31c359e63ed117dd153f3cc706b7b4d124113cf7dc7a660`; envelope bodies total `26161` canonical bytes; artifact is `29209` / `sha256:78810b9e8807a7ccac0ddb6e62c51df1e894adc9a83ba54ab844d2970779ff90`; evidence is `sha256:0979ada42752629b73578f289cb3d927458bcc3f6be0f174ec05e219ccaa740d`. Node rejects `25` attacks and independent Python reconstructs every envelope and rejects `24`. This is regeneration-contract closure only: no authority artifact contents, RuntimeFeatureSet generation, retained ABI, Store cohort or matcher implementation were generated.

The first actual content tranche attacked the gap between envelopes and materialized contents. It emits four bound ASTs, two V2 semantic profiles with unchanged members/paths, three direct profile-reference rewrites, 55 exact Capability V2 endpoint rules, a new RuntimeFeatureSet binding with the previously missing `assert-ref-schema-digest`, and the full 12-case Result→Admission projection. It accounts for all 31 profile occurrences while deferring exactly 26 layered/Event owner-import references. Source is `3368` canonical bytes / `sha256:91be34fc94017c8b7643c4ff03210f52d8fa2a7383d3cb6f8bb4058b1b42111b`; artifact is `85938` / `sha256:74dc21899030280fd21f22d8d34810bab3f07239a9ce4c8f2ba68612e7891cca`; Node evidence is `sha256:5f1e5e1ead02e5f9a1bf84d360178e746e82d4d997aaa1fdf789636c3bad4887`; independent evidence is `sha256:891117e4d8f954cf69b78815f627f107ae17e1795ad9d9a43fb18a53e1270747`. Both implementations reject 24 attacks, including obsolete-rule resurrection, V1 profile redefinition, schema-digest omission and readiness escalation. Owner/import content, regenerated authority, RuntimeFeatureSet generation, Store, matcher implementation and promotion remain false.

The next attack asked whether those arrays were already truthful output artifacts. They were not: a complete legacy binding/map artifact would require a candidate-definition digest that cannot be sealed before later owner/rule/registry surfaces close. Instead, the first phase now emits four exact surface-owned bodies under the DAG output names, each bound to its authority-envelope digest. The bodies contain one binding program, two profiles, 55 rules and 12 projection cases and total `32855` canonical bytes. Source is `2258` / `sha256:98f17eb070f8b4dc81bff8d82c0746f4860efa05df312891fc176e480fd1a1ea`; artifact is `34725` / `sha256:c398cea998f951443e88d4aae444d42f5f0d7dd5e080122fbf69d5d105ebbe37`; Node evidence is `sha256:14c292aeacf9b96e7d80aeb383d2709dbf02a5810a7df95fb969c1ab42936fa5`; independent evidence is `sha256:74be93aee9978859c1b9e79dd9d66d155cc6fb32ee797c29a740b71cfc86ade4`. Both reject 20 omission/substitution/composition/readiness attacks. Whole legacy artifacts, sealed candidate definition, partial promotion, owner-import content and RuntimeFeatureSet generation/plan remain false.

The next attack targeted the 26 deferred references without changing the retained definition or silently re-identifying the large layered catalogs. A candidate overlay contains exactly 25 layered-owner and one Event-payload JSON-pointer substitutions, each with an exact V1 precondition and V2 replacement. Composed with the five direct-tranche occurrences it resolves all 31/31 profile occurrences; omission, duplication, ambient paths, regex replacement, source-precondition drift and partial application fail closed. Source is `1665` canonical bytes / `sha256:1e5601432f91c9bcd555440584c375dfb2b0bf8a99eac07544e8335e5c5bad39`; artifact is `22856` / `sha256:07a598bd4ea76c039473b8d8b401fd01a68d92d2929cd33f0844882fc0391fdf`; Node evidence is `sha256:952487cc4fbb0d77786c55ece6df8bd5a3710bc20fb11b8fac0b734405811ca9`; independent evidence is `sha256:ebd0aae650d166499e794d1de93bd5a5db7b023cc01440c6b7ae876df8c7899d`. Both implementations reject 20 attacks. This is candidate overlay closure, not regenerated authority contents, retained activation, RuntimeFeatureSet generation, Store evidence or matcher implementation.

The next adversarial pass showed why the 26-patch overlay was still not an owner-import artifact: follow-up, goal and Event projection contain their own Admission-owner references, while the Admission batch also embeds its old schema AST and matcher identity. The new owner-import body set therefore reconstructs four surfaces and five outputs. It replaces 63 Admission identities, two matcher identities and 29 semantic-profile occurrences, installs the exact Admission V2 AST, regenerates the Event owner-grammar hash and applies the changes to all three projection documents. Every output body binds the actual predecessor body digests, not only envelope promises. Source is `2943` / `sha256:52acce8c2c259d1c702427fbdef3e8c75f31cd27a3f2a4e5be98c50cdf157715`; artifact is `1324765` / `sha256:8d871dd2dc4cd75b732c566051d5b1f92d45f941deb5e75786175a4e23e44c86`; body total is `1322793`; Node evidence is `sha256:acd4dd2e17642ea98585620e1eb73d00e168e6b2b5c243046abfa40e2afc8a54`; independent evidence is `sha256:e46ad97636047f63e6ee53dd28b1ae2ac0001cb84cb049d80b1641408592e7e9`. Node rejects 23 and independent Python 21 omission, resurrection, hash, dependency, phase-smuggling and readiness attacks. The result is still surface-owned content, not full legacy artifacts, a sealed definition, retained authority or runtime generation.

The next attack targeted the tempting but invalid shortcut of string-replacing the 517-KB atomic preflight artifact. That artifact embeds compiled documents and hashes, so changing only visible identities would create internally stale evidence. The owner-closure package instead emits two source-level bodies and four named outputs. The first binds all three predecessor body digests, replaces exactly five structural Admission identities, recomputes the graph binding and independently proves a `16/16/0-cycle/3-layer` graph plus zero-change rejection of partial packages. The second replaces the final two owner/authority identities and materializes an indivisible four-row V2 cohort with canonical URI, exact schema-body digest and rederived content-identity rule for every candidate schema. Source is `2518` / `sha256:36dbc5e8f3a6a4433be5f68e3fce893f0ad878d38efbc559946d73e566268dc5`; artifact is `22605` / `sha256:ae62a4c2217e8aca1ffd09844439d044ea272b7b5cb9cb40adf3cd23394c726d`; body total is `20730`; Node evidence is `sha256:5d8fd849564d81c1cdedc2ffefb6508a2a3a45fcaac115811bbc2c6ff62ec0a2`; independent evidence is `sha256:7523f7a033df347c7711ec3f2b689527a75cae90c01efda71f3ed4fba06361cb`. Node rejects 28 and independent Python 23 dependency, cycle, stale-hash, V1-resurrection, partial-cohort, retained-mutation and readiness attacks. Full compiled artifacts, definition seal, rule lowering, registry/provenance, generation, Store and retained activation remain deliberately false.

The next attack asked whether the V1 lowering rows could simply be relabelled. They cannot: rule IDs are domain-separated hashes of allocation endpoints, and reference classifications store those IDs. The Event-owner body therefore independently reconstructs every allocation endpoint, verifies every old ID, changes exactly 135 Admission endpoints and recomputes all 1094 generated IDs. It recomputes and verifies all 143 downstream reference bindings, while only 15 stored reference values actually change; this explicit distinction corrects the earlier inflated change label. It also replaces 34 claim and 67 requirement profile identities, preserves 1089 candidate rules, five external imports and 1089 provenance rows, then resolves every reference chain against generated plus 117 retained rules. The result has 1094 unique generated IDs, zero retained collisions and zero unresolved owners. Source is `2200` / `sha256:349f80ec4723c5d0ca9974af076393e0fbf0b2e9d08d907c2f11f8e9961dc24c`; artifact is `722660` / `sha256:89781085a98df26a85ff62397c1b5aacec2e9fec1c80a504329641693e364d0c`; surface body is `720855` / `sha256:284ebcba4f65da0953f65afa57cf3d01ef394d3b20aef9be5340421178ab3361`; Node evidence is `sha256:dc167cbbf6cee7821b27360e06fdb9c5edf0da32cdb9bd8382327e59e9d24cb4`; independent evidence is `sha256:9268f98d8eb10156ad067909fb1deef7e6962099c34217b93bb63571b44330c0`. Node rejects 24 and independent Python 19 dependency, resurrection, collision, unresolved-reference, partial-output, retained-mutation and readiness attacks.

The joint-surface attack then asked whether independently sound Owner and Event lowerings could be composed by concatenation. They cannot: every joint endpoint and every cross-partition reference must be rederived against one generated-ID namespace. The joint body consumes the exact Event-owner body, reconstructs 3612 candidate rules plus five logical imports, recomputes 3617 unique IDs and resolves all 6656 reference bindings. Only 20 reference values actually change, including exactly five direct AgentEvent-to-Admission-V2 links. It remaps 135 Admission endpoint identities and 34 claim plus 70 requirement classifications, preserves the exact 1089 Owner and 2523 Event partitions and proves disjointness from all 117 retained IDs with zero unresolved owners. Source is `2292` / `sha256:7f5f44f9ba838e1e8e93a7d4a7926c507d6df5f1dbea649eabbcc8573038ff80`; artifact is `2063281` / `sha256:e8c63d95dc95c883833e3a6201b23065f1ce72ff77c489a44bcccfb1fa2b04b3`; surface body is `2061465` / `sha256:0ba2fd18ddab9fa600e93ec5d2dbbb515e0ce47e1b1c1f5bb473b2fc2e042138`; Node evidence is `sha256:ac2eaeb3c9aa36552681828cf45a98e8e72fb692e3d1a1da21fd545775d9116b`; independent evidence is `sha256:64d670e43ad8b7c175facb712cef56856f960120b663ac9e1333c66b2386d438`. Node rejects 24 and independent Python 21 dependency, stale-ID, collision, unresolved-reference, partial-output, retained-mutation and readiness attacks. Full legacy artifacts, definition seal, completion bindings, registry/provenance, generation, Store and retained authority remain false.

The Completion attack then asked whether the old nine-program set could survive with one string replacement. It cannot: the changed request-freeze semantics require a new program identity, exact coupling to the already materialized RuntimeFeatureSet-to-capability-V2 body and explicit association of every ID-bearing instruction endpoint with the new joint rule namespace. The body rederives all 9 programs / 151 instructions, inventories 292 endpoint occurrences / 157 unique routes and binds the exact 47 ID-authority occurrences to 23 unique rederived joint rules (39 reference, eight opaque-random). The only capability V1 target becomes V2, one structural RuntimeFeatureSet V1 target remains and is bound through the dependency body to the same capability V2 schema/digest. Unresolved rule bindings and mixed V1/V2 capability-cohort occurrences are zero; generation is not claimed. Source is `3122` / `sha256:e499cf200d222146a851310bef31fa624d1769560010d8a587d42e026e13572b`; artifact is `96626` / `sha256:94d247f9f4fa1291e66e25367ac36ce8c2578d68f63eecb39d1adfb0c6a3f948`; surface body is `94761` / `sha256:f70beaf18973499fa6bfa9c6aa9650d629b44d177544293bcda0255e9b0e83b7`; Node evidence is `sha256:a6e95298a7d19c16b8c0078505d3908c6bb50f7fd3b3b717c6d690441a0f4d4c`; independent evidence is `sha256:bed4ee5829750ad81fa270cc7067e4bd7c42f0af372415bd0a593d34aa7de839`. Node rejects 28 and independent Python 25 dependency, legacy-owner, program-alias, omission, rule-binding, cohort and readiness attacks. Definition seal, registry/provenance, combined ABI, RuntimeFeatureSet generation, Store and retained authority remain false.

The registry attack then asked whether four schema AST hashes were enough to claim regenerated JSON schemas and a sealed definition. They are not. The body rewrites only the three authority-selected sections, replaces four closure identities, replaces the one materialized Capability V1 row and adds the three missing matcher rows. The resulting 25 materialized rows are explicitly split into 21 retained generated JSON schemas and four canonical V2 AST candidates; generated matcher-V2 JSON schemas stay zero, 41 of 66 structural documents remain missing, and definition/conformance remain false. Its provenance ledger preserves all 45 replay outputs and binds all 13 predecessor surfaces to exact body digest, byte count, authority envelope and output names. No selected registry row retains a replaced V1 identity. Source is `6775` / `sha256:1e538661b1d70c05e876a9d1da041461346bdbe7282180494ca071b468f5b4c7`; artifact is `55662` / `sha256:c5629187b9ffe586905121f9712d7364a7c8f5a67a23c1ddb61bf18abdebd71c`; surface body is `53943` / `sha256:2051556fd01dc9633aba7c66aa0fd354ea30be825481b421a8fd88ea2479eac5`; Node evidence is `sha256:7c0f2eebf66e6b8b2e100ab9d6aadbfec4b04599bc99aa03549c35abb769a089`; independent evidence is `sha256:9fad3b2801a617d107c6c084138f9d106a28727158bd422434ab9b41b2ca7309`. Node rejects 28 and independent Python 25 dependency, omission, legacy-resurrection, digest, content-rule, provenance, false-generation and readiness attacks. Whole registry/provenance rewrite, definition seal, combined ABI, RuntimeFeatureSet generation, Store and retained authority remain false.

The final-envelope attack then compared the declared source selectors with the old combined ABI's own source proof. It found a material defect: ordinal 14 selected the retained 25-program binding set, even though the combined ABI was built from Event 114 plus Completion 9. The isolated candidate replaces that source with the Event program artifact and selector, changing the envelope digest from `sha256:13ab547f60f000642a3f022579918a2bbf0fe5e8ba138079c86d70eb6d86cbf4` / 2174 bytes to `sha256:5ca43967f68b8799b4f181cb17135863ee63a202e0873eca64a58012a69a5c1b` / 2210 bytes. It deliberately does not patch only the old package digest or claim package regeneration; the complete authority package must later be regenerated from the corrected definition. The candidate ABI independently reconstructs 123 programs / 1527 instructions across 26 operations, eight scope kinds, 13 endpoint roles and 2519 endpoint references, with ABI digest `sha256:60f11f1b8632bfe70c477b378c03e0c167c4bda0ce905008d4d0698f5f624e59`. Store and RuntimeFeatureSet sections are plans only, with zero execution and explicit prerequisites for four generated schemas, four Store refs, definition seal and an atomic CAS epoch. Source is `4836` / `sha256:93d273036fadf7a4098e494db93e1ce6894e7c823e7c7668ec38d16cd2dbe9f1`; artifact is `26874` / `sha256:c187a34801c16a776ddeb65c258fd678be493711e5b3cd7b2a415cd27249b025`; surface body is `24997` / `sha256:8ea41c617005968347cd5b92915ba60b5fd456cc3e42b319295b130bf8c00787`; Node evidence is `sha256:22a916ee541f27cb5944095581dbd2ab2c2575e21c53084d4b2898416484d3fa`; independent evidence is `sha256:62524bcdeed02b603f92045bb7120fb091383d02411ca7e30189cd04383290a5`. Node rejects 30 and independent Python 25 correction, source, ABI, dependency, false-generation, Store, retention and readiness attacks. All 15 authority-named content surfaces now have isolated materialization evidence, but package regeneration, schema emission, definition seal, Store/runtime execution, retained authority and matcher implementation remain false.

The whole-package attack then tested whether the final-envelope correction could be smuggled in by updating one hash while retaining the old source graph. It cannot. A new effective graph is derived with only ordinal 14 changed; it is `14446` / `sha256:1ba2f7bb3bcd90f19331435f0e2a2c16debca50acd2598cecae309b73f0024a7`. All 15 envelopes are independently recomputed, the first 14 must equal the base objects byte-for-byte and the last must equal the separately proven corrected envelope. The full candidate is `29248` / `sha256:b7a93867fb803d0e23ae668d500e091e48e9c922875189a59a090f3599e0b1d9` and binds all 15 content surface proofs. Wrapper source is `5066` / `sha256:736c0e44d4021b1efcedccc357cfc068844601ad0025cf85ba8004a69ffe7e68`; artifact is `34150` / `sha256:94f1adb7ce3f597ba03f95acb9057c92f88af8b95917dd83ad3c342960857aed`; Node evidence is `sha256:5ade9a98283360ce18584c1479b26f6ba4e062cb34fa6900c972cd30703f6a7c`; independent evidence is `sha256:f3260fac5d8412ca310a473a9744e4be4573e3a76d6a9ba98f82c07cdcd41379`. Node rejects 25 and independent Python 22 omission, resurrection, dependency, source-graph, proof, false-generation, retention and readiness attacks. The corrected package and all proof bindings are closed, but none of the 16 underlying output artifacts is falsely marked regenerated; schema emission, definition seal, Store/runtime, retained authority and matcher implementation remain false.

The schema-emission attack then asked whether canonical AST hashes could continue to stand in for actual JSON Schema bodies. They cannot. Four Draft 2020-12 documents are generated inline from the pinned compiler and corrected authority package. Ten selected variants resolve against materialized base-plus-candidate ASTs, no source-only `idEndpoint` key leaks, and strict AJV compiles all four. Independent Python separately expands the templates/references and reproduces exact bytes, raw SHA-256 and domain-separated schema-body digests: Capability `17845` / `sha256:34e92a3ee1edb58d7c62208b1d0a9229f3d11610c13a9b5b9143eceda195a888`, Descriptor `11019` / `sha256:c7182b5932449ff152e2e5235554a5fcc86594f60e1eee0a26380b1912ea8fe0`, Result `5571` / `sha256:32135e03f305e9ba2d35ac2f2dcab48742b0c13320d835fa78a0accdf183cc85`, Admission `13296` / `sha256:016fd16c34c27037f0589d8e105b82725686b4a6db26e98e8ffc5e2dad0cbb46`. Source is `3615` / `sha256:d3c53b0a21065e58969b8a39f5fdb76cabc5cec4912189a41ebadd2460924742`; artifact is `53525` / `sha256:26c208fc539664f0ad0d760804be242fdd0b779f658ee66d43c94000abb4ef3e`; Node evidence is `sha256:eef5d3b68a3857c8232a9be76a1ce27773d8e736eb51be02c5df45cefa2a1095`; independent evidence is `sha256:8b5ae032da7746dce540e1e3dae4228de97eff655359d726ed3f03a87ff0de8a`. Node rejects 28 and independent Python 25 omission, template/reference, dialect, identity, digest, false-persistence, Store, retention and readiness attacks. The generated documents are real artifact content but are not persisted or Store-issued; registry recomposition and definition seal remain false, and 41 of 66 schema documents are still absent.

The registry-composition attack then replaced exactly the four AST placeholders with those generated identities while requiring byte-exact replay of all 21 retained rows. The registry sections, schema-body set and provenance are independently resealed without a definition seal. Source is `4180` / `sha256:25260bd93d3939d60ac4d8aad769afdb2477c28abb564911fa7bcd64b376b25f`; artifact is `59582` / `sha256:af54ab476f95b89d0f2e42dba8ffed7d6e749ab2035083b223fc9b7ffd3a7e2d`; Node evidence is `sha256:526980095febd669ac92cddea39ca68c06349d8fd8a187182d1aa1d0e6b55cc9`; independent evidence is `sha256:cb3ad7803da7fbb795ba8eaf0d0cc2cdd072fa47190352357ff40339a759d860`. Node rejects 28 and Python 26 attacks. The intermediate accounting remains 25/66 and 41 missing.

That `41` was then attacked as a possibly stale accounting claim. Four pinned Phase 0A artifacts contain 19 complete candidate documents whose canonical bytes, raw hashes, schema-body digests and authority-plan rows all agree. Admission V1 is correctly excluded because composed Admission V2 supersedes it; 18 other documents are current-closure members that were generated but never composed. Exact classification therefore becomes `18 available-not-composed + 23 actually unmaterialized`, not 41 absent bodies. Artifact is `44823` / `sha256:6190f7cd07b44b1e102e7b2af9011ea09640843f0955cb4577f87e1fb3cd36be`; Node evidence `sha256:107c4916d3d03f212fdce9634bed14c3b67ad0af3c36c50c7e317b25385ddbc1`; independent evidence `sha256:7f1a7a28af7da90b9e6607f3837638bab4aea58c3c2db43769fda373f98785fe`. Node rejects 22 and Python 20 attacks.

The append-only composition attack finally tested whether those 18 could enter registry accounting without mutating existing authority. Every prior document/digest/content row and all 66 closure rows must replay exactly; duplicate IDs, source/digest drift and false seal/Store claims fail closed. The resulting candidate has 43 documents and schema-body rows, 22 candidate content identities and exactly 23 remaining open documents. Source is `2354` / `sha256:b886fca4a8cb228e45d8be0c686fb80a1aa47c17535568827d451d45d3797713`; artifact is `118940` / `sha256:7bd6f9f2d969dcf624a3c597fdc4697c2a8748742c01b62bfac4d1ed260f02d3`; Node evidence is `sha256:e5a4bada2c50414495273289953e51fc4dbd77ef1a6e404cd879a16fc512c182`; independent evidence is `sha256:3920c5f6573a622b78c6bd1d578d1d2069c1053d58b84dd94689126f569b8e8e`. Node rejects 24 and Python 22 attacks. The candidate containers are not persisted as standalone schemas, no Store-issued ref/CAS epoch/definition seal exists and retained/product authority is still unchanged.

The next attack searched those 23 rows for full closed subschemas already embedded in proven candidates. It rejects one tempting false positive: CapabilityContract's `outputSchema` is a ProtocolSchemaRef descriptor, not the WorkspaceStorageAuditOutput body. Two roots are valid. InvocationDispatchKeyBody appears byte-identically in atomic and layered Invocation documents. InvocationTransition is reconstructed from exactly 12 discriminated payload branches that agree across AgentEvent, CommitEvent and CommitGroup; branch omission, reorder or discriminator collision fails. Strict AJV compiles both against the retained ImmutableContentRef closure, and independent Python reproduces the exact roots. Dispatch is `774` bytes / raw `sha256:87b342c5c66838d79111559d74ea137097ccff02ffbafbb969713f4457b4c2f6` / schema-body `sha256:8512bfff16ab92baf1f4ff4a6c05da002bf0250758eb996a8e0ba8bc8985b821`; Transition is `11639` / raw `sha256:a382c021e171e2e8b1d9a1c4e80fdc225a6b70a947f93cadf9ea09d22bdeaf4e` / schema-body `sha256:fe642af8eb3e128fc72abbb9e6d81e774c2f3e05effe19313990f2d402842e0f`. Append-only composition yields `45/66` and an exact remaining set of 21. Source is `3967` / `sha256:9733b5ee85ed6d21341083d605002c610ab5db3f7391cb3acd7b09d45428a5a9`; artifact `142359` / `sha256:34cb24c9ca4fb4a6b8ca8780db16f6c953f785499965ad6381f5b5f1abd283df`; Node evidence `sha256:c31275a7a394b92f921ad95c840a920619204bf9e9e27108e7e4abb9793db823`; independent evidence `sha256:444740f9548cb9572f7f6a47a8fe38f3f525ae7278c55a02b9db200fcdc7b074`. Node rejects 26 and Python 22 attacks. Persistence, Store, seal, retention and product readiness remain false.

The first source-authored attack then asks whether the remaining simple-looking interfaces can be generated from memory or nearby descriptors. They cannot. It pins the exact three declaration blocks for AgentCommandReceipt, CommandDedupeRecord and RequirementAttemptSelection plus the compiler source before compiling closed ASTs. AJV and a separate Python compiler agree on `984 + 2873 + 2211 = 6068` canonical bytes and all raw/schema-body digests. The one-item Evidence tuple remains exact, selected ImmutableContentRef branches remain closed, forbidden receipt fields remain structurally absent and source-only ID annotations do not leak. Append-only composition yields `48/66`, an exact remaining set of `18` and `27` candidate content identities. Source is `7766` / `sha256:d5b619e430c0abd2fa66a31c857236e353cc637ad8d9eba34b8e2dfac8205629`; artifact `148592` / `sha256:5367f8f5f59f9e696f41217c9da2a9bd791ee2b89ff91e374ba70c79ad7f6de6`; Node evidence `sha256:fcb0ca42aa9d6edb689f63eecee6f1e6f855ec12f522be05a9f52df44bd6d7b1`; independent evidence `sha256:d6fa926014136d436e3271fb78486f345640e684adf97c6732817dc02ccd3b4f`. Node rejects 27 and Python 23 attacks. The attack deliberately keeps ID-endpoint authority, standalone persistence, Store refs, definition seal, retention and product readiness false.

The evidence-foundation attack then targets a type-confusion risk that a generic digest regex would miss. EvidenceAdmissionKey must retain `projectorImplementationHash` as `raw-sha256`, not semantic `sha256`; EvidenceGraph must retain exactly one ordered node rather than a homogeneous expandable array. The pinned compiler and independent Python compiler agree on `2671 + 1885 = 4556` canonical bytes. Append-only composition yields `50/66`, an exact remaining set of `16` and `29` candidate content identities. Source is `5734` / `sha256:dcfcfa8289b70ed2780ea96e989c4c0a848440db8e3d0ba1400d412a6ddc2f24`; artifact `154913` / `sha256:d03e1da56fe65f094bb2db11b069805a0dae5e1ade0e9e9f10ff5bbcf5912b86`; Node evidence `sha256:e54a82663480b51e80092a8841f289dfe5a680db6098c9663db2a7d4bf020b11`; independent evidence `sha256:6d33f19686cca31f9a3d7f2cc22802aaa37f3c55a8c27a68b07586a74e38c745`. Node rejects 26 and Python 22 attacks. ID-endpoint authority, standalone persistence, Store refs, definition seal, retention and product readiness remain false.

The goal-foundation attack then checks whether the two authority-heavy Goal schemas can silently reinterpret shapes already fixed by the matcher cohort. They cannot: the source AST for `GoalAdmissionBinding.targetBinding` and `partialPolicy` must equal independently hard-coded cohort shapes before either compiler runs. This caught and corrected an initial temptation to put an instance-selected ref into the schema AST where the cohort contract requires the full retained `$ref`; exact content-kind narrowing remains a semantic binding-authority obligation instead of being smuggled into shape generation. GoalMinimum is `4841` bytes and GoalAdmissionBinding is `14519`; both compilers reproduce their raw and domain-separated identities. Append-only composition yields `52/66`, an exact remaining set of `14` and `31` candidate content identities. Source is `10934` / `sha256:976beea1c3ebbdbf1a820e421281eb990efab0a063c40b400fcb29f7585b13e3`; artifact `178451` / `sha256:a3635f306dda5e2d88ca78413ea7125ed9f60c203d945492f956ada63fcf1c26`; Node evidence `sha256:354193b8b4551f821f6c908ad3d911177381967300ccfe103080ecf19acc7a02`; independent evidence `sha256:a9d8dd1937a04ceecf56518817f2c97f1f89ece24288ae247f6ff51d50532fe1`. Node rejects 28 and Python 25 attacks. ID-endpoint authority, semantic ref-kind narrowing, standalone persistence, Store refs, definition seal, retention, matcher implementation and product readiness remain false.

The command-fingerprint attack then checks a different false-green path: compiling the generic review interface would leave `type`, `payload` and target/CAS structure wider than the accepted command. The tranche instead pins the 517162-byte atomic preflight and its exact 2267-byte AgentCommand document, then independently projects both accepted branches. Payload refs and target/CAS shape remain exact; command ID, correlation, accepted-context object and creation time cannot reappear; attachments remain an exact empty tuple. The output is `1970` bytes / raw `sha256:e4b15649d2982da922b1a6ec35830b90b42cdf40a95dd6c01c0c4f3882431f6a` / schema-body `sha256:dd55a50a92131f5d107bb9b88a923b7f2ca2fc92472b014e98fc4fd8c2dcb9f0`. Append-only composition yields `53/66`, an exact remaining set of `13` and `32` candidate content identities. Source is `4730` / `sha256:a8f1675a68b4743ba4421dc7814aee22649b9863d6f2f076acde8aafb1d7073e`; artifact `167166` / `sha256:97be93b19a4798326d858de820023091b9d4debb0ed1244835ade5da39172dad`; Node evidence `sha256:1b22064ad356f23956e36720e447592f4b37f3f51c960c80627604d69b8fe6e2`; independent evidence `sha256:eeb7e96b7d30e8b7691f1b827946456ce6177c340e1574850e789ae17227422b`. Node rejects 30 and Python 27 attacks. ID/binding authority, persistence, Store refs, definition seal, retention and product readiness remain false.

The protocol-error attack then tests whether a closed-looking enum can still admit impossible category/retryability/diagnostic combinations or leak local details. It pins the interface and exact 24-row table separately, parses the rows, and expands seven optional diagnostic pairs into 31 disjoint branches. A diagnostic is either fully absent or carries both digest and an exact retained opaque-bytes shape narrowed to diagnostic purpose and private/sensitive classification. Half-pairs, public/artifact diagnostics and every free-form message/path/cause/detail field fail structurally. The output is `18318` bytes / raw `sha256:c11aeb85149ac6dc360c0dfffe15552feff6e3bb9c8a89b0c2343a513e05a45c` / schema-body `sha256:7c8dafa1fbb1b2c80a71e89718028e2059bd1f080b16db4a34ece73f02ac91ee`. Append-only composition yields `54/66`, an exact remaining set of `12` and `33` candidate content identities. Source is `6754` / `sha256:033e776fb5f09d2c1d5762f91d4117bd6825b3b0970df34edb3b538fc6339db6`; artifact `191819` / `sha256:f681e928542adad29bbab9258b9eb950c65360aafcc23f3243c4764dd26d0f51`; Node evidence `sha256:e25e474f3d32ee11fa746b7d4f2cd1a3c57a33d24f16aaffe45d58d7ee33d252`; independent evidence `sha256:0c16679d459447bf684338c601820748721b7f5f73ae068578a47718c9738de1`. Node rejects 30 and Python 26 attacks. Trace ID authority, persistence, Store refs, definition seal, retention and product readiness remain false.

The selector/recipe attack then checks whether independently maintained claim and selector lists can drift or whether a plausible cross-product of value types and encodings can widen certification. The tranche takes the 28 claim members from one semantic profile, mechanically derives all selector IDs, and requires exact equality with the second profile. Selector emits only six paired branches, never the type×encoding cross-product; Recipe is narrowed to the capability's sole exact ID, projector and 28 unique digest set, retaining `raw-sha256` for executable identity. Selector is `10158` bytes / raw `sha256:c3f97896e3312e7cc881c70c83fe9691f390f446c6184d189d1f717018914835` / schema-body `sha256:d93e1bdb904e04d358140c0b9be865683ee2f29287b9f13fbba3a3966cf9cf70`; Recipe is `1201` / raw `sha256:a0628ae5009f8cd93fa6bf36d7d8b85bae3af08aab9eba4b12e65f6eff0007b5` / schema-body `sha256:bfbc1b746b8e616a2262318536780c1e135434d77d45dd79b7fb14bf4cc0ef3f`. Append-only composition yields `56/66`, an exact remaining set of `10` and `35` candidate content identities. Source is `5067` / `sha256:82f75d1dcc97dc93369aa8983bdd6cdb938d27cd7485f38ae1432c8205b5176e`; artifact `196828` / `sha256:a5b9559671ea4e09cc7281e4fd38c7f45b43361f22c087b4734604674669b8c7`; Node evidence `sha256:45fa153099baa6742d4850083097e07a955f6223d5158654f8759793b4e0d8f1`; independent evidence `sha256:9cf1ef608503fe3eb6db755c21922a3808602c19e4702977a559e073b41d6b21`. Node rejects 29 and Python 27 attacks. Claim-template bodies, ID/binding authority, persistence, Store refs, definition seal, retention and product readiness remain false.

The claim-template attack then targets the easiest place for a false fixed-suite claim: maintaining row IDs, selector semantics and predicates in separate lists. The tranche exact-pins the declaration, the fixed-suite paragraph and all 28 §9.4 table rows, independently parses them in Node and Python, and emits 28 ID-disjoint branches. It closes template version to `1`, each selector's source/pointer/type/encoding, each row-specific predicate, private classification, presentation key and the exact kernel-receipt/application-kernel settled+complete observation policy. It structurally rejects `condition`, `maxAgeMs`, embedded claim IDs, source/pointer/predicate swaps and policy weakening. The schema is `60830` bytes / raw `sha256:99ca66ac43e93d1c300e93b18e435aa619a7e588aacafb9724000688fc54d988` / schema-body `sha256:6a84181445fc506cf0f021741b96784fb8932b060aa0f47199e9565c94542a7f`. Append-only composition yields `57/66`, an exact remaining set of `9` and `36` candidate content identities. Source is `5245` / `sha256:f9daa74d4bb58e443a4b23b0025bede6163805cd5310e674dfe0517497a48bdc`; artifact `262388` / `sha256:cfd1143a2362ef8d04e08895b140d0dcaf5bc002db47ad171cb29e3b548b948c`; Node evidence `sha256:03c34d220dfbb1c74e642b399cd72191c6a7adbeebf250f07501c03be5186f5a`; independent evidence `sha256:9c927527166b9c27f4be68b8ca7def62d66d31203ac96bccbacad3867e92de79`. The direct schema rejects 28 semantic/structural attacks; artifact verification rejects 31 Node and 28 Python mutations. Cross-body digest equality and exact content-kind bindings are deliberately still false pending the generated binding-authority pass; persistence, Store refs, seal, retention and product readiness remain false.

The identity/receipt attack then checks two apparently unrelated but topologically leaf authority surfaces together. OpaqueIdProfile is not rebuilt from prose: it is an exact projection of the pinned definition's 23 random kinds, five semantic profiles and 117 endpoint rules, including uniqueness and primary-ID order. KernelReceipt expands completed plus diagnostic-absent/present cancelled/failed/unknown into seven disjoint branches. The first direct attack found a genuine schema bug: an unmodified retained opaque-bytes branch allows both diagnostic and artifact purposes. The generated receipt schema now narrows the embedded branch to `purpose='diagnostic'` and `private|sensitive`; completed cannot carry diagnostic/outcome fields, non-completed cannot inject result/proof fields, and a half-pair fails. Opaque profile is `44680` bytes / raw `sha256:ba11bd1ee3acf42fe4c630e8e694ebaf248fba76ae67668645b52544282689a0` / schema-body `sha256:2defa63f3e52e10f809ec102603900fd202b4887a565deb738bebdd8cfb9613c`; receipt is `12104` / raw `sha256:0d264961072b5c851a343af7b72ca42bf09dd783e912cc45e6818ea2392b4e68` / schema-body `sha256:98da5961a3630632d74f364887479b97b73e3c5cd0a97dd545306ce41ddfd332`. Append-only composition yields `59/66`, an exact remaining set of `7` and `38` candidate content identities. Source is `5817` / `sha256:54ccb684933ec367e9bbbd39b22f9f4a5c97e714221bbfdd7ab1ff1ee24b3c0d`; artifact `313284` / `sha256:5d9323441ea3a5061b14f50716479506dcf0ce8642665965660b34d70ac75135`; Node evidence `sha256:8e6f73b0b4ddedb239ff72ced9911e441042ddd82eb067d68756b101f5de64a2`; independent evidence `sha256:3dbe6ef85b7a08d9f6b3155c0db3ce00e5ff30bd336b0f4f47e45b8a4368f01d`. Direct schemas reject 17 attacks; artifact verification rejects 27 Node and 26 Python mutations. Exact completed-ref content kind/schema/digest equality remains outside shape validation and deliberately false pending receipt binding authority; persistence, Store refs, seal, retention and product readiness remain false.

The storage proof/output attack then tries to turn partial or budget-aborted traversal into a completed-looking audit. It fails because proof disposition is a 14-branch closed union: completed, cancelled, the exact five non-limit aborts and each of eleven limit reasons, with one matching witness only. Large counters cannot round through JSON numbers, implementation hashes cannot be relabelled semantic digests, and terminal broker resources must be exact. A second cross-field attack tries to hide skipped/error/cloud-placeholder observations by omitting diagnostics; both proof and output now require the complete diagnostic ref+digest pair iff any such counter is positive and forbid it iff all are zero. The output preserves five pinned support schemas and an exact 18-value abort vocabulary. Proof is `25711` bytes / raw `sha256:6f6a22190d8dba7551d87d670feaec006cd14cc8b343a9d71d48a60c4ea48ae3` / schema-body `sha256:3fffd836b29d8910a6f7a3978294b8bf8ccf0f1594b26c94c0568b70f6a8794e`; output is `6259` / raw `sha256:04778c1c1645cd7f9aa3228ccfd9ca70985d4ca3886ceabeda2054d4d84aa7c8` / schema-body `sha256:7b9f8043ffde35bbb34d5fe75cec6223ff1a6507fda8e08c4f7d0eac594e01bd`. Append-only composition yields `61/66`, an exact remaining set of `5` and `40` candidate content identities. Source is `8269` / `sha256:089ee7f06a6628628e13260f26ed2e7d03fe2374e50c004f7ff2dd8607871ae5`; artifact `256724` / `sha256:92f6d8878fbca1592c6f7fa07865c21def9b31235e4ca56951483c18dbaef2cc`; Node evidence `sha256:396c63e7ff60e3acf1e200b4291db33bb672c584576d3884bc2cde4005821103`; independent evidence `sha256:dcec6e4d588ee777ce4ec5a46ba832949ee79ff18fe897ab4c08e764d33041f9`. Direct schemas reject `9+7` attacks and both artifact implementations reject 25 mutations. Cross-object equality and exact output-ref bindings deliberately remain false pending generated binding authority; persistence, Store refs, seal, retention and product readiness remain false.

The goal/presentation attack next tries to exploit list widening and localization drift. A Goal with 27 claims, reordered claims, a second source candidate, reordered constraint kinds, an ambient normalized input or an extra condition all fail. The exact claim shapes are projected from the already pinned 28 ClaimTemplate branches, not retyped from prose. Presentation cannot drop/reorder keys or templates, introduce an unknown token, delete a denial row, add detail to a no-detail row, place braces in localized messages or relabel the renderer hash as semantic SHA-256. Its six templates and 54 denial slots are exact ordered tuples. The audit explicitly does not claim that JSON Schema proves each allowed token occurs exactly once or that repeated retained refs/digests are equal; those remain generated binding/instance obligations. Goal is `53885` bytes / raw `sha256:f5569a00d8373efc4976b91d61eca564393a8538b6e83a940c492bb937ae13f6` / schema-body `sha256:045769a38430829ffd6791fcf93f033f908027bc78d73982bded6ffe9c3c58b6`; presentation is `25189` / raw `sha256:22af1dde508c6b2c701ed2a5c2797135845daaba56939819b8f780b7c210ab9b` / schema-body `sha256:fb2f0010a2880d5b0e3ec69ae766eff5975dd85544a12f687d34d15a2e7e3a63`. Append-only composition yields `63/66`, exact remaining EvidenceView, StructuredResult and ProtocolFeatureSchemaManifest, and `42` candidate content identities. Source is `7090` / `sha256:d0a936c6e88a136b96add22f4190a0da535fbd36a7d2e2d9121a36787253c34d`; artifact `315347` / `sha256:d87be485a343d05ec94a2fbf8cea6bc3054d69564fe966eb29e386e7d806e3b6`; Node evidence `sha256:9e315c6750c15022882586d19291179d15e9215655c24d6fc0a3d3e9e633ba6d`; independent evidence `sha256:694dbbc1fde44370791beb2ece3ab50eda5da5f4e1b24684f218c385720bfb54`. Direct schemas reject `6+8` attacks and both artifact implementations reject 22 mutations. ID/binding authority, persistence, Store refs, seal, retention and product readiness remain false.

The evidence/result attack then targets the last public projection shapes before the manifest. A blocked view/result cannot smuggle one certified scalar or presentation key; a verified result cannot add an unresolved denial; partial/blocked cannot omit all denials; fields cannot reorder or rename a presentation key. Locale, status and template form six closed branches, so changing any one without the other two fails. Disclosure keys are exact tuples (`16`, `16+@unresolved`, or only `@unresolved`), renderer hashes cannot be relabelled semantic digests, and both artifact arrays remain exact empty. The schema intentionally does not claim equality of repeated certificate/ref/digest/value fields, sorted unresolved semantics, or exact disclosure parameters: those remain executable binding-authority obligations. EvidenceView is `37620` bytes / raw `sha256:bc5c77f641503fbec3d97e4887247d1c2a8eb957f4d8eca830034a0a4c31e039` / schema-body `sha256:4dbf6fe31ca8468e5f6b60375b6ba0e77245f24c2558588458f501f0bfde4ed8`; StructuredResult is `69854` / raw `sha256:8af0674741a4fdf97d93323969ae2d44f2dca3e3ef210525bb9214c7be26fd06` / schema-body `sha256:50297c76ea10796f6f7611659eeb32ffa5c48c161fd641e5477494ac6d406aa8`. Append-only composition yields `65/66`, exact remaining ProtocolFeatureSchemaManifest and `44` candidate content identities. Source is `5489` / `sha256:9abd948558b6300d6a3528e92fe10795f6c6702f308fd01f723fccd678af9062`; artifact `353583` / `sha256:71be54a10765a38850724c082658d57678ffc80f2b2d9b04e7f7036ccfad67a6`; Node evidence `sha256:81d9a975c125c67852823388472a7ef271efb119956565033350fb37d99c41c4`; independent evidence `sha256:e4c6265ac8b51918b691d9821f1ca3d922fa6a8d406cc905cbb4ff42f9a3756e`. Direct schemas reject `8+8` attacks and both artifact implementations reject 24 mutations. ID/binding authority, persistence, Store refs, seal, retention and product readiness remain false.

The final structural attack asks whether `66/66` can be reached by inserting a loose manifest shell. It cannot: the generated ProtocolFeatureSchemaManifest schema has exact ordered tuples for all 66 schema IDs/versions, row-matched public `json-schema` described IDs, 50 digest domains and 66 closure-derived content-identity rules. Dropping or reordering a schema/domain/content row, changing described ID/version/classification/content-rule ID, widening role or adding an ambient field fails. Digest/binding/guard/state/commit item shapes are closed and bounded, but the audit explicitly refuses to call their eventual members, roles, repeated digests or Store object identities authoritative until the separate binding/seal/Store stages. The schema is `168385` bytes / raw `sha256:68b00a84969b3e47c6d6dd75ab9e3a051802ba1812f4490e8b9b82e87d7ecf31` / schema-body `sha256:f3efcc38e020fe70e744d98f69259e1aad944125bdb731dfbea45bca1bf93127`. Append-only composition reaches `66/66`, missing `0`, and `45` candidate content identities. Source is `4322` / `sha256:35c151b4e10d15740be5a9b47aa032437979074f45f4ab74bb1ffed8fd495631`; artifact `435940` / `sha256:b6cc554ad4824e0261ee511ee19bc636934b858dd6313a599136410d3e18cae0`; Node evidence `sha256:204b31f3484ec3c1a3fd381a047e321ac2e4dfd623aa8a7e5be21b4ad41eba86`; independent evidence `sha256:050ddf4cb39a90875b241d1593ee86e4e91ff1f65603cda6eb3fbada7277a8aa`. Direct schema rejects 12 attacks and both artifact implementations reject 23 mutations. Manifest instance, exact rule membership, ID/binding authority, Store refs, seal, retention and product readiness remain false.

The next attack found that even an exact V1 Manifest instance would be a false green. Its legacy
binding-rule vocabulary cannot retain the actually executable `148/1620/30` authority, the
Event+Completion ABI covers only `123/1527/26` and explicitly excludes retained compatibility,
and RuntimeFeatureSet V1 has no ABI/profile root. The versioned alignment oracle therefore rejects
V1 sealing and projects an exact `66 → 66` replacement: three roots change, 63 schema IDs remain.
The only admitted chain is `RuntimeFeatureSetV2 → ManifestV2 → ProtocolAuthorityProfileV1`;
the profile owns all 3617 ID rules plus unified programs/ABI, contains no Manifest ref/digest,
Manifest binds it by Store ref/digest, and RuntimeFeatureSet binds only Manifest. Node rejects 20
and independent Python 22 false-seal/count/cycle/ambient/mixed/partial mutations. Source/artifact
are `4893/9582` bytes with digests
`sha256:0736b023e4d8174b3efd3f3da73f134619cf64654b08fec16aa0ac69a2b0d063` /
`sha256:5918ecff921a1fb6795ca71f92a30c9839115b7748a672be99edad27361eef96`.
This is a selected topology, not the missing unified ABI, replacement schemas or Store proof.

The unified-ABI follow-up closes the first of those gaps without normalizing legacy programs into
a fictitious new envelope. A discriminator selects one of three exact program-set dialects before
decode; retained endpoints forbid a role field, candidate endpoints require their declared roles.
The full index is `148/1620/30`, has zero duplicate program IDs and binds all `2640` endpoint
occurrences. Overlapping operation names retain both exact operand forms, retained-only operations
are first-class, and no engine default may infer compatibility. Node attacks 23 and independent
Python 25 program-set/index/form/count/ambient/coercion/partial-activation/readiness mutations;
all fail. ABI/artifact digests are
`sha256:d507ec656486aa45f761dd9aab873227001418f5f97c73a0580473a2538f9956` /
`sha256:633d07f559c5045026823c19140621fe6081ce1eb8c59ff919e56ade138b8897`.
This still does not instantiate AuthorityProfile or permit activation.

The focused compiler suite now passes `317/317`; the endpoint oracle agrees `117/117`, the exact `40/30/44` owner/occurrence/trace grammar, the `79` direct payload owner rows, all `1803` payload/ref projections, the independently reconstructed `15/17/11/9/depth-1` retained-owner closure, the `4 documents / 6 variants / 2 owners / 41 endpoints / 5 imports` ingress surface, the `16/16/16/0/3-layer` remaining graph, the full `16 owner documents / 1089 owner endpoints / 16 digests` atomic inventory, the required `19 documents / 3612 endpoints` joint topology, the `1089+5=1094` owner lowering, the `3612+5=3617` joint lowering, the `114/1376` Event binding lowering, the `9/151` Completion binding lowering, the `123/1527/26` combined ABI and `5/5` retained semantic profiles with `2/5` exercised profiles. The source oracles reconstruct their respective branch, owner, projection, digest, allocation, classification, execution and application-boundary evidence; the ABI oracle rejects 12 widening/partial-activation attacks. The ingress simulation passes `4` accepted schema instances / `13` structural rejections and `2` binding positives / `6` rejections; the layered simulator passes `68` accepted instances, `1175` structural and `28` semantic rejections, `133/133` owner-binding checks and all `915` projections. The Event simulation passes `5` accepted schema instances, `11` rejected schema mutations, `3` ordinary positives / `2` rejections, `3` CommitGroup positives / `8` rejections and `2` trace positives / `7` rejections. The Invocation simulation derives `12` lifecycle transitions plus one receipt-link fact, reaches `settled@5` with one stable dispatch call and rejects `11` lifecycle/key/receipt mutations. The retained binding oracle agrees `25/93` plus `4/4` value fixtures; the Event binding oracle executes `7` linked programs and rejects `7` mutations; the Completion oracle executes all `9` programs and rejects `10+12` attacks; the logical Store lab passes `12` scenarios and the SQLite full-cohort lab passes process-crash/concurrency/integrity/backup proof. The schema-subset oracle passes `100/100` simulations (`34` accepted, `66` rejected) plus `4/4` bounded-array and `5/5` exact-tuple primitives, canonical vectors pass `6/6`, typecheck passes, full Vitest passes `214` files / `2391` tests with only `1` file / `4` tests skipped, and compile followed by byte/digest verification passes. Candidate definition identity is `sha256:103055032f7abd4d5212057508eaa05637627940b8b6daf7d6e60f584e7a7f08` (raw `511753` bytes / `sha256:6b737363a9cff56158da71a75296280916c631531fc2cd4107a90cb46c7c2610`); compiler source is `417373` bytes / `sha256:fe738cc60bedb2cb8bed65234c6f865da2d937e81aa7e2cb0d12d404979a1ff8`, compiler bundle pin is `sha256:b4c1e4574aa6686fdbecbeaf7228b8b39714f9888c61a16e2bbf3947696ec5e1`, and bootstrap pin is `sha256:fb0c1af64e1815cb06da18d921ecd186ee327e0d8d35b65a0f4e2fe329bbbea6`.

This evidence changes the project from prose-only design to a **partial Phase 0 machine candidate**, but does not rewrite PASS 3 and is not an independent external generated-artifact review. The Python oracles use independently implemented algorithms; they are still project-authored evidence. The compiler deliberately emits `conformanceReady=false` and refuses `--require-conformance`. Event source, projection parity, occurrence/trace map, CommitGroup, all 11 owner schemas, every joint candidate rule, all 114 Event programs and all 9 Completion programs now have closed machine sources, one combined candidate ABI and process-crash SQLite cohort evidence, but remain outside retained structural/binding/Store authority. The machine gap report keeps 0A open for bundled meta-schema identity, final role/content-identity/digest/binding-rule authority, retained Store-issued ProtocolSchemaRefs, retained engine adoption, power-loss/torn-write proof and independent external generated-artifact review. It keeps 0B–0E blocked for the remaining 44 retained schema slots, RuntimeFeatureSet manifest/capability targets, full state/commit closure, event/claim fixtures, storage broker proof, completion/presentation proof and measured three-store evidence. The next safe work is the exact retained manifest/engine promotion package followed by power-cut-capable backend validation on disposable `E:` storage; no runtime/product/Safe route was enabled.

---

## 14. Owner correction after live V2 problem review — not an independent PASS

The 2026-08-28 review of checkout AgentTask/Turn stores, current routing/parser code and real-model benchmark artifacts found product-goal drift: schema/read closure had become the center of the program even though it does not reach the major V2 failures or establish agent quality. This is an owner-directed architecture correction, not PASS 4 and not independent closure.

Corrections:

1. `agent-core-read.v1` remains a valid protocol/durability substrate but is no longer the Astra product closure target.
2. New normative `MONARCH_ASTRA_V3_AGENT_CORE.md` defines `astra-core-experience.v1`, P01–P20, mandatory services, four representative capability packs and full-task/efficiency gates.
3. Decision admission is changed from “strict syntax equals strict semantics” to branch-constrained generation plus bounded benign canonicalization followed by strict semantic/authority validation.
4. Deterministic recipes and registered workflows precede model planning; a simple exact task cannot require a prose planning turn by default.
5. Context, resource-aware single-slot scheduling, partial recovery, Catalog pinning, workflow graphs and broad completion are mandatory product-foundation owners rather than deferred optional prose.
6. A machine-readable problem map and acceptance corpus (expanded after Agent Core
   red-team PASS2 from A01–A30 to A01–A35) validate architecture coverage while
   explicitly keeping `productImplemented=false` and every fixture non-executable.

This correction reopens the broad architecture object for artifact-level review. It does not invalidate prior protocol findings, does not authorize runtime import and does not claim that P01–P20 are implemented.

---

## 15. Agent Core / Computer Use adversarial PASS 3 — final independent pass

После замыкания Agent Core candidate-definition и Computer Use proof package третий и последний
разрешённый independent reviewer проверил frozen machine object read-only. Runtime/product,
Windows input, сеть, модели, пользовательские данные, production persistence и Monarch Safe не
открывались. Вердикт frozen object:

```text
FAIL
P0: 0
P1: 6
P2: 1
```

| ID | Severity | Frozen failure | Post-review correction candidate |
|---|---:|---|---|
| AGENTCORE-PASS3-P1-01 | P1 | latest observation head существовал только in-memory | isolated SQLite WAL/FULL proof: crash-before/after-commit, reopen, interprocess CAS, replay/corruption/rollback |
| AGENTCORE-PASS3-P1-02 | P1 | Stop классифицировал только одну переданную reservation, а не все ранее helper-accepted attempts | один serialized arbiter ledger; Stop связывает полный classified attempt set и переводит каждый accepted attempt в outcome-unknown |
| AGENTCORE-PASS3-P1-03 | P1 | closed records не имели полного type/range contract | typed closed schema subset, safe integer bounds, null/array/object/float/overflow negative attacks |
| AGENTCORE-PASS3-P1-04 | P1 | happy path подставлял evidence-строки вместо concrete bodies | concrete Reservation/Attempt/Receipt/fresh Observation/PostconditionVerdict/TerminalTransition bodies |
| AGENTCORE-PASS3-P1-05 | P1 | A39/A41 simulator не материализовал каждый required artifact body | A39 exact 8-artifact closure × 20 rows; A41 exact union; независимое равенство с fixture `requiredArtifacts` |
| AGENTCORE-PASS3-P1-06 | P1 | candidate seal не закрывал transitive executable dependencies/toolchain | recursive local dependency closure: 53 executable sources + package.json/package-lock.json |
| AGENTCORE-PASS3-P2-01 | P2 | manifest/root publication имела TOCTOU и non-atomic mixed-generation window | immutable generation manifest публикуется до atomic root rename; root — единственная commit-точка |

Post-review mechanical evidence: Computer Use `12/12`, source attacks `40/40`, independent
artifact attacks `55/55`, durable-head `9/9` + `3` subprocess crash points, candidate seal
Node/Python attacks `19/17`, focused proof suite `2/2` PASS за `343.21s`, полный Agent Core
aggregate `45/45` files / `87/87` tests PASS за `2079.14s`.

Эти результаты подтверждают, что известные контрпримеры воспроизводимо закрыты текущими
project-authored proof tools. Они **не переписывают независимый verdict**: четвёртого pass не
было и пользователь ограничил серию тремя проходами. Поэтому текущий статус остаётся
`post-PASS3 correction candidate`; `shadowImplementationAuthorized=false`, product/runtime/release
readiness не заявляются.

### Post-audit architecture extension: ResourceModelHost, не новый independent pass

После PASS 3 owner-directed architecture work отдельно атаковал P15/A24/A25 — отсутствие в V2
единого владельца model residency generation, RAM/VRAM reservations, warm/cold swap и inference
lease lifecycle. Новый ResourceModelHost corpus pinned к exact bytes трёх реальных V2 roots и
прошёл `10/10` isolated fairness, aging, deadline, cancel, warm-affinity, swap, overcommit,
load-failure и crash/rebind сценариев. Source verifier отверг `25` weakening attacks, независимо
реализованный Python verifier — `29` resealed artifact attacks. Source/artifact/evidence:
`sha256:afa1c27b02e4a66454ff53835287156404eb4a349dc16742aea9adf56a0a8359` /
`69289` canonical bytes / `sha256:29aaec7320156d20217848867acd8ac97f078526f99e822930e0aa61765b1c1a` /
`sha256:72e6760cd7d8e0c43096a6be128ef3024f1c7fd5960d01b4759d4d7866cc7f74`.

Это project-authored mechanical evidence, **не PASS 4** и не изменение frozen verdict. Оно не
исполняет llama.cpp/CUDA host, product route, модели, сеть, Windows input, production persistence,
installed hardware matrix, user data или Monarch Safe. До отдельного owner decision
`shadowImplementationAuthorized=false`; итог полного aggregate этого tranche фиксируется в
нормативном Agent Core документе и cumulative `0.3.0` changelog: `46/46` files, `89/89` tests
PASS за `2109.68s`.
