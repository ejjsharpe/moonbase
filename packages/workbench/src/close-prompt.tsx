import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { controls } from '@moonbase/ui/controls';
import type { CloseChoice, EditorSnapshot } from '@moonbase/application/editor';
import { Popup, popupStyles } from './popup.tsx';

/** Asks whether to save, discard or keep a file's unsaved changes before it closes. */
export function ClosePrompt({
  prompt,
  answer,
}: {
  prompt: NonNullable<EditorSnapshot['closePrompt']>;
  answer: (choice: CloseChoice) => void;
}) {
  return (
    <Popup title="Save changes before closing?" onClose={() => answer('cancel')}>
      <Dialog.Description>{prompt.buffer.target.path} has unsaved changes.</Dialog.Description>
      <div {...stylex.props(popupStyles.actions)}>
        {(['save', 'discard', 'cancel'] as const).map((value) => (
          <Button key={value} {...stylex.props(controls.button)} onClick={() => answer(value)}>
            {value[0].toUpperCase() + value.slice(1)}
          </Button>
        ))}
      </div>
    </Popup>
  );
}
