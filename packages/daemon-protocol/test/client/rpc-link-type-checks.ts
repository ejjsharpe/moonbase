/**
 * Type-level checks of the method a link hands a request, run by the typecheck: each
 * `@ts-expect-error` fails it once the line it marks compiles. Whatever the tag's type, the link
 * runs the method the tag names at runtime; these keep a caller from writing a payload for another.
 */
import type { Stream } from 'effect';
import type { ChatInput } from '@moonbase/contracts/chat';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { followWatch, type DaemonRpc } from '../../src/client/daemon-rpc-link.ts';
import type { RpcConnectionClient } from '../../src/client/rpc-connection.ts';
import type { RpcLink } from '../../src/client/rpc-link.ts';

declare const link: RpcLink<DaemonRpc>;
declare const host: ChatHostTarget;
declare const read: ChatInput<'getChat'>;
declare const folder: { host: ChatHostTarget; input: { root: string } };
const options = { capability: 'chat' };

// A literal tag hands over its own method, which takes its own payload.
export const literal = link.call('getChat', (method) => method({ host, input: read }), options);
// @ts-expect-error a literal tag's method takes no other procedure's payload
link.call('getChat', (method) => method(folder), options);

// A tag of a union type hands over a method that takes no one procedure's payload.
link.call<'getChat' | 'sendChat', unknown, unknown, unknown>(
  'getChat',
  // @ts-expect-error an explicit union
  (method) => method({ host, input: read }),
  options,
);
declare const tag: 'getChat' | 'sendChat';
// @ts-expect-error a tag variable of a union type
link.call(tag, (method) => method({ host, input: read }), options);
declare const anyTag: keyof RpcConnectionClient<DaemonRpc>;
// @ts-expect-error every tag at once
link.call(anyTag, (method) => method({ host, input: read }), options);
declare const watchTag: 'watchChat' | 'watchChatList';
followWatch(
  link,
  watchTag,
  'chat',
  // @ts-expect-error a watch's tag of a union type
  (method) => method({ host, target: read.target }) as Stream.Stream<never>,
  { capability: 'chat' },
);
