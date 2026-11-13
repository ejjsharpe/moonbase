/** How long ago a chat last did something: minutes and hours, then days, then a date. */
export function formatChatAge(at: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(at)) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
