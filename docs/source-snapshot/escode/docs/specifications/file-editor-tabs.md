# File tabs inside checkout tabs

Status: accepted by the user, 2026-10-31, including the complete synthesis and final defaults. This specifies a subsequent implementation; it does not describe shipped behavior. Decision owner: [How should file tabs behave inside a checkout tab?](https://github.com/ejjsharpe/escode/issues/91). Destination: [Specify checkout tabs and fuzzy file lookup](https://github.com/ejjsharpe/escode/issues/87).

Implementation specification: [Specification: file tabs inside checkout tabs](https://github.com/ejjsharpe/escode/issues/92).

Each checkout-specific project tab has one editor pane and a row of file tabs. A file has one tab and one editable working buffer in that checkout. Its ordinary editor, Git comparisons and save-conflict comparison are views of that same file. Opening another view reuses the tab and the user's edits.

## Reference and scope

The [VS Code research](https://github.com/ejjsharpe/escode/blob/580e954ec785f6be23a1a13d3e0d8741bd3b3268/docs/research/vscode-editor-tabs.md), resolved by [How do VS Code editor tabs work?](https://github.com/ejjsharpe/escode/issues/90), traces official documentation and source at `microsoft/vscode` revision `c254b82c637ec4ee275483e6e4dcb31360a8b7d7`. It supplies the preview, Keep Open, ordering, MRU, keyboard and restoration references. The user specifically selected one tab per file, with comparison views sharing that tab.

The parent map owns checkout-tab membership, chat/draft context and file-lookup behavior. Its accepted direction gives each top-level project tab a fixed checkout. Opening the same checkout focuses its existing tab; different worktrees can have separate tabs while retaining their shared Project identity. File tabs live inside those workspaces. This specification adds no chat tabs or chat execution changes.

One editor pane can display a normal editor or a comparison's old/new sides. Additional editor groups, split editor panes, sticky Pin Editor tabs, tab multi-selection, configurable tab layouts and a new content-search feature are outside this iteration. Ordinary Keep Open is included.

## Identity and ownership

Within a client's checkout workspace, the existing validated checkout/file identity identifies a file tab. Display names, branch names and comparison kinds do not identify separate tabs. Files with the same relative path in different checkouts retain separate tabs, buffers and recovery drafts. Branch changes in the same checkout do not create another workspace or tab identity.

Each workspace remembers its file tabs, visual order, active file, preview, selected view and editor positions. Visual order and most-recently-used (MRU) order are distinct. Tab navigation and unsaved buffers belong to the client; another client's navigation, Save or Discard must not clear its edits or recovery state. Filesystem approval and operation authority remain with the execution host.

## Opening and previews

There is at most one replaceable preview in a workspace, shared by Files and Source Control. A successful single-click open of a file not already open creates a preview, replacing the previous clean preview. Its filename is italic. Opening an already-open file activates its existing tab, changes the view when the entry point requests a view, and does not evict another preview.

Double-clicking the file entry or its preview tab, choosing Keep Open, editing either editable view, or moving a preview to a different tab position keeps it open. Saving or undoing back to clean leaves it kept open. New File, explicit keyboard opening with Cmd+Down, and restored unsaved buffers also open kept open. Promotion changes the existing tab without adding a duplicate.

A plain Files click and Space preview while retaining tree focus. Arrow navigation still changes tree focus/selection; Enter retains Rename. Cmd+Down opens kept open and focuses the editor. Modified clicks and multi-selection retain the existing Files contract. Failed new opens report the failure and leave the displayed editor and existing preview intact.

An explicitly activated file-lookup result opens kept open, focusing its existing tab or creating one in the target workspace. Merely moving through lookup results follows the search specification and does not create file tabs. Other explicit Open File actions also keep the file open; browsing with Files/Source Control retains preview behavior.

New tabs are inserted immediately to the right of the active tab; opening an existing tab does not reorder it. Preview replacement follows the same insertion rule, without a reserved preview position. Tabs can be reordered by dragging. There is one horizontally scrolling row, and activation reveals the active tab. Opening files does not automatically evict kept-open tabs.

## Views and sidebar navigation

Opening a Files entry selects that file's ordinary editor. Opening a Source Control entry selects its corresponding staged, unstaged or untracked comparison in the same file tab. Clicking a tab restores its last-used view. A labelled editor control lets the user select the normal file view or an available comparison directly, including when the other sidebar is visible.

Switching the sidebar between Files and Source Control leaves the active tab and view visible. Opening a chat temporarily replaces the editor surface; returning to Files or Source Control restores the workspace's active file and tabs. Chats remain outside the file-tab row. Chat-list and context rules follow the parent checkout-tab specification.

All editable views use the same working-file buffer. Existing comparison meanings remain: staged uses HEAD against the editable working copy, unstaged uses the index as its original, and untracked uses an empty original. Saving writes the working file without staging. An unavailable working file retains an available read-only comparison under the existing rules.

A successfully refreshed comparison with equal sides shows No changes and stays selected. A comparison that cannot load shows an unavailable explanation and Retry; the normal file view remains selectable. The disappearance of a Source Control row alone does not close the file or switch its view. Save-conflict Compare also uses the same file tab and retains Compare/Overwrite/Reload/Cancel and the loaded disk baseline.

## Closing and reopening

Each file tab has Close. Closing a dirty file, whether displayed normally or as a comparison, offers Save/Discard/Cancel for the single shared buffer. Cancel, a failed Save or failed required persistence keeps the tab and its available edits. Closing releases the model only after the existing recovery-removal handoff succeeds. It never stages a file or closes a chat.

Closing the active tab activates the most recently used remaining tab in that workspace. Closing an inactive tab preserves the active one. Closing the last tab leaves an empty editor area and the checkout's project tab open.

Tab context menus provide Close, Close Others, Close to the Right, Close All and Keep Open. Close Others uses the context-targeted tab; Close to the Right uses visual order. Bulk close captures its target set and resolves required dirty-file choices before removing tabs or applying proposed discards. Cancel or failure retains those tabs and remaining edits. Saves already completed remain real disk changes; cancellation does not undo them. This retains the existing deliberate-close preservation rule.

Reopen Closed (Cmd+Shift+T) reverses the most recent successful file-close action in the current workspace, restoring the files' last views and positions. A bulk close is reopened as one batch. Already-open files are reused without duplicating or overwriting their buffers. Unavailable paths remain exact unavailable targets with explanations; reopening never substitutes another file.

Recently closed history is metadata for the current client session, separate from persisted open-tab state. It contains explicit successful file closes. Preview replacement, moves, Trash and project-tab closure do not enter this history. Reopening reads current file contents and cannot recover explicitly discarded text or undo filesystem operations. The implementation must bound retained history and evict complete older batches without splitting the latest reopenable batch.

Closing a checkout's project tab retains that workspace's file-tab metadata for reopening and uses the parent map's checkout-scoped Save/Discard/Cancel behavior. Chat work and the on-disk worktree continue. Explicit Quit and last-window close retain their accepted lifecycle rules.

## Keyboard and accessibility

| Action | macOS interaction |
| --- | --- |
| Close active file | Cmd+W while Files or Source Control is visible, including sidebar focus |
| Reopen last close action | Cmd+Shift+T |
| Choose a recent tab | Ctrl+Tab; Ctrl+Shift+Tab traverses the recent-tabs picker backwards |
| Previous/next tab in visual order | Cmd+Option+Left/Right |
| Keep preview open | Double-click or Keep Open in the tab context menu |
| Preview/open from Files | Space previews; Cmd+Down opens kept open and focuses the editor |

These commands target the active checkout's file tabs. Cmd+W with no file tabs is a no-op and does not close the project tab or window. File-tab shortcuts do not act on hidden editors while Chats or Agents is visible, or consume active dialogs and text-entry controls' own editing commands.

In the recent-tabs picker, holding Ctrl and pressing Tab/Shift+Tab moves its selection; releasing Ctrl commits it. Escape cancels and retains the original active tab, view and MRU order. Picker selection alone does not replace the file preview or discard edits.

Tab labels show filenames and enough parent-path text to distinguish duplicate names. Hover exposes the full path. Preview italics, an unsaved dot and active selection indicate separate states; Git status is not the unsaved marker. The editor toolbar names the current comparison. Accessible names convey the path and relevant states without relying on color or italics alone.

The strip and tabs use the established tablist/tab pattern, selected state and roving keyboard focus. With focus in the strip, Left/Right and Home/End navigate tabs while retaining strip focus; Enter/Space enters the editor. Shift+F10 opens the tab context menu. Closing and menu dismissal restore a meaningful surviving focus target; an empty strip cannot strand keyboard focus. Controls remain usable at narrow widths and with VoiceOver.

## Restoration and unavailable state

Reopening a project tab and restarting the app restore its open file identities, visual order, active file, selected views and cursor/scroll positions alongside available recovery drafts. Normal and comparison views retain their own editor position. Restore available unsaved text and its loaded disk baseline through the existing recovery mechanism; it remains best effort. Reopening restores no agent turn automatically.

Clean file contents and Git comparisons are loaded from their current validated sources; tab restoration does not persist stale comparison bodies as edit authority. Revalidate save-conflict comparisons against current disk state. Recovered unsaved buffers are kept-open tabs even when old preview metadata exists.

Restore a clean preview as the workspace's preview. Its dirty recovery draft, when available, takes precedence and makes it kept open.

Already-open or restored files that disappear keep their tabs, exact paths and available edits, with an unavailable explanation and recovery controls. An unavailable checkout preserves its workspace and drafts. Retry uses the original identities and never creates missing folders/files or adopts a replacement checkout silently. New failed opens leave the prior editor visible. Existing binary, encoding, symbolic-link and 2 MiB editor limits remain.

Successful in-app rename/move updates the affected tab paths in place, including dirty descendants, preserving order, active selection, chosen view and available editor positions. Carry the same available text, disk baselines, recovery records and existing undo-reset disclosure. Successful Trash removes only the affected tabs through its existing dirty-file gate. Failed, partial and uncertain operations use their recorded per-item outcomes; uncertainty retains work and blocks unsafe mutation. Recently closed references must follow known moves and must not resurrect deliberately trashed paths. The existing operation journal remains authoritative across restart.

## Implementation handoff

Reuse existing checkout-scoped buffers, Monaco models, file operations and recovery. Add the tab metadata to the client view state and its validated persistence path; do not create a second buffer registry or put comparison snapshots in recovery text. Preserve stale-response checks so an earlier file/diff request cannot replace a later selection.

| Existing boundary | Required reach |
| --- | --- |
| `apps/desktop/src/main.tsx` checkout/project composition | Shared open/reuse path, tabs and view selection independent of the sidebar; close/MRU/reopen, focus, save/conflict and successful operation reconciliation |
| `apps/desktop/src/files.tsx` | Distinguish preview from Keep Open and explicit opening without breaking tree selection, existing keys, inline editing or native operations |
| File-lookup integration from the parent map | Exact target workspace/file; activation reuses the shared open path and dirty buffer |
| `apps/desktop/src/workspace.ts`, `packages/contracts/index.ts`, `apps/desktop/host/workspace.ts` | Validated client-owned tab/view/position restoration alongside existing recovery ownership; retain current version/rejection policy |
| `apps/desktop/host/file-operation-state.ts` and renderer operation reconciliation | Tab and closed-history references follow recorded move/Trash outcomes, including restart and unavailable descendants |
| Existing desktop navigation, editable-diff, lifecycle, Files and recovery tests | Extend relevant fixtures and focused acceptance coverage; preserve existing save, journal, authority and chat-lifecycle gates |

This is a behavior and preservation handoff, not a selected tab library or a prescribed new abstraction. Qualification targets the actual desktop and packaged application through the existing automated tests. On 2026-10-31, the user removed VoiceOver testing and manual accessibility sign-off from acceptance for this personal application; they will report future problems during use. Retain the accessible controls and automated keyboard, focus and semantic checks.

## Acceptance examples

1. **Independent workspaces:** open two checkouts of one project with matching relative filenames. Edit one, navigate to the other and back, close/reopen its project tab, then restart. Tab sets, order, active file, views, positions and available unsaved drafts stay with the exact checkout/client.
2. **Preview and promotion:** single-click A then B; only B remains as preview. Edit B or Keep Open, then single-click C; B stays and C is the preview. Saving/undoing B does not make it replaceable. Reopening B reuses its tab and preserves C's preview.
3. **One file and several views:** keep A open, edit it, choose its unstaged and staged entries, then Files. One tab remains, every editable view has the same text, the selected view returns on tab activation, and Save leaves the Git index unchanged.
4. **Sidebar and Chats:** switch Files/Source Control without selecting an entry; the current editor stays. Open a chat and return; restore the same file tabs and active view without changing the chat's identity or execution context.
5. **Opening paths:** New File, Cmd+Down, confirmed lookup activation and preview reordering keep tabs open. Space previews with tree focus retained; Enter still renames. A failed new open leaves the existing editor/preview visible. Rapid delayed file/diff replies cannot steal the newer selection.
6. **Order and overflow:** open a new file with a middle tab active, check right-hand insertion, drag it, and overflow a narrow row. The active tab is revealed; duplicate filenames are distinguishable; kept-open tabs are not silently evicted.
7. **Close selection:** close an inactive tab without focus change, close the active tab back to the MRU survivor, then close the last file. The project tab remains open; Cmd+W with an empty editor does nothing.
8. **Dirty and bulk close:** edit files through normal and diff views. Cancel, failed Save or persistence failure retains affected tabs/text. Cancel a later prompt after an earlier Save: all targeted tabs remain, earlier disk Save remains real, and proposed discards are not applied. A successful batch closes only its captured targets.
9. **Reopen:** reopen a single close and each bulk-close operation with Cmd+Shift+T. Restore views/order without duplicates, skip preview replacements in history, retain exact unavailable targets, and never recover explicitly discarded text. Restart restores open tabs but starts a fresh recently-closed session history.
10. **Restoration and comparison refresh:** restore clean and dirty tabs and a clean preview; recover dirty text/baselines as kept open. Reload current comparison data. An equal comparison displays No changes; a failed comparison displays unavailable without changing the selected view or losing edits.
11. **Filesystem outcomes:** move/rename a dirty file and a directory containing several tabs; preserve available state at the successful destinations. Exercise failed and partial Trash, uncertain operation/restart, external deletion, and replaced checkout identity. Only recorded successful outcomes change references; edits remain recoverable under existing guarantees.
12. **Keyboard and accessibility:** exercise the MRU picker commit/cancel, visual-order navigation, contextual Cmd+W, tree keys, tab-strip keys and menus in development and packaged builds. Verify focus, accessible path/state labels and unsaved markers through automated assertions, including an empty row and narrow overflow. Chats/Agents and active dialogs retain their own keyboard scope.

The parent map's remaining checkout/chat/search decisions retain their own confirmation and completion gates. Application implementation begins in a subsequent effort after that decision map is complete.
