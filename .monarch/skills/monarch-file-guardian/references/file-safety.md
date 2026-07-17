# File safety rules

- Reject relative-path escape after normalization and re-check the resolved real path when links or reparse points are involved.
- Never overwrite or delete a protected path, repository metadata, secrets, model files, or unrelated user work without the controller's explicit authorization.
- Prefer narrow edits and atomic replacement for configuration or state files.
- Preserve encoding and line endings when editing existing text; default new text to UTF-8.
- For creation, verify existence plus expected size/content. For move or rename, verify both destination presence and source absence. For deletion, verify absence.
- A successful command with a missing or wrong artifact is a failed file operation.
- Keep user-visible errors concise while retaining detailed local audit evidence.
