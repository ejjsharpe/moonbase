/**
 * Whether a file's stats say only `uid` owns it and no group or other permission bit is set: the
 * check every credential, token, log and data file passes before Moonbase trusts it.
 */
export const isPrivateTo = (stats: { uid: number; mode: number }, uid: number | undefined) =>
  stats.uid === uid && (stats.mode & 0o077) === 0;
