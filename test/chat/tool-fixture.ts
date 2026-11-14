import { controlledHostFixture } from './controlled-host-fixture.ts';
export { until, type FixtureStats, type CleanupReport } from './controlled-host-fixture.ts';

export function fixture(hold = false) {
  return controlledHostFixture(new URL('./faux-tool.mjs', import.meta.url), hold);
}
