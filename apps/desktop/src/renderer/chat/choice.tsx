import { Select } from '@base-ui/react/select';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <Select.Root
      value={value || null}
      onValueChange={(value) => {
        if (value) onChange(value);
      }}
      disabled={disabled}
      items={options}>
      <Select.Trigger aria-label={label} {...stylex.props(controls.button, controls.fullWidth)}>
        <Select.Value placeholder={label} />
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
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
