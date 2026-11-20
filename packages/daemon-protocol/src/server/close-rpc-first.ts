import { Context } from 'effect';

/**
 * Whether a closing server stops Bun only once its RPC servers have closed, so they send each
 * running watch and request an interrupted exit. Off unless provided: tests turn it on to prove a
 * client takes those as a lost connection (#404).
 */
export const CloseRpcFirst = Context.Reference<boolean>(
  '@moonbase/daemon-protocol/server/CloseRpcFirst',
  { defaultValue: () => false },
);
