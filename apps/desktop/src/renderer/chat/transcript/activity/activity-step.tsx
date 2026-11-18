import { useContext, useEffect, useEffectEvent, useId, useMemo, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import * as Atom from 'effect/reactivity/Atom';
import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { colors } from '@moonbase/ui/tokens.stylex';
import type {
  ChatTranscriptMatch,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { useDisclosure } from '../disclosure/disclosure.ts';
import { Note } from '../transcript-note.tsx';
import { useTranscript } from '../transcript-context.ts';
import {
  describeActivityHeadline,
  getActivityStepState,
  getAnsweredCall,
  type ActivityStep,
} from './activity.ts';
import { describeHeadlineText, StepLine } from './activity-headline.tsx';
import { foldOutputs, setCallOpen, setOutputOpen } from './open-calls.ts';

/** What a step reads from the row it is in. */
export type StepContext = {
  source: ChatTranscriptSource;
  entryId: string;
  expanded: readonly string[];
  match: ChatTranscriptMatch | null;
  revealing: boolean;
  /** The given parts, whether or not their step is open. */
  children: (open: boolean, parts: readonly ChatTranscriptPart[]) => ReactNode;
};

const closed = Atom.make(false);

/**
 * One step: a line saying what it did, which opens to the parts behind it. A call's output in a
 * later row draws no line and opens with the call; an output open on its own (Find revealing a
 * match in it) shows its call open too, and folding the call folds it.
 */
export function ActivityStepView({
  step,
  source,
  entryId,
  expanded,
  match,
  revealing,
  output,
  children,
}: StepContext & {
  step: ActivityStep;
  /** The step answers a call in a retained row, so it shows under that call's line. */
  output: boolean;
}) {
  const { view } = useTranscript();
  const { openCalls } = view;
  const registry = useContext(RegistryContext);
  const parts = [step.lead, ...step.answers];
  const partIds = parts.map((part) => part.partId);
  const disclosure = useDisclosure({
    entryId,
    id: 'activity:' + step.lead.partId,
    expanded,
    match: match && partIds.includes(match.partId) ? match : null,
    revealing,
  });
  const call = output ? getAnsweredCall(step) : undefined;
  const followKey = call ? `${call.entryId}\n${call.partId}` : '';
  const publishKey =
    step.lead.kind === 'arguments' && source.kind === 'entry'
      ? `${source.entryId}\n${step.lead.partId}`
      : '';
  // Only an output follows a call, and only a call has outputs; other steps read nothing.
  const following = useAtomValue(followKey ? openCalls.isOpen(followKey) : closed);
  /** This call's output is open on its own, so the call shows open. */
  const outputOpen = useAtomValue(publishKey ? openCalls.isOutputOpen(publishKey) : closed);
  const update = useAtomSet(openCalls.state);
  useEffect(() => {
    if (publishKey) update(setCallOpen(publishKey, disclosure.open));
  }, [update, publishKey, disclosure.open]);
  const outputId = useId();
  useEffect(() => {
    if (!followKey) return;
    update(setOutputOpen(outputId, followKey, disclosure.open));
    return () => update(setOutputOpen(outputId, followKey, false));
  }, [update, followKey, outputId, disclosure.open]);
  // Folding the call folds this output where it is open on its own.
  const foldWithCall = useEffectEvent(() => {
    if (disclosure.open) disclosure.onOpenChange();
  });
  useEffect(() => {
    if (!followKey) return;
    // A subscription follows an atom once it has been read.
    const folds = openCalls.folds(followKey);
    registry.get(folds);
    return registry.subscribe(folds, () => foldWithCall());
  }, [registry, openCalls, followKey]);
  const open = disclosure.open || following || outputOpen;
  const changeOpen = (next: boolean) => {
    if (!next && outputOpen) update(foldOutputs(publishKey));
    if (next !== disclosure.open) disclosure.onOpenChange();
  };
  const results = useAtomValue(view.rows.resultsByCall);
  const described = useMemo(
    () =>
      output
        ? null
        : {
            state: getActivityStepState(step, { source }, results),
            headline: describeActivityHeadline(step, { source }, results),
          },
    [output, step, source, results],
  );
  const panelId = useId();
  // A plain disclosure, not a Collapsible: a long run renders hundreds of steps, and each
  // Collapsible measures its panel.
  return (
    <div data-transcript-step="" data-open={open ? '' : undefined}>
      {described && (
        <StepLine
          {...described}
          // The whole line opens the step, as its chevron does.
          onClick={(event) => {
            if ((event.target as Element).closest('button')) return;
            if (!window.getSelection()?.toString()) changeOpen(!open);
          }}>
          <button
            type="button"
            aria-label={`Activity · ${describeHeadlineText(described.headline)}`}
            aria-expanded={open}
            aria-controls={panelId}
            title="Show recorded parts"
            disabled={disclosure.disabled}
            onClick={() => changeOpen(!open)}
            {...stylex.props(controls.button, controls.iconButton, styles.toggle)}>
            <Icon name="chevron" />
          </button>
        </StepLine>
      )}
      {disclosure.disclosureError && (
        <Note role="alert">
          Could not remember this activity disclosure. Its content is expanded.
        </Note>
      )}
      {/* Kept mounted so Find can hydrate folded parts. */}
      <div id={panelId} hidden={!open} {...stylex.props(open && styles.panel)}>
        {children(open, parts)}
      </div>
    </div>
  );
}

const styles = stylex.create({
  /** The step's opener: always shown, pointing right, and down once its parts are open. */
  toggle: {
    position: 'absolute',
    top: 2,
    right: 4,
    width: 24,
    height: 24,
    padding: 4,
    color: colors.muted,
    transform: { default: 'rotate(-90deg)', ':is([aria-expanded=true])': 'none' },
  },
  /**
   * An opened step's recorded parts, indented under it behind a rule, so it is plain where the step
   * ends and the next closed step begins. A call's output row continues the same rule.
   */
  panel: {
    marginInline: '20px 8px',
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.border,
    // Its last block's own bottom margin would push the next line further than a closed step's.
    marginBottom: -4,
    ':empty': { display: 'none' },
  },
});
