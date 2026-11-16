import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  plugins: [stylex.vite(), react()],
  // Unminified: tests find components by name (the transcript's row render counts).
  build: { outDir: '../dist/demo', emptyOutDir: true, minify: false },
  server: { port: 4177, strictPort: true },
});
