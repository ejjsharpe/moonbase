/** Browser-safe application boundary. Privileged implementations use ./services. */
export const maximumFileBytes = 2 * 1024 * 1024;
export type CheckoutTarget = { hostId: string; checkoutId: string; projectId: string; root: string; branch: string };
export type FileTarget = { checkout: CheckoutTarget; path: string };
export type FileDocument = { text: string; version: string };
export type FileView = "file" | "staged" | "unstaged" | "untracked" | "conflict";
export type EditorPosition = { line: number; column: number; top: number; left: number };
export type CheckoutView = {
  openFiles: string[]; active: string; preview: string | null;
  fileViews: Record<string, FileView>;
  positions: Record<string, Partial<Record<FileView | `${FileView}:original`, EditorPosition>>>;
  tree: { expanded: string[]; selected: string[]; focus: string; scroll: number; hideIgnored: boolean };
};
export type RecoveryDraft = { target: FileTarget; text: string; disk: FileDocument };
export type EditorRecovery = {
  version: 1; clientId: string;
  /** Known exact targets retain closed checkout metadata; open membership is separate. */
  checkouts: CheckoutTarget[]; openCheckoutIds: string[]; selectedCheckoutId: string | null;
  /** Keys are CheckoutTarget.checkoutId, not display labels or composite JSON keys. */
  views: Record<string, CheckoutView>; drafts: RecoveryDraft[];
  recentFiles: FileTarget[]; sidebarWidth: number;
};
export const emptyRecovery = (clientId: string): EditorRecovery => ({
  version: 1, clientId, checkouts: [], openCheckoutIds: [], selectedCheckoutId: null, views: {}, drafts: [], recentFiles: [], sidebarWidth: 270,
});
export type RecoveryLoad = { revision: number; state: EditorRecovery; errors: string[]; operations: OperationResult[] };
export type DirectoryEntry = { path: string; directory: boolean; ignored?: boolean };
export type DirectoryListing = { entries: DirectoryEntry[]; partial: boolean; error?: string };
export type GitChange = { path: string; area: "staged" | "unstaged" | "untracked" };
export type GitStatus = { branch: string; changes: GitChange[]; error?: string };
export type Comparison = { original: string; title: string; working: FileDocument | null; error?: string };
export type LookupMatch = { path: string; score: number; positions: number[] };
export type RecoveryChange = { clientId: string; previousRevision: number; revision: number };
export type RecoveryPublication = RecoveryChange & { requestId: string };
export type EntryReference = { target: FileTarget; identity: string; directory: boolean };
export type WorkspaceOperation = {
  id: string; clientId: string; checkout: CheckoutTarget;
  kind: "create-file" | "create-directory" | "move" | "copy" | "trash" | "import";
  sources: EntryReference[]; destination?: string; text?: string;
  replacements?: EntryReference[]; nativeReferences?: string[];
};
export type OperationResult = {
  id: string; clientId: string; checkout: CheckoutTarget; kind: WorkspaceOperation["kind"];
  recoveryChanges: RecoveryChange[];
  outcome: "completed" | "failed" | "uncertain";
  items: { source: string; destination?: string; outcome: "completed" | "failed" | "uncertain"; message?: string }[];
  message?: string;
};
export type SaveResult =
  | { kind: "saved"; disk: FileDocument; recoveryChanges: RecoveryChange[]; persistencePending?: boolean; message?: string }
  | { kind: "conflict"; disk: FileDocument };
export type WorkspaceEvent = { checkout: CheckoutTarget; paths: string[]; ready?: boolean; error?: string };
export type WorkspaceCommands = {
  openCheckout: {
    input: {
      root: string;
    };
    output: CheckoutTarget;
  };
  readFile: {
    input: FileTarget;
    output: FileDocument;
  };
  saveFile: {
    input: {
      target: FileTarget;
      clientId: string;
      requestId: string;
      text: string;
      expectedVersion: string;
    };
    output: SaveResult;
  };
  listDirectory: {
    input: {
      checkout: CheckoutTarget;
      path: string;
      hideIgnored?: boolean;
    };
    output: DirectoryListing;
  };
  gitStatus: {
    input: {
      checkout: CheckoutTarget;
    };
    output: GitStatus;
  };
  readComparison: {
    input: {
      target: FileTarget;
      area: "staged" | "unstaged" | "untracked";
    };
    output: Comparison;
  };
  lookupFiles: {
    input: {
      checkout: CheckoutTarget;
      query: string;
      limit?: number;
      history?: string[];
    };
    output: {
      matches: LookupMatch[];
      history: LookupMatch[];
      partial: boolean;
      error?: string;
    };
  };
  inspectEntries: {
    input: {
      checkout: CheckoutTarget;
      paths: string[];
    };
    output: EntryReference[];
  };
  mutate: {
    input: WorkspaceOperation;
    output: OperationResult;
  };
  operationStatus: {
    input: {
      clientId: string;
      id: string;
    };
    output: OperationResult | null;
  };
  acknowledgeOperation: {
    input: {
      clientId: string;
      operationClientId: string;
      id: string;
    };
    output: void;
  };
  loadRecovery: {
    input: {
      clientId: string;
    };
    output: RecoveryLoad;
  };
  persistRecovery: {
    input: {
      clientId: string;
      requestId: string;
      expectedRevision: number;
      state: EditorRecovery;
    };
    output: RecoveryPublication;
  };
  getRecoveryPublication: {
    input: {
      clientId: string;
      requestId: string;
    };
    output: RecoveryPublication | null;
  };
};
export type WorkspaceCommand = keyof WorkspaceCommands;
export type CommandInput<K extends WorkspaceCommand> = WorkspaceCommands[K]["input"];
export type CommandOutput<K extends WorkspaceCommand> = WorkspaceCommands[K]["output"];
export type ApplicationErrorCode = "InvalidInput" | "Unavailable" | "Conflict" | "Persistence" | "Uncertain" | "Cancelled" | "Unauthorized" | "Incompatible";
export class ApplicationError extends Error {
  #applicationError = true;
  readonly _tag = "ApplicationError";
  readonly code: ApplicationErrorCode;
  readonly target?: FileTarget;
  constructor(options: { code: ApplicationErrorCode; message: string; target?: FileTarget }) {
    super(options.message); this.name = "ApplicationError"; this.code = options.code; this.target = options.target;
  }
  static is(value: unknown): value is ApplicationError {
    try { return typeof value === "object" && value !== null && #applicationError in value; } catch { return false; }
  }
  static fromUnknown(value: unknown): ApplicationError {
    if (ApplicationError.is(value)) return value;
    let message: string;
    try { message = String(value); } catch { message = "Unprintable application failure"; }
    return new ApplicationError({ code: "Unavailable", message });
  }
}
export type CommandOptions = { signal?: AbortSignal };
export interface EditorClient {
  command<K extends WorkspaceCommand>(operation: K, input: CommandInput<K>, options?: CommandOptions): Promise<CommandOutput<K>>;
  watch(input: { checkout: CheckoutTarget; paths: string[] }, receive: (event: WorkspaceEvent) => void,
    onError: (error: ApplicationError) => void): () => void;
}
