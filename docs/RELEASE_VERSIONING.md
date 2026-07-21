# Monarch release versioning

Monarch uses the product version shape `generation.stage.feature.patch`.

- `generation` — global product generation and release iteration.
- `stage` — maturity stage; `2` is the current Public Beta stage.
- `feature` — a substantial product change, such as a new module or a major capability family.
- `patch` — a small improvement, addition, or bug fix within the current feature line.

The base release may omit a trailing zero (`0.2.3` equals the start of the `0.2.3.x` line). The first Safe deletion hotfix in that line is therefore `0.2.3.1`. A bug fix must not advance the `feature` component.

Every release must keep `package.json`, `package-lock.json`, `installer/Monarch.iss`, the Git tag, GitHub Release, installer metadata, and the official website on the same version.
