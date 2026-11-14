/**
 * A new chat's worktree branch, named from the first words of its message: `chat/tidy-the-composer`.
 * Mentions are left out; main adds a number when the name is taken.
 */
export function chatWorktreeBranch(message: string) {
  const words =
    message
      .replace(/(?:^|\s)@(?:"[^"]*"|\S+)/g, ' ')
      .replace(/['’]/g, '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let slug = '';
  for (const word of words.slice(0, 6)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 40) break;
    slug = next;
  }
  return `chat/${slug || words[0]?.slice(0, 40) || 'task'}`;
}
