import { createRequire } from 'node:module';

// Electron downloads and extracts its binary on first resolution, and that install is not safe
// across processes. Resolve it once before Node starts the parallel test-file processes.
export function globalSetup() {
  createRequire(new URL('../../../package.json', import.meta.url))('electron');
}
