# Stable channel bootstrap

Never place an unsigned placeholder at the canonical manifest paths.

Before the first stable installer is published, the canonical pair may contain a signed `available: false` bootstrap manifest. The verified release workflow replaces both files together in one fast-forward commit when a real update is ready.
