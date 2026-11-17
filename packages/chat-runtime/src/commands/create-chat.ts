import { realpath, rmdir, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { configure } from '@earendil-works/pi-durable';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type { ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { UncertainError } from '@moonbase/contracts/errors';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { makeChatFolder } from '../chat-folders.ts';
import { Metadata, Request, key, type ChatSettings } from '../documents.ts';
import { decodeStoredRequest } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { safeError } from './safe-error.ts';

export async function createChat(
  host: Host,
  d: ChatInput<'createChat'>,
): Promise<ChatOutput<'createChat'>> {
  host.session(d.session);
  const binding = JSON.stringify({ operation: 'createChat', ...d });
  const existing = await host.harness.snapshot(
    Request,
    key(d.session.actorId, d.requestId),
    context,
  );
  if (existing) {
    decodeStoredRequest(existing, d.session.actorId, d.requestId);
    if (existing.binding !== binding) throw new RequestReusedError();
    if (existing.conversationId)
      return {
        requestId: d.requestId,
        conversation: host.summary(
          existing.conversationId,
          await host.metadata({ ...d.session, conversationId: existing.conversationId }),
        ),
      };
  }
  let settings: ChatSettings, ownFolder: string | undefined;
  const requested = d.settings;
  if (requested.cwd !== undefined) {
    const cwd = await realpath(requested.cwd).catch(() => {
      throw new InvalidChatRequestError({ problem: 'folder-missing' });
    });
    if (cwd !== requested.cwd || !(await stat(cwd)).isDirectory())
      throw new InvalidChatRequestError({ problem: 'folder-not-canonical' });
  } else if (!host.config.chatFolders)
    throw new InvalidChatRequestError({ problem: 'folder-required' });
  const model = host.config.models.getModel(requested.model.provider, requested.model.modelId);
  if (!model) throw new InvalidChatRequestError({ problem: 'model' });
  if (
    requested.reasoningEffort &&
    !getSupportedThinkingLevels(model).includes(requested.reasoningEffort)
  )
    throw new InvalidChatRequestError({ problem: 'reasoning-effort' });
  await host.config.approveCreation?.(requested);
  if (requested.cwd !== undefined) settings = { ...requested, cwd: requested.cwd };
  else {
    ownFolder = await makeChatFolder(host.config.chatFolders!, d.title);
    settings = { ...requested, cwd: ownFolder, ownFolder: true };
  }
  let conversationId: string,
    definiteRejection: ChatError | undefined,
    reused = false;
  try {
    conversationId = await host.harness.commit(async (tx) => {
      const request = await tx.doc(Request, key(d.session.actorId, d.requestId), binding);
      try {
        decodeStoredRequest(request, d.session.actorId, d.requestId);
      } catch (error) {
        definiteRejection = safeError(error);
        throw definiteRejection;
      }
      if (request.binding !== binding) {
        definiteRejection = new RequestReusedError();
        throw definiteRejection;
      }
      if (request.conversationId) {
        reused = true;
        return request.conversationId;
      }
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await configure(tx, conversation.id, {
        cwd: settings.cwd,
        model: settings.model,
        ...(settings.reasoningEffort ? { thinkingLevel: settings.reasoningEffort } : {}),
      });
      await tx.doc(Metadata, conversation.id, 'metadata', {
        identity: host.identity,
        title: d.title,
        createdAt: new Date().toISOString(),
        settings,
      });
      request.conversationId = String(conversation.id);
      return String(conversation.id);
    }, context);
  } catch (error) {
    if (definiteRejection && error === definiteRejection) {
      // No chat was made, so its folder is still empty; a non-empty folder is left alone.
      if (ownFolder) await rmdir(ownFolder).catch(() => {});
      throw error;
    }
    throw new UncertainError({ operation: 'Creating the chat' });
  }
  // A racing original or retry made this chat first, in a folder of its own: this one is unused.
  if (reused && ownFolder) await rmdir(ownFolder).catch(() => {});
  try {
    return {
      requestId: d.requestId,
      conversation: host.summary(
        conversationId,
        await host.metadata({ ...d.session, conversationId }),
      ),
    };
  } catch {
    throw new UncertainError({ operation: 'Creating the chat' });
  }
}
