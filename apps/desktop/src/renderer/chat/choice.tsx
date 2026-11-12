import { useState, type ReactNode } from 'react';
import { Select } from '@base-ui/react/select';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { overlays } from '@moonbase/ui/overlays';
import { colors, radius } from '@moonbase/ui/tokens.stylex';

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  leading,
  action,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
  compact?: boolean;
  /** Drawn before the value, such as a host's status dot. */
  leading?: ReactNode;
  /** A command below the options, such as setting up what the list is missing. */
  action?: { label: string; run(): void };
}) {
  const [open, setOpen] = useState(false);
  return (
    <Select.Root
      open={open}
      onOpenChange={setOpen}
      value={value || null}
      onValueChange={(value) => {
        if (value) onChange(value);
      }}
      disabled={disabled}
      items={options}>
      <Select.Trigger
        aria-label={label}
        {...stylex.props(
          controls.button,
          controls.fullWidth,
          compact && controls.quietButton,
          compact && styles.chip,
        )}>
        {leading}
        <span {...stylex.props(controls.truncate, controls.grow)}>
          <Select.Value placeholder={label} />
        </span>
        {compact ? (
          <span aria-hidden="true" {...stylex.props(styles.caret)}>
            ▾
          </span>
        ) : (
          <Icon name="chevron" />
        )}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} {...stylex.props(overlays.positioner)}>
          <Select.Popup {...stylex.props(overlays.popup)}>
            <Select.List {...stylex.props(overlays.options)}>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  {...stylex.props(overlays.option)}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
            {action && (
              <button
                type="button"
                {...stylex.props(overlays.option, styles.action)}
                onClick={() => {
                  setOpen(false);
                  action.run();
                }}>
                {action.label}
              </button>
            )}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

const styles = stylex.create({
  chip: { height: 30, padding: '0 10px', gap: 6, borderRadius: radius.row },
  caret: { color: colors.muted },
  action: {
    width: '100%',
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    backgroundColor: 'transparent',
    color: colors.secondary,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
});
