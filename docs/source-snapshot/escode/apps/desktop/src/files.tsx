import * as stylex from "@stylexjs/stylex";
import { uiProps } from "./ui/props";
import { controls } from "./ui/controls";
import { filesUI } from "./ui/files";
import { overlays } from "./ui/overlays";
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useSyncExternalStore } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { memory, useMemory } from "./workspace";
import type { FilesMemory } from "../host/workspace";

import { FilesModel } from "./files-model";
import { FilesViewport } from "./files-viewport";
export function FilesTree({
  root,
  active,
  activePath,
  disabled,
  revision,
  dirty,
  open,
  rename,
  create,
  trash,
  transfer,
}: {
  root: string;
  active: boolean;
  activePath: string;
  disabled: boolean;
  revision: number;
  dirty: (path: string) => boolean;
  open: (path: string, editor: boolean) => Promise<void>;
  rename: (path: string, destination: string) => Promise<void>;
  create: (parent: string, name: string, kind: "file" | "folder") => Promise<string>;
  trash: (paths: string[]) => Promise<void>;
  transfer: (
    kind: "copy" | "cut" | "paste" | "duplicate" | "drag-move" | "drag-copy" | "import",
    paths: string[],
    parent: string,
  ) => Promise<void>;
}) {
  const [state, setState] = useMemory(root, "files", {
    expanded: [],
    selected: [],
    focus: "",
    scroll: 0,
  });
  const [edit, setEdit] = useState<{
    source?: string;
    parent: string;
    kind: "file" | "folder";
    value: string;
    error?: string;
  } | null>(null);
  const drag = useRef<{ id: string; source: string; paths: string[]; token: Promise<string> } | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragGeneration = useRef(0);
  const [dropTarget, setDropTarget] = useState<{ parent: string; copy: boolean } | null>(null);
  const dragFormat = "application/x-escode-tree";
  function clearDrag() {
    clearTimeout(hover.current);
    hover.current = undefined;
    drag.current = null;
    setDropTarget(null);
  }
  useEffect(() => {
    dragGeneration.current++;
    clearDrag();
    return () => {
      dragGeneration.current++;
      clearTimeout(hover.current);
      drag.current = null;
    };
  }, [root, active, disabled]);
  function startDrag(event: DragEvent, path: string) {
    if (!active || disabled || edit || (event.target as Element).closest("input, textarea")) {
      event.preventDefault();
      return;
    }
    clearDrag();
    const paths = latest.current.selected.includes(path) ? [...latest.current.selected] : [path];
    update({ selected: paths, focus: path });
    const id = crypto.randomUUID();
    const token = window.escode.project("drag-capture", root, paths);
    // Keep capture rejection handled even if the user cancels before dropping.
    void token.catch(() => {});
    drag.current = { id, source: path, paths, token };
    event.dataTransfer.setData(dragFormat, id);
    event.dataTransfer.effectAllowed = "copyMove";
  }
  function over(event: DragEvent, parent: string) {
    event.stopPropagation();
    const session = drag.current;
    const native =
      !event.dataTransfer.types.includes(dragFormat) && event.dataTransfer.types.includes("Files");
    if (
      (!session && !native) ||
      !active ||
      disabled ||
      edit ||
      (!native && !event.dataTransfer.types.includes(dragFormat))
    ) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    const folded = (p: string) => p.normalize("NFC").toLowerCase();
    if (
      session?.paths.some(
        (p) => folded(parent) === folded(p) || folded(parent).startsWith(folded(p) + "/"),
      )
    ) {
      event.dataTransfer.dropEffect = "none";
      clearTimeout(hover.current);
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = native || event.altKey ? "copy" : "move";
    if (dropTarget?.parent !== parent) {
      clearTimeout(hover.current);
      const generation = dragGeneration.current;
      if (parent && !latest.current.expanded.includes(parent))
        hover.current = setTimeout(() => {
          if (drag.current === session && generation === dragGeneration.current) {
            update({ expanded: [...new Set([...latest.current.expanded, parent])] });
            void load(parent);
          }
        }, 650);
    }
    setDropTarget({ parent, copy: native || event.altKey });
  }
  async function drop(event: DragEvent, target: string) {
    event.preventDefault();
    event.stopPropagation();
    const session = drag.current;
    const valid = session && event.dataTransfer.getData(dragFormat) === session.id;
    const files = Array.from(event.dataTransfer.files);
    const native = !event.dataTransfer.types.includes(dragFormat) && files.length > 0;
    const nativeToken = native
      ? Promise.resolve().then(() => window.escode.nativeFiles(files))
      : undefined;
    void nativeToken?.catch(() => {});
    const copy = event.altKey;
    const generation = dragGeneration.current;
    clearDrag();
    if ((!valid && !native) || !active || disabled || edit) {
      setActionError(
        "Only a drag from this checkout's Files tree or genuine native files is supported.",
      );
      return;
    }
    try {
      let parent = "";
      if (target) {
        const container = target.split("/").slice(0, -1).join("/");
        const listing = await load(container);
        if (listing.error) throw Error(listing.error);
        const entry = listing.entries?.find((e) => e.path === target);
        if (!entry) throw Error(listing.error || "Destination missing. Refresh and try again.");
        parent = entry.directory ? target : container;
      }
      const token = await (nativeToken ?? session!.token);
      if (generation !== dragGeneration.current) return;
      setActionError("");
      await transfer(native ? "import" : copy ? "drag-copy" : "drag-move", [token], parent);
    } catch (error) {
      if (generation === dragGeneration.current) setActionError(String(error));
    }
    if (generation === dragGeneration.current) restoreFocus();
  }
  const input = useRef<HTMLInputElement>(null);
  const committing = useRef(false);
  const startingEdit = useRef(false);
  const [actionError, setActionError] = useState("");
  const editRef = useRef<HTMLDivElement>(null);
  const initializedInput = useRef<HTMLInputElement | null>(null);
  async function beginEdit(kind: "rename" | "file" | "folder", target = state.selected[0] || "") {
    if (edit || disabled || startingEdit.current) return;
    startingEdit.current = true;
    model.pause(true);
    let began = false;
    setActionError("");
    setMenu(null);
    try {
      let parent = "";
      let directory = false;
      if (target) {
        const container = target.split("/").slice(0, -1).join("/");
        const listing = await load(container);
        if (listing.error) throw Error(listing.error);
        const entry = listing.entries?.find((entry) => entry.path === target);
        if (!entry)
          throw Error(
            listing.error || "Selected entry is missing. Refresh and select the entry again.",
          );
        directory = entry.directory;
        parent = kind === "rename" || !directory ? container : target;
      } else if (kind === "rename") {
        throw Error("Select one entry to rename.");
      }
      if (parent && kind !== "rename") {
        const parts = parent.split("/");
        update({
          expanded: [
            ...new Set([
              ...latest.current.expanded,
              ...parts.map((_, i) => parts.slice(0, i + 1).join("/")),
            ]),
          ],
        });
      }
      epoch.current++;
      model.cancel();
      model.pause(true);
      pendingRescan.current = true;
      began = true;
      setEdit(
        kind === "rename"
          ? {
              source: target,
              parent,
              kind: directory ? "folder" : "file",
              value: target.split("/").at(-1)!,
            }
          : { parent, kind, value: "" },
      );
    } catch (error) {
      setActionError(
        `Cannot ${kind === "rename" ? "rename" : "create at"} ${root}/${target}: ${String(error)} Use Refresh and select the entry again.`,
      );
      restoreFocus();
    } finally {
      startingEdit.current = false;
      if (!began) model.pause(!!editing.current || startingEdit.current || revealing.current > 0);
    }
  }
  function restoreFocus() {
    // Let completion's editor effects settle before returning focus to Files.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (tree.current?.getClientRects().length) tree.current.focus();
    }));
  }
  async function commit() {
    if (!edit || committing.current) return;
    const name = edit.value;
    if (
      !name.trim() ||
      name === "." ||
      name === ".." ||
      /[/\\\0]/.test(name) ||
      name.toLowerCase() === ".git"
    ) {
      setEdit({ ...edit, error: "Enter one name without separators or traversal." });
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    committing.current = true;
    try {
      const destination = edit.parent ? edit.parent + "/" + name : name;
      if (edit.source && destination !== edit.source) await rename(edit.source, destination);
      else if (!edit.source) await create(edit.parent, name, edit.kind);
      update({ focus: destination, selected: [destination] });
      setEdit(null);
      refresh();
      restoreFocus();
    } catch (error) {
      setEdit({
        ...edit,
        error: String(error).includes("EEXIST")
          ? "This name is already in use. Choose another name."
          : `${root}/${edit.source || (edit.parent ? edit.parent + "/" : "") + name}: ${String(error)}`,
      });
      requestAnimationFrame(() => {
        if (input.current?.getClientRects().length) input.current.focus();
      });
    } finally {
      committing.current = false;
    }
  }
  useLayoutEffect(() => {
    if (!active || !edit || !input.current || initializedInput.current === input.current) return;
    initializedInput.current = input.current;
    input.current.focus();
    const end =
      edit.kind === "file" && edit.value.lastIndexOf(".") > 0
        ? edit.value.lastIndexOf(".")
        : edit.value.length;
    input.current?.setSelectionRange(0, end);
  });
  useEffect(() => {
    if (!edit || edit.error || !active) return;
    const clickAway = (event: PointerEvent) => {
      if (!editRef.current?.contains(event.target as Node)) void commit();
    };
    document.addEventListener("pointerdown", clickAway);
    return () => document.removeEventListener("pointerdown", clickAway);
  }, [edit, active]);
  function field() {
    if (!edit) return null;
    return (
      <div
        ref={editRef}
        {...uiProps("tree-edit", filesUI.edit)}
        onDragStart={(e) => e.stopPropagation()}
        onDragOver={(e) => e.stopPropagation()}
        onDrop={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <input {...stylex.props(controls.field, controls.fullWidth)}
          ref={input}
          aria-label={edit.source ? "Rename " + edit.source : "New " + edit.kind + " name"}
          aria-invalid={!!edit.error}
          aria-describedby={root + ":edit-help"}
          value={edit.value}
          onChange={(e) => setEdit({ ...edit, value: e.target.value, error: undefined })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape" && !committing.current) {
              e.preventDefault();
              setEdit(null);
              restoreFocus();
            }
          }}
        />
        <div id={root + ":edit-help"} {...uiProps("tree-edit-help", filesUI.help)}>
          {edit.error ? (
            <div {...stylex.props(controls.alert, filesUI.editError)} role="alert">{edit.error}</div>
          ) : edit.source ? (
            "Enter to rename; Escape to cancel. Earlier text undo history resets; unsaved text and cursor/scroll are preserved."
          ) : (
            "Enter to create; Escape to cancel."
          )}
        </div>
      </div>
    );
  }
  const model = useMemo(() => new FilesModel({
    list: (path) => window.escode.listDirectory(root, path).then(result => {
      if (result.kind !== "available") throw Error(result.message);
      return { ...result.listing, entries: [...result.listing.entries], ignored: [...result.listing.ignored] };
    }),
    watch: (paths, changed) => window.escode.watchFiles(root, paths, changed),
  }), [root]);
  const cache = useSyncExternalStore(model.subscribe, () => model.cache);
  const viewport = useMemo(() => new FilesViewport(), [root]);
  const [geometry, setGeometry] = useState({ top: state.scroll, height: 600, width: 0 });
  const [, measured] = useState(0);
  const epoch = useRef(0);
  const restoring = useRef(true);
  const tree = useRef<HTMLDivElement>(null);
  const anchor = useRef(state.focus);
  const prefix = useRef({ text: "", time: 0 });
  const [menu, setMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const latest = useRef(state);
  latest.current = state;
  function update(next: Partial<FilesMemory>) {
    latest.current = { ...latest.current, ...next };
    setState(latest.current);
  }
  const editing = useRef(edit);
  editing.current = edit;
  const pendingRescan = useRef(false);
  const revealing = useRef(0);
  const load = (path: string) => model.load(path);
  const [watchError, setWatchError] = useState("");
  const [watchRevision, setWatchRevision] = useState(0);
  const loadedDirectories = () => model.directories();
  function rescan() {
    // Keep the inline field mounted until its user commits or cancels.
    if (editing.current || startingEdit.current || revealing.current) {
      pendingRescan.current = true;
      return;
    }
    pendingRescan.current = false;
    epoch.current++;
    model.refresh();
  }
  useEffect(() => {
    if (!edit && pendingRescan.current) rescan();
  }, [edit]);
  const watchPaths = JSON.stringify(loadedDirectories().sort());
  useEffect(() => {
    if (!active) return;
    return model.watch(JSON.parse(watchPaths), (error, ready) => {
      if (error) setWatchError(error);
      if (!error && ready) setWatchError("");
      if (!error && !ready) setWatchRevision((r) => r + 1);
    });
  }, [root, active, watchPaths, watchRevision]);
  const wasActive = useRef(active);
  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    const recover = () => {
      setWatchError("");
      setWatchRevision((r) => r + 1);
      rescan();
    };
    if (!wasActive.current) recover();
    wasActive.current = true;
    window.addEventListener("focus", recover);
    return () => window.removeEventListener("focus", recover);
  }, [root, active]);
  function refresh() {
    setWatchError("");
    setWatchRevision((r) => r + 1);
    restoring.current = true;
    epoch.current++;
    model.refresh(true);
  }
  useEffect(() => {
    if (memory.views[root]?.files) setState(memory.views[root].files!);
    rescan();
    setWatchRevision((r) => r + 1);
  }, [revision]);
  useLayoutEffect(() => { model.pause(!!edit || startingEdit.current || revealing.current > 0); }, [edit, model]);
  useEffect(() => { if (active) model.discover(state.expanded, state.hideIgnored); }, [cache, state.expanded, state.hideIgnored, active, edit]);
  useEffect(() => () => { epoch.current++; model.cancel(); }, [model]);
  const filterError = Object.values(cache).find((v) => v.filterError)?.filterError;
  const visible = (parent: string) => model.visible(parent, !!state.hideIgnored);
  const previousActive = useRef(activePath);
  const revealSequence = useRef(0);
  const [revealMessage, setRevealMessage] = useState("");
  const [hiddenReveal, setHiddenReveal] = useState("");
  const pendingScroll = useRef("");
  const pendingFocusScroll = useRef("");
  const revealButton = useRef<HTMLButtonElement>(null);
  const origin = useRef({ root, active, activePath });
  origin.current = { root, active, activePath };
  async function reveal(explicit = false, showIgnored = false) {
    const sequence = ++revealSequence.current;
    const generation = epoch.current;
    const originGeneration = dragGeneration.current;
    const file = activePath;
    const valid = () =>
      sequence === revealSequence.current &&
      generation === epoch.current &&
      originGeneration === dragGeneration.current &&
      origin.current.root === root &&
      origin.current.active &&
      origin.current.activePath === file;
    if (!file || !active) return;
    if (explicit) {
      setRevealMessage("");
      setHiddenReveal("");
    }
    revealing.current++;
    model.pause(true);
    try {
      const parts = file.split("/");
      const ancestors: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        const listing = await load(parent);
        if (!valid()) return;
        const path = parts.slice(0, i + 1).join("/");
        if (!listing.entries?.some((e) => e.path === path)) {
          if (explicit)
            setRevealMessage(listing.error || "Active file is unavailable. Refresh and try again.");
          return;
        }
        if (
          !showIgnored &&
          latest.current.hideIgnored &&
          !filterError &&
          !listing.filterError &&
          listing.ignored?.includes(path)
        ) {
          if (explicit) {
            setHiddenReveal(file);
            setRevealMessage("Active file is hidden by Hide Git-ignored files.");
          }
          return;
        }
        if (i < parts.length - 1) ancestors.push(path);
      }
      if (!valid()) return;
      if (showIgnored) {
        update({ hideIgnored: false });
        requestAnimationFrame(() => {
          if (valid()) revealButton.current?.focus();
        });
      }
      update({ expanded: [...new Set([...latest.current.expanded, ...ancestors])] });
      restoring.current = false;
      pendingScroll.current = file;
      if (explicit) {
        setHiddenReveal("");
        setRevealMessage("");
      }
    } finally {
      revealing.current--;
      model.pause(!!editing.current || startingEdit.current || revealing.current > 0);
      if (!revealing.current && pendingRescan.current) rescan();
    }
  }
  useEffect(() => {
    if (active && !disabled && previousActive.current !== activePath) {
      previousActive.current = activePath;
      setHiddenReveal("");
      setRevealMessage("");
      void reveal();
    }
  }, [activePath, active, disabled]);
  useLayoutEffect(() => {
    if (!active || pendingScroll.current !== activePath) {
      pendingScroll.current = "";
      return;
    }
    if (scrollToPath(pendingScroll.current)) pendingScroll.current = "";
  });
  async function entryAction(action: "copy-path" | "copy-relative" | "finder") {
    const target = menu ?? "";
    const generation = dragGeneration.current;
    dismiss();
    setActionError("");
    try {
      await window.escode.project("entry-action", root, target, action);
      if (generation === dragGeneration.current)
        setRevealMessage(
          action === "finder"
            ? "Requested Finder reveal for " + (target || root)
            : "Copied " + (target || root),
        );
    } catch (error) {
      if (generation === dragGeneration.current) setActionError(String(error));
    }
  }
  const rows = model.rows(state.expanded, state.hideIgnored);
  const focused = rows.find((r) => r.path === state.focus) ?? rows[0];
  // Status and new-entry rows participate in geometry, but never keyboard selection.
  const display: ({ key: string; row?: typeof rows[number]; parent?: string; message?: string; field?: boolean })[] = [];
  function extras(parent: string) {
    if (edit && !edit.source && edit.parent === parent) display.push({ key: "\0edit:" + parent, field: true });
    const value = cache[parent];
    const message = value?.error ? `${parent || "Checkout"}: ${value.error}. Use Refresh to retry.`
      : value?.slow ? "Loading files…"
      : value?.entries && !visible(parent).length ? value.entries.length ? "No visible entries · Git-ignored files are hidden" : "Empty folder" : "";
    if (message) display.push({ key: "\0status:" + parent, parent, message });
  }
  if (edit && (edit.source ? !rows.some(row => row.path === edit.source) : edit.parent && !rows.some(row => row.path === edit.parent && state.expanded.includes(row.path))))
    display.push({ key: "\0hidden-edit", field: true });
  extras("");
  for (const row of rows) {
    if (edit?.source !== row.path) viewport.measure(row.path, 28);
    display.push({ key: row.path, row });
    if (row.directory && state.expanded.includes(row.path)) extras(row.path);
  }
  const preserveAnchor = !pendingScroll.current && !pendingFocusScroll.current;
  const anchoredTop = viewport.setRows(display.map(item => item.key), geometry.width, geometry.top);
  useLayoutEffect(() => {
    if (tree.current && preserveAnchor && !restoring.current && anchoredTop !== geometry.top) {
      tree.current.scrollTop = anchoredTop;
      setGeometry(old => ({ ...old, top: anchoredTop }));
    }
  });
  function scrollToPath(path: string) {
    const element = tree.current;
    if (!element || !viewport.keys.includes(path)) return false;
    element.scrollTop = viewport.reveal(path, element.scrollTop, element.clientHeight);
    setGeometry(old => old.top === element.scrollTop ? old : { ...old, top: element.scrollTop });
    return true;
  }
  useLayoutEffect(() => {
    if (active && pendingFocusScroll.current && scrollToPath(pendingFocusScroll.current)) pendingFocusScroll.current = "";
  });
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element || !active) return;
    const resize = () => {
      const top = viewport.setRows(viewport.keys, element.clientWidth, element.scrollTop);
      element.scrollTop = top;
      setGeometry(old => old.width === element.clientWidth && old.height === element.clientHeight ? old : { ...old, top, width: element.clientWidth, height: element.clientHeight });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element || !active) return;
    const update = () => {
      element.scrollTop = viewport.setRows(viewport.keys, element.clientWidth, element.scrollTop);
      setGeometry(old => old.top === element.scrollTop ? old : { ...old, top: element.scrollTop });
      measured(value => value + 1);
    };
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) changed = viewport.measure((entry.target as HTMLElement).dataset.measure!, entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height) || changed;
      if (changed) update();
    });
    // Inline fields and diagnostics can grow; filename rows have a fixed height.
    let changed = false;
    for (const row of element.querySelectorAll<HTMLElement>("[data-measure]")) {
      changed = viewport.measure(row.dataset.measure!, row.getBoundingClientRect().height) || changed;
      observer.observe(row);
    }
    if (changed) update();
    return () => observer.disconnect();
  });
  useEffect(() => {
    function missing(path: string) {
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (!model.resolved(parent)) return false;
        const entries = cache[parent]?.entries;
        if (!entries) return false;
        if (!entries.some((e) => e.path === parts.slice(0, i + 1).join("/"))) return true;
      }
      return false;
    }
    const expanded = state.expanded.filter((p) => !missing(p));
    const selected = state.selected.filter((p) => !missing(p));
    let focus = state.focus;
    while (focus && missing(focus)) focus = focus.split("/").slice(0, -1).join("/");
    if (
      expanded.length !== state.expanded.length ||
      selected.length !== state.selected.length ||
      focus !== state.focus
    )
      update({ expanded, selected, focus });
  }, [cache]);

  // Wait for restored expanded directories before clamping the remembered scroll.
  useLayoutEffect(() => {
    if (!active) {
      restoring.current = true;
      return;
    }
    if (!tree.current || !restoring.current) return;
    const savedAnchor = state.scrollAnchor;
    const index = savedAnchor ? viewport.keys.indexOf(savedAnchor.path) : -1;
    tree.current.scrollTop = index >= 0 ? viewport.offsets[index] + Math.min(savedAnchor!.offset, viewport.offsets[index + 1] - viewport.offsets[index] - 1) : state.scroll;
    setGeometry(old => old.top === tree.current!.scrollTop ? old : { ...old, top: tree.current!.scrollTop });
    if (
      cache[""] &&
      !rows.some((r) => r.directory && state.expanded.includes(r.path) && !cache[r.path])
    )
      restoring.current = false;
  });
  useEffect(() => {
    if (menu !== null)
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  function focus(path: string, range = false, additive = false) {
    let selected = [path];
    if (range) {
      const start = rows.findIndex((r) => r.path === anchor.current);
      const end = rows.findIndex((r) => r.path === path);
      selected = rows
        .slice(Math.min(start < 0 ? end : start, end), Math.max(start, end) + 1)
        .map((r) => r.path);
    } else {
      anchor.current = path;
      if (additive)
        selected = state.selected.includes(path)
          ? state.selected.filter((p) => p !== path)
          : [...state.selected, path];
    }
    update({ focus: path, selected });
    pendingFocusScroll.current = path;
    scrollToPath(path);
  }

  function toggle(path: string) {
    if (!state.expanded.includes(path)) {
      void load(path);
    }
    revealSequence.current++;
    pendingScroll.current = "";
    const expanded = state.expanded.includes(path);
    update({
      expanded: expanded ? state.expanded.filter((p) => p !== path) : [...state.expanded, path],
      ...(expanded && state.focus.startsWith(path + "/") ? { focus: path } : {}),
    });
  }
  function context(path: string) {
    if (!state.selected.includes(path)) {
      anchor.current = path;
      update({ selected: [path], focus: path });
    } else update({ focus: path });
    setMenu(path);
  }
  function dismiss() {
    setMenu(null);
    tree.current?.focus();
  }
  async function moveToTrash() {
    if (disabled || edit || !latest.current.selected.length) return;
    const paths = [...latest.current.selected];
    dismiss();
    await trash(paths);
    if (active) restoreFocus();
  }
  async function transferSelection(kind: "copy" | "cut" | "paste" | "duplicate") {
    const paths = [...latest.current.selected];
    const target = menu ?? latest.current.focus;
    dismiss();
    setActionError("");
    try {
      let parent = "";
      if (kind === "paste" && target) {
        const container = target.split("/").slice(0, -1).join("/");
        const listing = await load(container);
        if (listing.error) throw Error(listing.error);
        const entry = listing.entries?.find((e) => e.path === target);
        if (!entry) throw Error(listing.error || "Destination missing. Refresh and select again.");
        parent = entry.directory ? target : container;
      }
      await transfer(kind, paths, parent);
    } catch (error) {
      setActionError(String(error));
    }
    if (active) restoreFocus();
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || disabled || edit) return;
    if (event.key === "Escape" && drag.current) {
      clearDrag();
      return;
    }
    if (event.key === "Escape" && menu !== null) {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.metaKey && ["Backspace", "Delete"].includes(event.key)) {
      event.preventDefault();
      void moveToTrash();
      return;
    }
    if (event.metaKey && ["c", "x", "v"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      void transferSelection(
        event.key.toLowerCase() === "c"
          ? "copy"
          : event.key.toLowerCase() === "x"
            ? "cut"
            : "paste",
      );
      return;
    }
    const row = focused;
    const index = rows.findIndex((r) => r.path === row?.path);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      update({ selected: rows.map((r) => r.path) });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.altKey && ["n", "N"].includes(event.key)) {
      event.preventDefault();
      beginEdit(event.shiftKey ? "folder" : "file");
      return;
    }
    if (event.key === "Enter" && state.selected.length === 1) {
      event.preventDefault();
      beginEdit("rename", state.selected[0]);
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const target = state.selected[0] || row?.path;
      if (target) context(target);
      else setMenu("");
      return;
    }
    if (!row) return;
    if (event.metaKey && event.key === "ArrowDown") {
      event.preventDefault();
      if (!row.directory) void open(row.path, true);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      focus(rows[next].path, event.shiftKey);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.directory) {
        if (!state.expanded.includes(row.path)) toggle(row.path);
        else if (rows[index + 1]?.level > row.level) focus(rows[index + 1].path, event.shiftKey);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.directory && state.expanded.includes(row.path)) toggle(row.path);
      else {
        const parent = row.path.split("/").slice(0, -1).join("/");
        if (parent) focus(parent, event.shiftKey);
      }
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (!row.directory) void open(row.path, false);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - prefix.current.time < 700 ? prefix.current.text : "") +
        event.key.toLocaleLowerCase();
      prefix.current = { text, time: now };
      const query = [...text].every((c) => c === text[0]) ? text[0] : text;
      const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
      const match = ordered.find((r) =>
        r.path.split("/").at(-1)!.toLocaleLowerCase().startsWith(query),
      );
      if (match) focus(match.path, event.shiftKey);
    }
  }
  function listing(entry: typeof rows[number]) {
    const { parent, level } = entry;
    return (
            <div
              key={entry.path}
              role="treeitem"
              id={root + ":" + entry.path}
              data-path={entry.path}
              aria-label={entry.path.split("/").at(-1) + (dirty(entry.path) ? ", unsaved" : "")}
              aria-level={level}
              aria-posinset={entry.position}
              aria-setsize={entry.size}
              aria-selected={state.selected.includes(entry.path)}
              aria-expanded={entry.directory ? state.expanded.includes(entry.path) : undefined}
              aria-current={entry.path === activePath ? "true" : undefined}
            >
              <div
                {...uiProps(
                  "tree-row" +
                  (edit?.source === entry.path ? " tree-editing" : "") +
                  (entry.path === focused?.path ? " tree-focus" : "") +
                  (dropTarget?.parent === entry.path ? " tree-drop" : ""),
                  filesUI.row(level),
                  edit?.source === entry.path && filesUI.editing,
                  state.selected.includes(entry.path) && filesUI.selected,
                  entry.path === focused?.path && filesUI.focused,
                  dropTarget?.parent === entry.path && filesUI.drop,
                )}
                draggable={!disabled && !edit}
                onDragStart={(event) => startDrag(event, entry.path)}
                onDragEnd={clearDrag}
                onDragOver={(event) => over(event, entry.directory ? entry.path : parent)}
                onDrop={(event) => void drop(event, entry.path)}
                onClick={(event) => {
                  if (disabled) return;
                  tree.current?.focus();
                  focus(entry.path, event.shiftKey, event.metaKey || event.ctrlKey);
                  if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
                    if (entry.directory) toggle(entry.path);
                    else void open(entry.path, false);
                  }
                }}
                onDoubleClick={() => { if (!disabled && !entry.directory) void open(entry.path, true); }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!disabled) context(entry.path);
                }}
              >
                {entry.directory && (
                  <svg {...stylex.props(controls.icon, state.expanded.includes(entry.path) && filesUI.rotated)}
                    aria-hidden="true"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                  >
                    <path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                )}
                {edit?.source === entry.path ? (
                  field()
                ) : (
                  <span {...uiProps("tree-label", controls.truncate, controls.grow, entry.path === activePath && filesUI.activeLabel)} title={entry.path.split("/").at(-1)}>{entry.path.split("/").at(-1)}</span>
                )}
                {dirty(entry.path) && <span aria-hidden="true"> •</span>}
              </div>
            </div>
    );
  }
  return (
    <>
      <div {...uiProps("files-tools", filesUI.tools)} aria-label="Files actions">
        <button {...stylex.props(controls.button, filesUI.iconButton)}
          aria-label="New File"
          title="New File (Cmd+Option+N)"
          aria-keyshortcuts="Meta+Alt+N"
          disabled={disabled || !!edit}
          onClick={() => beginEdit("file")}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z M14 2v6h6 M12 12v6 M9 15h6" /></svg>
        </button>
        <button {...stylex.props(controls.button, filesUI.iconButton)}
          aria-label="New Folder"
          title="New Folder (Cmd+Option+Shift+N)"
          aria-keyshortcuts="Meta+Alt+Shift+N"
          disabled={disabled || !!edit}
          onClick={() => beginEdit("folder")}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z M12 11v6 M9 14h6" /></svg>
        </button>
        <button {...stylex.props(controls.button, filesUI.iconButton)}
          ref={revealButton}
          aria-label="Reveal Active File"
          title="Reveal Active File"
          disabled={!activePath || disabled || !!edit}
          onClick={() => void reveal(true)}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3" /></svg>
        </button>
        <button {...stylex.props(controls.button, filesUI.iconButton, (!!state.hideIgnored) && filesUI.pressedButton)}
          aria-label="Hide Git-ignored files"
          title="Hide Git-ignored files"
          aria-pressed={!!state.hideIgnored}
          onClick={() => {
            update({ hideIgnored: !state.hideIgnored });
            setHiddenReveal("");
            setRevealMessage("");
          }}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16l-6 7v7l-4 2v-9L4 4Z" /></svg>
        </button>
        <button {...stylex.props(controls.button, filesUI.iconButton)} aria-label="Refresh" title="Refresh" onClick={refresh}><svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 3 M18 18A8 8 0 0 1 5 15" /></svg></button>
        <button {...stylex.props(controls.button, filesUI.iconButton)}
          aria-label="Collapse All"
          title="Collapse All"
          onClick={() => {
            revealSequence.current++;
            pendingScroll.current = "";
            update({ expanded: [], focus: state.focus.split("/")[0] || "" });
          }}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="7" width="14" height="14" rx="2" /><path d="M17 3H5a2 2 0 0 0-2 2v12 M11 14h6" /></svg>
        </button>
      </div>
      {watchError && (
        <div role="status" {...uiProps("tree-edit-help", controls.status, filesUI.help)}>
          Automatic Files updates unavailable: {watchError} Use Refresh or return to this window to rescan. Available edits are retained.
        </div>
      )}
      {filterError && (
        <div role="status" {...uiProps("tree-edit-help", controls.status, filesUI.help)}>
          {filterError}
        </div>
      )}
      {revealMessage && !revealMessage.startsWith("Revealed ") && (
        <div role="status" {...uiProps("tree-edit-help", controls.status, filesUI.help)}>
          {revealMessage}
        </div>
      )}
      {hiddenReveal === activePath && hiddenReveal && (
        <button {...stylex.props(controls.button)} onClick={() => void reveal(true, true)}>Show ignored files</button>
      )}
      {actionError && (
        <div role="alert" {...uiProps("tree-edit-help", controls.alert, filesUI.help)}>
          {actionError}
        </div>
      )}
      {dropTarget && (
        <div role="status" {...uiProps("tree-edit-help tree-drop-status", controls.status, filesUI.help, filesUI.dropStatus)}>
          {`${dropTarget.copy ? "Copy" : "Move"} to ${dropTarget.parent || "checkout root"}${!dropTarget.copy ? " · confirmation before moving" : ""}`}
        </div>
      )}
      <div
        ref={tree}
        role="tree"
        aria-label="Files"
        data-row-count={rows.length}
        aria-busy={(!cache[""]?.entries && !cache[""]?.error) || rows.some(row => row.directory && state.expanded.includes(row.path) && !cache[row.path]?.entries && !cache[row.path]?.error)}
        aria-multiselectable="true"
        aria-disabled={disabled}
        aria-activedescendant={focused ? root + ":" + focused.path : undefined}
        tabIndex={0}
        {...uiProps("files-tree" + (dropTarget?.parent === "" ? " tree-drop" : ""), filesUI.tree, stylex.defaultMarker(), dropTarget?.parent === "" && filesUI.drop)}
        onDragOver={(event) => over(event, "")}
        onDrop={(event) => void drop(event, "")}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            clearTimeout(hover.current);
            setDropTarget(null);
          }
        }}
        onKeyDown={key}
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.extent) {
            update({ selected: [], focus: "" });
            tree.current?.focus();
          }
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.extent) {
            e.preventDefault();
            update({ selected: [], focus: "" });
            setMenu("");
          }
        }}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setGeometry(old => ({ ...old, top }));
          if (active && !restoring.current && event.currentTarget.getClientRects().length)
            update({ scroll: top, scrollAnchor: viewport.anchor(top) });
        }}
      >
        <div {...stylex.props(filesUI.extent(viewport.height))} data-extent="true" >
          {viewport.mounted(geometry.top, geometry.height, [pendingScroll.current, focused?.path ?? "", edit?.source ?? "", ...display.filter(item => item.field).map(item => item.key), drag.current?.source ?? ""]).map(index => {
            const item = display[index];
            return <div {...stylex.props(filesUI.mounted(viewport.offsets[index]))} key={item.key} data-measure={!item.row || edit?.source === item.row.path ? item.key : undefined} >
              {item.row ? listing(item.row) : item.field ? field() : <div {...uiProps("tree-message", controls.status, filesUI.message)} role="status"
                onDragOver={event => over(event, item.parent ?? "")} onDrop={event => void drop(event, item.parent ?? "")}>{item.message}</div>}
            </div>;
          })}
        </div>
      </div>
      {menu !== null && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={"Actions for " + menu}
          {...uiProps("files-menu", overlays.menu)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              dismiss();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              items[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
              ]?.focus();
            }
          }}
        >
          {rows.some(row => row.path === menu && !row.directory) && <button {...stylex.props(controls.button, overlays.menuButton)} role="menuitem"
            disabled={disabled || !!edit} onClick={() => { const file = menu; dismiss(); void open(file, true); }}>
            Open File
          </button>}
          <button {...stylex.props(controls.button, overlays.menuButton)} role="menuitem" onClick={() => void entryAction("copy-path")}>
            Copy Path
          </button>
          <button {...stylex.props(controls.button, overlays.menuButton)} role="menuitem" onClick={() => void entryAction("copy-relative")}>
            Copy Relative Path
          </button>
          <button {...stylex.props(controls.button, overlays.menuButton)} role="menuitem" onClick={() => void entryAction("finder")}>
            Reveal in Finder
          </button>
          <p {...stylex.props(overlays.menuText)}>
            {state.selected.length} selected · {menu}
          </p>
          <button {...stylex.props(controls.button, overlays.menuButton)}
            role="menuitem"
            disabled={disabled || !!edit}
            onClick={() => beginEdit("file", menu)}
          >
            New File
          </button>
          <button {...stylex.props(controls.button, overlays.menuButton)}
            role="menuitem"
            disabled={disabled || !!edit}
            onClick={() => beginEdit("folder", menu)}
          >
            New Folder
          </button>
          <button {...stylex.props(controls.button, overlays.menuButton)}
            role="menuitem"
            disabled={disabled || !!edit || state.selected.length !== 1}
            onClick={() => {
              dismiss();
              beginEdit("rename", menu);
            }}
          >
            Rename
          </button>
          <button {...stylex.props(controls.button, overlays.menuButton)}
            role="menuitem"
            disabled={disabled || !!edit || !state.selected.length}
            onClick={() => void moveToTrash()}
          >
            Move to Trash
          </button>
          {(["copy", "cut", "paste", "duplicate"] as const).map((kind) => (
            <button {...stylex.props(controls.button, overlays.menuButton)}
              key={kind}
              role="menuitem"
              disabled={disabled || !!edit || (kind !== "paste" && !state.selected.length)}
              onClick={() => void transferSelection(kind)}
            >
              {kind[0].toUpperCase() + kind.slice(1)}
            </button>
          ))}
          {state.selected.length > 1 && <p {...stylex.props(overlays.menuText)}>Choose one entry for Rename.</p>}
          <button {...stylex.props(controls.button, overlays.menuButton)} role="menuitem" onClick={dismiss}>
            Dismiss menu
          </button>
        </div>
      )}
      <div {...uiProps("files-operation-actions", filesUI.tools)}>
        <button {...stylex.props(controls.button, filesUI.iconButton)}
          disabled={disabled || !!edit || state.selected.length !== 1}
          title="Rename selected entry"
          aria-label={"Rename " + state.selected[0]}
          onClick={() => beginEdit("rename", state.selected[0])}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5 4 4 M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z" /></svg>
        </button>
        <button {...stylex.props(controls.button, filesUI.iconButton)}
          disabled={disabled || !!edit || !state.selected.length}
          aria-label={
            "Move to Trash " +
            (state.selected.length === 1
              ? state.selected[0]
              : state.selected.length + " selected items")
          }
          title="Move selected entries to Trash (Cmd+Delete)"
          aria-keyshortcuts="Meta+Backspace Meta+Delete"
          onClick={() => void moveToTrash()}
        >
          <svg {...stylex.props(controls.icon)} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7" /></svg>
        </button>
      </div>
    </>
  );
}
