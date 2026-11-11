// Controlled host behaviour: the first reply streams thinking and text in steps the test advances,
// and the host's transcript reads are counted; later replies are plain faux replies.
import {
  seedTranscriptHistory,
  seedTranscriptLongText,
  instrumentTranscriptReads,
} from '../../packages/pi-runtime/test/transcript-history-fixture.ts';
import { Harness } from '@earendil-works/pi-durable';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { fauxModelOptions, installFaux } from './faux-model.ts';

export function createBehaviour(config) {
  const faux = fauxProvider({ ...fauxModelOptions, tokensPerSecond: 100000 });
  let reads, harness, seeded, longSeeded, seedError;
  const open = Harness.open;
  Harness.open = async (...args) => {
    harness = await open(...args);
    reads = instrumentTranscriptReads(harness);
    return harness;
  };
  let release;
  const gate = config.hold
    ? new Promise((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const original = faux.provider.streamSimple.bind(faux.provider);
  let invocations = 0;
  const progress = Promise.withResolvers();
  const fail = (error) => {
    seedError = String(error?.stack ?? error);
  };
  const advance = (message) => {
    if (message?.type === 'next-chunk') progress.resolve();
    if (message?.type === 'seed-history')
      void seedTranscriptHistory(harness, message.target).then((ids) => {
        seeded = { target: message.target, ids };
      }, fail);
    if (message?.type === 'seed-long-text')
      void seedTranscriptLongText(harness, message.target).then((record) => {
        longSeeded = { target: message.target, ...record };
      }, fail);
  };
  process.on('message', advance);
  faux.provider.streamSimple = (...args) => {
    if (++invocations !== 1) return original(...args);
    const stream = createAssistantMessageEventStream();
    let stopped = false;
    args[2]?.signal?.addEventListener(
      'abort',
      () => {
        stopped = true;
        progress.resolve();
        stream.end(fauxAssistantMessage('partial', { stopReason: 'aborted' }));
      },
      { once: true },
    );
    void (async () => {
      for (let i = 0; i < 5 && !stopped; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const text = 'first remote text ' + i;
        stream.push({
          type: 'text_delta',
          contentIndex: 1,
          delta: text,
          partial: fauxAssistantMessage([
            { type: 'thinking', thinking: 'remote thinking ' + i },
            { type: 'text', text },
          ]),
        });
        if (i === 0) await progress.promise;
      }
      if (stopped) return;
      await gate;
      if (!stopped) {
        const message = fauxAssistantMessage('REMOTE COMPLETED');
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      }
    })();
    return stream;
  };
  return {
    installProviders: (models) => installFaux(models, faux),
    stats: () => ({
      calls: invocations,
      tools: 0,
      reads: { ...reads },
      seeded,
      longSeeded,
      seedError,
    }),
    release: () => {
      release?.();
      progress.resolve();
    },
    close: () => process.off('message', advance),
  };
}
