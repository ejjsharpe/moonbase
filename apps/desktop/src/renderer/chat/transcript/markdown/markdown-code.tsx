import { memo, useContext, useMemo, useRef, useState } from 'react';
import { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useAtomValue } from '@effect/atom-react';
import { Button } from '@base-ui/react/button';
import { Collapsible } from '@base-ui/react/collapsible';
import { Icon } from '@moonbase/ui/icons';
import * as stylex from '@stylexjs/stylex';
import * as monaco from 'monaco-editor';
import { controls } from '@moonbase/ui/controls';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import {
  foldedCodeLines,
  markdownWork,
  canHighlight,
  getSyntaxTone,
  type SyntaxTone,
} from './markdown-model.ts';
import { ActiveFindMatch, type FindTarget } from './markdown-context.ts';
import { flowStyles } from './markdown-flow.ts';
import { useReadingPin } from '../reading-pin.ts';
import { useRememberedExpansion } from '../disclosure/remembered-fold.ts';
import { getFindSourceProps } from '../part/find-ranges.ts';

/** Pixels a code block grows before scrolling. */
const codeMaxHeight = 400;
/** Each highlighting language, loaded once and kept for the page's life. */
const languages = Atom.family((language: string) =>
  Atom.make(Effect.tryPromise(() => monaco.editor.colorize('', language, {}))).pipe(Atom.keepAlive),
);
const noLanguage: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> = Atom.make(
  AsyncResult.initial(),
);
function tokenize(text: string, language: string) {
  markdownWork.tokenize++;
  return monaco.editor.tokenize(text, language);
}
/** A fenced code block: highlighted once its language loads, folded past its first lines. */
export const Code = memo(function Code({
  text,
  language,
  closed,
  copyStart,
  sourceStart,
  sourceEnd,
  foldStart,
  foldId,
}: {
  text: string;
  language: string;
  closed: boolean;
  /** Offers Copy, for the part around the message to handle (`data-copy-code`). */
  copyStart?: number;
  /** The block's source offsets, fences included. */
  sourceStart?: number;
  sourceEnd?: number;
  /** Where the folded lines start in the source. */
  foldStart?: number;
  /** Names the block's unfolding in its row's view memory. */
  foldId?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  /**
   * Folded code shows its first lines; the rest render only while unfolded. The reader's unfolding
   * is remembered; Find's is not.
   */
  const remembered = useRememberedExpansion(foldId ?? null);
  const lines = text.split('\n');
  const foldable = lines.length > foldedCodeLines;
  const findMatch = useContext(ActiveFindMatch);
  /** Find maps the shown and folded lines as separate source spans. */
  const spans =
    foldable && sourceStart !== undefined && sourceEnd !== undefined && foldStart !== undefined
      ? { start: sourceStart, fold: foldStart, end: sourceEnd }
      : null;
  /** The Find match last checked for unfolding, and whether Find unfolded the code while mounted. */
  const [revealed, setRevealed] = useState({ match: null as FindTarget | null, open: false });
  // A newly active Find match in the folded lines unfolds them once; the reader can fold again.
  // The unfolding is Find's, not the reader's, so it is not remembered, and nothing saves the view
  // while the list is still moving to the match.
  if (findMatch !== revealed.match)
    setRevealed({
      match: findMatch,
      open:
        revealed.open ||
        (!!findMatch && !!spans && findMatch.end > spans.fold && findMatch.start < spans.end),
    });
  const unfolded = remembered.open || revealed.open;
  const setUnfolded = (open: boolean) => {
    if (!open && revealed.open) setRevealed({ ...revealed, open: false });
    remembered.setOpen(open);
  };
  const known = monaco.languages
    .getLanguages()
    .find(
      (value) =>
        value.id === language ||
        value.aliases?.some((alias) => alias.toLowerCase() === language.toLowerCase()) ||
        value.extensions?.includes(`.${language}`),
    );
  const languageId = known?.id;
  const supported = !!languageId && canHighlight(text, closed);
  const loaded = AsyncResult.isSuccess(
    useAtomValue(supported && languageId ? languages(languageId) : noLanguage),
  );
  const [ready, setReady] = useState('');
  // Highlighting replaces the text nodes, so it waits until no reader focus or selection is
  // inside, and stops listening once applied.
  const waiting = supported && ready !== languageId;
  const pinned = useReadingPin(pre, waiting) !== 0;
  if (waiting && languageId && loaded && !pinned) setReady(languageId);
  const tokens = useMemo(
    () =>
      languageId && ready === languageId && canHighlight(text, closed)
        ? tokenize(text, languageId)
        : undefined,
    [text, languageId, closed, ready],
  );
  const renderLines = (from: number, to: number) => {
    const shown = lines.slice(from, to);
    if (!tokens) return shown.join('\n');
    return shown.map((line, offset) => {
      const index = from + offset,
        lineTokens = tokens[index];
      return (
        <span key={index}>
          {lineTokens?.length
            ? lineTokens.map((token, part) => {
                const tone = getSyntaxTone(token.type);
                return (
                  <span key={part} {...stylex.props(tone && toneStyles[tone])}>
                    {line.slice(token.offset, lineTokens[part + 1]?.offset)}
                  </span>
                );
              })
            : line}
          {offset < shown.length - 1 ? '\n' : ''}
        </span>
      );
    });
  };
  return (
    <Collapsible.Root
      open={unfolded}
      onOpenChange={setUnfolded}
      {...(sourceStart !== undefined && sourceEnd !== undefined
        ? getFindSourceProps(sourceStart, sourceEnd)
        : {})}
      {...stylex.props(stylex.defaultMarker(), flowStyles.flow, styles.code)}>
      <div {...stylex.props(controls.row, styles.codeHeader)}>
        <span data-find-ignore>
          {language || 'Plain text'}
          {!closed && ' · Incomplete'}
        </span>
        {copyStart !== undefined && (
          <Button
            aria-label="Copy code"
            title="Copy code"
            data-copy-code={copyStart}
            {...stylex.props(controls.button, controls.iconButton)}>
            <Icon name="copy" />
          </Button>
        )}
      </div>
      <pre ref={pre} tabIndex={0} {...stylex.props(controls.pre, styles.codeText)}>
        <code>
          {spans ? (
            <span {...getFindSourceProps(spans.start, spans.fold)}>
              {renderLines(0, foldedCodeLines)}
            </span>
          ) : (
            renderLines(0, foldable ? foldedCodeLines : lines.length)
          )}
          {foldable && (
            <Collapsible.Panel
              render={<span />}
              {...(spans && getFindSourceProps(spans.fold, spans.end))}>
              {'\n'}
              {renderLines(foldedCodeLines, lines.length)}
            </Collapsible.Panel>
          )}
        </code>
      </pre>
      {foldable && (
        <Collapsible.Trigger {...stylex.props(controls.button, controls.quietButton)}>
          {unfolded ? 'Fold code' : `Show all ${lines.length} lines`}
        </Collapsible.Trigger>
      )}
    </Collapsible.Root>
  );
});
const styles = stylex.create({
  code: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    minWidth: 0,
    overflow: 'hidden',
  },
  codeHeader: {
    justifyContent: 'space-between',
    paddingBlock: space.xs,
    paddingInline: space.md,
    fontSize: type.small,
    color: colors.secondary,
  },
  codeText: {
    fontFamily: type.mono,
    fontSize: type.body,
    lineHeight: 1.6,
    padding: space.md,
    margin: 0,
    whiteSpace: 'pre',
    maxHeight: codeMaxHeight,
    overflow: 'auto',
  },
});
const tones = stylex.create({
  comment: { color: syntax.comment },
  keyword: { color: syntax.keyword },
  string: { color: syntax.string },
  number: { color: syntax.number },
  type: { color: syntax.type },
  function: { color: syntax.function },
  variable: { color: syntax.variable },
  constant: { color: syntax.constant },
  property: { color: syntax.variable },
  operator: { color: syntax.operator },
  regexp: { color: syntax.regexp },
  tag: { color: syntax.keyword },
  attribute: { color: syntax.variable },
});
const toneStyles: Record<SyntaxTone, stylex.StyleXStyles> = tones;
