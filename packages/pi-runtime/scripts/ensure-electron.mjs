// Electron downloads its binary on the first `require('electron')`. Test files run in parallel
// and several launch Electron, so without this each starts its own download into the same
// folder and can run a half-extracted binary. Fetch it once, before the tests start.
import { createRequire } from 'node:module';

createRequire(new URL('../../../package.json', import.meta.url))('electron');
