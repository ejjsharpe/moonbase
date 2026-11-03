import { Tabs } from '@base-ui/react/tabs';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { checkoutKey } from '@moonbase/application/editor';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { styles } from './styles.ts';

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
}: {
  checkouts: readonly CheckoutTarget[];
  value: string;
  chatVisible: boolean;
  chatOpen: boolean;
  disabled: boolean;
  preserving: boolean;
  closeCheckout(checkout: CheckoutTarget): void;
  closeChat(): void;
}) {
  return (
    <Tabs.List aria-label="Workbench views" {...stylex.props(workbench.projectTabs, styles.tabs)}>
      {checkouts.map((checkout) => {
        const value = tabValue({ kind: 'project', checkout });
        return (
          <div key={value} {...stylex.props(workbench.fileTab)}>
            <Tabs.Tab
              value={value}
              title={`${checkout.hostId} · ${checkout.branch} · ${checkout.root}`}
              {...stylex.props(controls.button, selected === value && workbench.fileSelected)}>
              {checkout.root.split('/').at(-1)} · {checkout.branch}
            </Tabs.Tab>
            <Button
              {...stylex.props(controls.button)}
              aria-label={`Close checkout ${checkout.root}`}
              disabled={disabled || preserving}
              onClick={() => closeCheckout(checkout)}>
              <CloseIcon />
            </Button>
          </div>
        );
      })}
      {chatVisible ? (
        <div {...stylex.props(workbench.fileTab)}>
          <Tabs.Tab
            value="chat"
            {...stylex.props(controls.button, selected === 'chat' && workbench.fileSelected)}>
            Chat
          </Tabs.Tab>
          {chatOpen ? (
            <Button
              {...stylex.props(controls.button)}
              aria-label="Close Chat panel"
              disabled={disabled}
              onClick={closeChat}>
              <CloseIcon />
            </Button>
          ) : null}
        </div>
      ) : null}
    </Tabs.List>
  );
}
function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true">
      <path d="m4 4 8 8 M12 4l-8 8" />
    </svg>
  );
}
