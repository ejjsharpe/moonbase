import { useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import * as stylex from '@stylexjs/stylex';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { FolderMenu, folderMenuStyles, homePath } from '../folder-menu.tsx';
import { Icon } from '@moonbase/ui/icons';
import { styles } from './shell-styles.ts';

/**
 * The rail's +, when the editor knows projects that are closed: a menu that reopens one without
 * the native picker, which stays at its foot as Open folder…
 */
export function ProjectOpener({
  recent,
  reopen,
  browse,
  disabled,
}: {
  /** Closed checkouts, newest first. The editor approved each when it was first opened. */
  recent: readonly CheckoutTarget[];
  reopen(checkout: CheckoutTarget): void;
  browse(): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const focusTarget = useRef<HTMLElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Open checkout"
        disabled={disabled}
        {...stylex.props(controls.button, styles.railTab)}>
        <span aria-hidden="true" {...stylex.props(styles.tile, styles.openTile)}>
          <Icon name="plus" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="right"
          align="start"
          sideOffset={20}
          collisionPadding={12}
          {...stylex.props(overlays.positioner)}>
          <Popover.Popup
            aria-label="Open project"
            initialFocus={() => focusTarget.current ?? true}
            {...stylex.props(folderMenuStyles.popup)}>
            <FolderMenu
              focusRef={(element) => {
                focusTarget.current = element;
              }}
              groups={[
                {
                  label: 'Recent projects',
                  items: recent.map((checkout) => ({
                    path: checkout.root,
                    projectId: checkout.projectId,
                    detail:
                      checkout.vcs === 'git'
                        ? `${checkout.branch} · ${homePath(checkout.root)}`
                        : homePath(checkout.root),
                  })),
                },
              ]}
              choose={(root) => {
                const checkout = recent.find((item) => item.root === root);
                setOpen(false);
                if (checkout) reopen(checkout);
              }}
              browse={() => {
                setOpen(false);
                browse();
              }}
              browseLabel="Open folder…"
              empty="Projects you close appear here."
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
