import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import { EditorSession } from '../session/session-service.ts';
import { appendAlert, describeEditorFailure, isCancelled } from './alerts.ts';

export type EditorAlertsShape = {
  readonly alerts: SubscriptionRef.SubscriptionRef<readonly string[]>;
  /**
   * Shows a failure: a string as written (callers pass only their own notes, never host text),
   * any other failure as `describeEditorFailure` gives it. A closing editor reports nothing, nor
   * does anyone a cancellation.
   */
  readonly report: (error: unknown) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
};

/** The editor's alerts. */
export class EditorAlerts extends Context.Service<EditorAlerts, EditorAlertsShape>()(
  'moonbase/editor/EditorAlerts',
) {
  static readonly layer = Layer.effect(
    EditorAlerts,
    Effect.gen(function* () {
      const session = yield* EditorSession;
      const alerts = yield* SubscriptionRef.make<readonly string[]>([]);
      return {
        alerts,
        report: (error) =>
          Effect.flatMap(session.get, ({ closing }) =>
            // Work its caller cancelled (a newer action replaced it) needs no alert.
            closing || isCancelled(error)
              ? Effect.void
              : SubscriptionRef.update(alerts, (shown) =>
                  appendAlert(shown, describeEditorFailure(error)),
                ),
          ),
        clear: SubscriptionRef.set(alerts, []),
      } satisfies EditorAlertsShape;
    }),
  );
}
