import { memo, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { type } from '@moonbase/ui/tokens.stylex';
import type { MarkdownBlock, MarkdownCache } from './markdown-model.ts';
import { ActiveFindMatch, type FindTarget, type MarkdownActions } from './markdown-context.ts';
import { ParsedBlock } from './markdown-elements.tsx';
import { flowStyles } from './markdown-flow.ts';
import { useReadingPin } from '../reading-pin.ts';
import { getFindSourceProps } from '../part/find-ranges.ts';

export const Markdown = memo(function Markdown({
  source,
  identity,
  revision,
  cache,
  findTarget = null,
  ...actions
}: MarkdownActions & {
  source: string;
  identity: string;
  revision: string;
  cache: MarkdownCache;
  /** Must keep its identity while unchanged. */
  findTarget?: FindTarget | null;
}) {
  const blocks = useMemo(
    () => cache.parse(identity, revision, source),
    [cache, identity, revision, source],
  );
  return (
    <ActiveFindMatch.Provider value={findTarget}>
      <div {...stylex.props(styles.prose)}>
        {blocks.map((block) => (
          <Block key={block.key} block={block} {...actions} />
        ))}
      </div>
    </ActiveFindMatch.Provider>
  );
});
/** One block of a message; the cache keeps an unchanged block's identity while the message grows. */
const Block = memo(function Block({
  block,
  ...actions
}: MarkdownActions & { block: MarkdownBlock }) {
  const root = useRef<HTMLDivElement>(null);
  const current = useMemo(
    () => ({ block, openLink: actions.openLink, copyCode: actions.copyCode }),
    [block, actions.openLink, actions.copyCode],
  );
  const [retained, setRetained] = useState(current);
  // A reader's focus or selection holds the block they are reading still.
  const pinned = useReadingPin(root) !== 0;
  if (!pinned && retained !== current) setRetained(current);
  const selected = pinned ? retained : current;
  // A split block renders exactly its node's source; Find maps its matches within it.
  const only = selected.block.tree.children.length === 1 ? selected.block.tree.children[0] : null;
  const start = only?.position?.start.offset,
    end = only?.position?.end.offset;
  return (
    <div
      ref={root}
      {...(start !== undefined && end !== undefined ? getFindSourceProps(start, end) : {})}
      {...stylex.props(
        stylex.defaultMarker(),
        only?.type === 'heading' || only?.type === 'thematicBreak'
          ? flowStyles.sectionFlow
          : flowStyles.flow,
      )}>
      <ParsedBlock
        block={selected.block}
        openLink={selected.openLink}
        copyCode={selected.copyCode}
      />
    </div>
  );
});

const styles = stylex.create({
  prose: { fontSize: type.message, lineHeight: 1.7, overflowWrap: 'anywhere', minWidth: 0 },
});
