import type { ReactElement, ReactNode } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Tooltip } from '@base-ui/react/tooltip';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { checkoutKey } from '@moonbase/application/editor';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { styles } from './styles.ts';
import { Icon } from '../icon.tsx';
import { AnimatedTab } from './animated-tab.tsx';

type MainTab = { kind: 'project'; checkout: CheckoutTarget } | { kind: 'chat' };
export const tabValue = (tab: MainTab) =>
  tab.kind === 'chat' ? 'chat' : `project:${checkoutKey(tab.checkout)}`;

/** Two lowercase letters for a rail tile: the initials of a hyphenated name, else its start. */
export function projectInitials(name: string) {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toLowerCase();
}

const hues = [
  styles.silver,
  styles.periwinkle,
  styles.green,
  styles.pink,
  styles.lavender,
  styles.sand,
];
/** Every checkout of one repository, worktrees included, shares a projectId and so a hue. */
function projectHue(projectId: string) {
  let hash = 0;
  for (const character of projectId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length];
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
  value: selected,
  chatVisible,
  chatOpen,
  disabled,
  preserving,
  closeCheckout,
  closeChat,
  openCheckout,
  openChat,
  chatDisabled,
}: {
  checkouts: readonly CheckoutTarget[];
  value: string;
  chatVisible: boolean;
  chatOpen: boolean;
  disabled: boolean;
  preserving: boolean;
  closeCheckout(checkout: CheckoutTarget): void;
  closeChat(): void;
  openCheckout?: () => void;
  openChat?: () => void;
  chatDisabled?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const transition = { duration: reducedMotion ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] as const };
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
                {checkouts.map((checkout) => {
                  const value = tabValue({ kind: 'project', checkout });
                  const name = checkout.root.split('/').at(-1) || checkout.root;
                  return (
                    <AnimatedTab
                      key={value}
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
                                aria-label={`${name} · ${checkout.branch}`}
                                {...stylex.props(
                                  controls.button,
                                  styles.railTab,
                                  selected === value && styles.railTabSelected,
                                )}>
                                <span
                                  aria-hidden="true"
                                  data-initials={projectInitials(name)}
                                  {...stylex.props(
                                    styles.tile,
                                    styles.projectTile,
                                    projectHue(checkout.projectId),
                                  )}
                                />
                                <span {...stylex.props(styles.visuallyHidden)}>
                                  {name} · {checkout.branch}
                                </span>
                              </Tabs.Tab>
                            }>
                            <span {...stylex.props(styles.peekName)}>{name}</span>
                            <span {...stylex.props(styles.peekDetail, styles.peekBranch)}>
                              {checkout.branch}
                            </span>
                            <span {...stylex.props(styles.peekDetail, styles.peekPath)}>
                              {checkout.hostId} · {checkout.root}
                            </span>
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
                </motion.div>
              )}
            </div>
          </LayoutGroup>
        </Tabs.List>
      </div>
    </Tooltip.Provider>
  );
}
