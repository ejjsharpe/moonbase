import { fstatSync, readdirSync } from 'node:fs';

/**
 * This process's open descriptor count once it stops changing: pipes of earlier helper runs close
 * a moment after their run ends, which under load is longer than any number of event-loop turns.
 * Waits until the count holds for 20 checks 5 ms apart, and gives up after 1,000.
 */
async function settleDescriptors() {
  let count = readdirSync('/dev/fd').length,
    unchanged = 0;
  for (let turn = 0; turn < 1000 && unchanged < 20; turn++) {
    await new Promise<void>((done) => setTimeout(done, 5));
    const next = readdirSync('/dev/fd').length;
    unchanged = next === count ? unchanged + 1 : 0;
    count = next;
  }
}

/**
 * This process's open descriptors once they settle, each as `fd:device:inode`, so a descriptor
 * opened later under a closed one's number is still a different one.
 */
export async function readOpenDescriptors() {
  await settleDescriptors();
  const open = new Set<string>();
  for (const name of readdirSync('/dev/fd'))
    try {
      const { dev, ino } = fstatSync(Number(name));
      open.add(`${name}:${dev}:${ino}`);
    } catch {
      // The listing's own descriptor, closed once it returns.
    }
  return open;
}

/**
 * The descriptors open once they settle that were not open in `before`. A descriptor of earlier
 * work that closes in between is not counted against the work under test.
 */
export async function findNewDescriptors(before: Set<string>) {
  return [...(await readOpenDescriptors())].filter((descriptor) => !before.has(descriptor));
}
