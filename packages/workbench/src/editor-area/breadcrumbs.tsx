import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';

/** The active file's path under its checkout's folder name, marking unsaved changes. */
export function Breadcrumbs({
  checkout,
  path,
  unsaved,
}: {
  checkout: CheckoutTarget;
  path: string;
  unsaved: boolean;
}) {
  const parts = [
    checkout.root.split('/').filter(Boolean).at(-1) || checkout.root,
    ...path.split('/'),
  ];
  return (
    <nav
      aria-label="File breadcrumbs"
      title={`${checkout.root}/${path}`}
      {...stylex.props(workbench.breadcrumbs)}>
      <ol {...stylex.props(workbench.breadcrumbList)}>
        {parts.map((part, index) => {
          const last = index === parts.length - 1;
          return (
            <li
              key={index}
              aria-current={last ? 'page' : undefined}
              {...stylex.props(workbench.breadcrumb, last && workbench.currentBreadcrumb)}>
              {index > 0 && (
                <span aria-hidden="true" {...stylex.props(workbench.breadcrumbSeparator)}>
                  /
                </span>
              )}
              <span {...stylex.props(controls.truncate)} title={part}>
                {part}
                {last && unsaved ? ' · Unsaved' : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
