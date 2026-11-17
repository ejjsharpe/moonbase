import { Fragment, useEffect, useEffectEvent, useRef } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { titleBar } from './title-bar.stylex.ts';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { checkoutName } from '@moonbase/ui/projects';
import { colors, radius, type } from '@moonbase/ui/tokens.stylex';
import { backShortcut, forwardShortcut, mac, sidebarShortcut } from './use-shell-keys.ts';

/**
 * The title never starts before back, forward and the sidebar button, which follow the window
 * controls on macOS.
 */
const titleMinLeft = (mac ? 84 : 8) + 3 * 28 + 2 * 2 + 12;

/**
 * The window's title bar: back, forward and the sidebar button; the open file's path, or in Agents
 * a slot the open chat fills with its title and actions; then project chats and a new chat.
 */
export function TitleBar({
  agents,
  chatOpen,
  checkout,
  activePath,
  back,
  forward,
  sidebarHidden,
  toggleSidebar,
  dockOpen,
  toggleDock,
  startNewChat,
  chatTitle,
  findAnchor,
  layout,
}: {
  /** Whether Agents shows, rather than a project. */
  agents: boolean;
  /** Whether a chat is open to show in Agents and the dock. */
  chatOpen: boolean;
  /** The project showing, if any, and its open file's path. */
  checkout?: CheckoutTarget;
  activePath?: string | null;
  /** Steps back or forward, absent when there is nowhere to go. */
  back?: () => void;
  forward?: () => void;
  sidebarHidden: boolean;
  toggleSidebar(): void;
  dockOpen: boolean;
  toggleDock(): void;
  startNewChat(): void;
  /** Receives the slot the open chat in Agents puts its title and actions in. */
  chatTitle(slot: HTMLDivElement | null): void;
  /** The content column's left edge the title starts over, in the view showing. */
  findAnchor(): Element | null | undefined;
  /** What moves that edge: the title follows it again when this changes. */
  layout: string;
}) {
  // The title starts over the content column's left edge, wherever the rail and sidebar leave it,
  // and after the sidebar button when the sidebar is hidden.
  const title = useRef<HTMLDivElement>(null);
  const anchor = useEffectEvent(findAnchor);
  useEffect(() => {
    const edge = anchor();
    if (!edge) return;
    const observer = new ResizeObserver(() => {
      if (title.current)
        title.current.style.left = `${Math.max(titleMinLeft, Math.round(edge.getBoundingClientRect().left))}px`;
    });
    observer.observe(edge);
    return () => observer.disconnect();
  }, [layout]);
  return (
    <header aria-label="Window title bar" {...stylex.props(styles.titleBar)}>
      <div {...stylex.props(styles.barStart, mac && styles.barStartMac)}>
        <Button
          aria-label="Back"
          title={`Back · ${backShortcut}`}
          disabled={!back}
          onClick={back}
          {...stylex.props(controls.button, styles.barStartButton)}>
          <Icon name="goBack" />
        </Button>
        <Button
          aria-label="Forward"
          title={`Forward · ${forwardShortcut}`}
          disabled={!forward}
          onClick={forward}
          {...stylex.props(controls.button, styles.barStartButton)}>
          <Icon name="goForward" />
        </Button>
        <Button
          aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
          title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar · ${sidebarShortcut}`}
          onClick={toggleSidebar}
          {...stylex.props(controls.button, styles.barStartButton)}>
          <Icon name="sidebar" />
        </Button>
      </div>
      <div ref={title} {...stylex.props(styles.title, agents && chatOpen && styles.titleBesideNew)}>
        <span aria-hidden="true" {...stylex.props(styles.titleDivider)} />
        {agents && chatOpen && <div ref={chatTitle} {...stylex.props(styles.titleSlot)} />}
        {agents && !chatOpen && <span {...stylex.props(styles.titleCurrent)}>Agents</span>}
        {!agents && checkout && (
          <>
            <span aria-hidden="true" {...stylex.props(styles.titleIcon)}>
              <Icon name="folder" />
            </span>
            <span>{checkoutName(checkout)}</span>
            {activePath &&
              activePath.split('/').map((part, index, parts) => (
                <Fragment key={index}>
                  <span aria-hidden="true" {...stylex.props(styles.titleSeparator)}>
                    /
                  </span>
                  <span {...stylex.props(index === parts.length - 1 && styles.titleCurrent)}>
                    {part}
                  </span>
                </Fragment>
              ))}
          </>
        )}
      </div>
      <div {...stylex.props(styles.barActions)}>
        {!agents && chatOpen && checkout && (
          <Button
            aria-label="Toggle project chats"
            title={`${dockOpen ? 'Hide' : 'Show'} project chats · ⌘J`}
            aria-pressed={dockOpen}
            onClick={toggleDock}
            {...stylex.props(controls.button, styles.barButton, dockOpen && styles.barButtonOn)}>
            <Icon name="sidebarRight" />
          </Button>
        )}
        {chatOpen && (
          <Button
            aria-label="Start a new chat"
            title="New chat · ⌘N"
            onClick={startNewChat}
            {...stylex.props(controls.button, styles.barButton)}>
            <Icon name="plus" />
          </Button>
        )}
      </div>
    </header>
  );
}

const styles = stylex.create({
  titleBar: {
    position: 'absolute',
    zIndex: 25,
    top: 0,
    left: 0,
    right: 0,
    height: titleBar.height,
    WebkitAppRegion: 'drag',
  },
  // Back, forward and the sidebar button, after the window controls on macOS.
  barStart: {
    position: 'absolute',
    zIndex: 30,
    top: titleBar.buttonTop,
    left: 8,
    display: 'flex',
    gap: 2,
  },
  barStartMac: { left: 84 },
  barStartButton: {
    width: 28,
    height: 28,
    padding: 6,
    borderWidth: 0,
    borderRadius: radius.control,
    color: { default: colors.muted, ':hover:not(:disabled)': colors.text },
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.hover },
    opacity: { default: 1, ':disabled': 0.4 },
    WebkitAppRegion: 'no-drag',
  },
  /** The page's title, from the divider over the content column's left edge. */
  title: {
    position: 'absolute',
    top: 0,
    // Until the content column is measured; then it follows that column's left edge.
    left: 184,
    right: 96,
    height: titleBar.height,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: type.body,
    color: colors.secondary,
  },
  titleDivider: {
    flexShrink: 0,
    width: 1,
    height: 20,
    marginRight: 8,
    backgroundColor: colors.border,
  },
  // Agents has only the new-chat button at the bar's end, so the chat's own buttons sit beside it.
  titleBesideNew: { right: 36 },
  titleSlot: { flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center' },
  titleIcon: { display: 'flex', flexShrink: 0, color: colors.muted },
  titleSeparator: { color: colors.muted },
  titleCurrent: {
    color: colors.text,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  barActions: {
    position: 'absolute',
    top: titleBar.buttonTop,
    right: 8,
    display: 'flex',
    gap: 4,
  },
  barButton: {
    width: 28,
    height: 28,
    padding: 6,
    borderWidth: 0,
    borderRadius: radius.control,
    color: { default: colors.muted, ':hover:not(:disabled)': colors.text },
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.hover },
  },
  barButtonOn: { color: colors.text },
});
