import { useState, type KeyboardEvent } from 'react';
import type { CheckoutTarget, FileTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, type EditorSnapshot } from '@moonbase/application/editor';
import { cycleRecentTabs, type RecentTabs } from './editor-tabs/recent-tabs.tsx';
import type { ExplorerPanel } from './explorer/explorer.tsx';
import type { FocusOrigin, FocusReturn } from './focus-return.ts';
import { pickerCommand, pickerMode, type PickerMode } from './picker/picker-shortcuts.ts';
import type { EditorActions } from './editor-actions.ts';

/**
 * The workbench's keys, outside dialogs, menus and fields other than the editor's: ⌘S saves, ⌘P
 * and its variants open the picker, ⇧⌘E and ⇧⌘G switch the explorer's view, ⌘W closes the active
 * tab, ⇧⌘T reopens one, ⌥⌘← and ⌥⌘→ go back and forward, and Ctrl+Tab switches between recent
 * tabs until Control is let go. Commands return focus to where they started.
 */
export function useWorkbenchKeys({
  actions,
  state,
  checkout,
  view,
  target,
  focus,
  findOrigin,
  openPicker,
  showPanel,
  closeFiles,
  run,
}: {
  actions: EditorActions;
  state: EditorSnapshot;
  checkout: CheckoutTarget | undefined;
  view: EditorSnapshot['recovery']['views'][string] | undefined;
  target: FileTarget | undefined;
  focus: FocusReturn;
  findOrigin: (element: HTMLElement) => FocusOrigin;
  openPicker: (mode: PickerMode) => void;
  showPanel: (panel: ExplorerPanel) => void;
  closeFiles: (paths: string[]) => Promise<boolean>;
  run: (work: Promise<unknown>) => void;
}) {
  const [recent, setRecent] = useState<RecentTabs | null>(null);
  const { withFocus } = focus;
  function keyDown(event: KeyboardEvent) {
    focus.captureInteraction();
    const element = event.target as HTMLElement;
    if (
      element.closest('[role="dialog"], [role="menu"]') ||
      (element.closest('input,textarea,select,[contenteditable=true]') &&
        !element.closest('.monaco-editor'))
    )
      return;
    if (!checkout || !view || state.preserving) return;
    const key = event.key.toLowerCase(),
      command = event.metaKey || event.ctrlKey,
      picking = pickerMode(event, pickerCommand(event));
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (command && key === 's' && !event.altKey && !(event.ctrlKey && event.metaKey)) {
      take();
      if (target) run(actions.save(target));
    } else if (picking) {
      take();
      openPicker(picking);
    } else if (
      event.metaKey &&
      event.shiftKey &&
      (key === 'e' || (key === 'g' && !element.closest('.monaco-editor')))
    ) {
      // ⇧⌘G is Find Previous in the editor and its find widget, so it switches views only from
      // elsewhere; the editor has no ⇧⌘E of its own.
      take();
      showPanel(key === 'e' ? 'files' : 'git');
    } else if (event.metaKey && key === 'w' && !event.shiftKey) {
      take();
      if (target) run(withFocus(closeFiles([target.path]), findOrigin(element), true));
    } else if (event.metaKey && event.shiftKey && key === 't') {
      take();
      run(withFocus(actions.reopen(checkout), findOrigin(element), true));
    } else if (event.metaKey && event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      take();
      run(
        withFocus(
          actions.navigate(checkout, event.key === 'ArrowRight' ? 1 : -1),
          findOrigin(element),
        ),
      );
    } else if (event.ctrlKey && event.key === 'Tab') {
      take();
      const next = cycleRecentTabs(recent, {
        active: view.active,
        recentFiles: state.recovery.recentFiles
          .filter((file) => checkoutKey(file.checkout) === checkoutKey(checkout))
          .map((file) => file.path),
        openFiles: view.openFiles,
        back: event.shiftKey,
        origin: findOrigin(element),
      });
      if (next) setRecent(next);
    } else if (event.key === 'Escape' && recent) {
      event.preventDefault();
      setRecent(null);
    }
  }
  function keyUp(event: KeyboardEvent) {
    if (event.key === 'Control' && recent && checkout) {
      event.stopPropagation();
      const path = recent.paths[recent.index];
      setRecent(null);
      run(withFocus(actions.open({ checkout, path }), recent.origin));
    }
  }
  return {
    keyDown,
    keyUp,
    /** The Ctrl+Tab switcher, while open. */
    recent,
    /** Closes the Ctrl+Tab switcher without switching, as focus leaving the workbench does. */
    dismissRecent: () => setRecent(null),
  };
}
