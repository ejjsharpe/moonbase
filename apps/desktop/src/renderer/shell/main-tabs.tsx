import { useState, type ReactElement, type ReactNode } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Tooltip } from '@base-ui/react/tooltip';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { checkoutKey } from '@moonbase/application/editor';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { checkoutName, projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { styles } from './styles.ts';
import { Icon } from '../icon.tsx';
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

/** Hovering this long opens a peek; moving between tiles then switches peeks at once. */
const peekDelay = 140;

export function MainTabs({
  checkouts,
  selectedCheckoutId,
  value: selected,
  chatVisible,
  chatOpen,
  disabled,
  preserving,
  closeCheckout,
  closeChat,
  openCheckout,
  recentCheckouts = [],
  reopenCheckout,
  openChat,
  chatDisabled,
  openSettings,
}: {
  checkouts: readonly CheckoutTarget[];
  /** The editor's selected checkout, whose project tile shows it even while Agents is in view. */
  selectedCheckoutId?: string | null;
  value: string;
  chatVisible: boolean;
  chatOpen: boolean;
  disabled: boolean;
  preserving: boolean;
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
}) {
  const reducedMotion = useReducedMotion();
  const transition = { duration: reducedMotion ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] as const };
  // Remembers each repository's last chosen checkout, so its tile returns to that worktree.
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(new Map());
  const current = checkouts.find((checkout) => checkout.checkoutId === selectedCheckoutId);
  const currentKey = current && `${current.hostId}\0${current.projectId}`;
  if (current && currentKey && chosen.get(currentKey) !== current.checkoutId)
    setChosen(new Map(chosen).set(currentKey, current.checkoutId));
  return (
    <Tooltip.Provider delay={peekDelay}>
      <div {...stylex.props(styles.railSlot)}>
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
                            disabled={disabled || preserving || !present}
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
                      disabled={disabled || preserving}
                    />
                  ) : (
                    <Peek
                      trigger={
                        <Button
                          aria-label="Open checkout"
                          {...stylex.props(controls.button, styles.railTab)}
                          disabled={disabled || preserving}
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
          {openSettings && (
            <div {...stylex.props(styles.railRow, styles.railFoot)}>
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
