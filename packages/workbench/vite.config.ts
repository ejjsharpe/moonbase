import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import { fileURLToPath } from 'node:url';

const demo = (page: string) => fileURLToPath(new URL(`./demo/${page}`, import.meta.url));

export default defineConfig({
  root: demo(''),
  plugins: [stylex.vite(), react()],
  build: {
    outDir: '../dist/demo',
    emptyOutDir: true,
    // The browser tests open each page of the built demo.
    rolldownOptions: {
      input: [demo('index.html'), demo('recovery-race.html'), demo('save-race.html')],
    },
  },
  // Test fixtures import this entry after load; prebundling prevents a dependency-discovery reload.
  optimizeDeps: { include: ['@base-ui/react/menu'] },
  server: { port: 4176, strictPort: true },
});
