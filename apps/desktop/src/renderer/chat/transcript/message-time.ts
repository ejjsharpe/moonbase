/** A recorded time as a row shows it: today's messages show their time; older ones add the date. */
export function formatMessageTime(iso: string) {
  const at = new Date(iso),
    time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
