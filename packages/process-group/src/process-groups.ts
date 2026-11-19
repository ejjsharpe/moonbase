import { Context, Layer, type Effect, type Scope } from 'effect';
import type { ProcessGroupError } from './process-group-error.ts';
import {
  signalSystemGroup,
  startProcessGroup,
  type ProcessGroup,
  type ProcessGroupOptions,
  type SignalGroup,
} from './process-group.ts';

export type ProcessGroupsShape = {
  /**
   * Starts `executable` in its own process group, owned by the current Scope, whose close stops
   * the group. It fails with `ProcessGroupError` (`start`) when it can't be started.
   */
  readonly spawn: (
    executable: string,
    args: readonly string[],
    options: ProcessGroupOptions,
  ) => Effect.Effect<ProcessGroup, ProcessGroupError, Scope.Scope>;
};

/**
 * Starts process groups. Node's `child_process` is wrapped here, once, rather than run through
 * `effect/process`: the group stop needs what its spawner doesn't do (signal the whole group, keep
 * signalling through EPERM, fail when the group's absence stays unconfirmed, end held pipes) and
 * its own release would signal the group ID again after it was confirmed gone.
 */
export class ProcessGroups extends Context.Service<ProcessGroups, ProcessGroupsShape>()(
  'moonbase/process-group/ProcessGroups',
) {
  /** Process groups signalled through `signalGroup`; tests inject signal outcomes here. */
  static readonly layerWith = (signalGroup: SignalGroup) =>
    Layer.succeed(ProcessGroups, {
      spawn: (executable, args, options) =>
        startProcessGroup(signalGroup, executable, args, options),
    });
  static readonly layer = ProcessGroups.layerWith(signalSystemGroup);
}
