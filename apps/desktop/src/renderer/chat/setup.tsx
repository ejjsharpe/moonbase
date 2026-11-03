import type { ProviderState } from '@moonbase/contracts/providers';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { space } from '@moonbase/ui/tokens.stylex';
import { controls } from '@moonbase/ui/controls';
import type { ProviderSetupController } from '@moonbase/application/chat';
import { Choice } from './choice.tsx';

export function ProviderSetup({ controller }: { controller: ProviderSetupController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [providerId, setProviderId] = useState('openai');
  const flow = state.status?.flow,
    prompt = flow?.prompt;
  const selected = state.status?.providers.find((provider) => provider.id === providerId);
  return (
    <details open={!state.status?.providers.some((provider) => provider.configured)}>
      <summary {...stylex.props(controls.summary)}>Provider setup</summary>
      <div {...stylex.props(styles.stack)}>
        <Choice
          label="Provider"
          value={providerId}
          options={
            state.status?.providers.map((provider) => ({
              value: provider.id,
              label: provider.name,
            })) ?? []
          }
          onChange={setProviderId}
          disabled={flow?.state === 'running'}
        />
        <p role="status">{selected?.configured ? 'Configured' : 'Setup required'}</p>
        {state.error && <p role="alert">{state.error}</p>}
        {flow?.state === 'running' ? (
          <>
            <p role="status">{flow.message}</p>
            {flow.canOpenUrl && (
              <Button
                {...stylex.props(controls.button)}
                onClick={() => void controller.openUrl(flow.id)}>
                Open sign-in page
              </Button>
            )}
            {prompt && (
              <PromptForm
                key={prompt.id}
                prompt={prompt}
                submit={(answer) => void controller.answer(flow.id, prompt.id, answer)}
              />
            )}
            <Button
              {...stylex.props(controls.button)}
              onClick={() => void controller.cancel(flow.id)}>
              Cancel setup
            </Button>
          </>
        ) : (
          <>
            {flow && <p role="status">{flow.message}</p>}
            <Button
              {...stylex.props(controls.button)}
              disabled={state.busy || !selected}
              onClick={() => void controller.login(providerId)}>
              {selected?.auth === 'oauth' ? 'Sign in with ChatGPT' : 'Set API key'}
            </Button>
            {selected?.configured && (
              <Button
                {...stylex.props(controls.button)}
                disabled={state.busy}
                onClick={() => void controller.logout(providerId)}>
                Sign out
              </Button>
            )}
            <Button
              {...stylex.props(controls.button)}
              disabled={state.busy}
              onClick={() => void controller.refresh()}>
              Refresh providers
            </Button>
          </>
        )}
      </div>
    </details>
  );
}

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space.sm },
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
