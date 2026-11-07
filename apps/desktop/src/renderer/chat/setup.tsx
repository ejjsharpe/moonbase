import type { ProviderState } from '@moonbase/contracts/providers';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import { controls } from '@moonbase/ui/controls';
import type { ProviderSetupController } from '@moonbase/application/chat';
import { Choice } from './choice.tsx';
import { Icon } from '../icon.tsx';

/** Each local model provider with its state and one action; a running sign-in opens under its row. */
export function ProviderSetup({ controller }: { controller: ProviderSetupController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const flow = state.status?.flow;
  const providers = state.status?.providers ?? [];
  return (
    <section aria-label="Provider setup" {...stylex.props(styles.setup)}>
      <div {...stylex.props(styles.intro)}>
        <p {...stylex.props(styles.note)}>
          Local chats use these model providers. Credentials are encrypted on this Mac.
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
        {providers.map((provider) => {
          const own = flow?.providerId === provider.id ? flow : null,
            running = own?.state === 'running';
          let action = null;
          if (running) action = null;
          else if (provider.configured)
            action = (
              <Button
                aria-label={`Sign out of ${provider.name}`}
                {...stylex.props(controls.button, controls.quietButton)}
                disabled={state.busy}
                onClick={() => void controller.logout(provider.id)}>
                Sign out
              </Button>
            );
          else if (provider.auth === 'oauth')
            action = (
              <Button
                aria-label={`Sign in to ${provider.name}`}
                {...stylex.props(controls.button)}
                disabled={state.busy || (!!flow && flow.state === 'running')}
                onClick={() => void controller.login(provider.id)}>
                Sign in
              </Button>
            );
          else if (provider.auth === 'api_key')
            action = (
              <Button
                aria-label={`Set API key for ${provider.name}`}
                {...stylex.props(controls.button)}
                disabled={state.busy || (!!flow && flow.state === 'running')}
                onClick={() => void controller.login(provider.id)}>
                Set API key
              </Button>
            );
          return (
            <li
              key={provider.id}
              aria-label={provider.name}
              {...stylex.props(styles.provider, running && styles.activeProvider)}>
              <div {...stylex.props(styles.row)}>
                <span
                  aria-hidden="true"
                  {...stylex.props(styles.dot, provider.configured && styles.readyDot)}
                />
                <span {...stylex.props(styles.text)}>
                  <span {...stylex.props(styles.name)}>{provider.name}</span>
                  <span {...stylex.props(styles.detail)}>
                    {provider.configured
                      ? `Ready · ${provider.models.length} ${provider.models.length === 1 ? 'model' : 'models'}`
                      : 'Not set up'}
                  </span>
                </span>
                {action}
              </div>
              {/* A provider that signs in with its own tool says how, in place of a button. */}
              {!provider.configured && provider.auth !== 'oauth' && provider.auth !== 'api_key' && (
                <p {...stylex.props(styles.note, styles.panel)}>
                  Sign in with the provider&apos;s own tool, then refresh providers.
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
                      {...stylex.props(controls.button, controls.quietButton, styles.cancel)}
                      onClick={() => void controller.cancel(own.id)}>
                      Cancel setup
                    </Button>
                  )}
                </div>
              )}
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
  provider: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
  },
  activeProvider: { borderColor: colors.accent },
  row: { display: 'flex', alignItems: 'center', gap: space.md, padding: '10px 12px' },
  dot: {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: '50%',
    backgroundColor: colors.controlBorder,
  },
  readyDot: { backgroundColor: syntax.string },
  text: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  name: { color: colors.text },
  detail: { color: colors.muted, fontSize: type.small },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: '10px 12px 12px',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
  cancel: { alignSelf: 'flex-start' },
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
