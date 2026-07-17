---
name: monarch-telegram-operator
description: Configure, diagnose, or control the fully local Monarch Telegram bridge. Use for pairing, Bot API calls, reminders, remote tasks, pending approvals, rate limits, pairing abuse, revocation, lockdown, and Telegram security or status UI.
---

# Monarch Telegram Operator

1. Keep the bot as a transport into the same Monarch Kernel; never create a parallel permission or execution path.
2. Never expose the bot token or pairing code in logs, screenshots, reports, memory, or chat history. Rotate a code immediately if it was exposed.
3. Require a paired `chat_id + user_id`, rate-limit all inbound messages, and bind confirmation callbacks to the originating user, chat, request, and TTL.
4. Restrict generic Bot API chat targets to locally paired chats. Reserve polling, webhook, logout, and managed-token methods for the bridge.
5. Use `/lockdown` for immediate remote shutdown. Resume only through local Monarch Control after review. Use `/unlink` or `telegram.pairing.revoke` to remove access and orphaned reminders.
6. Verify status, pairing count, remote pause state, and audit evidence after control changes.

Read [references/commands.md](references/commands.md) when changing commands or the Control UI.
