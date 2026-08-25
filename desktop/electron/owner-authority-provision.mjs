import { app, safeStorage } from 'electron';
import path from 'node:path';
import { loadOrCreateOwnerDeviceIdentity, ownerAuthorityPaths } from './owner-authority.mjs';

app.whenReady().then(async () => {
  const authorityRoot = path.join(app.getPath('appData'), 'Monarch', 'authority');
  const identity = await loadOrCreateOwnerDeviceIdentity({ authorityRoot, safeStorage });
  if (identity.status !== 'ready') {
    console.error(JSON.stringify({ ok: false, ...identity.summary }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    tier: 'public',
    diagnostic: 'owner-device-request-ready',
    deviceIdPrefix: identity.deviceIdPrefix,
    requestPath: ownerAuthorityPaths(authorityRoot).deviceRequestPath,
  }, null, 2));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => app.quit());
