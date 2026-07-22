# Monarch Releases

This public repository is the distribution boundary for Monarch. It contains signed channel metadata, detached signatures, public release notes, and immutable GitHub Release assets. It does not contain Monarch source code, private collaboration history, local data, models, secrets, or signing keys.

Canonical stable metadata:

- `channels/stable/manifest.json`
- `channels/stable/manifest.sig`
- `contracts/channel-manifest.schema.json`
- `contracts/keyring.schema.json`

The channel files must only be advanced by the verified release or metadata-refresh workflows. Installers are downloaded directly from immutable GitHub Release assets.
