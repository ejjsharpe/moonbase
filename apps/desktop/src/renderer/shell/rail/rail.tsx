import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Tooltip } from '@base-ui/react/tooltip';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { titleBar } from '../title-bar.stylex.ts';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { checkoutKey } from '@moonbase/application/editor';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { checkoutName, projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius, rail, type } from '@moonbase/ui/tokens.stylex';
import { Icon } from '@moonbase/ui/icons';
import { AnimatedTab } from './animated-tab.tsx';
import { ProjectOpener } from './project-opener.tsx';

type MainTab = { kind: 'project'; checkout: CheckoutTarget } | { kind: 'chat' };
export const tabValue = (tab: MainTab) =>
  tab.kind === 'chat' ? 'chat' : `project:${checkoutKey(tab.checkout)}`;

type RailProject = { key: string; active: CheckoutTarget; open: number };

/**
 * One rail tile per repository: its checkouts, worktrees included, share a projectId. A tile shows
 * the checkout last chosen in its repository, else the first opened; the sidebar header switches
 * worktrees.
 */
export function railProjects(
  checkouts: readonly CheckoutTarget[],
  chosen: ReadonlyMap<string, string>,
): RailProject[] {
  const repositories = new Map<string, CheckoutTarget[]>();
  for (const checkout of checkouts) {
    const key = `${checkout.hostId}\0${checkout.projectId}`;
    repositories.set(key, [...(repositories.get(key) ?? []), checkout]);
  }
  return [...repositories].map(([key, open]) => ({
    key,
    active: open.find((checkout) => checkout.checkoutId === chosen.get(key)) ?? open[0],
    open: open.length,
  }));
}

