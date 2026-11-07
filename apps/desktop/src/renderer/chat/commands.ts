/** A value a command takes, such as a model or a reasoning effort. */
export type ChatCommandOption = { value: string; label: string; current?: boolean };

/**
 * A `/` command the composer lists at the start of a message. The renderer runs it; Pi Durable
 * provides no commands of its own, so a runtime command would join this list.
 */
export type ChatCommand = {
  name: string;
  description: string;
  /** Choices for the command's argument, named by `optionsLabel` (a model, an effort). */
  options?: readonly ChatCommandOption[];
  optionsLabel?: string;
  run(option?: ChatCommandOption): void;
};

export type ChatCommandContext = {
  /** Whether a saved chat is open, rather than a new one. */
  selected: boolean;
  /** Whether the open chat has a run to stop. */
  running: boolean;
  /** A new local chat's models; an open chat or a remote host keeps its own. */
  models: readonly ChatCommandOption[];
  /** The chosen model's reasoning efforts. */
  efforts: readonly ChatCommandOption[];
  newChat(): void;
  stop(): void;
  clearDraft(): void;
  chooseModel(value: string): void;
  chooseEffort(value: string): void;
};

/** The commands available now, in the order the composer lists them. */
export function listChatCommands(context: ChatCommandContext): ChatCommand[] {
  const commands: ChatCommand[] = [];
  if (context.selected)
    commands.push({ name: 'new', description: 'Start a new chat', run: context.newChat });
  if (context.models.length)
    commands.push({
      name: 'model',
      description: 'Switch model',
      options: context.models,
      optionsLabel: 'Models',
      run: (option) => option && context.chooseModel(option.value),
    });
  if (context.efforts.length)
    commands.push({
      name: 'effort',
      description: 'Switch reasoning effort',
      options: context.efforts,
      optionsLabel: 'Reasoning efforts',
      run: (option) => option && context.chooseEffort(option.value),
    });
  if (context.running)
    commands.push({ name: 'stop', description: 'Stop the current run', run: context.stop });
  commands.push({ name: 'clear', description: 'Clear the draft', run: context.clearDraft });
  return commands;
}

/** Every command name, so a message never sends an unavailable command to the agent. */
export const chatCommandNames = ['new', 'model', 'effort', 'stop', 'clear'] as const;

/** What the caret is typing on a message's first line: a command name, or a command's argument. */
export type CommandQuery =
  | { kind: 'command'; query: string }
  | { kind: 'option'; command: ChatCommand; query: string };

export function findCommandQuery(
  text: string,
  caret: number,
  commands: readonly ChatCommand[],
): CommandQuery | null {
  const head = text.slice(0, caret);
  if (!head.startsWith('/') || head.includes('\n')) return null;
  const name = /^\/(\S*)$/.exec(head);
  if (name) return { kind: 'command', query: name[1]! };
  const argument = /^\/(\S+) +(.*)$/.exec(head);
  const command = argument && commands.find((c) => c.name === argument[1]);
  if (!command?.options) return null;
  return { kind: 'option', command, query: argument![2]! };
}

/** 0 when the text starts with the query, 1 when it holds it elsewhere, -1 when not at all. */
const rank = (text: string, query: string) => {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return -1;
  return at === 0 ? 0 : 1;
};

/** Commands whose name holds the query, those starting with it first. */
export function filterCommands(commands: readonly ChatCommand[], query: string) {
  return commands
    .map((command) => ({ command, rank: rank(command.name, query) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command);
}

/** Options whose label or value holds the query, those starting with it first. */
export function filterOptions(options: readonly ChatCommandOption[], query: string) {
  const text = query.trim();
  return options
    .map((option) => ({
      option,
      rank: Math.min(
        ...[rank(option.label, text), rank(option.value, text)].map((r) => (r < 0 ? 2 : r)),
      ),
    }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.option);
}

/** The draft once a command's line is consumed: the lines after it. */
export const removeCommandLine = (text: string) => {
  const end = text.indexOf('\n');
  return end < 0 ? '' : text.slice(end + 1);
};

/**
 * The command a submitted message's first line names. A line that names no command is a message;
 * one that names a command it can't run is an error rather than text for the agent.
 */
export function resolveCommandLine(
  text: string,
  commands: readonly ChatCommand[],
): { command: ChatCommand; option?: ChatCommandOption } | { error: string } | null {
  const line = /^\/(\S+)(?:[ \t]+(.*?))?[ \t]*(?:\n|$)/.exec(text);
  if (!line || !chatCommandNames.some((name) => name === line[1])) return null;
  const name = line[1]!,
    argument = line[2] ?? '';
  const command = commands.find((c) => c.name === name);
  if (!command) return { error: `/${name} isn't available here.` };
  if (!command.options) {
    if (argument) return { error: `/${name} takes no argument.` };
    return { command };
  }
  const noun = (command.optionsLabel ?? 'option').toLowerCase().replace(/s$/, '');
  if (!argument) return { error: `Choose a ${noun} for /${name}.` };
  const exact = command.options.find(
    (option) =>
      option.value.toLowerCase() === argument.toLowerCase() ||
      option.label.toLowerCase() === argument.toLowerCase(),
  );
  const matches = exact ? [exact] : filterOptions(command.options, argument);
  if (matches.length !== 1)
    return {
      error: matches.length
        ? `More than one ${noun} matches “${argument}”.`
        : `No ${noun} matches “${argument}”.`,
    };
  return { command, option: matches[0]! };
}
