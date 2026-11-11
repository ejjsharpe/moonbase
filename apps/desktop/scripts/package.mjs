import { build, Platform, Arch } from 'electron-builder';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
execFileSync(
  process.execPath,
  [fileURLToPath(new URL('./build.mjs', import.meta.url)), '--package'],
  {
    stdio: 'inherit',
  },
);
await build({
  targets: Platform.MAC.createTarget('dir', process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
  projectDir: fileURLToPath(new URL('../dist', import.meta.url)),
  config: {
    appId: 'dev.moonbase.editor',
    productName: 'Moonbase',
    asar: true,
    directories: { output: '../release' },
    files: [
      '**/*',
      '!workspace/**',
      '!daemon/**',
      '!helpers/**',
      '!main-inputs.json',
      '!daemon-inputs.json',
      '!renderer/module-inputs.json',
    ],
    // The daemon's runtime is a helper executable; its bundle and Claude Code's helper script are
    // resources beside each other, outside the archive, so Bun can load them.
    extraFiles: [{ from: 'helpers', to: 'Helpers' }],
    extraResources: [
      { from: 'workspace', to: 'workspace' },
      { from: 'daemon', to: 'daemon' },
    ],
    electronVersion: '45.1.0',
    npmRebuild: false,
    mac: { identity: null, category: 'public.app-category.developer-tools' },
  },
});
