import { useImperativeHandle, useRef, type Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Tabs } from '@base-ui/react/tabs';
import { AnimatePresence, useReducedMotion } from 'motion/react';
import { workbench } from '@moonbase/ui/workbench';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { checkoutKey, fileKey, type CheckoutTabs } from '@moonbase/application/editor';
import type { FocusReturn } from '../focus-return.ts';
import { EditorTab, type TabDrag } from './editor-tab.tsx';
import type { EditorActions } from '../editor-actions.ts';
import type { Effect } from 'effect';
import type { WorkbenchServices } from '../workbench-editor.ts';

/** What the tab strip offers its workbench, to tell where focus was and to return it. */
export type EditorTabsHandle = {
  /** The strip's element. */
  element(): HTMLElement | null;
  /** The tab of an open file, while it shows. */
  findTab(path: string): HTMLElement | undefined;
};

/** A checkout's open files as a strip of tabs, inside the editor's `Tabs.Root`. */
export function EditorTabs({
  ref,
  actions,
  checkout,
  view,
  git,
  closeFiles,
  withFocus,
}: {
  ref?: Ref<EditorTabsHandle>;
  actions: EditorActions;
  checkout: CheckoutTarget;
  view: CheckoutTabs;
  git: boolean;
  closeFiles: (paths: string[]) => Effect.Effect<boolean, unknown, WorkbenchServices>;
  withFocus: FocusReturn['withFocus'];
}) {
  const strip = useRef<HTMLDivElement>(null),
    tabs = useRef(new Map<string, HTMLElement>()),
    dragged = useRef<string | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      element: () => strip.current,
      findTab: (path) => tabs.current.get(path),
    }),
    [],
  );
  const drag: TabDrag = {
    start: (path) => {
      dragged.current = path;
    },
    end: () => {
      dragged.current = null;
    },
    dragging: () => dragged.current !== null,
    drop: (path) => {
      if (dragged.current) actions.reorder(checkout, dragged.current, view.openFiles.indexOf(path));
      dragged.current = null;
    },
  };
  // Buffer tabs slide open and shut; the rest slide along to close the gap.
  const reducedMotion = useReducedMotion();
  const tabMotion = { duration: reducedMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] as const };
  return (
    <Tabs.List ref={strip} aria-label="Open files" {...stylex.props(workbench.fileTabs)}>
      {/* One group per checkout: switching swaps the list outright, since a tab's value is its
          path and an outgoing tab must never share it with an incoming one. */}
      <AnimatePresence key={checkoutKey(checkout)} initial={false}>
        {view.openFiles.map((path) => (
          <EditorTab
            key={fileKey({ checkout, path })}
            actions={actions}
            checkout={checkout}
            view={view}
            path={path}
            git={git}
            tabMotion={tabMotion}
            drag={drag}
            tabRef={(element) => {
              if (!element) return;
              tabs.current.set(path, element);
              return () => {
                if (tabs.current.get(path) === element) tabs.current.delete(path);
              };
            }}
            closeFiles={closeFiles}
            withFocus={withFocus}
          />
        ))}
      </AnimatePresence>
    </Tabs.List>
  );
}
