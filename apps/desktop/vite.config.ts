import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)), base: "./",
  plugins: [stylex.vite(), react(), { name: "renderer-inputs", generateBundle() { this.emitFile({ type: "asset", fileName: "module-inputs.json", source: JSON.stringify([...this.getModuleIds()]) }); } }],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
