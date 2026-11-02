import { controlledHostFixture } from './fixture.ts';
export { until, type FixtureStats, type CleanupReport } from './fixture.ts';

export function fixture(hold = false) {
  return controlledHostFixture(new URL('./tool-host.mjs', import.meta.url), hold);
}
