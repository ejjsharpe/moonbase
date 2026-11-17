/**
 * Whether `path` is an exact relative path in a checkout: no traversal, no `.git`, no absolute or
 * backslash path. A `directory` may be the root, `''`.
 */
export function isRelativePath(path: string, directory = false) {
  if (directory && path === '') return true;
  return !(
    !path ||
    path.length > 4096 ||
    path.startsWith('/') ||
    /[\\\0]/.test(path) ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}
