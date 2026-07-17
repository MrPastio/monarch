# Profile Module

The `profile` module is the clean-room Monarch adaptation of useful MARK-ALFA profile mechanics.

It stores local profile data in `data/local/profile.json` by default:

- `displayName`
- `adaptiveSummary`
- `traits`
- `styleRules`
- `boundaries`
- `preferences`

Capabilities:

- `profile.read`, risk `read`
- `profile.update`, risk `write`

The module does not import MARK-ALFA personality files, prompts, memories, or identity text. It only keeps the schema idea: a local profile layer that can evolve separately from memory and router internals.

Use `MONARCH_PROFILE_STORE_PATH` or `MONARCH_PROFILE_PATH` to override the file path. Values `off`, `none`, or `memory` use an in-memory store.
