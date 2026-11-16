import type { ReactNode, RefObject } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Dialog } from '@base-ui/react/dialog';
import { overlays } from '@moonbase/ui/overlays';
import { workbench } from '@moonbase/ui/workbench';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';

/** A modal editor dialog with a title, closed by Escape or its backdrop. */
export function Popup({
  title,
  children,
  onClose,
  initialFocus,
  finalFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: () => boolean | HTMLElement | null;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          {...stylex.props(workbench.document, overlays.dialog, styles.popup)}>
          <Dialog.Title {...stylex.props(overlays.dialogTitle)}>{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const styles = stylex.create({
  backdrop: { position: 'fixed', inset: 0, backgroundColor: colors.backdrop, zIndex: 50 },
  popup: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 51,
    overflowY: 'auto',
  },
});

/** The parts of a popup's body: the paths it is about, and its row of buttons. */
export const popupStyles = stylex.create({
  path: { overflowWrap: 'anywhere', fontSize: type.small, color: colors.secondary },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
});
