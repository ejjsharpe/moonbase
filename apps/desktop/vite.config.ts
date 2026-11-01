import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)), base: "./",
  plugins: [stylex.vite(), react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
