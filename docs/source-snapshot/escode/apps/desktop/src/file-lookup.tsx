import * as stylex from "@stylexjs/stylex";
import { uiProps } from "./ui/props";
import { controls } from "./ui/controls";
import { overlays } from "./ui/overlays";
import { useEffect, useRef, useState } from "react";
import { Button } from "@base-ui/react/button";
import { comparePathScores } from "../host/lookup-score";

import { memory, openFile } from "./workspace";

function highlightedPath(path: string, positions: readonly number[]) {
  const parts = [];
  let start = 0;
  for (const position of positions) {
    parts.push(path.slice(start, position), <mark {...stylex.props(overlays.mark)} key={position}>{path[position]}</mark>);
    start = position + 1;
  }
  parts.push(path.slice(start));
  return parts;
}

export type LookupRoot = { root: string; project: string; branch?: string };
type LookupRow = import("@escode/contracts").LookupResult["results"][number] & LookupRoot;
export function FileLookup({ root = "", project = "", roots, onClose }: {
  root?: string; project?: string; roots?: readonly LookupRoot[]; onClose: () => void;
}) {
  const scope = roots ?? [{ root, project }];
  const scopeKey = JSON.stringify(scope.map(({ root, project }) => [root, project]));
  const liveScope = useRef(scopeKey);
  liveScope.current = scopeKey;
  const inScope = (target: LookupRoot) => scope.some(r => r.root === target.root && r.project === target.project) &&
    memory.projects.some(r => r.root === target.root && r.project === target.project);
  const dialog = useRef<HTMLDialogElement>(null);
  const origin = useRef(document.activeElement);
  const generation = useRef(0);
  const busy = useRef(false);
  const activated = useRef(false);
  const [results, setResults] = useState<LookupRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [observationError, setObservationError] = useState("");
  const [invalidation, setInvalidation] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("Type a filename or path. Exact paths can also be opened.");
  useEffect(() => {
    const popup = dialog.current!;
    popup.showModal();
    return () => {
      generation.current++;
      popup.close();
      if (!activated.current && origin.current instanceof HTMLElement && origin.current.isConnected) origin.current.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const failures = new Map<string, string>();
    setObservationError("");
    const stops = scope.slice(0, 8).map(target => window.escode.observeFiles(target.root, (error, ready) => {
      // Readiness refreshes discovery; exact activation already validates its captured path.
      if (!active || (ready && busy.current)) return;
      if (error) {
        failures.set(target.root, error.slice(0, 2048));
        setObservationError("Live updates unavailable: " + [...failures].map(([root, message]) => `${root}: ${message}`).join("; ") + ". Results may be incomplete. Refresh or reopen to retry.");
      }
      generation.current++;
      setInvalidation(value => value + 1);
    }));
    return () => { active = false; generation.current++; for (const stop of stops) stop(); };
  }, [scopeKey, refresh]);
  useEffect(() => {
    const request = ++generation.current;
    setResults([]); setSelected(0);
    setMessage(!scope.length ? "No open checkouts" : "Type a filename or path. Exact paths can also be opened.");
    if (!scope.length) return;
    let stopped = false, stop: (() => void) | undefined, next = 0;
    let rows: LookupRow[] = [], bytes = 0, capped = scope.length > 8;
    const coverage: string[] = [];
    const size = (row: LookupRow) => (row.path.length + row.root.length + row.project.length + (row.branch?.length ?? 0)) * 6 + row.positions.length * 8 + 128;
    const current = () => !stopped && request === generation.current && liveScope.current === scopeKey && !!dialog.current?.open;
    const scan = () => {
      if (!current()) return;
      if (next >= Math.min(scope.length, 8)) {
        setMessage(`${rows.length} matches${capped ? "; Partial coverage: search capped. Refine the query or Refresh." : ""}${coverage.length ? "; " + coverage.join("; ") : ""}${!rows.length && !capped && !coverage.length ? query.trim() ? ". No eligible matches. You can still open an exact path." : ". No recent files in this checkout scope. Type a filename or path." : ""}`);
        return;
      }
      const target = scope[next++];
      setMessage(`Searching checkout ${next} of ${Math.min(scope.length, 8)}…`);
      stop = window.escode.searchFiles(target.root, query, result => {
        if (!current()) return;
        if (result.partial) coverage.push(`Incomplete: ${target.root}. ${result.message}`);
        for (const resultRow of result.results) {
          const row = { ...resultRow, ...target };
          const compare = (a: LookupRow, b: LookupRow) => {
            if (!!a.recent !== !!b.recent) return a.recent ? -1 : 1;
            if (a.recent && b.recent) {
              const history = memory.recentFiles ?? [];
              return history.findIndex(f => f.root === a.root && f.path === a.path) - history.findIndex(f => f.root === b.root && f.path === b.path);
            }
            return comparePathScores(a, b, query);
          };
          const index = rows.findIndex(other => compare(row, other) < 0);
          if (rows.length === 100 && index < 0) { capped = true; continue; }
          rows.splice(index < 0 ? rows.length : index, 0, row); bytes += size(row);
          while (rows.length > 100 || bytes > 512 * 1024) { bytes -= size(rows.pop()!); capped = true; }
        }
        setResults([...rows]);
        scan();
      }, error => {
        if (!current()) return;
        coverage.push(`Unavailable: ${target.root}. ${error.slice(0, 2048)}`);
        scan();
      }, (memory.recentFiles ?? []).filter(f => f.root === target.root).map(f => f.path));
    };
    const timer = setTimeout(scan, 120);
    return () => { stopped = true; generation.current++; clearTimeout(timer); stop?.(); rows = []; };
  }, [scopeKey, query, refresh, invalidation]);

  useEffect(() => { document.getElementById(`lookup-result-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const activate = async (row?: LookupRow) => {
    if ((!query && !row) || busy.current) return;

    const request = ++generation.current;
    const invocationScope = scopeKey;
    const current = () => request === generation.current && liveScope.current === invocationScope && !!dialog.current?.open;
    busy.current = true;
    setMessage("Opening file…");
    try {
      let target: LookupRoot | undefined = row, path = "";
      if (row) {
        if (!inScope(row)) throw Error("Checkout is no longer open.");
        path = await window.escode.lookupFile(row.root, row.path);
      } else if (!roots) {
        target = scope[0];
        if (!inScope(target)) throw Error("Checkout is no longer open.");
        path = await window.escode.lookupFile(target.root, query);
      } else {
        if (scope.length > 8) throw Error("Exact lookup is capped at 8 checkouts. Select a checkout and retry locally.");
        for (const candidate of scope) {
          if (!current()) return;
          if (!inScope(candidate)) continue;
          let found: string;
          try { found = await window.escode.lookupFile(candidate.root, query); }
          catch { continue; }
          if (target) throw Error("Several checkouts contain this path. Choose a result or enter an absolute path.");
          target = candidate; path = found;
        }
        if (!target) throw Error("File could not be opened in the current scope. Check the path and retry.");
      }
      if (!target || !current() || !inScope(target)) return;
      const openingCurrent = () => current() && inScope(target!);
      const opened = await openFile({ root: target.root, path, view: "file", intent: "keep", current: openingCurrent });
      if (!openingCurrent()) return;
      if (!opened) throw Error("File could not be opened. Check the path and retry.");
      activated.current = true;
      onClose();
      window.dispatchEvent(new CustomEvent("reveal-file", { detail: { project: target.project, root: target.root } }));
    } catch (error) {
      if (current()) setMessage(String(error) + " Edit the path or press Enter to retry.");
    } finally { busy.current = false; }
  };
  return (
    <dialog ref={dialog} {...uiProps("project-picker file-lookup", overlays.dialog)} aria-labelledby="file-lookup-title"
      aria-describedby="file-lookup-scope"
      onCancel={event => { event.preventDefault(); generation.current++; onClose(); }}
      onKeyDown={event => event.stopPropagation()}>
      <h2 {...stylex.props(controls.heading, overlays.dialogTitle)} id="file-lookup-title">Find file</h2>
      <p id="file-lookup-scope">{roots ? `Open checkouts (${scope.length})` : `Active checkout: ${root}`}</p>
      <input {...stylex.props(controls.field, controls.fullWidth)} autoFocus aria-label="Exact file path" maxLength={4096} value={query}
        placeholder="Filename, path, or quoted contiguous piece"
        role="combobox" aria-controls="lookup-results" aria-expanded={results.length > 0}
        aria-activedescendant={results.length ? `lookup-result-${selected}` : undefined}
        onChange={event => { generation.current++; setQuery(event.target.value); setMessage("Press Enter or choose Open file."); }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void activate(results[selected]); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected(index => results.length ? (index + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length : 0); }
        }} />
      <div id="lookup-results" role="listbox" aria-label="Matching files" {...uiProps("lookup-results", overlays.results)}>
        {[true, false].map(recent => {
          const group = results.map((result, index) => ({ result, index })).filter(({ result }) => !!result.recent === recent);
          return group.length > 0 && <div key={String(recent)} role="group" aria-label={recent ? "Recent files" : "File results"}>
            <h3>{recent ? "Recent files" : "File results"}</h3>
            {group.map(({ result, index }) => <div {...stylex.props(overlays.result, index === selected && overlays.selectedResult)} key={result.root + ":" + result.path} id={`lookup-result-${index}`} role="option" aria-selected={index === selected}
              onMouseDown={event => event.preventDefault()} onClick={() => void activate(result)}>
              {highlightedPath(result.path, result.positions)}
              {roots && <small {...uiProps("lookup-root", overlays.lookupRoot)}>{result.project.split("/").at(-1)} · {result.branch} · {result.root}</small>}
            </div>)}
          </div>;
        })}
      </div>
      <p {...stylex.props(controls.status, overlays.dialogStatus)} role="status">{message}{observationError && ` ${observationError}`}</p>
      <Button {...stylex.props(controls.button, overlays.dialogButton)} onClick={() => { generation.current++; setRefresh(value => value + 1); }}>Refresh</Button>
      <Button {...stylex.props(controls.button, overlays.dialogButton)} disabled={!query} onClick={() => void activate()}>Open file</Button>
      <Button {...stylex.props(controls.button, overlays.dialogButton)} onClick={() => { generation.current++; onClose(); }}>Cancel</Button>
    </dialog>
  );
}
