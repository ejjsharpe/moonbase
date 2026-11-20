import { useMemo } from 'react';
import { useAtomValue } from '@effect/atom-react';
import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { Menu } from '@base-ui/react/menu';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey } from '@moonbase/application/editor';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { checkoutName, projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import { Icon } from '@moonbase/ui/icons';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/**
 * The project sidebar's header: the checkout's name and branch. It opens a menu of the
 * repository's worktrees; choosing one opens it as the selected checkout. A plain folder has no
 * branch or worktrees, so its header offers Initialize Git instead, disabled while it runs.
 */
export function WorktreeSwitcher({
  actions,
  checkout,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget;
}) {
  const run = useEditorTask(actions);
  const initializing =
    useAtomValue(actions.editor.atoms.session).initializing === checkout.checkoutId;
  const name = checkoutName(checkout);
  if (checkout.vcs === 'none')
    return (
      <div title={`${checkout.hostId} · ${checkout.root}`} {...stylex.props(styles.folder)}>
        <span {...stylex.props(styles.text)}>
          <span {...stylex.props(styles.name)}>{name}</span>
          <span {...stylex.props(styles.detail)}>No Git</span>
        </span>
        <Button
          title="Run git init in this folder"
          disabled={initializing}
          {...stylex.props(controls.button, styles.initialize)}
          onClick={() => run(actions.initializeRepository(checkout))}>
          {initializing ? 'Initializing…' : 'Initialize Git'}
        </Button>
      </div>
    );
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Switch worktree, ${name} · ${checkout.branch}`}
        title={`${checkout.hostId} · ${checkout.root}`}
        {...stylex.props(controls.button, styles.trigger)}>
        <span {...stylex.props(styles.text)}>
          <span {...stylex.props(styles.nameRow)}>
            <span {...stylex.props(styles.name)}>{name}</span>
            <Icon name="chevron" />
          </span>
          <span {...stylex.props(styles.branch)}>{checkout.branch}</span>
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} {...stylex.props(overlays.positioner)}>
          <Menu.Popup
            aria-label="Worktrees"
            {...stylex.props(overlays.popup, overlays.menuPopup, styles.popup)}>
            <WorktreeList actions={actions} checkout={checkout} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The repository's worktrees, listed each time the menu opens: closing it, or the checkout
 * changing, interrupts a listing still running.
 */
function WorktreeList({ actions, checkout }: { actions: EditorActions; checkout: CheckoutTarget }) {
  const run = useEditorTask(actions);
  const { runtime } = actions.editor;
  const key = checkoutKey(checkout);
  const listing = useMemo(
    () =>
      Atom.setIdleTTL(
        runtime.atom(
          actions.listWorktrees(checkout).pipe(
            Effect.map((result) => result.worktrees),
            Effect.tapError((error) => Effect.sync(() => actions.report(error))),
          ),
        ),
        0,
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the checkout is keyed by `key`.
    [runtime, key],
  );
  const worktrees = useAtomValue(listing);
  if (!AsyncResult.isSuccess(worktrees))
    return AsyncResult.isFailure(worktrees) ? null : (
      <div role="status" {...stylex.props(styles.status)}>
        Loading worktrees…
      </div>
    );
  return worktrees.value.map((worktree) => {
    const current = worktree.root === checkout.root;
    const worktreeName = checkoutName(worktree);
    return (
      <Menu.Item
        key={worktree.root}
        disabled={current}
        aria-label={`${worktreeName} · ${worktree.branch}${current ? ', current' : ''}`}
        {...stylex.props(overlays.menuItem, styles.item)}
        onClick={() => run(actions.openCheckout(worktree.root))}>
        <span
          aria-hidden="true"
          data-initials={projectInitials(worktreeName)}
          {...stylex.props(projectTiles.tile, projectHue(checkout.projectId), styles.itemTile)}
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
  });
}

const styles = stylex.create({
  // The explorer's header: the name over its branch; the rail shows the tile.
  trigger: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    padding: '3px 6px',
    borderWidth: 0,
    borderRadius: radius.row,
    textAlign: 'left',
    color: colors.secondary,
    WebkitAppRegion: 'no-drag',
    backgroundColor: {
      default: 'transparent',
      ':hover:not(:disabled)': colors.hover,
      '[data-popup-open]': colors.elevated,
    },
  },
  folder: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
    padding: '3px 6px',
    color: colors.secondary,
    WebkitAppRegion: 'no-drag',
  },
  initialize: { flexShrink: 0, padding: '3px 8px', fontSize: type.caption },
  detail: {
    color: colors.muted,
    fontSize: type.caption,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  text: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.35 },
  nameRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, color: colors.muted },
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
