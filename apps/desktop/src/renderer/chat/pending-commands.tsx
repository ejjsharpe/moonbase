import { Context } from 'effect';
import { useAtomValue } from '@effect/atom-react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import { ChatSends } from '@moonbase/application/chat';
import { effortLabels } from './model-choice.ts';
import { isBusy } from './open-chat.ts';
import { useChat } from './chat-context.ts';

/**
 * Commands whose outcome the host never confirmed, kept with their identities: each can be
 * queried, or retried under the same identity, so it never runs twice.
 */
export function PendingCommands() {
  const { atoms, services, act } = useChat();
  const sends = Context.get(services, ChatSends);
  const pending = useAtomValue(atoms.pending);
  const connected = useAtomValue(atoms.ready);
  const active = useAtomValue(atoms.active);
  const dispatching = useAtomValue(atoms.dispatching);
  const storageError = useAtomValue(atoms.storageError);
  if (!pending.length) return null;
  return (
    <section aria-label="Retained commands" {...stylex.props(styles.pending)}>
      <h3 {...stylex.props(styles.label)}>Retained command identities</h3>
      {pending.map((p) => {
        let identity = '';
        if (p.operation === 'sendChat') identity = ` · chat ${p.input.target.conversationId}`;
        else if (p.operation === 'stopChat')
          identity = ` · submission ${p.input.stop.submissionId} · task ${p.input.stop.taskId ?? 'queued'}`;
        return (
          <details key={p.input.requestId} {...stylex.props(styles.item)}>
            <summary {...stylex.props(controls.summary)}>
              {p.operation} · {p.message}
            </summary>
            <p {...stylex.props(styles.identity)}>
              {p.input.requestId}
              {identity}
            </p>
            {p.operation === 'createChat' && (
              <p {...stylex.props(styles.small)}>
                {p.input.title}
                {p.input.settings
                  ? ` · ${p.input.settings.cwd ?? 'No project'} · ${p.input.settings.model.provider}/${p.input.settings.model.modelId}${p.input.settings.reasoningEffort ? ` · ${effortLabels[p.input.settings.reasoningEffort]}` : ''}`
                  : ''}
              </p>
            )}
            {p.operation === 'createChat' && p.firstMessage && (
              <>
                <p {...stylex.props(styles.small)}>
                  Retry creates the conversation and sends this original message.
                </p>
                <p {...stylex.props(styles.identity)}>Send · {p.firstMessage.requestId}</p>
                <pre {...stylex.props(controls.pre, styles.text)}>{p.firstMessage.text}</pre>
              </>
            )}
            {p.operation === 'sendChat' && (
              <pre {...stylex.props(controls.pre, styles.text)}>{p.input.text}</pre>
            )}
            <div {...stylex.props(controls.row)}>
              <Button
                {...stylex.props(controls.button)}
                disabled={!connected || isBusy(active, 'query:' + p.input.requestId)}
                onClick={() => void act(sends.query(p.input.requestId))}>
                Query outcome
              </Button>
              <Button
                {...stylex.props(controls.button)}
                // A request still in flight is never sent alongside itself, so Retry waits for it.
                disabled={
                  !connected ||
                  isBusy(active, p.input.requestId) ||
                  dispatching.includes(p.input.requestId) ||
                  !!storageError
                }
                onClick={() => void act(sends.retry(p.input.requestId))}>
                Retry original{' '}
                {{ stopChat: 'Stop', sendChat: 'Send', createChat: 'Create' }[p.operation]}
              </Button>
            </div>
          </details>
        );
      })}
    </section>
  );
}

const styles = stylex.create({
  pending: {
    paddingBlock: space.sm,
    paddingInline: space.xl,
    maxHeight: '30vh',
    overflowY: 'auto',
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  label: { fontSize: type.small, fontWeight: 400, margin: 0, color: colors.muted },
  item: { marginBlock: space.sm, marginInline: 0, color: colors.warningText },
  text: { maxHeight: 100, overflowY: 'auto', color: colors.text },
  identity: {
    fontFamily: type.mono,
    fontSize: type.caption,
    overflowWrap: 'anywhere',
    color: colors.secondary,
  },
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
  },
});
