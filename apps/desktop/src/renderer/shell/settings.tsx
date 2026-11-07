import { useSyncExternalStore } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import type { MoonbaseApplication } from '@moonbase/application';
import type { ChatController } from '@moonbase/application/chat';
import { controls } from '@moonbase/ui/controls';
import { colors, radius, shadow, space, type } from '@moonbase/ui/tokens.stylex';
import { workbench } from '@moonbase/ui/workbench';
import { ProviderSetup } from '../chat/setup.tsx';
import { Icon } from '../icon.tsx';

export type SettingsSection = 'hosts' | 'providers';
const noSubscription = () => () => {};
const noChat = () => undefined;

/** Hosts, their connection and IDs, and local provider setup: what used to sit under the chats. */
export function Settings({
  application,
  chat,
  section,
  onSectionChange,
  close,
}: {
  application: MoonbaseApplication;
  chat: ChatController | null;
  section: SettingsSection;
  onSectionChange(section: SettingsSection): void;
  close(): void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup {...stylex.props(workbench.document, styles.popup)}>
          <Tabs.Root
            value={section}
            onValueChange={(value) => onSectionChange(value as SettingsSection)}
            orientation="vertical"
            {...stylex.props(styles.layout)}>
            <nav {...stylex.props(styles.nav)}>
              <Dialog.Title {...stylex.props(styles.title)}>Settings</Dialog.Title>
              <Tabs.List aria-label="Settings sections" {...stylex.props(styles.tabs)}>
                {(
                  [
                    ['hosts', 'Hosts'],
                    ['providers', 'Providers'],
                  ] as const
                ).map(([value, label]) => (
                  <Tabs.Tab
                    key={value}
                    value={value}
                    {...stylex.props(styles.tab, section === value && styles.activeTab)}>
                    {label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </nav>
            <Tabs.Panel value="hosts" {...stylex.props(styles.panel)}>
              <Hosts application={application} chat={chat} />
            </Tabs.Panel>
            <Tabs.Panel value="providers" {...stylex.props(styles.panel)}>
              <h2 {...stylex.props(styles.heading)}>Providers</h2>
              {chat?.providers ? (
                <ProviderSetup controller={chat.providers} />
              ) : (
                <p {...stylex.props(styles.note)}>
                  {chat
                    ? 'A remote host signs in to model providers itself.'
                    : 'Chat is unavailable, so providers cannot be set up.'}
                </p>
              )}
            </Tabs.Panel>
          </Tabs.Root>
          <Dialog.Close
            aria-label="Close settings"
            {...stylex.props(controls.button, controls.iconButton, styles.close)}>
            <Icon name="close" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Hosts({
  application,
  chat,
}: {
  application: MoonbaseApplication;
  chat: ChatController | null;
}) {
  const lifecycle = useSyncExternalStore(application.subscribe, application.getSnapshot);
  const state = useSyncExternalStore(
    chat?.subscribe ?? noSubscription,
    chat?.getSnapshot ?? noChat,
  );
  const local = state?.mode === 'local';
  const busy = (id: string) => !!state?.active.includes(id);
  const connected = state?.connection?.state === 'connected';
  const connection = state?.connection?.state;
  let status = connection
    ? connection[0].toUpperCase() + connection.slice(1)
    : 'Loading configuration';
  if (local) status = state.ready ? 'Local ready' : 'Loading local chats';
  // A single unnamed host (an app composed with one chat client) still gets its row.
  let targets = lifecycle.chatTargets;
  if (!targets.length && chat) targets = [{ id: '', label: local ? 'Local' : 'Remote host' }];
  const switching = lifecycle.phase !== 'live' || lifecycle.chat.state === 'opening';
  return (
    <>
      <h2 {...stylex.props(styles.heading)}>Hosts</h2>
      <ul aria-label="Chat hosts" {...stylex.props(styles.hosts)}>
        {targets.map((target) => {
          const current = !lifecycle.chatTargets.length || target.id === lifecycle.chatTargetId;
          let action = null;
          if (!current)
            action = (
              <Button
                aria-label={`Use ${target.label}`}
                {...stylex.props(controls.button)}
                disabled={switching}
                onClick={() => void application.selectChatTarget(target.id).catch(() => {})}>
                Use
              </Button>
            );
          else if (state && !local)
            action =
              connected || state.connection?.state === 'connecting' ? (
                <Button
                  {...stylex.props(controls.button)}
                  disabled={busy('disconnect')}
                  onClick={() => void chat?.disconnect()}>
                  Disconnect
                </Button>
              ) : (
                <Button
                  {...stylex.props(controls.button)}
                  disabled={
                    !state.connection ||
                    busy('connect') ||
                    state.connection.state === 'disconnecting'
                  }
                  onClick={() => void chat?.connect()}>
                  {busy('connect') ? 'Connecting…' : 'Connect'}
                </Button>
              );
          return (
            <li key={target.id} {...stylex.props(styles.host, current && styles.currentHost)}>
              <Icon name={(current ? local : target.id === 'local') ? 'computer' : 'server'} />
              <span {...stylex.props(styles.hostText)}>
                <span>{target.label}</span>
                {current ? (
                  <span role="status" {...stylex.props(styles.hostStatus)}>
                    {state ? status : (lifecycle.chat.error ?? 'Chat is unavailable.')}
                  </span>
                ) : (
                  <span {...stylex.props(styles.hostStatus)}>Not in use</span>
                )}
              </span>
              {action}
            </li>
          );
        })}
      </ul>
      {state && chat && (
        <div {...stylex.props(styles.details)}>
          <p {...stylex.props(styles.para)}>
            {local
              ? 'Read, write, edit and shell tools use your OS permissions. The working folder is not a sandbox. Hiding Moonbase or switching views keeps local agents running.'
              : 'Disconnect ends connectivity. Remote work continues until you Stop it.'}
          </p>
          {!local && state.connection && (
            <p {...stylex.props(styles.para)}>{state.connection.profile.destination}</p>
          )}
          {state.notice && (
            <p role="status" {...stylex.props(styles.para)}>
              {state.notice}
            </p>
          )}
          <p {...stylex.props(styles.para, styles.ids)}>
            Host {chat.context.host.hostId} · Store {chat.context.host.storeId} · Actor{' '}
            {chat.context.actorId}
          </p>
        </div>
      )}
    </>
  );
}

const styles = stylex.create({
  backdrop: { position: 'fixed', inset: 0, backgroundColor: colors.backdrop, zIndex: 50 },
  popup: {
    position: 'fixed',
    top: 72,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 51,
    width: 'min(640px, calc(100vw - 40px))',
    height: 'min(460px, calc(100vh - 96px))',
    boxSizing: 'border-box',
    display: 'flex',
    overflow: 'hidden',
    color: colors.text,
    fontSize: type.body,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
    boxShadow: shadow.raised,
    outline: 'none',
  },
  layout: { flex: 1, minWidth: 0, display: 'flex' },
  nav: {
    flexShrink: 0,
    width: 160,
    padding: '12px 8px',
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  // The open section: filled like a selected row, with a bar on its leading edge.
  activeTab: {
    color: colors.text,
    backgroundColor: { default: colors.selected, ':hover': colors.selectedHover },
    fontWeight: 600,
    '::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      top: 7,
      bottom: 7,
      width: 2,
      borderRadius: 1,
      backgroundColor: colors.accent,
    },
  },
  title: { margin: 0, padding: '2px 8px 4px', fontSize: type.body, fontWeight: 700 },
  tabs: { display: 'flex', flexDirection: 'column', gap: 2 },
  tab: {
    height: 30,
    paddingInline: 8,
    borderWidth: 0,
    borderRadius: radius.row,
    textAlign: 'left',
    font: 'inherit',
    position: 'relative',
    color: { default: colors.secondary, ':hover': colors.text },
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    cursor: 'pointer',
  },
  panel: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    padding: '14px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    outline: 'none',
  },
  heading: { margin: 0, fontSize: type.body, fontWeight: 700 },
  hosts: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  host: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    padding: '10px 12px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
    color: colors.secondary,
  },
  currentHost: { borderColor: colors.accent },
  hostText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', color: colors.text },
  hostStatus: { color: colors.muted, fontSize: type.small },
  details: {
    color: colors.muted,
    fontSize: type.small,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
  },
  para: { margin: 0 },
  ids: { fontSize: type.caption },
  note: { margin: 0, color: colors.muted, fontSize: type.small },
  close: { position: 'absolute', top: 10, right: 10 },
});
