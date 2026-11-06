import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Menu } from '@base-ui/react/menu';
import type { EditorController } from '@moonbase/application/editor';
import type { CheckoutTarget, Worktree } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { checkoutName, projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import { Icon } from './icon.tsx';

/**
 * The project sidebar's header: the checkout's tile, name and branch. It opens a menu of the
 * repository's worktrees; choosing one opens it as the selected checkout.
 */
export function WorktreeSwitcher({
  controller,
  checkout,
  run,
}: {
  controller: EditorController;
  checkout: CheckoutTarget;
  run(work: Promise<unknown>): void;
}) {
  const [worktrees, setWorktrees] = useState<readonly Worktree[] | null>(null);
  const name = checkoutName(checkout);
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (!open) return;
        setWorktrees(null);
        run(controller.listWorktrees(checkout).then((result) => setWorktrees(result.worktrees)));
      }}>
      <Menu.Trigger
        aria-label={`Switch worktree, ${name} · ${checkout.branch}`}
        title={`${checkout.hostId} · ${checkout.root}`}
        {...stylex.props(controls.button, styles.trigger)}>
        <span
          aria-hidden="true"
          data-initials={projectInitials(name)}
          {...stylex.props(projectTiles.tile, projectHue(checkout.projectId), styles.tile)}
        />
        <span {...stylex.props(styles.text)}>
          <span {...stylex.props(styles.name)}>{name}</span>
          <span {...stylex.props(styles.branch)}>{checkout.branch}</span>
        </span>
        <Icon name="chevron" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} {...stylex.props(overlays.positioner)}>
          <Menu.Popup
            aria-label="Worktrees"
            {...stylex.props(overlays.popup, overlays.menuPopup, styles.popup)}>
            {worktrees === null ? (
              <div role="status" {...stylex.props(styles.status)}>
                Loading worktrees…
              </div>
            ) : (
              worktrees.map((worktree) => {
                const current = worktree.root === checkout.root;
                const worktreeName = checkoutName(worktree);
                return (
                  <Menu.Item
                    key={worktree.root}
                    disabled={current}
                    aria-label={`${worktreeName} · ${worktree.branch}${current ? ', current' : ''}`}
                    {...stylex.props(overlays.menuItem, styles.item)}
                    onClick={() => run(controller.openCheckout(worktree.root))}>
                    <span
                      aria-hidden="true"
                      data-initials={projectInitials(worktreeName)}
                      {...stylex.props(
                        projectTiles.tile,
                        projectHue(checkout.projectId),
                        styles.itemTile,
                      )}
                    />
                    <span {...stylex.props(styles.text)}>
                      <span {...stylex.props(styles.name)}>{worktreeName}</span>
                      <span {...stylex.props(styles.branch)}>
                        {worktree.branch}
                        {worktree.main ? ' · main worktree' : ''}
                      </span>
                    </span>
                    {current && <span {...stylex.props(styles.current)}>✓</span>}
                  </Menu.Item>
                );
              })
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const styles = stylex.create({
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: 'calc(100% - 8px)',
    margin: '0 4px 12px',
    padding: 6,
    borderWidth: 0,
    borderRadius: radius.row,
    textAlign: 'left',
    color: colors.secondary,
    backgroundColor: {
      default: 'transparent',
      ':hover:not(:disabled)': colors.hover,
      '[data-popup-open]': colors.elevated,
    },
  },
  tile: { width: 28, height: 28, borderRadius: radius.row, fontSize: type.caption },
  text: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.35 },
  name: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  branch: {
    color: colors.muted,
    fontSize: type.caption,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    // Nerd Font branch glyph.
    '::before': { content: '"\\e0a0  "' },
  },
  popup: { width: 'min(280px, calc(100vw - 16px))' },
  status: { padding: space.sm, color: colors.muted, fontSize: type.small },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    padding: '6px 8px',
    borderRadius: radius.row,
  },
  itemTile: { width: 20, height: 20, borderRadius: 5, fontSize: 9 },
  current: { color: colors.secondary },
});
