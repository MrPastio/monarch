import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [oscarRuntimeConfig(), react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});

function oscarRuntimeConfig(): Plugin {
  let command = 'build';

  return {
    name: 'oscar-runtime-config',
    configResolved(config) {
      command = config.command;
    },
    transformIndexHtml() {
      if (command !== 'serve') {
        return [];
      }

      const token = resolveOscarApiToken();
      if (!token) {
        return [];
      }

      const runtimeConfig = JSON.stringify({ apiToken: token }).replace(/</g, '\\u003c');
      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children: `window.OSCAR_API_TOKEN = ${runtimeConfig}.apiToken;`,
        },
      ];
    },
  };
}

function resolveOscarApiToken() {
  const envToken = process.env.OSCAR_API_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    return readFileSync(resolve(configDir, '..', '..', 'secrets', 'oscar_token.txt'), 'utf8').trim().replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}
