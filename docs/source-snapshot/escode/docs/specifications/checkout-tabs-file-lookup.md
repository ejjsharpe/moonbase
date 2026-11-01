# Checkout tabs and fuzzy file lookup

Status: **accepted by the user**, 2026-10-31, including the complete synthesis, integration defaults and acceptance cases. The user explicitly confirmed shared understanding. This describes subsequent implementation, not current application behavior.

Decision owner: [How should checkout tabs and fuzzy file lookup work?](https://github.com/ejjsharpe/escode/issues/89). Destination: [Specify checkout tabs and fuzzy file lookup](https://github.com/ejjsharpe/escode/issues/87). The separately [accepted file-tab specification](https://github.com/ejjsharpe/escode/issues/91#issuecomment-6536410741) owns file tabs, previews, comparison views, ordering and file-close/reopen behavior. This specification complements that accepted handoff, integrated as [File tabs inside checkout tabs](file-editor-tabs.md).

## Evidence and amendment

The [pinned VS Code/T3 research](https://github.com/ejjsharpe/escode/blob/ac1258ce68e46e7a2624408388bf37b931cafd73/docs/research/fuzzy-search-vscode-t3.md) traces VS Code `c254b82c637ec4ee275483e6e4dcb31360a8b7d7`, T3 Code `96c21aaca1d78e1bfc7bae3c68b635ba22ef13f3` and T3's FFF dependency. The [checkout-tab baseline trace](https://github.com/ejjsharpe/escode/issues/89#issuecomment-6536201975) uses escode `fc8643912b79fab9279256cde75e9af0843bf9a1`. The [exclusion addendum](https://github.com/ejjsharpe/escode/issues/89#issuecomment-6536462038) records the exact VS Code defaults and their limits.

This amends the baseline's one-tab-per-project rule and its behavior of switching a project's editor checkout when selecting a bound chat. One Project still represents one repository across linked worktrees. Several checkouts can now have their own fixed editor tabs. Provider sessions, saved chats, approval authority and Git/worktree ownership are not duplicated to create those views.

## Checkout workspaces

- Each project tab represents one exact checkout. Opening it again focuses that tab; opening another worktree creates a separate tab under the same Project identity. A branch change in the same directory changes its label, not its identity.
- Each checkout has independent Files, Source Control and Chats views, active file, editor/view state, tree state and selected chat. Matching relative filenames in different checkouts have separate buffers and disk baselines. Files and comparisons within one checkout retain the existing shared buffer.
- Chats lists only conversations and existing-checkout drafts attached to that checkout. Selecting one never retargets the tab to another checkout. Agents remains the app-wide view, including closed editor contexts and No project chats; the same chat ID, unsent text and provider state are shared between its views.
- Tabs open explicitly through opening a checkout/file or an **Open checkout** action on an applicable chat/worktree. Selecting an Agents conversation or creating/preparing a background worktree does not open or focus an editor tab. A future or unavailable checkout cannot be created or substituted by this navigation action.
- Closing a checkout tab resolves Save/Discard/Cancel for its dirty buffers only. Cancel, failed Save or failed required persistence retains available work. Closing preserves the checkout, saved project, chats and live chat work; it does not remove a worktree or issue Stop. Other checkout tabs are unaffected.
- Open checkout membership and each workspace's available state restore after restart. Reopening a closed tab restores its remembered workspace. Existing recovery remains best effort; restart never resumes agent work automatically. Last-window close and explicit Quit retain their accepted, separate behavior.

## New chats and draft contexts

**Inside a checkout tab:** New chat captures that checkout as its initial context.

**Inside Agents:** New chat always opens a project picker, including when only one project is saved. It lists all saved projects, including those with closed tabs, in most-recent-use order. Fuzzy filtering uses the agreed ordered-character matching; labels disambiguate projects with the same name. A **No project** choice retains the existing scratch-chat workflow. Cancelling the picker creates no draft.

Choosing a project opens a saved draft in Agents on that project's last-used editor checkout. The original checkout is the fallback when no other checkout has been used. Show the resolved context clearly and allow explicit existing-checkout or new-worktree selection before first Send. There is no mandatory second checkout picker and no automatic editor-tab opening. A remembered but unavailable checkout remains unavailable until the user explicitly chooses otherwise; it is not a reason to silently choose another path.

Project ordering and remembered checkout defaults are client navigation state. Background agent output does not reorder the picker. A saved draft captures its selected context: later tab navigation, recency changes or another draft never retarget it. Unsent text retains its stable chat/client identity.

Changing a draft from its tab's checkout to another checkout or a future managed worktree continues editing in Agents. The original tab remains fixed. A future-worktree draft appears in Agents while no destination checkout exists; after preparation the same chat belongs to the actual checkout and is eligible for its Chats view. Agents remains the editing surface unless the user explicitly navigates elsewhere.

First Send alone prepares a new managed worktree. Merely searching, opening a picker or asking to open a checkout creates no directory, branch, provider turn or replacement reservation. Preparation Stop, failed creation and uncertain Send retain their existing identities and recovery behavior. Successful preparation still does not automatically open a checkout tab.

## File lookup scope and matching

Cmd+P and a labelled clickable **Find file…** action open a lookup popup from either Files, Source Control or Chats inside a checkout tab, or from Agents.

- In a checkout tab, search only its checkout.
- In Agents, search exactly the checkout tabs open in the current window, including several worktrees of one project. Saved projects and worktrees without open tabs are outside this scope. No project scratch folders are not added to this project-file scope.
- Search the checkout's eligible filesystem paths, including unexpanded/unloaded directories; do not filter only the currently visible Files rows. This searches names and paths, not file contents.
- Use the pinned VS Code file-lookup behavior: case-insensitive ordered characters with gaps, with case, consecutive-character, boundary, basename/prefix and path relevance signals. Every query piece must match; quoted pieces request contiguous matching. Return highlights from the matching positions. No spelling correction, semantic matching, commands or symbol search is added.
- For example, `wkb` can find `workbench`; the misspelling `wrok` does not find it through typo correction. Filename matches and path qualification follow the same scoring contract across the searched checkouts.
- Blank input shows recent files within scope. Typed input combines the separately filtered history group with ranked file matches, following the VS Code reference and deduplicating exact checkout/file targets. Identical relative paths in different checkouts remain distinct results. Recent-file history persists across restart, but never brings a closed checkout into scope.

Rows show the filename, relative path, project and checkout identification, with enough information to distinguish worktrees. Ranking is over the in-scope results; project labels do not imply a new project-switcher or command mode. Every row retains its exact authorized checkout/file identity, independently of its display label.

## Ordinary exclusions and deliberate lookup

Use these fixed desktop VS Code default exclusion globs for recursive enumeration:

```text
**/.git
**/.svn
**/.hg
**/.jj
**/.DS_Store
**/Thumbs.db
**/node_modules
**/bower_components
**/*.code-search
```

Excluded directories prune their descendants. Enable checkout-local and nested ignore-file behavior (`.gitignore`, `.ignore`, `.rgignore`, and repository-local Git excludes) as in the pinned enumerator. Disable parent ignore files, global Git ignores and ripgrep configuration-file arguments by default. Hidden names are eligible unless an explicit rule excludes them: `.env`, `.github`, `.vscode` and nonignored `dist`/`build` paths are not categorically hidden. The [source addendum](https://github.com/ejjsharpe/escode/issues/89#issuecomment-6536462038) identifies the first-party invocation and configuration defaults; native ignore parsing still needs implementation qualification.

These are default rules, not a VS Code settings-compatibility feature. This iteration does not interpret `.vscode/settings.json` layers, custom `files.exclude`/`search.exclude`, sibling conditions or settings overrides. The Files tree's Hide Git-ignored files toggle remains independent of lookup policy.

As in the reference, history and exact-path checks are separate from recursive enumeration. Previously opened ignored files may appear in eligible history; apply the default glob semantics to history rather than treating every ignored ancestor as a blanket history ban. A deliberately entered exact relative or absolute file path may find an excluded file **only within an open checkout in the active scope** and under the existing host approval and file-opening rules. It cannot open a closed checkout, authorize an outside path or follow a symbolic link past escode's filesystem boundary.

Escode retains its existing no-follow boundary even though VS Code follows symbolic links by default. It also retains its current encoding, binary, symbolic-link and 2 MiB editor limits. Finding a pathname does not promise that the editor can decode its contents or introduce another viewer.

## Activation, cancellation and failure

Up/Down selects a row without opening files, changing tabs or creating file previews. Enter or clicking a result explicitly opens/reuses the exact file in its checkout tab's Files view and focuses the editor. Under the accepted file-tab specification, this keeps the target file tab open through the shared file-opening path. Existing unsaved buffers and loaded disk baselines win over replacing them with new disk reads. Opening never saves or stages a file.

Escape dismisses lookup and restores its originating focus without changing the active file, view or project tab. Lookup is an accessible keyboard-operated popup, with an announced search scope, loading/partial/empty state, result labels and selected row. It must work from a chat composer without submitting a prompt or losing unsent text. Active dialogs and text-entry controls retain their own editing/confirmation scope.

If a result becomes unavailable or the open-tab scope changes, revalidate its exact target before activation. Reject stale query responses and stale activation results; do not activate an older highlighted row after the user chooses another. A failed new open leaves the prior editor/tab state and query available, with an explanation and retry path. It never redirects to a matching name in another checkout or adopts a replaced directory silently. Available dirty/recovery buffers remain available under the existing unavailable-file rules.

An unavailable checkout retains its tab and workspace with **Unavailable**, **Retry** and **Close**. Searches over other open checkouts continue, explicitly identifying unavailable or incomplete coverage. Disclose scanning, capped results and retryable enumeration/ignore failures; do not present a definitive No matches for an incomplete search. Show No open checkouts when that is the actual scope. Retry validates the original identities and never creates resources.

Discovery must converge with external create/rename/delete and changed ignore rules. Refresh/reopen must retry unavailable enumeration and reconcile the current scope. Earlier cached results do not authorize file access. Worktree removal remains its separate existing operation and preservation gate; removed checkouts retain an unavailable workspace until closed or validly resolved, with their chat associations intact.

## Interaction defaults

The confirmed synthesis includes these interaction defaults:

- Top-level tab labels show project plus branch/worktree identification, with exact directory available for disambiguation. Detached/duplicate labels still expose enough path information to choose the correct checkout.
- Closing the active checkout tab selects an adjacent surviving checkout tab, or Agents when none remains. This is separate from the file-tab interview's MRU rule for closing an active **file** tab.
- The clickable lookup action is available in both Agents and checkout views and shows its scope in the popup. Each new invocation starts with blank input/recent files; a failed open retains the current query.

## Subsequent implementation handoff

Deliver checkout-tab composition and client-state ownership first, then chat-list/default/picker changes, then authenticated filename discovery, scoring and popup integration. This sequence is a handoff, not application implementation authorization. Do not introduce a second Project identity, chat store or editor buffer registry to implement another view.

Required reach includes `src/main.tsx` tab identity, composition, file opening and scoped close; `src/agents.tsx`, `chat.tsx`, `chat-state.ts` and worktree controls; client workspace persistence and its validated contracts/host path; existing checkout/repository approval and filesystem identity validation; and navigation, chat/draft, Files, diff, recovery and lifecycle fixtures. Coordinate file-open/view state with the separate file-tab work rather than implementing competing ownership paths.

The execution host owns authorized filesystem enumeration and revalidation. Client lookup scope and navigation grant no path authority. Preserve the authenticated contracts and stale-result checks, client-owned metadata/recovery, explicit Save conflicts, operation-journal reconciliation, exact provider context and scoped Stop/replies. Retain required upstream attribution when reusing scorer code. No universal search abstraction, native FFF dependency or new settings framework is selected by this behavior specification.

Implementation must set and document explicit limits for enumeration/candidate retention, concurrent roots, result count, request/response size, caches/history and watcher lifetime. Bound work before allocation, keep filesystem work off the interactive renderer path, cancel obsolete queries and release resources when the popup/scope/client closes. Preserve host chat control responsiveness. Limits must produce explicit partial/capped states; they are not permission to silently search only loaded tree rows.

Measure cold and warm lookup, rapid typing/cancellation, external changes and missing/large scopes in the actual local development and packaged app. Record dataset sizes, observed latency, memory/event-loop behavior and cleanup; no performance, capacity or native-binary equivalence is claimed by this specification. Changed keyboard and focus behavior requires fresh VoiceOver evidence; prior acceptance records cannot certify the new controls.

## Acceptance examples

1. Open two worktrees of one project and another project. Each has a distinct fixed tab and checkout-scoped chat list; opening the same checkout again reuses its tab. Switching branch preserves that tab's identity and available edits.
2. Put different text at the same relative path in both worktrees. Search locally and globally, activate each result, edit one and return. The exact checkout, buffer, baseline and file view remain distinct, while Files/diffs of one file share its working text.
3. Search from Files, Source Control and project Chats: only that tab's checkout participates. Search from Agents: exactly the open checkout tabs participate. Close one worktree tab; neither fresh results nor history can reopen it through global lookup.
4. Find an eligible file inside an unexpanded folder. Verify `wkb`/`workbench`, misspelling rejection, basename/path ranking, multi-piece/quoted queries, matching highlights and equal-name disambiguation against pinned scorer expectations.
5. Verify local/nested ignore files, default metadata/dependency globs, eligible dotfiles and nonignored build output. Toggle Files tree visibility without changing lookup policy. Verify deliberate history/exact-path exceptions stay within the active open-checkout scope and cannot escape root/no-follow validation.
6. Open Cmd+P from a dirty editor and a chat composer. Highlight other results, then Escape: preserve the original tab/file/view/focus and text without preview navigation, save or send. Enter/click reuses the intended buffer, selects Files and focuses the editor; delayed replies cannot steal a newer activation.
7. On blank input, show in-scope recents without duplicate targets; typed input merges history and ranked paths. Restart and retain recent metadata while applying the restored current scope. A closed checkout's history stays excluded until explicitly reopened.
8. New chat from each checkout tab captures that checkout. Agents always offers the searchable MRU project picker, including a closed project and No project. Cancel creates nothing; selecting a project shows its remembered checkout without opening a tab. With no remembered alternate use the original; an unavailable remembered path does not silently fall back.
9. Keep an unsent draft while changing tabs; it never retargets. Change its context to another checkout or a new managed worktree: continue in Agents with the same text/ID and a fixed original tab. First Send alone prepares resources. Success, Stop and failure preserve existing binding/reservation/uncertainty rules without automatic tab opening.
10. Close one checkout with dirty files while another has independent dirty files and running chat work. Exercise Save/Discard/Cancel and failed persistence: affect only the intended workspace, preserve its chats/worktree and leave the other workspace intact. Reopen/restart and restore available state and drafts under the existing recovery guarantee.
11. Delete or replace an open checkout, or remove an eligible managed worktree through its existing gate. Retain the unavailable tab/edits and chat identity; search healthy roots with explicit incomplete coverage. A stale result cannot redirect or create a missing/replacement checkout. Missing files, unsupported editor contents and enumeration/ignore failure retain meaningful query/error state.
12. Exercise scope changes during enumeration, rapid typing, caps, request-size exhaustion, watcher/cache cleanup, external rename/ignore changes and retry. No incomplete state claims exhaustive No matches. Verify keyboard navigation, result/scope announcements and focus with actual VoiceOver in the identified development/packaged builds.

## Deferred work

New project-wide code-content search is explicitly reserved for a later iteration; ordinary editor Find remains available. Chat transcript search, fuzzy command/symbol search, semantic retrieval, full VS Code settings compatibility, split editors and broader remote/multi-machine UI are not added here. Existing editor limits, save guarantees, recovery limits and filesystem/provider preservation constraints remain applicable.

The parent map also includes the accepted [file-tab specification](file-editor-tabs.md), whose documentation handoff is integrated with this one. Shared understanding of the complete checkout/search synthesis is confirmed. Application implementation and runtime qualification remain a subsequent effort.

## Implementation testing amendment

The testing decisions in [the implementation specification](https://github.com/ejjsharpe/escode/issues/93) supersede older manual gates here: retain automated keyboard, focus and accessibility checks; manual VoiceOver sessions and accessibility sign-off are excluded. Extend existing Electron/host seams, with one primary owner per behavior and no duplicate suites. File-tab behavior remains governed by the accepted file-tab contract and its later testing amendment.
