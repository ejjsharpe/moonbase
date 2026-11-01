import { controlledHostFixture } from '../../../tests/chat/fixture.ts';
export { until, type FixtureStats, type CleanupReport } from '../../../tests/chat/fixture.ts';

export function fixture(hold = false) {
  return controlledHostFixture(new URL('./host.mjs', import.meta.url), hold);
}
