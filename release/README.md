# Monarch release platform

## Trust boundary

`MrPastio/monarch-releases` is the canonical public distribution repository. The updater reads exact bytes from:

```text
https://raw.githubusercontent.com/MrPastio/monarch-releases/main/channels/stable/manifest.json
https://raw.githubusercontent.com/MrPastio/monarch-releases/main/channels/stable/manifest.sig
```

`manifest.sig` is one Base64-encoded Ed25519 signature followed by LF. It signs the exact UTF-8 bytes of `manifest.json`; parsing and reserialization before verification are forbidden.

No production private key or invented public key is committed here. Until a real public key is injected into Monarch and configured in GitHub, update checks must fail closed.

## One-time distribution bootstrap

1. Export `release/distribution-template` into a new empty directory and publish that directory as the public `MrPastio/monarch-releases` repository:

   ```powershell
   Copy-Item -LiteralPath release\distribution-template `
     -Destination D:\MonarchReleasesBootstrap -Recurse
   ```
2. Protect `main`: require pull requests for humans and allow only the release workflow token to fast-forward the stable channel.
3. Create an Ed25519 key outside all repositories:

   ```powershell
   node scripts/release-manifest.mjs generate-key `
     --private-key D:\MonarchReleaseKeys\stable-private.pem `
     --public-key D:\MonarchReleaseKeys\stable-public.pem `
     --keyring D:\MonarchReleaseKeys\stable-keyring.json `
     --key-id monarch-release-2026-01
   ```

4. Store Base64 of the private PEM as the source repository Actions secret `MONARCH_RELEASE_PRIVATE_KEY_B64`.
5. Store Base64 of the public PEM as the source repository Actions variable `MONARCH_RELEASE_PUBLIC_KEY_B64`.
6. Embed the generated public key under `monarch-release-2026-01` in the bootstrap updater keyring before publication.
7. Configure the source repository Actions secret `MONARCH_RELEASES_TOKEN` with access only to contents and releases in `MrPastio/monarch-releases`.
8. Configure the `stable-release` GitHub environment with required reviewer approval.

The key generator refuses to overwrite files. Keep the private key off `C:` and outside source, distribution, public snapshots, logs, artifacts, and command output.

## Publishing v0.2.3.3

`release/stable-release-spec.json` contains the accepted immutable runtime/environment IDs and an armed `available: true` stable release. Publish only from the exact reviewed commit by running `Stable release` with version `0.2.3.3`.

The workflow builds from a clean tracked snapshot, signs exact manifest bytes, uploads to a draft release, downloads every asset back, verifies bytes/hash/signature, publishes the release, and only then fast-forwards the stable channel.

## Metadata refresh

The weekly workflow verifies the current signature and refreshes metadata when no more than 30 days remain. It retains the release version and asset, increments `sequence`, and renews the lifetime to 90 days. At 14 days or less, a refresh failure creates a high-priority source-repository issue. Release and refresh workflows share the `monarch-stable-release` concurrency group.
