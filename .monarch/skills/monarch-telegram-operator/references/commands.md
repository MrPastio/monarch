# Telegram control surface

- General: `/start`, `/help`, `/status`, `/task`.
- Local intelligence: `/security`, `/skills`.
- Approvals and identity: `/pending`, `/whoami`.
- Reminders: `/remind`, `/reminders`, `/cancel`.
- Rich output: `/poll`, `/table`, `/api`.
- Access control: `/unlink`, `/lockdown`; resume is local-only.

Pairing is private-chat-only by default, expires after 15 minutes, and blocks one `chat_id + user_id` for 30 minutes after five failed codes. Do not weaken these defaults for convenience.
