import type { ProviderState } from '@moonbase/contracts/providers';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import { controls } from '@moonbase/ui/controls';
import type { ProviderSetupController } from '@moonbase/application/chat';
import { Choice } from './choice.tsx';
import { Icon } from '../icon.tsx';
import { projectTiles } from '@moonbase/ui/projects';

type Provider = ProviderState['providers'][number];

/** The company behind a provider, so its subscription and API key share one card. */
function vendorOf(provider: Provider) {
  if (provider.id.startsWith('openai')) return 'OpenAI';
  if (provider.id === 'anthropic' || provider.id.startsWith('claude')) return 'Anthropic';
  if (provider.id === 'google') return 'Google';
  if (provider.id === 'openrouter') return 'OpenRouter';
  return provider.name;
}

/** One card per vendor, listing its ways to connect; a running sign-in opens under its way. */
export function ProviderSetup({ controller }: { controller: ProviderSetupController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const flow = state.status?.flow;
  const vendors = new Map<string, Provider[]>();
  for (const provider of state.status?.providers ?? [])
    vendors.set(vendorOf(provider), [...(vendors.get(vendorOf(provider)) ?? []), provider]);
  const starting = state.busy || flow?.state === 'running';
  const way = (provider: Provider) => {
    const own = flow?.providerId === provider.id ? flow : null,
      running = own?.state === 'running',
      key = provider.auth === 'api_key',
      // Claude Code owns this login, so the CLI signs in and out rather than a button here.
      external = provider.auth === 'claude_code';
    let action = null;
    if (running || external) action = null;
    else if (provider.configured)
      action = (
        <Button
          aria-label={key ? `Remove key for ${provider.name}` : `Sign out of ${provider.name}`}
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={state.busy}
          onClick={() => void controller.logout(provider.id)}>
          {key ? 'Remove key' : 'Sign out'}
        </Button>
      );
    else if (key || provider.auth === 'oauth')
      action = (
        <Button
          aria-label={key ? `Add key for ${provider.name}` : `Sign in to ${provider.name}`}
          {...stylex.props(controls.button)}
          disabled={starting}
          onClick={() => void controller.login(provider.id)}>
          {key ? 'Add key' : 'Sign in'}
        </Button>
      );
    let detail = 'Not set up';
    if (provider.configured)
      detail = `${provider.models.length} ${provider.models.length === 1 ? 'model' : 'models'}`;
    if (provider.configured && external) detail += ' · signed in with Claude Code';
    return (
      <li
        key={provider.id}
        aria-label={provider.name}
        {...stylex.props(styles.way, running && styles.activeWay)}>
        <div {...stylex.props(styles.row)}>
          <span {...stylex.props(styles.icon)}>
            <Icon name={key ? 'key' : 'user'} />
          </span>
          <span {...stylex.props(styles.text)}>
            <span {...stylex.props(styles.name)}>
              {key ? 'API key' : provider.name}
              <span
                aria-hidden="true"
                {...stylex.props(styles.dot, provider.configured && styles.readyDot)}
              />
            </span>
            <span {...stylex.props(styles.detail)}>{detail}</span>
          </span>
          {action}
        </div>
        {/* A provider that signs in with its own tool says how, in place of a button. */}
        {external && !provider.configured && (
          <p {...stylex.props(styles.note, styles.panel)}>
            {/* One span keeps the command inline in the panel's flex column. */}
            <span>
              Install Claude Code and run{' '}
              <code {...stylex.props(styles.command)}>claude auth login</code> in a terminal, then
              refresh providers. Usage counts against your Claude plan.
            </span>
          </p>
        )}
        {own && (
          <div {...stylex.props(styles.panel)}>
            <p role="status" {...stylex.props(styles.note)}>
              {own.message}
            </p>
            {running && own.canOpenUrl && (
              <Button
                {...stylex.props(controls.button)}
                onClick={() => void controller.openUrl(own.id)}>
                Open sign-in page
              </Button>
            )}
            {running && own.prompt && (
              <PromptForm
                key={own.prompt.id}
                prompt={own.prompt}
                submit={(answer) => void controller.answer(own.id, own.prompt!.id, answer)}
              />
            )}
            {running && (
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                onClick={() => void controller.cancel(own.id)}>
                Cancel setup
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <section aria-label="Provider setup" {...stylex.props(styles.setup)}>
      <div {...stylex.props(styles.intro)}>
        <p {...stylex.props(styles.note)}>
          Each provider, and the ways to connect it. Credentials are encrypted on this Mac.
        </p>
        <Button
          aria-label="Refresh providers"
          title="Refresh providers"
          {...stylex.props(controls.button, controls.iconButton)}
          disabled={state.busy}
          onClick={() => void controller.refresh()}>
          <Icon name="refresh" />
        </Button>
      </div>
      {state.error && (
        <p role="alert" {...stylex.props(styles.alert)}>
          {state.error}
        </p>
      )}
      {!state.status && !state.error && (
        <p role="status" {...stylex.props(styles.note)}>
          Loading providers…
        </p>
      )}
      <ul aria-label="Model providers" {...stylex.props(styles.list)}>
        {[...vendors].map(([vendor, ways]) => {
          const connected = ways.filter((provider) => provider.configured).length;
          return (
            <li key={vendor} aria-label={vendor} {...stylex.props(styles.vendor)}>
              <div {...stylex.props(styles.vendorHeader)}>
                <span
                  aria-hidden="true"
                  data-initials={vendor.slice(0, 2)}
                  {...stylex.props(projectTiles.tile, styles.vendorTile)}
                />
                <span {...stylex.props(styles.vendorName)}>{vendor}</span>
                <span {...stylex.props(styles.detail, connected > 0 && styles.connected)}>
                  {connected ? `${connected} connected` : 'Not set up'}
                </span>
              </div>
              <ul {...stylex.props(styles.ways)}>{ways.map(way)}</ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const styles = stylex.create({
  setup: { display: 'flex', flexDirection: 'column', gap: space.md },
  intro: { display: 'flex', alignItems: 'center', gap: space.sm },
  note: { flex: 1, margin: 0, color: colors.muted, fontSize: type.small, lineHeight: 1.6 },
  alert: { margin: 0, color: colors.warningText, fontSize: type.small },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  vendor: {
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
  },
  vendorHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    backgroundColor: colors.surface,
  },
  vendorTile: {
    width: 22,
    height: 22,
    borderRadius: 6,
    fontSize: 10,
    color: colors.text,
    backgroundColor: colors.selected,
  },
  vendorName: { flex: 1, fontWeight: 600 },
  connected: { color: syntax.string },
  ways: { listStyle: 'none', margin: 0, padding: 0 },
  way: { borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: colors.border },
  activeWay: { backgroundColor: colors.elevated },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 16px' },
  icon: { display: 'inline-flex', flexShrink: 0, color: colors.secondary },
  text: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  name: { display: 'flex', alignItems: 'center', gap: space.sm, color: colors.secondary },
  dot: {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: '50%',
    backgroundColor: colors.controlBorder,
  },
  readyDot: { backgroundColor: syntax.string },
  detail: { color: colors.muted, fontSize: type.small },
  command: {
    color: colors.text,
    backgroundColor: colors.elevated,
    borderRadius: radius.control,
    paddingInline: space.xs,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: '4px 16px 12px 42px',
  },
  stack: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: space.sm },
});

function PromptForm({
  prompt,
  submit,
}: {
  prompt: NonNullable<NonNullable<ProviderState['flow']>['prompt']>;
  submit(answer: string): void;
}) {
  const [answer, setAnswer] = useState('');
  return (
    <form
      {...stylex.props(styles.stack)}
      onSubmit={(event) => {
        event.preventDefault();
        const captured = answer;
        setAnswer('');
        submit(captured);
      }}>
      <label htmlFor="provider-answer">{prompt.message}</label>
      {prompt.type === 'select' ? (
        <Choice
          label={prompt.message}
          value={answer}
          options={prompt.options.map((option) => ({ value: option.id, label: option.label }))}
          onChange={setAnswer}
        />
      ) : (
        <input
          id="provider-answer"
          type={prompt.type === 'secret' || prompt.type === 'manual_code' ? 'password' : 'text'}
          value={answer}
          autoComplete="off"
          spellCheck={false}
          maxLength={16384}
          onChange={(event) => setAnswer(event.target.value)}
          {...stylex.props(controls.field, controls.fullWidth)}
        />
      )}
      <Button type="submit" {...stylex.props(controls.button)} disabled={!answer.trim()}>
        Continue setup
      </Button>
    </form>
  );
}
