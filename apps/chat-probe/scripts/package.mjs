import { build, Platform, Arch } from 'electron-builder';
import { fileURLToPath } from 'node:url';
await import('./build.mjs');
await build({
  targets: Platform.MAC.createTarget('dir', process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
  projectDir: fileURLToPath(new URL('../dist', import.meta.url)),
  config: {
    appId: 'dev.moonbase.chat-proof',
    productName: 'Moonbase Chat Proof',
    asar: true,
    directories: { output: '../release' },
    files: ['**/*', '!inputs.json', '!renderer/module-inputs.json'],
    electronVersion: '45.1.0',
    npmRebuild: false,
    mac: { identity: null, category: 'public.app-category.developer-tools' },
  },
});
