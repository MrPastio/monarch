# Подпись кода Monarch (Windows)

## Что уже сделано в сборке

- `installer/code-signing.ps1` — вся логика подписи: SHA-256, RFC 3161 timestamp,
  3 попытки при сбое timestamp-сервера, проверка `Valid` + наличие timestamp +
  совпадение отпечатка сертификата.
- `build-offline-payload.ps1` подписывает `Monarch.exe` (лаунчер) **до** записи
  его хэша в `payload-manifest.json`.
- `build-installer.ps1` через Inno Setup (`SignTool=monarch`,
  `SignedUninstaller=yes`) подписывает `Monarch-Setup.exe` и деинсталлятор,
  затем ещё раз проверяет подпись готового установщика.
- `release-stable.yml` передаёт настройки из repository variables / secrets.
- Без настройки (`MONARCH_SIGN_MODE` пуст) сборка идёт как раньше, без подписи.
- Тест контракта: `tests/release/code-signing.test.ts` (входит в `npm run release:test`).

Проверено 2026-09-26 временным самоподписанным сертификатом: signtool подписывает
и ставит timestamp, недоверенная цепочка и чужой сертификат отклоняются,
Inno вызывает обёртку `sign-file.ps1` и прерывает сборку при отказе.
Позитивный путь с доверенным сертификатом не проверен — сертификата пока нет.

## Настройка

| Переменная | Значение |
|---|---|
| `MONARCH_SIGN_MODE` | `none` / `thumbprint` / `command` |
| `MONARCH_SIGN_CERT_SHA1` | отпечаток сертификата в `Cert:\CurrentUser\My` (режим `thumbprint`) |
| `MONARCH_SIGN_COMMAND` | командная строка с `{file}` (режим `command`, хранить в secrets) |
| `MONARCH_SIGN_TIMESTAMP` | URL timestamp, по умолчанию `http://timestamp.digicert.com` |
| `MONARCH_SIGN_REQUIRED` | `1` — сборка падает, если подпись не настроена |

Локально с токеном / Certum SimplySign / SSL.com eSigner (сертификат виден в
хранилище Windows, ключ не покидает HSM):

```powershell
$env:MONARCH_SIGN_MODE = 'thumbprint'
$env:MONARCH_SIGN_CERT_SHA1 = '<40 hex>'
$env:MONARCH_SIGN_REQUIRED = '1'
.\installer\build-installer.ps1
```

В CI (облачный HSM или Azure Artifact Signing через `signtool /dlib`):
repository variable `MONARCH_SIGN_MODE=command`, secret `MONARCH_SIGN_COMMAND`,
после первой успешной подписанной сборки — variable `MONARCH_SIGN_REQUIRED=1`.

## Почему не подписываются runtime/environment

Деревья `runtime` и `environment` зафиксированы байт-в-байт в
`payload-version-contract.json`. Подпись с timestamp каждый раз даёт новые
байты, то есть ломает неизменяемый контракт и требует новой версии рантайма
на каждый релиз. `node.exe`, Python и VC-runtime уже подписаны своими
издателями; SmartScreen проверяет скачанный файл с Mark-of-the-Web — это
`Monarch-Setup.exe`, а распакованные файлы метку не получают. Если Defender
начнёт ложно срабатывать на неподписанные `.pyd`/`electron.exe`, правильный
путь — выпустить новую версию runtime, подписанную один раз, и зарегистрировать
её хэш в контракте, а не подписывать на каждой сборке.

## Что нужно от владельца (не автоматизируется)

1. **Сертификат.** Для частного разработчика вне США/Канады Azure Artifact
   Signing недоступен. Реалистично: OV от Certum (есть дешёвый Open Source
   Code Signing, если репозиторий публичный) с облачным SimplySign, либо
   SSL.com eSigner. EV не даёт мгновенной репутации с 2024 года — не переплачивать.
   Покупка, KYC и выпуск — только владелец.
2. **Один издатель навсегда.** Репутация SmartScreen привязана к сертификату;
   при продлении какое-то время подписывать релизы обоими.
3. **Microsoft Store.** Единственный путь без предупреждения с первого дня.
   Для Monarch подходит отправка существующего Win32 EXE-установщика
   (Partner Center → «EXE or MSI app»): нужен аккаунт разработчика,
   подписанный установщик и тихая установка (`/VERYSILENT` у Inno есть).
   MSIX не подходит: контейнеризация мешает самообновлению лаунчера
   (`swap-launcher.ps1`) и записи в `E:\MonarchApp`.
4. **Ложные срабатывания Defender** — отправлять свежий `Monarch-Setup.exe`
   на https://www.microsoft.com/wdsi/filesubmission (Software developer →
   Incorrectly detected). Требует входа в аккаунт Microsoft владельца.
