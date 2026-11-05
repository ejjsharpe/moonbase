import { type Harness, type ConversationId, type EntryDraft } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatTarget } from '@moonbase/contracts/chat';

export async function seedTranscriptHistory(harness: Harness, target: ChatTarget) {
  return harness.commit(async (tx) => {
    const ids: string[] = [];
    for (let index = 0; index < 1121; index++) {
      const text = `qualification record ${index} 🌔`;
      let draft: EntryDraft;
      if (index % 20 === 0) draft = { kind: 'pi.reset', head: 'self' };
      else if (index % 2)
        draft = { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 1 }] };
      else
        draft = {
          kind: 'pi.assistant',
          model: [
            fauxAssistantMessage([
              { type: 'thinking', thinking: `retained thought ${index}` },
              { type: 'text', text },
            ]),
          ],
        };
      const entry = await tx.appendEntry(Number(target.conversationId) as ConversationId, draft);
      ids.push(String(entry.id));
    }
    return ids;
  }, BACKGROUND_CONTEXT);
}

export async function seedTranscriptLongText(harness: Harness, target: ChatTarget) {
  const text = 'early NEEDLE 😀\r\n' + '😀α'.repeat(1600000) + 'late ΣNEEDLE 😀\r\n';
  const entry = await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage([{ type: 'thinking', thinking: text }])],
      }),
    BACKGROUND_CONTEXT,
  );
  return {
    entryId: String(entry.id),
    bytes: new TextEncoder().encode(text).length,
    units: text.length,
    late: text.indexOf('ΣNEEDLE') + 1,
  };
}

export function instrumentTranscriptReads(harness: Harness) {
  const reads = {
    scans: 0,
    entries: 0,
    inspections: 0,
    ranges: [] as { limit: number; min: string | null; max: string | null; rows: number }[],
  };
  const commit = harness.commit.bind(harness),
    inspect = harness.inspect.bind(harness);
  harness.commit = (change, context) =>
    commit(
      (tx) =>
        change(
          new Proxy(tx, {
            get(object, key) {
              if (key === 'scanEntries')
                return async (...args: Parameters<typeof tx.scanEntries>) => {
                  reads.scans++;
                  const page = await object.scanEntries(...args);
                  reads.ranges.push({
                    limit: args[1],
                    min: args[0].minEntryId === undefined ? null : String(args[0].minEntryId),
                    max: args[0].maxEntryId === undefined ? null : String(args[0].maxEntryId),
                    rows: page.items.length,
                  });
                  return page;
                };
              if (key === 'entry')
                return (...args: Parameters<typeof tx.entry>) => {
                  reads.entries++;
                  return object.entry(...args);
                };
              const value = Reflect.get(object, key);
              return typeof value === 'function' ? value.bind(object) : value;
            },
          }),
        ),
      context,
    );
  harness.inspect = (...args) => {
    reads.inspections++;
    return inspect(...args);
  };
  return reads;
}
