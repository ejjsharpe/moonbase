import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { controls } from '@moonbase/ui/controls';
import {
  runMutation as runMutationDirectly,
  type EditorController,
  type MutationAction,
} from '@moonbase/application/editor';
import { Popup } from './popup.tsx';
import { styles } from './styles.ts';

/**
 * Runs a file operation without its dialog, asking only before replacing existing entries.
 * Resolves true once it completed. A failure goes to `inlineError` when the caller shows it
 * beside its own field, otherwise to the editor's alerts. The caller places focus afterwards,
 * or names with `finalFocus` where the replace prompt returns it as it closes.
 */
export type RunMutation = (
  action: MutationAction,
  destination: string,
  options?: {
    inlineError?: (message: string) => void;
    finalFocus?: () => HTMLElement | false;
  },
) => Promise<boolean>;

/**
 * One workbench's direct mutations: `runMutation` admits one at a time while `admits` allows it,
 * `confirmation` is the replace prompt to render, and `running` is true while one runs.
 * Unmounting abandons a running mutation, so a late reply completes nothing.
 */
export function useMutationRunner(
  controller: EditorController,
  admits: (action: MutationAction) => boolean,
) {
  const [prompt, setPrompt] = useState<{
    paths: string[];
    answer: (replace: boolean) => void;
    finalFocus?: () => HTMLElement | false;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController();
    lifetime.current = current;
    return () => current.abort();
  }, []);
  const runMutation: RunMutation = async (
    action,
    destination,
    { inlineError, finalFocus } = {},
  ) => {
    const fail = (message: string) => {
      if (inlineError) inlineError(message);
      else controller.report(message);
    };
    if (runningRef.current || !admits(action)) {
      fail(
        'File action unavailable. Check the selection and finish the current editor dialog or preservation.',
      );
      return false;
    }
    const signal = lifetime.current.signal;
    runningRef.current = true;
    setRunning(true);
    try {
      const result = await runMutationDirectly(
        controller,
        { ...action, checkout: { ...action.checkout }, paths: [...action.paths] },
        destination,
        {
          signal,
          confirmReplace: (replacements) =>
            new Promise<boolean>((resolve) => {
              const answer = (replace: boolean) => {
                signal.removeEventListener('abort', decline);
                if (!signal.aborted) setPrompt(null);
                resolve(replace);
              };
              const decline = () => answer(false);
              signal.addEventListener('abort', decline, { once: true });
              setPrompt({
                paths: replacements.map((item) => item.target.path),
                answer,
                finalFocus,
              });
            }),
        },
      );
      if (result.error && !signal.aborted) fail(result.error);
      return result.completed && !signal.aborted;
    } finally {
      runningRef.current = false;
      if (!signal.aborted) setRunning(false);
    }
  };
  const confirmation = prompt && (
    <ReplacePrompt paths={prompt.paths} answer={prompt.answer} finalFocus={prompt.finalFocus} />
  );
  return {
    runMutation,
    running: running || !!prompt,
    /** Whether a mutation is running now, for event handlers ahead of a render. */
    isRunning: () => runningRef.current,
    confirmation,
  };
}

/** Asks before a file operation replaces existing entries, starting on Cancel. */
function ReplacePrompt({
  paths,
  answer,
  finalFocus = () => false,
}: {
  paths: string[];
  answer: (replace: boolean) => void;
  finalFocus?: () => HTMLElement | false;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const title =
    paths.length === 1
      ? `Replace ${paths[0].split('/').at(-1)}?`
      : `Replace ${paths.length} items?`;
  return (
    // Without `finalFocus`, the caller places focus once it knows the outcome.
    <Popup
      title={title}
      initialFocus={cancel}
      finalFocus={finalFocus}
      onClose={() => answer(false)}>
      <Dialog.Description {...stylex.props(styles.path)}>
        {paths.join(', ')} {paths.length === 1 ? 'already exists' : 'already exist'} and will be
        replaced.
      </Dialog.Description>
      <div {...stylex.props(styles.dialogActions)}>
        <Button {...stylex.props(controls.button)} onClick={() => answer(true)}>
          Replace
        </Button>
        <Button ref={cancel} {...stylex.props(controls.button)} onClick={() => answer(false)}>
          Cancel
        </Button>
      </div>
    </Popup>
  );
}