/** A rail control with a peek card beside it on hover or focus, so tiles stay compact. */
function Peek({ trigger, children }: { trigger: ReactElement; children: ReactNode }) {
  return (
    <Tooltip.Root disableHoverablePopup>
      <Tooltip.Trigger render={trigger} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" sideOffset={20} {...stylex.props(styles.peekPositioner)}>
          <Tooltip.Popup {...stylex.props(styles.peek)}>{children}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The shortcut that hides and shows the rail: the sidebar's key, plus ⌥ on macOS or Shift. */
export const railShortcut = (mac: boolean) => (mac ? '⌃⌥⌘S' : 'Ctrl+Alt+Shift+S');

/** How far past the revealed rail the pointer goes before the rail hides, so jitter at its edge does not. */
const peekMargin = 12;

/** Hovering this long opens a peek; moving between tiles then switches peeks at once. */
const peekDelay = 140;

/** The project rail along the window's left edge: Agents, a tile per project, + and Settings. */
export function Rail({
  checkouts,
  selectedCheckoutId,
  value: selected,
  chatVisible,
  chatOpen,
  disabled,
  holdingUnsaved,
  closeCheckout,
  closeChat,
  openCheckout,
  recentCheckouts = [],
  reopenCheckout,
  openChat,
  chatDisabled,
  openSettings,
  collapsed,
  toggleCollapsed,
  focusView,
  mac,
}: {
  checkouts: readonly CheckoutTarget[];
  /** The editor's selected checkout, whose project tile shows it even while Agents is in view. */
  selectedCheckoutId?: string | null;
  value: string;
  chatVisible: boolean;
  chatOpen: boolean;
  disabled: boolean;
  holdingUnsaved: boolean;
  closeCheckout(checkout: CheckoutTarget): void;
  closeChat(): void;
  openCheckout?: () => void;
  /** Closed checkouts, newest first; with them, + opens a menu that reopens one. */
  recentCheckouts?: readonly CheckoutTarget[];
  reopenCheckout?: (checkout: CheckoutTarget) => void;
  openChat?: () => void;
  chatDisabled?: boolean;
  /** Hosts and providers; pinned to the foot of the rail. */
  openSettings?: () => void;
  /** Whether the rail is hidden; it then slides out at the window's left edge. */
  collapsed: boolean;
  toggleCollapsed(): void;
  /** Focuses the view, for focus on a rail that slides away, which would otherwise fall to the page. */
  focusView(): void;
  /** Shows the rail's shortcut the platform's way. */
  mac: boolean;
}) {
  const reducedMotion = useReducedMotion();
  // Hidden, the rail slides over the panes as soon as the pointer reaches the window's left edge,
  // like the Dock set to hide, and slides away once the pointer is clearly past it. It follows the
  // pointer's position rather than enter and leave events: those never fire when the rail slides
  // in under a still pointer, and macOS's resize edge reports leaving the window at the very edge,
  // where the rail must stay.
  const [peeking, setPeeking] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const viewFocus = useEffectEvent(focusView);
  if (!collapsed && peeking) setPeeking(false);
  useEffect(() => {
    if (!peeking) return;
    // The sliding rail turns inert, so focus on it goes to the view first.
    const hide = () => {
      if (slot.current?.contains(document.activeElement)) viewFocus();
      setPeeking(false);
    };
    const move = (event: PointerEvent) => {
      if (event.clientX <= (slot.current?.offsetWidth ?? 0) + peekMargin) return;
      // The rail's own menus, such as +, keep it out while they are open.
      if ((event.target as Element | null)?.closest?.('[role="menu"], [role="dialog"]')) return;
      hide();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('blur', hide);
    };
  }, [peeking]);
  const shown = !collapsed || peeking;
  const transition = { duration: reducedMotion ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] as const };
  // Remembers each repository's last chosen checkout, so its tile returns to that worktree.
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(new Map());
  const current = checkouts.find((checkout) => checkout.checkoutId === selectedCheckoutId);
  const currentKey = current && `${current.hostId}\0${current.projectId}`;
  if (current && currentKey && chosen.get(currentKey) !== current.checkoutId)
    setChosen(new Map(chosen).set(currentKey, current.checkoutId));
  return (
    <Tooltip.Provider delay={peekDelay}>
      {collapsed && !peeking && (
        <div
          aria-hidden="true"
          onPointerEnter={() => setPeeking(true)}
          {...stylex.props(styles.railEdge)}
        />
      )}
      <div
        ref={slot}
        inert={!shown}
        {...stylex.props(
          styles.railSlot,
          collapsed && styles.railSlotCollapsed,
          collapsed && peeking && styles.railSlotPeeking,
        )}>
        <Tabs.List aria-label="Workbench views" {...stylex.props(styles.rail)}>
          <LayoutGroup>
            <AnimatePresence initial={false} mode="popLayout">
              {chatVisible ? (
                <AnimatedTab key="agents" {...stylex.props(stylex.defaultMarker(), styles.railRow)}>
                  {(present) => (
                    <>
                      {selected === 'chat' && (
                        <span aria-hidden="true" {...stylex.props(styles.selectionPill)} />
                      )}
                      <Peek
                        trigger={
                          <Tabs.Tab
                            value="chat"
                            disabled={!present}
                            {...stylex.props(
                              controls.button,
                              styles.railTab,
                              selected === 'chat' && styles.railTabSelected,
                            )}>
                            <span
                              aria-hidden="true"
                              {...stylex.props(styles.tile, styles.agentsTile)}>
                              <Icon name="agents" />
                            </span>
                            <span {...stylex.props(styles.visuallyHidden)}>Agents</span>
                          </Tabs.Tab>
                        }>
                        <span {...stylex.props(styles.peekName)}>Agents</span>
                        <span {...stylex.props(styles.peekDetail)}>Chats and running agents</span>
                      </Peek>
                      {chatOpen ? (
                        <Button
                          {...stylex.props(controls.button, styles.railClose)}
                          aria-label="Close Chat panel"
                          disabled={disabled || !present}
                          onClick={closeChat}>
                          <Icon name="close" />
                        </Button>
                      ) : null}
                    </>
                  )}
                </AnimatedTab>
              ) : null}
            </AnimatePresence>
            {openChat ? (
              <div {...stylex.props(styles.railRow)}>
                <Peek
                  trigger={
                    <Button
                      {...stylex.props(controls.button, styles.railTab)}
                      disabled={disabled || chatDisabled}
                      onClick={openChat}>
                      <span aria-hidden="true" {...stylex.props(styles.tile, styles.openTile)}>
                        <Icon name="agents" />
                      </span>
                      <span {...stylex.props(styles.visuallyHidden)}>Open Chat panel</span>
                    </Button>
                  }>
                  <span {...stylex.props(styles.peekName)}>Open Chat panel</span>
                </Peek>
              </div>
            ) : null}
            <span aria-hidden="true" {...stylex.props(styles.railDivider)} />
            <div role="group" aria-label="Project tabs" {...stylex.props(styles.railGroup)}>
              <AnimatePresence initial={false} mode="popLayout">
                {railProjects(checkouts, chosen).map(({ key, active: checkout, open }) => {
                  const value = tabValue({ kind: 'project', checkout });
                  const name = checkoutName(checkout);
                  // A plain folder has no branch to name.
                  const label = checkout.vcs === 'git' ? `${name} · ${checkout.branch}` : name;
                  return (
                    <AnimatedTab
                      key={key}
                      {...stylex.props(stylex.defaultMarker(), styles.railRow)}>
                      {(present) => (
                        <>
                          {selected === value && (
                            <span aria-hidden="true" {...stylex.props(styles.selectionPill)} />
                          )}
                          <Peek
                            trigger={
                              <Tabs.Tab
                                value={value}
                                disabled={!present}
                                aria-label={label}
                                {...stylex.props(
                                  controls.button,
                                  styles.railTab,
                                  selected === value && styles.railTabSelected,
                                )}>
                                <span
                                  aria-hidden="true"
                                  data-initials={projectInitials(name)}
                                  {...stylex.props(
                                    projectTiles.tile,
                                    projectHue(checkout.projectId),
                                    styles.tile,
                                  )}
                                />
                                <span {...stylex.props(styles.visuallyHidden)}>{label}</span>
                              </Tabs.Tab>
                            }>
                            <span {...stylex.props(styles.peekName)}>{name}</span>
                            {checkout.vcs === 'git' ? (
                              <span {...stylex.props(styles.peekDetail, styles.peekBranch)}>
                                {checkout.branch}
                              </span>
                            ) : (
                              <span {...stylex.props(styles.peekDetail)}>No Git repository</span>
                            )}
                            <span {...stylex.props(styles.peekDetail, styles.peekPath)}>
                              {checkout.hostId} · {checkout.root}
                            </span>
                            {open > 1 && (
                              <span {...stylex.props(styles.peekDetail)}>
                                {open} worktrees open · switch in the sidebar
                              </span>
                            )}
                          </Peek>
                          <Button
                            {...stylex.props(controls.button, styles.railClose)}
                            aria-label={`Close checkout ${checkout.root}`}
                            disabled={disabled || holdingUnsaved || !present}
                            onClick={() => closeCheckout(checkout)}>
                            <Icon name="close" />
                          </Button>
                        </>
                      )}
                    </AnimatedTab>
                  );
                })}
              </AnimatePresence>
              {openCheckout && (
                <motion.div
                  layout={reducedMotion ? false : 'position'}
                  transition={transition}
                  {...stylex.props(styles.railRow)}>
                  {recentCheckouts.length && reopenCheckout ? (
                    <ProjectOpener
                      recent={recentCheckouts}
                      reopen={reopenCheckout}
                      browse={openCheckout}
                      disabled={disabled || holdingUnsaved}
                      trigger={stylex.props(controls.button, styles.railTab)}>
                      <span aria-hidden="true" {...stylex.props(styles.tile, styles.openTile)}>
                        <Icon name="plus" />
                      </span>
                    </ProjectOpener>
                  ) : (
                    <Peek
                      trigger={
                        <Button
                          aria-label="Open checkout"
                          {...stylex.props(controls.button, styles.railTab)}
                          disabled={disabled || holdingUnsaved}
                          onClick={openCheckout}>
                          <span aria-hidden="true" {...stylex.props(styles.tile, styles.openTile)}>
                            <Icon name="plus" />
                          </span>
                        </Button>
                      }>
                      <span {...stylex.props(styles.peekName)}>Open project</span>
                    </Peek>
                  )}
                </motion.div>
              )}
            </div>
          </LayoutGroup>
          <div {...stylex.props(styles.railRow, styles.railFoot)}>
            <Peek
              trigger={
                <Button
                  aria-label={collapsed ? 'Keep rail open' : 'Hide rail'}
                  {...stylex.props(controls.button, styles.railTab)}
                  onClick={toggleCollapsed}>
                  <span aria-hidden="true" {...stylex.props(styles.tile, styles.settingsTile)}>
                    <Icon name={collapsed ? 'railExpand' : 'railCollapse'} />
                  </span>
                </Button>
              }>
              <span {...stylex.props(styles.peekName)}>
                {collapsed ? 'Keep rail open' : 'Hide rail'}
              </span>
              <span {...stylex.props(styles.peekDetail)}>
                {collapsed ? 'Shows at the left edge while hidden · ' : ''}
                {railShortcut(mac)}
              </span>
            </Peek>
          </div>
          {openSettings && (
            <div {...stylex.props(styles.railRow)}>
              <Peek
                trigger={
                  <Button
                    aria-label="Settings"
                    {...stylex.props(controls.button, styles.railTab)}
                    onClick={openSettings}>
                    <span aria-hidden="true" {...stylex.props(styles.tile, styles.settingsTile)}>
                      <Icon name="settings" />
                    </span>
                  </Button>
                }>
                <span {...stylex.props(styles.peekName)}>Settings</span>
                <span {...stylex.props(styles.peekDetail)}>Hosts and providers · ⌘,</span>
              </Peek>
            </div>
          )}
        </Tabs.List>
      </div>
    </Tooltip.Provider>
  );
}

const styles = stylex.create({
  /** The strip along the window's left edge that reveals the hidden rail, below the header row. */
  railEdge: {
    position: 'absolute',
    zIndex: 21,
    top: titleBar.height,
    bottom: 0,
    left: 0,
    // Wider than macOS's resize edge, which takes the first few pixels.
    width: 8,
  },
  railSlot: {
    position: 'absolute',
    zIndex: 20,
    top: titleBar.height,
    left: 0,
    bottom: 0,
    width: rail.width,
    transitionProperty: 'transform',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  // Hidden, it slides in and out quickly, like the Dock.
  railSlotCollapsed: {
    transform: 'translateX(-100%)',
    transitionDuration: '80ms',
    transitionTimingFunction: 'ease-out',
  },
  // Revealed over the panes from the left edge, lifted off them with a shadow.
  railSlotPeeking: { transform: 'translateX(0)', boxShadow: '12px 0 32px #00000080' },
  rail: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: rail.gap,
    paddingTop: 6,
    paddingBottom: 16,
    overflowX: 'hidden',
    overflowY: 'auto',
    // The rail is part of the frame, with the title bar.
    backgroundColor: colors.chrome,
    WebkitAppRegion: 'drag',
  },
  railGroup: { display: 'flex', flexDirection: 'column', gap: rail.gap },
  railRow: {
    position: 'relative',
    display: 'flex',
    flexShrink: 0,
    paddingInline: rail.gutter,
    WebkitAppRegion: 'no-drag',
  },
  railTab: {
    position: 'relative',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: rail.tile,
    height: rail.tile,
    padding: 0,
    borderWidth: 0,
    borderRadius: rail.tileRadius,
    color: { default: colors.secondary, ':hover': colors.text },
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': 'transparent' },
  },
  railTabSelected: { color: colors.text },
  railDivider: {
    flexShrink: 0,
    width: 24,
    height: 1,
    marginLeft: `calc((${rail.width} - 24px) / 2)`,
    backgroundColor: colors.controlBorder,
  },
  selectionPill: {
    position: 'absolute',
    left: 0,
    top: `calc((${rail.tile} - 20px) / 2)`,
    width: 4,
    height: 20,
    borderRadius: '0 2px 2px 0',
    backgroundColor: colors.text,
  },
  tile: {
    width: rail.tile,
    height: rail.tile,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: rail.tileRadius,
    fontFamily: type.mono,
    fontSize: rail.tileText,
    fontWeight: 700,
    color: colors.onAccent,
  },
  agentsTile: { backgroundColor: colors.accent },
  railFoot: { marginTop: 'auto' },
  settingsTile: { color: colors.muted, backgroundColor: 'transparent' },
  openTile: {
    color: colors.muted,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.controlBorder,
  },
  // Close sits on the tile's corner and appears while its row is hovered or focused.
  railClose: {
    position: 'absolute',
    top: -6,
    left: `calc(${rail.gutter} + ${rail.tile} - 10px)`,
    width: 20,
    height: 20,
    padding: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    color: { default: colors.secondary, ':hover:not(:disabled)': colors.text },
    backgroundColor: colors.elevated,
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-within')]: 1,
    },
    pointerEvents: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'auto',
      [stylex.when.ancestor(':focus-within')]: 'auto',
    },
  },
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  peekPositioner: { zIndex: 60 },
  peek: {
    maxWidth: 340,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '10px 12px',
    borderRadius: radius.panel,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    backgroundColor: colors.elevated,
    boxShadow: '0 14px 36px #00000080',
    fontFamily: type.ui,
    fontSize: type.small,
    lineHeight: 1.45,
    color: colors.text,
    pointerEvents: 'none',
  },
  peekName: { fontSize: type.body, fontWeight: 600 },
  peekDetail: { color: colors.secondary },
  // Nerd Font branch glyph.
  peekBranch: { '::before': { content: '"\\e0a0  "' } },
  peekPath: {
    color: colors.muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
