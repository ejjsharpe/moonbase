import { useRef, type Ref } from 'react';
import { Menu } from '@base-ui/react/menu';
import * as stylex from '@stylexjs/stylex';
import type { icons } from '@moonbase/ui/icons';
import { controls } from '@moonbase/ui/controls';
import { filesUI } from '@moonbase/ui/files';
import { overlays } from '@moonbase/ui/overlays';
import { Icon } from './icon.tsx';

export type ExplorerAction =
  | {
      label: string;
      icon: keyof typeof icons;
      keys?: string;
      disabled?: boolean;
      /** Whether it places focus itself, so closing the menu leaves focus alone. */
      movesFocus?: boolean;
      run(): void;
    }
  | 'separator';

/** The explorer's file actions behind one "…" button, so its header keeps the width for the branch. */
export function ExplorerMenu({
  actions,
  triggerRef,
}: {
  actions: readonly ExplorerAction[];
  /** The "…" button, where focus lands when the editor has nothing better. */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const chosen = useRef<ExplorerAction | null>(null);
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) chosen.current = null;
      }}>
      <Menu.Trigger
        ref={triggerRef}
        aria-label="Explorer actions"
        title="Explorer actions"
        {...stylex.props(controls.button, filesUI.iconButton)}>
        <Icon name="more" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} {...stylex.props(overlays.positioner)}>
          <Menu.Popup
            finalFocus={() =>
              !(chosen.current && chosen.current !== 'separator' && chosen.current.movesFocus)
            }
            aria-label="Explorer actions"
            {...stylex.props(overlays.popup, overlays.menuPopup, overlays.wideMenu)}>
            {actions.map((action, index) =>
              action === 'separator' ? (
                <Menu.Separator key={index} {...stylex.props(overlays.separator)} />
              ) : (
                <Menu.Item
                  key={action.label}
                  disabled={action.disabled}
                  onClick={() => {
                    chosen.current = action;
                    action.run();
                  }}
                  {...stylex.props(overlays.option, overlays.menuItem, overlays.commandItem)}>
                  <span {...stylex.props(overlays.commandIcon)}>
                    <Icon name={action.icon} />
                  </span>
                  <span {...stylex.props(overlays.commandLabel)}>{action.label}</span>
                  {action.keys && (
                    <span aria-hidden="true" {...stylex.props(overlays.commandKeys)}>
                      {action.keys}
                    </span>
                  )}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
