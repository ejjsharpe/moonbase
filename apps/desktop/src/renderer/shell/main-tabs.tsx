import { Tabs } from '@base-ui/react/tabs';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { checkoutKey } from '@moonbase/application/editor';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { styles } from './styles.ts';
import { Icon } from '../icon.tsx';
import { AnimatedTab } from './animated-tab.tsx';

type MainTab = { kind: 'project'; checkout: CheckoutTarget } | { kind: 'chat' };
export const tabValue = (tab: MainTab) =>
  tab.kind === 'chat' ? 'chat' : `project:${checkoutKey(tab.checkout)}`;

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
    <Tabs.List aria-label="Workbench views" {...stylex.props(workbench.projectTabs, styles.tabs)}>
      <LayoutGroup>
        <AnimatePresence initial={false} mode="popLayout">
          {chatVisible ? (
            <AnimatedTab
              key="agents"
              {...stylex.props(
                stylex.defaultMarker(),
                styles.agentsGroup,
                selected === 'chat' && styles.agentsSelected,
                selected !== 'chat' &&
                  checkouts.length > 0 &&
                  selected !== tabValue({ kind: 'project', checkout: checkouts[0] }) &&
                  workbench.tabDivider,
              )}>
              {(present) => (
                <>
                  <Tabs.Tab
                    value="chat"
                    disabled={!present}
                    {...stylex.props(
                      controls.button,
                      workbench.tabButton,
                      styles.agentsTab,
                      selected === 'chat' && workbench.selectedTab,
                    )}>
                    <Icon name="agents" />
                    <span>Agents</span>
                  </Tabs.Tab>
                  {chatOpen ? (
                    <Button
                      {...stylex.props(
                        controls.button,
                        controls.iconButton,
                        styles.chatClose,
                        workbench.revealTabClose,
                        selected === 'chat' && workbench.visibleTabClose,
                      )}
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
        <div role="group" aria-label="Project tabs" {...stylex.props(styles.projects)}>
          <AnimatePresence initial={false} mode="popLayout">
            {checkouts.map((checkout, index) => {
              const value = tabValue({ kind: 'project', checkout });
              return (
                <AnimatedTab
                  key={value}
                  {...stylex.props(
                    stylex.defaultMarker(),
                    workbench.projectTab,
                    selected === value && workbench.activeProject,
                    selected !== value &&
                      index < checkouts.length - 1 &&
                      selected !== tabValue({ kind: 'project', checkout: checkouts[index + 1] }) &&
                      workbench.tabDivider,
                  )}>
                  {(present) => (
                    <>
                      <Tabs.Tab
                        value={value}
                        disabled={!present}
                        title={`${checkout.hostId} · ${checkout.branch} · ${checkout.root}`}
                        {...stylex.props(
                          controls.button,
                          workbench.tabButton,
                          workbench.projectButton,
                          selected === value && workbench.selectedTab,
                        )}>
                        <Icon name="folder" />
                        <span {...stylex.props(controls.truncate, controls.grow)}>
                          {checkout.root.split('/').at(-1)} · {checkout.branch}
                        </span>
                      </Tabs.Tab>
                      <Button
                        {...stylex.props(
                          controls.button,
                          workbench.tabButton,
                          workbench.tabClose,
                          workbench.revealTabClose,
                          selected === value && workbench.visibleTabClose,
                        )}
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
            <Button
              render={
                <motion.button
                  layout={reducedMotion ? false : 'position'}
                  transition={transition}
                />
              }
              aria-label="Open checkout"
              title="Open project"
              {...stylex.props(controls.button, workbench.tabButton, workbench.tabOpen)}
              disabled={disabled || preserving}
              onClick={openCheckout}>
              <Icon name="plus" />
            </Button>
          )}
        </div>
        {openChat && (
          <Button
            {...stylex.props(controls.button, workbench.tabButton, controls.quietButton)}
            disabled={disabled || chatDisabled}
            onClick={openChat}>
            Open Chat panel
          </Button>
        )}
      </LayoutGroup>
    </Tabs.List>
  );
}
