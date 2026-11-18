import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { colors, type } from '@moonbase/ui/tokens.stylex';
import { summarizeActivityHeadlines, type ActivityHeadline } from './activity.ts';
import { StepLine } from './activity-headline.tsx';
import { formatMessageTime } from '../message-time.ts';
import { textStyles } from '../transcript-text.ts';

/**
 * A run of tool rows folded behind one line: "Worked for 1m 29s", a chevron, the clock time at the
 * far end, and a rule under it. While it works it reads "Working for 14s", and the line under the
 * rule says what it is doing now or the thought it is on.
 */
export function RunLine({
  headlines,
  failed,
  active,
  current,
  startedAt,
  endedAt,
  open,
  stepsId,
  onToggle,
}: {
  headlines: readonly ActivityHeadline[];
  /** How many steps failed, were interrupted or have no result. */
  failed: number;
  active: boolean;
  /** What the work is on now: the latest message's thought, else its latest step. */
  current?: ActivityHeadline;
  /** When the work began: the end of whatever the transcript recorded before it. */
  startedAt?: string;
  /** When its last step was recorded; a running run counts up to now instead. */
  endedAt?: string;
  open: boolean;
  /** The ID of the run's rows, which the line opens. */
  stepsId?: string;
  onToggle: () => void;
}) {
  const now = useNow(active && !!startedAt);
  const until = active ? now : Date.parse(endedAt ?? '');
  const elapsed = startedAt ? until - Date.parse(startedAt) : NaN;
  const duration = Number.isFinite(elapsed) && elapsed >= 0 ? formatDuration(elapsed) : null;
  const summary = summarizeActivityHeadlines(headlines);
  let label = duration ? `Worked for ${duration}` : summary;
  if (active) label = duration ? `Working for ${duration}` : 'Working…';
  return (
    <>
      <div {...stylex.props(styles.fold)}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={stepsId}
          data-transcript-activity-group=""
          title={failed ? `${summary} · ${failed} failed` : summary}
          onClick={onToggle}
          {...stylex.props(controls.button, controls.quietButton, styles.button)}>
          <span>
            {label}
            {!active && failed > 0 && (
              <span {...stylex.props(styles.problem)}> · {failed} failed</span>
            )}
          </span>
          <span aria-hidden="true" {...stylex.props(styles.chevron)}>
            <Icon name="chevron" />
          </span>
        </button>
        {!active && endedAt && (
          <time
            dateTime={endedAt}
            title={new Date(endedAt).toLocaleString()}
            {...stylex.props(styles.time, textStyles.revealed)}>
            {formatMessageTime(endedAt)}
          </time>
        )}
      </div>
      {active && !open && current && (
        <StepLine
          state="running"
          // A command reads in full ("Running npm test"); a file is named by its action.
          headline={{ ...current, detail: current.category === 'command' ? current.detail : '' }}
        />
      )}
    </>
  );
}

/** The current time, ticking each second while enabled. */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** "12s", "4m 05s", "1h 02m". */
function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000),
    minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours) return `${hours}h ${pad(minutes % 60)}m`;
  if (minutes) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${seconds}s`;
}

const styles = stylex.create({
  /** A folded run of tool rows: "Worked for 1m 29s", a chevron, the time, and a rule under it. */
  fold: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingTop: 2,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    paddingInline: 4,
    fontFamily: type.ui,
    fontSize: type.message,
    lineHeight: 1.7,
    color: { default: colors.muted, ':hover': colors.text },
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
  },
  problem: { flexShrink: 0, color: colors.danger },
  /** Points right while folded, down once open. */
  chevron: {
    display: 'inline-flex',
    transform: { default: 'rotate(-90deg)', ':is([aria-expanded=true] *)': 'none' },
  },
  time: {
    marginLeft: 'auto',
    paddingInline: 4,
    color: colors.muted,
    fontSize: type.caption,
    fontVariantNumeric: 'tabular-nums',
  },
});
