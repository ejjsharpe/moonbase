import { icons } from '@moonbase/ui/icons';
import { fileIcons, findFileIcon } from '@moonbase/ui/file-icons';

export function Icon({ name }: { name: keyof typeof icons }) {
  const Component = icons[name];
  return <Component size={16} stroke={1.5} aria-hidden="true" />;
}

/** The icon for the kind of file at `path`, such as TypeScript or an image. */
export function FileIcon({ path }: { path: string }) {
  const Component = fileIcons[findFileIcon(path)];
  return <Component size={16} stroke={1.5} aria-hidden="true" />;
}
