import { readdirSync } from 'node:fs';

/**
 * This process's open descriptor count once it stops changing: pipes of earlier helper runs close
 * a moment after their run ends, which under load is longer than any number of event-loop turns.
 * Waits until the count holds for 20 checks 5 ms apart, and gives up after 1,000.
 */
export async function settledDescriptorCount() {
  let count = readdirSync('/dev/fd').length,
    unchanged = 0;
  for (let turn = 0; turn < 1000 && unchanged < 20; turn++) {
    await new Promise<void>((done) => setTimeout(done, 5));
    const next = readdirSync('/dev/fd').length;
    unchanged = next === count ? unchanged + 1 : 0;
    count = next;
  }
  return count;
}
