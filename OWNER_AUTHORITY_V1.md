# Owner Authority v1 — активация и перенос

## Если Monarch просто перемещён или обновлён

- Тот же ПК, тот же Windows-аккаунт и сохранён `%APPDATA%\Monarch\authority` — ничего переносить не нужно. Полностью перезапусти Monarch и проверь `Контроль → System → Owner`.
- Новый ПК, другой Windows-аккаунт, переустановка Windows или потерянный authority-каталог — это новое устройство. Старый entitlement и private key не копируются.

## Новый ПК или первая активация

1. Открой `Контроль → System → Активация и перенос Owner`.
2. Нажми **Создать запрос**, затем **Экспортировать запрос**.
3. Передай issuer-машине только `device-request.json`.
4. На доверенной issuer-машине выпусти новый entitlement:

   ```powershell
   Set-Location "<корень исходников Monarch>"
   node .\scripts\owner-authority.mjs issue `
     --request "X:\OwnerTransfer\device-request.json" `
     --out "X:\OwnerTransfer\owner-entitlement.json"
   ```

   Без `--expires` entitlement бессрочный. Vendor key остаётся только в выделенном внешнем каталоге issuer-ключей, заданном в `scripts/owner-authority.mjs`, и никогда не переносится на целевой ПК.

5. На целевом ПК нажми **Импортировать entitlement** и выбери точный `owner-entitlement.json`.
6. Нажми **Полностью перезапустить**. Обычный reload страницы недостаточен.
7. После запуска badge должен показать `Owner · signed-device-entitlement`; профиль — `full-local + on-request`.

## Source-workspace fallback

Если работаешь из исходников, запрос можно подготовить командой:

```powershell
Set-Location "<корень исходников Monarch>"
npm run owner:device-request
```

Установленная сборка этого не требует: создание, экспорт и импорт доступны в Control/System.

## Никогда не переносить

- `device-private-key.dpapi`;
- весь `%APPDATA%\Monarch\authority` на другой ПК/аккаунт;
- vendor signing key;
- runtime proof/envelope;
- старый entitlement как способ активировать новое устройство.

Неверная подпись, другой fingerprint, истёкший entitlement, partial/corrupt device identity оставляют режим `Public`. Monarch не перегенерирует повреждённый keypair автоматически.

Полная архитектура и диагностическая матрица: [docs/architecture/OWNER_AUTHORITY_V1.md](docs/architecture/OWNER_AUTHORITY_V1.md).
