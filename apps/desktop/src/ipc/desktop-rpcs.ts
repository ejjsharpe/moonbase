import { DesktopChatRpcs } from './chat-rpcs.ts';
import { EditorRpcs } from './editor-rpcs.ts';
import { WindowRpcs } from './window-rpcs.ts';

/** Every procedure main serves the window's document over its IPC port. */
export const DesktopRpcs = EditorRpcs.merge(DesktopChatRpcs, WindowRpcs);
