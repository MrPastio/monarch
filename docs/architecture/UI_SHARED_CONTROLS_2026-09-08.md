# Shared dropdown and confirmation surfaces

Owner scope: one visual style for every app dropdown and warning/confirmation.

- `ui-select.js`: one native-value-preserving, searchable, keyboard-operable popover for every single-choice select in the main UI and Safe UI. Initial and dynamically inserted controls are enhanced. Hidden/disabled state, form resets and programmatic value changes stay synchronized. Existing custom model/composer/research menus use the same surface tokens and row styling.
- `ui-dialogs.js`: async, text-safe native dialog component replaces all 11 renderer window.confirm/window.prompt call sites across Oscar, Coder, images and settings. Default focus is Cancel. A second request is cancelled, never queued. Consent text and side-effect ordering are preserved.
- `ui-controls.css`: common dark glass, warm borders, gold selection, list rows, dialog and warning surfaces; reduced motion and focus visibility. Safe authorizations retain their isolated window and original controls. No Safe data/runtime or authorization protocol change.

Native Windows folder pickers and host-owned Electron system/security dialogs remain OS surfaces; their authority/trust flow is not replaced by renderer dialogs. External provider pages are outside Monarch styling.

Validation: source and installed asset QA must remain distinguished from a restarted live session. Main UI and Safe markup QA uses synthetic/absent bridges only, never user vault data. Inspect `<qa-artifact-root>/shared-controls`.
