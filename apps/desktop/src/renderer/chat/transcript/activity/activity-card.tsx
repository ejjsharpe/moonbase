import { useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from '@effect/atom-react';
import { space } from '@moonbase/ui/tokens.stylex';
import type { ChatTranscriptPart } from '@moonbase/contracts/chat';
import { useTranscript } from '../transcript-context.ts';
import { getAnsweredCall, groupActivitySteps, type ActivityStep } from './activity.ts';
import { ActivityStepView, type StepContext } from './activity-step.tsx';

/** Consecutive activity parts read as a list of steps, each opening to its own recorded parts. */
export function Activity({
  joinPrevious,
  joinNext,
  source,
  parts,
  children,
  ...context
}: StepContext & {
  joinPrevious: boolean;
  joinNext: boolean;
  parts: readonly ChatTranscriptPart[];
}) {
  const retained = useAtomValue(useTranscript().view.rows.retained);
  const ownEntry = source.kind === 'entry' ? source.entryId : undefined;
  // Steps keep their identity while the row's parts do, so a step's line isn't worked out again.
  const steps = useMemo(() => groupActivitySteps(parts, ownEntry), [parts, ownEntry]);
  // While its call's row is retained, an output draws no line: it continues its call's step.
  const isOutput = (step: ActivityStep) => {
    const call = getAnsweredCall(step);
    return !!call && retained.has(call.entryId);
  };
  const outputOnly = steps.every(isOutput);
  // Only empty thoughts: nothing to show yet, and no margins either.
  if (!steps.length) return null;
  return (
    <section
      data-transcript-activity=""
      {...stylex.props(
        activityStyles.card,
        joinPrevious && styles.joinPrevious,
        joinNext && styles.joinNext,
        outputOnly && styles.output,
      )}>
      {steps.map((step) => (
        <ActivityStepView
          key={step.lead.partId}
          step={step}
          output={isOutput(step)}
          source={source}
          {...context}>
          {children}
        </ActivityStepView>
      ))}
    </section>
  );
}

export const activityStyles = stylex.create({
  /** Tool work reads as quiet lines of steps; consecutive activity rows join into one list. */
  card: {
    // Contains its content's margins, so joined rows have no seam when a step opens.
    display: 'flow-root',
    minWidth: 0,
    marginBlock: space.sm,
    marginInline: 0,
    paddingBlock: 2,
  },
});
const styles = stylex.create({
  joinPrevious: { marginTop: 0, paddingTop: 0 },
  joinNext: { marginBottom: 0, paddingBottom: 0 },
  /** A call's output row draws no line while closed; open, it shows the output under the call. */
  output: { paddingTop: 0 },
});
