// Project-relative paths: '/'-separated, no leading slash, '' for the project root.

export const getParentPath = (path: string) => path.split('/').slice(0, -1).join('/');
export const getPathName = (path: string) => path.split('/').at(-1)!;
export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
/** Whether `path` is `folder` itself or anything inside it. */
export const isPathAtOrInside = (path: string, folder: string) =>
  path === folder || path.startsWith(folder + '/');
