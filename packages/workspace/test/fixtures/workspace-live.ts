import { WorkspaceLocalLive, type WorkspaceConfiguration } from '../../src/index.ts';

/** The host and one client store in one process, as a local app composes them. */
export const WorkspaceLive = (
  configuration: WorkspaceConfiguration & { installationId?: string },
  now?: () => number,
) => WorkspaceLocalLive({ installationId: 'test-installation', ...configuration }, now);
