import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Os testes de UI precisam de DOM; os de core rodam em node puro.
    // `ipcSnapshotStore` acessa `window.overlayHost`, entao tambem vai de jsdom.
    environmentMatchGlobs: [
      ['tests/ui.test.tsx', 'jsdom'],
      ['src/data/ipcSnapshotStore.test.ts', 'jsdom'],
    ],
  },
});
