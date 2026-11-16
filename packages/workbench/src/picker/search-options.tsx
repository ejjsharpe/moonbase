import * as stylex from '@stylexjs/stylex';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import type { TextSearchOptions } from '@moonbase/application/editor';
import { styles } from './picker-styles.ts';

type SearchOption = keyof TextSearchOptions;

const searchOptions = [
  ['matchCase', 'Aa', 'Match case', '⌥C'],
  ['wholeWord', 'ab', 'Whole word', '⌥W'],
  ['regex', '.*', 'Regular expression', '⌥R'],
] as const satisfies readonly (readonly [SearchOption, string, string, string])[];

/** ⌥C, ⌥W and ⌥R toggle Find's options from its field. */
export function findSearchOption(event: { altKey: boolean; code: string }) {
  if (!event.altKey) return;
  return ({ KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' } as const)[
    event.code as 'KeyC' | 'KeyW' | 'KeyR'
  ] as SearchOption | undefined;
}

/** Find's Match case, Whole word and Regular expression toggles. */
export function SearchOptions({
  options,
  change,
}: {
  options: TextSearchOptions;
  change: (options: TextSearchOptions) => void;
}) {
  return (
    <ToggleGroup
      multiple
      value={searchOptions.flatMap(([option]) => (options[option] ? [option] : []))}
      onValueChange={(pressed) =>
        change({
          matchCase: pressed.includes('matchCase'),
          wholeWord: pressed.includes('wholeWord'),
          regex: pressed.includes('regex'),
        })
      }
      {...stylex.props(styles.toggles)}>
      {searchOptions.map(([option, text, label, keys]) => (
        <Toggle
          key={option}
          value={option}
          aria-label={label}
          title={`${label} · ${keys}`}
          {...stylex.props(styles.toggle)}
          // The field keeps focus, so typing carries on after a click.
          onMouseDown={(event) => event.preventDefault()}>
          {text}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
