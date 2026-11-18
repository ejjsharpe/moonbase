import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import type { MoonbaseApplicationSnapshot } from '@moonbase/application';
import { controls } from '@moonbase/ui/controls';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';

/**
 * What the window says about itself above its views: closing, cleanup and recovery status, the
 * editor's latest error while Agents shows no project, and chat initialization and cleanup
 * failures.
 */
export function ShellNotices({
  lifecycle,
  closing,
  agents,
  recoveryFailed,
  holdingUnsaved,
  editorError,
  clearEditorErrors,
}: {
  lifecycle: MoonbaseApplicationSnapshot;
  closing: boolean;
  /** Whether Agents shows, rather than a project. */
  agents: boolean;
  recoveryFailed: boolean;
  holdingUnsaved: boolean;
  /** The editor's latest error, shown here while Agents shows and no project is open. */
  editorError?: string;
  clearEditorErrors(): void;
}) {
  let status = agents ? 'Agents · Explicit Send' : 'Explicit Save · Local workspace';
  if (closing || lifecycle.phase === 'prepared') status = 'Closing workbench…';
  else if (recoveryFailed) status = 'Edits not yet kept for recovery';
  return (
    <>
      {(closing ||
        lifecycle.phase === 'prepared' ||
        recoveryFailed ||
        lifecycle.cleanup.pending.length > 0) && (
        <div role="status" {...stylex.props(styles.status)}>
          {lifecycle.cleanup.pending.length ? 'Finishing panel cleanup…' : status}
        </div>
      )}
      {holdingUnsaved && (
        <div role="status" {...stylex.props(controls.hidden)}>
          Keeping edits…
        </div>
      )}
      {editorError && (
        <div role="alert" {...stylex.props(controls.status, controls.alert)}>
          {editorError}{' '}
          <Button {...stylex.props(controls.button)} onClick={clearEditorErrors}>
            Dismiss error
          </Button>
        </div>
      )}
      {lifecycle.chat.state === 'initialization-failed' && !agents ? (
        <section
          role="alert"
          aria-label="Chat initialization failed"
          {...stylex.props(styles.empty)}>
          <strong>Chat could not initialize</strong>
          <p>{lifecycle.chat.error}</p>
          <p>
            Files show as unavailable with Retry until the daemon returns. Open Chat panel to retry
            before closing this workbench.
          </p>
        </section>
      ) : null}
      {lifecycle.cleanup.errors.length ? (
        <section role="alert" aria-label="Panel cleanup errors" {...stylex.props(styles.empty)}>
          <strong>Panel cleanup failed</strong>
          {lifecycle.cleanup.errors.map((error, i) => (
            <p key={i}>{error}</p>
          ))}
          <p>Quit Moonbase before reopening this panel. Preserved recovery remains available.</p>
        </section>
      ) : null}
    </>
  );
}

/** Agents without a chat: why, and what to do about it. */
export function ChatUnavailable({
  lifecycle,
  chooseHost,
}: {
  lifecycle: MoonbaseApplicationSnapshot;
  chooseHost(): void;
}) {
  let heading = 'Chat is unavailable';
  if (lifecycle.chat.state === 'initialization-failed') heading = 'Chat could not initialize';
  else if (lifecycle.chat.state === 'cleanup-blocked') heading = 'Chat cleanup is blocked';
  return (
    <section {...stylex.props(styles.empty)} aria-label="Chat configuration">
      <h1>{heading}</h1>
      <p role="status">{lifecycle.chat.error ?? 'Chat is unavailable.'}</p>
      <p>
        Files need the same daemon, so they show as unavailable with Retry until it returns. Open
        Chat panel to retry initialization, or choose another host in Settings.
      </p>
      {lifecycle.chatTargets.length > 1 && (
        <Button {...stylex.props(controls.button)} onClick={chooseHost}>
          Choose a host
        </Button>
      )}
    </section>
  );
}

const styles = stylex.create({
  status: { padding: '6px 16px', color: colors.secondary, fontSize: type.small },
  empty: { padding: space.lg, maxWidth: 740 },
});
