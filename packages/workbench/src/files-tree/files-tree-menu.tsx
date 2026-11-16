import * as stylex from '@stylexjs/stylex';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Icon } from '@moonbase/ui/icons';
import { overlays } from '@moonbase/ui/overlays';
import type { FileCommand } from './file-commands.ts';
import { ariaKeys, formatKeys } from '../shortcuts.ts';
import type { TreeMenuState } from './use-tree-menu.ts';

/** The files tree's right-click menu of `commands` for the entries `menu` was opened on. */
export function FilesTreeMenu({
  menu,
  commands,
  refocusTree,
}: {
  menu: TreeMenuState;
  /** The menu's commands, while it is open. */
  commands: readonly (FileCommand | 'separator')[];
  refocusTree: () => void;
}) {
  const { closeMenu } = menu,
    point = menu.menu?.point;
  return (
    <ContextMenu.Root
      open={menu.available}
      onOpenChange={(open) => {
        if (!open) closeMenu();
      }}>
      <ContextMenu.Portal>
        <ContextMenu.Backdrop
          {...stylex.props(overlays.menuBackdrop)}
          onClick={() => closeMenu()}
        />
        <ContextMenu.Positioner
          anchor={point ? { getBoundingClientRect: () => point } : null}
          collisionPadding={8}
          {...stylex.props(overlays.positioner)}>
          <ContextMenu.Popup
            aria-label="File actions"
            finalFocus={menu.finalFocus}
            onFocus={(event) => {
              if (event.target === event.currentTarget)
                event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
            }}
            onKeyDownCapture={(event) => {
              if (event.key === 'Tab') {
                closeMenu({ restoreFocus: false });
                refocusTree();
                event.stopPropagation();
              }
            }}
            {...stylex.props(overlays.popup, overlays.menuPopup, overlays.wideMenu)}>
            {commands.map((item, index) =>
              item === 'separator' ? (
                <ContextMenu.Separator key={index} {...stylex.props(overlays.separator)} />
              ) : (
                <ContextMenu.Item
                  key={item.id}
                  disabled={item.disabled}
                  aria-keyshortcuts={item.keys && ariaKeys(item.keys)}
                  {...stylex.props(
                    overlays.option,
                    overlays.menuItem,
                    overlays.commandItem,
                    item.danger && overlays.dangerItem,
                  )}
                  onClick={() => {
                    if (item.disabled) return;
                    // Copy and reveal leave focus in the tree; the rest move it to a dialog,
                    // the editor or the chat.
                    closeMenu({ restoreFocus: !!item.staysInTree });
                    item.run();
                  }}>
                  <span {...stylex.props(overlays.commandIcon)}>
                    <Icon name={item.icon} />
                  </span>
                  <span {...stylex.props(overlays.commandLabel)}>{item.label}</span>
                  {item.keys && (
                    <span aria-hidden="true" {...stylex.props(overlays.commandKeys)}>
                      {formatKeys(item.keys)}
                    </span>
                  )}
                </ContextMenu.Item>
              ),
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
