import type {
  CheckoutTarget,
  Comparison,
  DirectoryEntry,
  DirectoryListing,
  FileView,
  GitStatus,
} from '@moonbase/contracts/workspace';
import { checkoutKey } from '../recovery/recovery-references.ts';

/** How the last activation of a file's comparison went, so a failed one isn't repeated. */
export type ComparisonAttempt = { mode: FileView; failedWorkingVersion?: string };
/** What the editor has read of its checkouts: listings, Git status and comparisons. */
export type DiscoveryState = {
  /** By `listingKey`. */
  listings: Readonly<Record<string, DirectoryListing>>;
  /** By checkout key. */
  git: Readonly<Record<string, GitStatus>>;
  /** By file key. */
  comparisons: Readonly<Record<string, Comparison>>;
  comparisonAttempts: Readonly<Record<string, ComparisonAttempt>>;
  /** Checkouts whose watch gave up, so an explicit refresh or reopen watches them again. */
  lostWatches: readonly string[];
};
export const emptyDiscovery: DiscoveryState = {
  listings: {},
  git: {},
  comparisons: {},
  comparisonAttempts: {},
  lostWatches: [],
};

export const listingKey = (checkout: CheckoutTarget, path: string) =>
  JSON.stringify([checkoutKey(checkout), path]);
/** Whether a listing, comparison or attempt key belongs to the checkout. */
export const isKeyOf = (key: string, checkout: CheckoutTarget) =>
  JSON.parse(key)[0] === checkoutKey(checkout);

/**
 * A new listing as shown: entries keep their last Git classification until the new one arrives,
 * so a refresh does not flash ignored files as unignored.
 */
export const keepClassification = (
  listing: DirectoryListing,
  previous: DirectoryListing | undefined,
): DirectoryListing => {
  const ignored = new Map(previous?.entries.map((entry) => [entry.path, entry.ignored]));
  return {
    ...listing,
    entries: listing.entries.map((entry) =>
      entry.ignored === undefined && ignored.get(entry.path) !== undefined
        ? { ...entry, ignored: ignored.get(entry.path) }
        : entry,
    ),
  };
};

/** A listing with Git's answer: each entry ignored or not, or unclassified if Git failed. */
export const classify = (
  listing: DirectoryListing,
  ignored: { paths: readonly string[]; error?: string },
): DirectoryListing => {
  const paths = new Set(ignored.paths);
  return {
    ...listing,
    entries: listing.entries.map((entry) => ({
      ...entry,
      ignored: ignored.error ? undefined : paths.has(entry.path),
    })),
    partial: listing.partial || !!ignored.error,
    error: ignored.error ?? listing.error,
  };
};

/**
 * A classification that answered after a newer listing replaced its own: still newer than the one
 * that listing carried over, so it applies to the entries it classified.
 */
export const classifyShown = (
  shown: DirectoryListing,
  classified: readonly DirectoryEntry[],
  ignored: readonly string[],
): DirectoryListing => {
  const paths = new Set(ignored);
  const listed = new Set(classified.map((entry) => entry.path));
  return {
    ...shown,
    entries: shown.entries.map((entry) =>
      listed.has(entry.path) ? { ...entry, ignored: paths.has(entry.path) } : entry,
    ),
  };
};

/** Removes everything read of a checkout, which is read again under its new target. */
export const forgetCheckout = (state: DiscoveryState, checkout: CheckoutTarget): DiscoveryState => {
  const keep = <A>(record: Readonly<Record<string, A>>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !isKeyOf(key, checkout)));
  const { [checkoutKey(checkout)]: _git, ...git } = state.git;
  return {
    ...state,
    listings: keep(state.listings),
    comparisons: keep(state.comparisons),
    comparisonAttempts: keep(state.comparisonAttempts),
    git,
  };
};
