import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  plugins: [stylex.vite(), react()],
  build: { outDir: '../dist/demo', emptyOutDir: true },
  // Test fixtures import this entry after load; prebundling prevents a dependency-discovery reload.
  optimizeDeps: { include: ['@base-ui/react/menu'] },
  server: { port: 4176, strictPort: true },
});
