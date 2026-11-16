import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { controls } from '@moonbase/ui/controls';
import {
  mutationUnavailable,
  type EditorController,
  type EditorSnapshot,
  type MutationAction,
  type MutationRunResult,
} from '@moonbase/application/editor';
import { Popup, popupStyles } from './popup.tsx';

/**
 * Runs a file operation without its dialog, asking only before replacing existing entries.
 * Resolves with whether it completed and, for a batch that failed partway, the items that did. A
 * failure goes to `inlineError` when the caller shows it beside its own field, otherwise to the
 * editor's alerts. The caller places focus afterwards, or names with `finalFocus` where the
 * replace prompt returns it as it closes.
 */
export type RunMutation = (
  action: MutationAction,
  destination: string,
  options?: {
    inlineError?: (message: string) => void;
    finalFocus?: () => HTMLElement | false;
  },
) => Promise<MutationRunResult>;

/**
 * One workbench's direct mutations, run by the editor controller, whose gate admits one at a
 * time. The workbench adds its own part of the gate: none run while `dialogOpen`, one of its own
 * dialogs being open. `confirmation` renders the controller's replace prompt. Unmounting declines a
 * pending prompt.
 */
export function useMutationRunner(
  controller: EditorController,
  state: EditorSnapshot,
  dialogOpen: () => boolean,
) {
  // Where the running mutation's replace prompt returns focus as it closes.
  const [promptFocus, setPromptFocus] = useState<{ finalFocus?: () => HTMLElement | false }>({});
  useEffect(
    () => () => {
      const prompt = controller.getSnapshot().replacePrompt;
      if (prompt) controller.mutations.answer(prompt.id, false);
    },
    [controller],
  );
  const runMutation: RunMutation = async (
    action,
    destination,
    { inlineError, finalFocus } = {},
  ) => {
    const fail = (message: string) => {
      if (inlineError) inlineError(message);
      else controller.reportMessage(message);
    };
    if (dialogOpen()) {
      fail(mutationUnavailable);
      return { completed: false, error: mutationUnavailable, items: [] };
    }
    // The controller applies the rest of the gate, refusing with `mutationUnavailable`.
    setPromptFocus({ finalFocus });
    const result = await controller.mutations.run(action, destination);
    if (result.error) fail(result.error);
    return result;
  };
  const prompt = state.replacePrompt;
  const confirmation = prompt && (
    <ReplacePrompt
      key={prompt.id}
      paths={prompt.paths}
      answer={(replace) => controller.mutations.answer(prompt.id, replace)}
      finalFocus={promptFocus.finalFocus}
    />
  );
  return { runMutation, confirmation };
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
      <Dialog.Description {...stylex.props(popupStyles.path)}>
        {paths.join(', ')} {paths.length === 1 ? 'already exists' : 'already exist'} and will be
        replaced.
      </Dialog.Description>
      <div {...stylex.props(popupStyles.actions)}>
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
