import { icons } from '@moonbase/ui/icons';

export function Icon({ name }: { name: keyof typeof icons }) {
  const Component = icons[name];
  return <Component size={16} stroke={1.5} aria-hidden="true" />;
}
