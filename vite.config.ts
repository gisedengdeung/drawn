import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';
const normalizeDirectory = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url))
    .replaceAll('\\', '/')
    .replace(/\/$/, '');

const localDataDirectory = normalizeDirectory('./data');
// Generated web assets change only when a preprocessing script runs, but they
// outnumber the source files by more than forty to one. Watching them slowed
// dev startup and HMR without ever producing a useful reload.
const generatedAssetDirectories = [
  normalizeDirectory('./public/data'),
  normalizeDirectory('./public/models'),
];
const unwatchedDirectories = [localDataDirectory, ...generatedAssetDirectories];

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: [...(d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : []), {
      binding: 'GALLERY_DB',
      database_name: 'drone-craft-gallery',
      database_id: '00000000-0000-4000-8000-000000000001',
    }],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      watch: {
        // Raw datasets, local caches and generated web assets must not enter
        // the development watcher.
        ignored: (filePath: string) => {
          const normalized = filePath.replaceAll('\\', '/');
          return unwatchedDirectories.some(
            (directory) =>
              normalized === directory ||
              normalized.startsWith(`${directory}/`),
          );
        },
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
