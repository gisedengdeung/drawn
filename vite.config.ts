import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    // Keep OAuth/cookie origins stable instead of silently choosing a different port.
    strictPort: true,
    watch: {
      ignored: ['**/data/**', '**/dongha/**', '**/backend/**', '**/outputs/**', '**/work/**'],
      ...(process.env.CODEX_SANDBOX === 'seatbelt' ? { useFsEvents: false, usePolling: true } : {}),
    },
  },
  plugins: [vinext()],
});
