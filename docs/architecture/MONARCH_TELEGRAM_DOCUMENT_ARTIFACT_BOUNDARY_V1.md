# Monarch Telegram Document / Artifact Boundary V1

Статус: **DESIGN + ACTIVE BOUNDED TEXT INGRESS/EXPLICIT ARTIFACT EGRESS; EXTRACTOR DISABLED**

Цикл: Monarch `0.3.0`

Дата: 2026-09-01

## 1. Зачем нужна отдельная граница

Telegram ingress уже принимает изображения, voice note и узкий product slice строгих
UTF-8 TXT/Markdown/JSON. `OscarAttachmentStore` сохраняет их как immutable payload,
answer-only отделяет text от image lane, а Agent Runtime получает локальное
`oscar.document.observe` user-assertion. Простое добавление PDF/DOCX в MIME allowlist
по-прежнему неверно: неизвестный parser стал бы неявным authority.

Обратный путь ещё опаснее. Agent artifact — локальное доказательство/результат, но не
разрешение передать байты внешнему Telegram API. `telegram.api.call(sendDocument)` не
может быть generic мостом из локального path: JSON-команда не получает filesystem
handle, а будущая доставка обязана иметь отдельный data-egress permit.

## 2. Неизменяемые инварианты

1. Telegram metadata не доказывает тип файла; MIME, extension, declared size и bytes
   проверяются вместе до Turn admission.
2. В V1 text projection разрешены только `text/plain`, `text/markdown` и
   `application/json`: текущий product projection максимум 32 KiB, строгий UTF-8,
   без NUL. JSON дополнительно
   полностью парсится.
3. PDF и DOCX узнаются по bounded metadata/signature, но возвращают
   `extractor-required`, пока отдельный pinned local extractor не создаёт receipt с
   version/hash/limits. Их байты не передаются vision runtime и не превращаются в
   строку «на удачу».
4. Document text всегда `untrusted-document-content`, `instructionsAllowed=false`.
   Он может дать наблюдение, но не меняет Goal, Policy, Approval или capability input.
5. Persistent bytes остаются immutable и связаны с conversation/privacy/source/digest;
   zero-retention использует только volatile lifetime.
6. Local artifact egress допускается только для `kernel-verified-task-artifact`, который
   принадлежит exact Telegram Turn/actor и имеет opaque `agent-artifact:*` reference.
   Абсолютный/относительный path в permit запрещён.
7. Egress требует отдельного one-shot approval scope `telegram.artifact.send`, exact
   chat/user/pairing epoch, artifact id/digest/size/MIME/name и срок не более 10 минут.
8. Permit подтверждает право одной попытки, не факт доставки. Success создаётся только
   из Bot API receipt, связанного с permit digest. Durable state проходит
   `offered → attempting → delivered`; crash/error после `attempting` становится
   `uncertain`, и runtime запрещает автоматический retry, чтобы не создать дубль.
9. Monarch Safe, secrets, произвольные workspace paths и артефакты другого Turn не
   обнаруживаются и не принимаются generic-каталогом.

## 3. Ingress state machine

```text
Telegram document metadata
  -> bounded getFile/download
  -> name + declared size + MIME + extension + signature
  -> existing-image-lane | admitted-text | extractor-required | rejected
  -> immutable attachment receipt
  -> trusted local projection receipt
  -> untrusted observation
  -> ordinary Oscar Turn / Agent admission
```

`extractor-required` — terminal user-visible refusal для текущего product slice, а не
fallback к модели. Следующий extractor slice должен отдельно закрыть PDF page/byte/time
limits, encrypted/malformed/bomb fixtures, process cancellation, temp cleanup и package
license/update provenance. DOCX требует ZIP central-directory ceilings и запрета external
relationships/macros; переименование ZIP в `.docx` недостаточно.

## 4. Artifact egress state machine

```text
verified Agent artifact
  -> exact Telegram actor/Turn ownership check
  -> bounded artifact descriptor (no path)
  -> one-shot user approval
  -> durable EgressPermit + frozen bytes digest
  -> Bot API multipart attempt
  -> durable attempt/outcome receipt
  -> permit consumed exactly once
```

Ни completion summary, ни наличие `artifactIds`, ни origin запроса из Telegram не дают
автоматического согласия вернуть файл наружу. Повтор после uncertain network response
должен отображать неопределённость либо восстанавливать server receipt; молчаливый
`sendDocument` retry может создать дубль и поэтому запрещён до outbox design.

## 5. Integration seams

- Telegram transport: новый bounded document metadata/download adapter рядом с image
  intake, без расширения generic `/api`.
- OscarAttachmentStore V1: текущий narrow slice проверяет image signature либо строгий
  text MIME/extension/UTF-8/size; отдельный typed parser receipt остаётся обязательным
  для будущего PDF/DOCX extractor.
- Oscar coordinator: image → vision observation; text → deterministic local text
  observation; PDF/DOCX → unavailable до extractor receipt.
- Agent Runtime V2: attachment-influenced tasks сохраняют `all-effects` approval.
- Astra V3: позднее импортирует immutable refs/receipts, но этот документ не включает
  product/shadow runtime и не создаёт V3 authority.
- Egress: завершённый verified Telegram task предлагает до трёх opaque artifacts.
  Нажатие exact inline-кнопки служит one-shot user approval; Application повторно
  проверяет Turn/task/artifact/checksum/workspace realpath, замораживает bytes в permit,
  а Telegram пишет outbox state до multipart `sendDocument`. Raw path не покидает host.

## 6. Обязательные acceptance gates

- metadata/extension/MIME/signature confusion и declared-size lie;
- invalid UTF-8, NUL, oversized text/JSON, JSON parse failure;
- PDF/DOCX fail closed без extractor;
- ZIP bomb/external relationship/encrypted PDF fixtures перед включением extractor;
- immutable replay: identical bytes → identical receipt, changed bytes → reject;
- document prompt injection остаётся observation data и не меняет effect input;
- cross-chat, rotated pairing, stale approval, wrong Turn/task/artifact/digest/MIME/name;
- absolute/relative path, Safe-like ref, unknown artifact origin и bytes mismatch;
- crash before attempt, after remote accept/before local commit, and replay;
- packaged clean-Windows run и owner-authorized live Telegram test.

Изолированный executable contract: `scripts/architecture/simulate-telegram-document-artifact-boundary.mjs`.
Он проверяет admission/permit/outbox invariants. Product text integration и explicit
verified-artifact egress реализованы узко; PDF/DOCX ingress extractor остаётся открытым.
