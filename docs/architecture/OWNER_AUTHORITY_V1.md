# Owner Authority v1

## Runtime chain

```text
vendor public key in build
        +
signed entitlement(device public-key SHA-256, keyId, dates)
        +
short-lived device signature(runtime port, Desktop attestation hash, nonce, dates)
        |
        v
immutable MonarchAuthorityContext
        |
Desktop/Coder request -> PolicyKernel -> exact durable action-card -> Kernel receipt
Voice/API/Telegram   -> Public        -> normal Public policy
```

There is one Monarch build. The renderer receives only the safe `MonarchAuthorityContext` summary and cannot select a tier.

## Files and key separation

The device identity lives in `%APPDATA%\Monarch\authority`:

- `device-private-key.dpapi` — Ed25519 PKCS#8 encrypted by Electron `safeStorage`;
- `device-public-key.spki` — public SPKI;
- `device-request.json` — public enrollment request;
- `owner-entitlement.json` — vendor-signed entitlement.

These files are not stored in Monarch Safe. Windows ACLs are restricted to the current user and SYSTEM. A partial or corrupted device pair fails closed and is never silently replaced.

The vendor Ed25519 private key lives only in the dedicated Owner entitlement release-key directory outside the repository. `scripts/owner-authority.mjs` refuses partial pairs and overwrites. Public builds contain only the SPKI public key registered by `keyId`.

## Entitlement v1

```json
{
  "schemaVersion": 1,
  "entitlementId": "owner_<uuid>",
  "tier": "owner",
  "devicePublicKeySha256": "<64 lowercase hex>",
  "issuedAt": "<ISO-8601>",
  "expiresAt": null,
  "keyId": "owner-root-2026-01",
  "signature": "<Ed25519 signature>"
}
```

`expiresAt: null` means no automatic expiry. Revocation v1 is removal of the entitlement or removal of its `keyId` from a later build.

## Session proof

Electron creates a proof with a maximum five-minute lifetime; the current implementation uses two minutes. It binds:

- entitlement ID;
- random session nonce;
- SHA-256 of the current Desktop attestation token;
- exact runtime port;
- issue and expiry timestamps.

The runtime verifies the vendor signature, entitlement dates, device fingerprint, proof signature, attestation hash, port, and proof lifetime before constructing Owner authority. The envelope is internal process bootstrap data; it is not a renderer API.

## Policy binding

Security returns one typed disposition: `hard-deny`, `owner-confirmable`, or `informational`. Policy computes a deterministic `policyDecisionHash` over the policy version, exact proposal, source, risk vector, authority tier, and non-informational Security verdict.

An Owner override persists:

- `purpose: owner-security-override`;
- `policyDecisionHash`;
- `authorityTierAtRequest: owner`;
- exact capability and canonical proposal hash.

It requires a same-surface arm, has `grantScope: once`, and is re-evaluated immediately before dispatch. Any mismatch returns to confirmation without dispatching an effect.

## Operations

### First activation or a new device — installed Monarch

1. On the target Windows device, under the Windows account that will run Monarch, open **Контроль → System → Активация и перенос Owner**.

2. Click **Создать запрос**, then **Экспортировать запрос**. Monarch creates or reuses the DPAPI-protected device identity and exports only `device-request.json`. A partial or corrupted identity stays Public and is never silently replaced.

3. Transfer **only** `device-request.json` to the trusted issuer machine or removable transfer directory. Never transfer `device-private-key.dpapi`, the vendor signing key, a session proof, an old entitlement from another PC, or the whole authority directory.

4. On the issuer machine, where the dedicated vendor key already exists in the external release-key directory fixed by `scripts/owner-authority.mjs`, issue a new entitlement from the Monarch source root:

   ```powershell
   Set-Location "<Monarch source root>"
   node .\scripts\owner-authority.mjs issue `
     --request "X:\OwnerTransfer\device-request.json" `
     --out "X:\OwnerTransfer\owner-entitlement.json"
   ```

   Omitting `--expires` creates an entitlement without automatic expiry. To set one, append `--expires "2027-08-03T00:00:00Z"`. The issuer refuses to overwrite an existing output file and requires the exact filename `owner-entitlement.json`.

5. Bring only the issued `owner-entitlement.json` back to the target device. In the same Control card click **Импортировать entitlement** and select that exact file. Main-process code validates the known vendor signature, schema, dates and current device fingerprint before writing it. Renderer receives only safe status metadata. When replacing an existing entitlement, Monarch first moves it to a recoverable timestamped backup in the authority directory.

6. Click **Полностью перезапустить** in the card, or fully exit Monarch through the tray action **Полностью закрыть Monarch** and start it again. Reloading only the renderer is insufficient because Owner proof is bound to the current Desktop/runtime session.

7. Open **Контроль → System** and verify the glass authority badge shows `Owner` with source `signed-device-entitlement`. Source-workspace verification may additionally run `npm run desktop:smoke` and require:

   ```text
   authorityTier: owner
   authoritySource: signed-device-entitlement
   approvalPolicy: on-request
   ```

### Source-workspace fallback

The installed workflow above does not require a repository or `npm` on the target device. For source development only, the equivalent request command remains:

```powershell
Set-Location "<Monarch source root>"
npm run owner:device-request
```

It creates `%APPDATA%\Monarch\authority\device-request.json` and, only when no keypair exists, the DPAPI-protected device identity. Issuance and import rules are identical to the installed workflow.

### Transfer matrix

| Situation | Required action |
| --- | --- |
| Monarch or the repository moved on the same PC, same Windows account, `%APPDATA%` preserved | Nothing. The existing authority remains valid. |
| Monarch updated or reinstalled while the same `%APPDATA%\Monarch\authority` and DPAPI identity remain readable | Nothing; restart and verify the Owner badge. |
| New PC, different Windows account, Windows reinstall, or lost authority directory | Treat it as a new device: generate a new request and issue a new entitlement. |
| Existing entitlement expired | Issue a replacement from the current device request; do not create a new device key. |
| Wrong-device, invalid-signature, or fingerprint diagnostic | Stay Public and reissue from the request generated on the current target device. |
| Partial/corrupted device identity | Stay Public. Preserve the complete authority directory for diagnosis; never auto-regenerate or overwrite it. A deliberate identity reset requires a new request and entitlement. |
| Owner access must be revoked on the device | Fully close Monarch and remove the entitlement through a recoverable administrative workflow; the next start is Public. |

Copying an old entitlement to a new device cannot activate Owner because the device key fingerprint and runtime proof will not match. UI state, renderer code, HTTP fields, environment variables, model text, Voice, Telegram, and external API calls cannot activate Owner.

The packaged Control/System card is implemented, but installed correct-device/wrong-device acceptance remains a mandatory release gate before stable publication.

No signing key, device private key, proof envelope, or entitlement signature is exposed through the renderer state or public release artifacts.
