import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type {
  FileTarget,
  OperationResult,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import { sameCheckout } from '../recovery/recovery-references.ts';
import { listOperationDestinations } from '../mutation/mutation.ts';

/** A file operation the editor dispatched or was told of, until it is acknowledged. */
export type KnownOperation = {
  /** The operation as this editor sent it; absent for one it learned of from the store. */
  operation?: WorkspaceOperation;
  result: OperationResult;
  /** The completed items whose moves the editor has taken in. */
  applied: readonly string[];
  acknowledged?: boolean;
};
export type OperationsState = ReadonlyMap<string, KnownOperation>;

export const operationKey = (clientId: string, id: string) => JSON.stringify([clientId, id]);

/** Whether an operation whose outcome is uncertain may touch `target` or anything inside it. */
export function isUncertainFor(operations: OperationsState, target: FileTarget) {
  return [...operations.values()].some(({ operation, result }) => {
    if (result.outcome !== 'uncertain' || !sameCheckout(result.checkout, target.checkout))
      return false;
    const paths = operation
      ? [
          ...operation.sources.map((source) => source.target.path),
          ...listOperationDestinations(operation),
        ]
      : result.items.flatMap((item) => [
          item.source,
          ...(item.destination ? [item.destination] : []),
        ]);
    return (
      !paths.length ||
      paths.some(
        (path) => isPathAtOrInside(target.path, path) || isPathAtOrInside(path, target.path),
      )
    );
  });
}

/** Whether every operation the editor knows of has been acknowledged. */
export const areOperationsSettled = (operations: OperationsState) =>
  [...operations.values()].every((known) => known.acknowledged);

/** The results shown: those not yet acknowledged. */
export const listUnsettled = (operations: OperationsState) =>
  [...operations.values()].filter((known) => !known.acknowledged).map((known) => known.result);

/** Whether the operation's reply names the operation that was sent. */
export const matchesOperation = (result: OperationResult, operation: WorkspaceOperation) =>
  result.clientId === operation.clientId &&
  result.id === operation.id &&
  result.kind === operation.kind &&
  sameCheckout(result.checkout, operation.checkout);
