import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    // Keep OAuth/cookie origins stable instead of silently choosing a different port.
    strictPort: true,
    watch: {
      // 생성된 웹 자산은 전처리 스크립트를 돌릴 때만 바뀌는데 소스보다 수십 배
      // 많다. 감시하면 dev 시작과 HMR만 느려지고 쓸모 있는 리로드는 없다.
      ignored: ['**/data/**', '**/public/models/**', '**/dongha/**', '**/backend/**', '**/outputs/**', '**/work/**'],
      ...(process.env.CODEX_SANDBOX === 'seatbelt' ? { useFsEvents: false, usePolling: true } : {}),
    },
  },
  plugins: [vinext()],
});
