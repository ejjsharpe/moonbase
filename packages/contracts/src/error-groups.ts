// What a failure means for the request that failed (epic #273 D14), for the few decisions that
// depend on that rather than on what failed: whether to forget a request the host refused, watch
// again after a host could not be reached, or keep a request whose outcome is unknown. Each error
// class declares its group beside its message, from its reason where one class covers several.

/** What a failure means for its request. */
export type ErrorGroup =
  /** Refused as given, before it ran; sent again unchanged, it is refused again. */
  | 'refusal'
  /** The caller may not do this. */
  | 'access'
  /** It conflicts with the state it was made against. */
  | 'conflict'
  /** The host, its connection or a service could not answer now; trying again may succeed. */
  | 'unavailable'
  /** The host or its reply is not one this client can use. */
  | 'incompatible'
  /** A store could not be read or written. */
  | 'storage'
  /** It may have run: check its outcome, never send it again. */
  | 'uncertain'
  /** Its caller cancelled it. */
  | 'cancelled';

const errorGroups: ReadonlySet<unknown> = new Set<ErrorGroup>([
  'refusal',
  'access',
  'conflict',
  'unavailable',
  'incompatible',
  'storage',
  'uncertain',
  'cancelled',
]);

/** The group a Moonbase error declares (its `group`); none for anything else. */
export function getErrorGroup(value: unknown): ErrorGroup | undefined {
  if (!(value instanceof Error)) return undefined;
  const { _tag: tag, group } = value as { _tag?: unknown; group?: unknown };
  return typeof tag === 'string' && errorGroups.has(group) ? (group as ErrorGroup) : undefined;
}

/**
 * Whether `value` is an error Moonbase defines, whose message is built from fixed text and its
 * fields and so may be shown (D11); anything else, such as a defect, shows only fixed text.
 */
export const isKnownError = (value: unknown) => getErrorGroup(value) !== undefined;

/** Refused as given, before it ran: nothing to resolve, and sent again it is refused again. */
export const isRefusal = (error: unknown) => getErrorGroup(error) === 'refusal';
/** The caller may not do this: it never ran. */
export const isAccessRefusal = (error: unknown) => getErrorGroup(error) === 'access';
/** It conflicts with the state it was made against, such as a source that changed under a read. */
export const isConflict = (error: unknown) => getErrorGroup(error) === 'conflict';
/** The host, its connection or a service could not answer now: watching or reading again may succeed. */
export const isUnavailable = (error: unknown) => getErrorGroup(error) === 'unavailable';
/** The host or its reply is not one this client can use; only the host can say what it ran. */
export const isIncompatible = (error: unknown) => getErrorGroup(error) === 'incompatible';
/** A store could not be read or written. */
export const isStorageFailure = (error: unknown) => getErrorGroup(error) === 'storage';
/** It may have run: its caller checks the outcome and never sends it again. */
export const isUncertain = (error: unknown) => getErrorGroup(error) === 'uncertain';
/** Its caller cancelled it. */
export const isCancelled = (error: unknown) => getErrorGroup(error) === 'cancelled';
