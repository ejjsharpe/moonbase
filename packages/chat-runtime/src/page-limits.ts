/** Snapshots and history pages stay below the reply limit with room for their envelope. */
export const historyPageBytes = 250 * 1024;
/** Listing and around-entry windows leave more room for their surrounding reply fields. */
export const entryListBytes = 240 * 1024;
/** Rows one listing, history or around-entry page may scan before returning a continuation. */
export const rowsPerPage = 32;
