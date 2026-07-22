#!/usr/bin/env node
import { probeGitHubReleaseOrigin } from '../release/lib/release-origin-probe.mjs';

const options = readArgs(process.argv.slice(2));
if (!options.url) {
  console.error('Usage: node scripts/probe-release-origin.mjs --url <GitHub release asset> [--minimum-mb 500] [--range-mb 1]');
  process.exit(2);
}

try {
  const result = await probeGitHubReleaseOrigin({
    url: options.url,
    minimumBytes: Math.round(Number(options.minimumMb || 0) * 1024 * 1024),
    rangeBytes: Math.round(Number(options.rangeMb || 1) * 1024 * 1024),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

function readArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[index + 1];
    if (name === '--url') result.url = value;
    else if (name === '--minimum-mb') result.minimumMb = value;
    else if (name === '--range-mb') result.rangeMb = value;
    else continue;
    index += 1;
  }
  return result;
}
