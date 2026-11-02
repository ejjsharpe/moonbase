import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Dialog } from '@base-ui/react/dialog';
import { overlays } from '@moonbase/ui/overlays';
import { styles } from './styles.ts';

export function Popup({
  title,
  children,
  onClose,
  finalFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
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
        <Dialog.Popup finalFocus={finalFocus} {...stylex.props(overlays.dialog, styles.popup)}>
          <Dialog.Title {...stylex.props(overlays.dialogTitle)}>{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
