/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
    // One React only: a second copy breaks hooks ("Cannot read properties of null (reading 'useContext')").
    dedupe: ['react', 'react-dom'],
  },
  // Pre-bundle the dependencies that only lazy routes import (the Ask and Report pages load Recharts), so Vite does
  // not discover them mid-session, re-optimise, and serve the page a second copy of React. Keep this list in step
  // with the packages imported only below a lazy() route in src/routes.tsx.
  optimizeDeps: { include: ['recharts'] },
  // The API's CORS allows only CLIENT_URL (http://localhost:5173), so never drift to another port.
  server: { port: 5173, strictPort: true },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Whole-page tests (routes, mocks, charts) are slow under the full parallel run.
    testTimeout: 30_000,
  },
});
