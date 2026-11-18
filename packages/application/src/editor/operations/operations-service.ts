import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import type {
  FileTarget,
  OperationResult,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import { EditorError } from '../editor-errors.ts';
import { sameCheckout } from '../keys.ts';
import { movePathsInRecovery } from '../views/views.ts';
import { EditorViews } from '../views/views-service.ts';
import { forgetTrashed, isCheckoutListed, moveClosed } from '../views/views.ts';
import {
  isUncertainFor,
  matchesOperation,
  operationKey,
  type KnownOperation,
  type OperationsState,
} from './operations.ts';

export type EditorOperationsShape = {
  readonly state: SubscriptionRef.SubscriptionRef<OperationsState>;
  readonly get: Effect.Effect<OperationsState>;
  readonly find: (clientId: string, id: string) => Effect.Effect<KnownOperation | undefined>;
  /** Records an operation as sent, its outcome uncertain until its reply arrives. */
  readonly register: (operation: WorkspaceOperation) => Effect.Effect<void>;
  /** Records operations the store holds for this editor, as it loaded. */
  readonly restore: (results: readonly OperationResult[]) => Effect.Effect<void>;
  /** Forgets an operation the host refused outright: it never ran. */
  readonly forget: (clientId: string, id: string) => Effect.Effect<void>;
  readonly acknowledge: (clientId: string, id: string) => Effect.Effect<void>;
  /** Whether an operation whose outcome is uncertain may touch `target`. */
  readonly isUncertainFor: (target: FileTarget) => Effect.Effect<boolean>;
  /** Takes an operation's completed items into what the editor remembers by path. */
  readonly applyFacts: (result: OperationResult) => Effect.Effect<void, EditorError>;
};

/** The file operations the editor has sent or been told of, until each is acknowledged. */
export class EditorOperations extends Context.Service<EditorOperations, EditorOperationsShape>()(
  'moonbase/editor/EditorOperations',
) {
  static readonly layer = Layer.effect(
    EditorOperations,
    Effect.gen(function* () {
      const views = yield* EditorViews;
      const state = yield* SubscriptionRef.make<OperationsState>(new Map());
      const change = (f: (draft: Map<string, KnownOperation>) => void) =>
        SubscriptionRef.update(state, (current) => {
          const draft = new Map(current);
          f(draft);
          return draft;
        });
      return {
        state,
        get: SubscriptionRef.get(state),
        find: (clientId, id) =>
          Effect.map(SubscriptionRef.get(state), (ops) => ops.get(operationKey(clientId, id))),
        register: (operation) =>
          change((draft) =>
            draft.set(operationKey(operation.clientId, operation.id), {
              operation,
              applied: [],
              result: {
                id: operation.id,
                clientId: operation.clientId,
                checkout: operation.checkout,
                kind: operation.kind,
                outcome: 'uncertain',
                items: [],
                message: 'Awaiting operation status.',
              },
            }),
          ),
        restore: (results) =>
          change((draft) => {
            for (const result of results)
              draft.set(operationKey(result.clientId, result.id), { result, applied: [] });
          }),
        forget: (clientId, id) => change((draft) => draft.delete(operationKey(clientId, id))),
        acknowledge: (clientId, id) =>
          change((draft) => {
            const key = operationKey(clientId, id),
              known = draft.get(key);
            if (known) draft.set(key, { ...known, acknowledged: true });
          }),
        isUncertainFor: (target) =>
          Effect.map(SubscriptionRef.get(state), (ops) => isUncertainFor(ops, target)),
        applyFacts: (result) =>
          Effect.gen(function* () {
            const key = operationKey(result.clientId, result.id);
            const ops = yield* SubscriptionRef.get(state);
            const known = ops.get(key) ?? { result, applied: [] };
            if (!ops.has(key)) yield* change((draft) => draft.set(key, known));
            const { operation } = known;
            const { recovery } = yield* views.get;
            if (
              (operation && !matchesOperation(result, operation)) ||
              known.result.kind !== result.kind ||
              !sameCheckout(known.result.checkout, result.checkout) ||
              !isCheckoutListed(recovery, result.checkout)
            )
              return yield* new EditorError({ reason: 'operation-checkout-identity' });
            const applied = new Set(known.applied);
            yield* views.modify((draft) => {
              for (const item of result.items.filter((item) => item.outcome === 'completed')) {
                const itemKey = JSON.stringify([item.source, item.destination]);
                if (applied.has(itemKey)) continue;
                if (
                  operation &&
                  !operation.sources.some((source) => source.target.path === item.source)
                )
                  continue;
                if (result.kind === 'move' && item.destination) {
                  movePathsInRecovery(
                    draft.recovery,
                    result.checkout,
                    item.source,
                    item.destination,
                  );
                  draft.closed = moveClosed(
                    draft.closed,
                    result.checkout,
                    item.source,
                    item.destination,
                  );
                }
                // Trash keeps dirty drafts visible at their original target for manual recovery.
                if (result.kind === 'trash')
                  draft.closed = forgetTrashed(draft.closed, result.checkout, item.source);
                applied.add(itemKey);
              }
            });
            yield* change((draft) => {
              const current = draft.get(key);
              if (current) draft.set(key, { ...current, result, applied: [...applied] });
            });
          }),
      } satisfies EditorOperationsShape;
    }),
  );
}
