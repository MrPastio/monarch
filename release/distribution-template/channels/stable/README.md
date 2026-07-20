# Stable channel bootstrap

Do not place an unsigned placeholder at the canonical manifest paths.

Before the first signed release, `manifest.json` and `manifest.sig` intentionally do not exist. Monarch therefore fails closed and reports that update metadata is unavailable. The first verified release workflow creates both files together in one fast-forward commit.

