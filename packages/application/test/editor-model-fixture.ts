import { Effect, Exit, Scope, type ManagedRuntime } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import {
  makeEditorController,
  makeEditorModel,
  type EditorDependencies,
  type EditorController,
  type EditorBuffer,
  type CloseChoice,
} from '@moonbase/application/editor';

/** A test composition owns its acquisition scope and injected runtime. */
export async function acquireEditor<R, E extends ApplicationError>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  dependencies: EditorDependencies,
) {
  const scope = Scope.makeUnsafe();
  const model = await runApplicationEffect(
    runtime,
    makeEditorModel(dependencies).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const controller = makeEditorController(runtime, model);
  const dispose = controller.dispose.bind(controller);
  let completion: Promise<void> | undefined;
  controller.dispose = () =>
    (completion ??= dispose().finally(() =>
      runApplicationEffect(runtime, Scope.close(scope, Exit.void)),
    ));
  return controller;
}

/** Drive the same exact-prompt snapshot/action contract as the workbench. */
export function answering<A>(
  controller: EditorController,
  action: () => Promise<A>,
  choose: (buffer: Readonly<EditorBuffer>) => Promise<CloseChoice>,
) {
  const answered = new Set<string>();
  const off = controller.subscribe(() => {
    const prompt = controller.getSnapshot().closePrompt;
    if (!prompt || answered.has(prompt.id)) return;
    answered.add(prompt.id);
    void choose(prompt.buffer).then((choice) => controller.answerClose(prompt.id, choice));
  });
  return action().finally(off);
}
