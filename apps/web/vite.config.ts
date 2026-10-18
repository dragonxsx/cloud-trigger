import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env['API_ORIGIN'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@cloud-trigger/source', 'module', 'browser', 'development|production'] },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/api', '/health', '/metrics', '/docs', '/badges', '/calendar.ics', '/hooks', '/mcp'].map(
        (p) => [p, { target: api, changeOrigin: true }],
      ),
    ),
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 600 },
});
