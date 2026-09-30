import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Build do renderer (overlay).
 *
 * O bundle vai para `dist/`, que tambem recebe a saida de `tsc` via
 * `tsconfig.build.json`. Sao alvos separados: o Node roda `dist/`, o Electron
 * carrega `dist/index.html`.
 */
export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // O modulo nativo de hotkey so e resolvido em runtime (ver hotkeySource.ts).
  optimizeDeps: {
    exclude: ['uiohook-napi'],
  },
});
