import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { colors, type } from '@moonbase/ui/tokens.stylex';
import { formatMessageTime } from '../message-time.ts';
import { textStyles } from '../transcript-text.ts';

/** A message's time and Copy: right-aligned under your bubble, under the agent's reply. */
export function MessageActions({
  createdAt,
  user,
  disabled,
  onCopy,
}: {
  createdAt: string | undefined;
  user: boolean;
  disabled: boolean;
  onCopy(): void;
}) {
  return (
    <div {...stylex.props(styles.actions, user && styles.userActions)}>
      {createdAt && (
        <time
          dateTime={createdAt}
          title={new Date(createdAt).toLocaleString()}
          {...stylex.props(styles.time, textStyles.revealed)}>
          {formatMessageTime(createdAt)}
        </time>
      )}
      <Button
        aria-label="Copy message"
        title="Copy message"
        {...stylex.props(controls.button, controls.iconButton, textStyles.revealed)}
        disabled={disabled}
        onClick={onCopy}>
        <Icon name="copy" />
      </Button>
    </div>
  );
}

const styles = stylex.create({
  actions: { display: 'flex', alignItems: 'center', gap: 2, height: 28, flexShrink: 0 },
  userActions: { justifyContent: 'flex-end' },
  time: { paddingInline: 6, color: colors.muted, fontSize: type.caption },
});
