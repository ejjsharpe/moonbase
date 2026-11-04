// Shared IPC controls for controlled hosts; provider/tool behavior stays in each host.
export function hostControl(client, stats, release) {
  const commands = [],
    mutations = [],
    heldReplies = [];
  let replyOperation,
    replyGate = Promise.resolve(),
    releaseReply = () => {};
  let watches = 0,
    publications = 0,
    activeWatches = 0;
  const bound = {
    command: async (...args) => {
      commands.push(args[0]);
      const result = await client.command(...args);
      if (['createChat', 'sendChat', 'stopChat'].includes(args[0]))
        mutations.push({
          operation: args[0],
          input: structuredClone(args[1]),
          result: structuredClone(result),
        });
      if (args[0] === replyOperation) {
        heldReplies.push(args[0]);
        await replyGate;
      }
      return result;
    },
    watch: (input, receive, onError) => {
      watches++;
      activeWatches++;
      const close = client.watch(
        input,
        (value) => {
          publications++;
          receive(value);
        },
        onError,
      );
      return async () => {
        await close();
        activeWatches--;
      };
    },
  };
  let end;
  const ended = new Promise((r) => (end = r));
  const control = (message) => {
    if (message?.type === 'stats')
      process.send?.({
        id: message.id,
        ...stats(),
        watches,
        publications,
        activeWatches,
        commands: [...commands],
        mutations: [...mutations],
        heldReplies: [...heldReplies],
        replyOperation,
      });
    if (message?.type === 'hold-reply') {
      replyOperation = message.operation;
      replyGate = new Promise((resolve) => {
        releaseReply = resolve;
      });
    }
    if (message?.type === 'release-reply') {
      replyOperation = undefined;
      releaseReply();
    }
    if (message?.type === 'release') release?.();
    if (message?.type === 'shutdown') {
      release?.();
      releaseReply();
      end();
    }
  };
  process.on('message', control);
  process.once('disconnect', () => {
    release?.();
    releaseReply();
    end();
  });

  return { bound, ended, close: () => process.off('message', control) };
}
