import { maximumRecentFiles, maximumRecentUnits } from "@escode/contracts";
import { scorePath, comparePathScores, type RankedPath } from "./lookup-score";
import { CheckoutRepository } from "./checkout-repository";
import { spawn, execFileSync } from "node:child_process";
import {
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  statSync,
  lstatSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { getSystemErrorName } from "node:util";
import { findExecutable } from "./tools";
import { createHash, randomUUID } from "node:crypto";
// macOS O_NOFOLLOW_ANY rejects symlinks in every path component.
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000;
export const limit = 2 * 1024 * 1024;
export type Document = { text: string; version: string };
export type Change = { path: string; area: "staged" | "unstaged" | "untracked" };
export type SaveResult = ({ kind: "saved"; disk: Document } | { kind: "conflict"; disk: Document }) & { persistencePending?: boolean; message?: string };
let activeLookups = 0;
let activeObservations = 0;
export class Checkout {
  readonly repositoryGit: CheckoutRepository;
  private directory: number | undefined;
  private filesOnly = false;
  private policyDirectory?: { path: string; dev: number; ino: number };
  private constructor(
    readonly root: string,
    private executable: string,
    private readonly helper: string,
    private readonly identity: { dev: number; ino: number },
    directory: number,
  ) {
    this.directory = directory;
    this.repositoryGit = new CheckoutRepository(root, (args) => this.git(args), () => this.executable);
  }
  static async open(path: string, helper = resolve("dist/host/filesystem")) {
    const root = realpathSync(path);
    const executable = await findExecutable("git");
    const fd = openSync(root, directoryFlags);
    try {
      const project = new Checkout(root, executable, helper, fstatSync(fd), fd);
      const top = project
        .io(["git", executable, "rev-parse", "--show-toplevel"])
        .toString("utf8")
        .trim();
      if (realpathSync(top) !== root) throw Error("Choose the repository checkout root.");
      project.repositoryGit.gitDirectory = realpathSync(
        project.git(["rev-parse", "--absolute-git-dir"]).toString().trim(),
      );
      project.repositoryGit.gitIdentity = statSync(project.repositoryGit.gitDirectory);
      project.repositoryGit.repository();
      const common = resolve(root, project.git(["rev-parse", "--git-common-dir"]).toString().trim());
      const policy = openSync(common, directoryFlags);
      try {
        const { dev, ino } = fstatSync(policy);
        project.policyDirectory = { path: common, dev, ino };
      } finally { closeSync(policy); }
      return project;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  static async restore(path: string, repository: string, helper = resolve("dist/host/filesystem")) {
    try {
      const project = await Checkout.open(path, helper);
      if (project.repositoryGit.repository() !== repository) {
        project.close();
        throw Error("Repository identity changed. Reopen the project.");
      }
      return project;
    } catch (error) {
      let executable = "",
        gitWorks = false;
      try {
        executable = await findExecutable("git");
        execFileSync(executable, ["--version"], { timeout: 5000, stdio: "pipe" });
        gitWorks = true;
      } catch {
        /* Previously approved files remain usable without Git. */
      }
      if (gitWorks) throw error;
      const root = realpathSync(path);
      if (root !== path) throw Error("Checkout path changed. Restore the original directory.");
      const fd = openSync(root, directoryFlags);
      const project = new Checkout(root, executable, helper, fstatSync(fd), fd);
      project.repositoryGit.repositoryIdentity = repository;
      project.filesOnly = true;
      return project;
    }
  }
  private watches = new Map<string, { watcher: FSWatcher; listeners: Set<(error?: string) => void> }>();
  private watchDisposers = new Set<() => void>();
  watchFiles(paths: string[], notify: (error?: string) => void) {
    const releases: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: string | undefined;
    let disposed = false;
    const changed = (error?: string) => {
      if (disposed) return;
      failure = error ?? failure;
      if (!timer) timer = setTimeout(() => {
        timer = undefined;
        notify(failure);
        failure = undefined;
      }, 100);
    };
    const dispose = () => {
      disposed = true;
      clearTimeout(timer);
      releases.forEach((release) => release());
      this.watchDisposers.delete(dispose);
    };
    this.watchDisposers.add(dispose);
    for (const path of new Set(paths)) {
      try {
        this.checkoutIdentity();
        if (path && this.path(path) !== path) throw Error("Use an exact directory path.");
        const full = path ? resolve(this.root, path) : this.root;
        // O_NOFOLLOW_ANY checks every ancestor; the watcher never grants read/write authority.
        const fd = openSync(full, directoryFlags);
        let identity: string;
        try {
          const info = fstatSync(fd);
          identity = `${info.dev}:${info.ino}`;
        } finally {
          closeSync(fd);
        }
        const key = path + "\0" + identity;
        let entry = this.watches.get(key);
        if (!entry) {
          const listeners = new Set<(error?: string) => void>();
          const watcher = watch(full, { persistent: false }, () => {
            listeners.forEach((listener) => listener());
          });
          try {
            this.checkoutIdentity();
            const check = openSync(full, directoryFlags);
            try {
              const current = fstatSync(check);
              if (`${current.dev}:${current.ino}` !== identity)
                throw Error("Directory changed while subscribing. Use Refresh to retry.");
            } finally {
              closeSync(check);
            }
          } catch (error) {
            watcher.close();
            throw error;
          }
          entry = { watcher, listeners };
          this.watches.set(key, entry);
          watcher.on("error", (error) => {
            listeners.forEach((listener) => listener(`${full}: ${String(error)}`));
            watcher.close();
            if (this.watches.get(key)?.watcher === watcher) this.watches.delete(key);
          });
        }
        entry.listeners.add(changed);
        const captured = entry;
        releases.push(() => {
          captured.listeners.delete(changed);
          if (!captured.listeners.size) {
            captured.watcher.close();
            if (this.watches.get(key) === captured) this.watches.delete(key);
          }
        });
      } catch (error) {
        changed(`${this.root}/${path}: ${String(error)}`);
      }
    }
    return dispose;
  }
  private checkPolicyDirectory() {
    const policy = this.policyDirectory;
    if (!policy) throw Error("Repository ignore policy unavailable. Reopen the project.");
    const fd = openSync(policy.path, directoryFlags);
    try {
      const live = fstatSync(fd);
      if (live.dev !== policy.dev || live.ino !== policy.ino) throw Error("Repository ignore policy directory replaced. Reopen the project.");
    } finally { closeSync(fd); }
    for (const path of [join(policy.path, "info"), join(policy.path, "info/exclude")]) {
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink()) throw Error("Repository ignore policy cannot follow symbolic links.");
        const check = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
        try {
          const live = fstatSync(check);
          if (path === join(policy.path, "info") ? !live.isDirectory() : !live.isFile()) throw Error("Repository ignore policy unavailable.");
        } finally { closeSync(check); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return policy.path;
  }
  observeFiles(notify: (error?: string) => void) {
    this.checkoutIdentity();
    if (activeObservations >= 16) throw Error("Lookup observation limit reached. Refresh to retry.");
    activeObservations++;
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      watchers.forEach(watcher => watcher.close());
      activeObservations--;
      this.watchDisposers.delete(dispose);
    };
    const failed = (error: unknown) => {
      if (disposed) return;
      dispose();
      notify(String(error).slice(0, 2048));
    };
    try {
      const policy = this.checkPolicyDirectory();
      const changed = () => {
        if (disposed || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          try { this.checkoutIdentity(); this.checkPolicyDirectory(); notify(); } catch (error) { failed(error); }
        }, 500);
      };
      // Both sources share one invalidation timer; events never grant filesystem authority.
      watchers.push(watch(this.root, { recursive: true, persistent: false }, (_event, path) => {
        const name = path?.toString();
        // Git status/index churn cannot change discovery; repository excludes can.
        if (name?.startsWith(".git/") && name !== ".git/info" && !name.startsWith(".git/info/")) return;
        changed();
      }).on("error", failed));
      if (!policy.startsWith(this.root + "/")) watchers.push(watch(policy, { recursive: true, persistent: false }, (_event, path) => {
        if (!path || path.toString() === ".git" || path.toString() === "info" || path.toString().startsWith("info/")) changed();
      }).on("error", failed));
      this.checkoutIdentity();
      this.checkPolicyDirectory();
      this.watchDisposers.add(dispose);
      return dispose;
    } catch (error) { dispose(); throw error; }
  }
  close() {
    for (const dispose of this.watchDisposers) dispose();
    if (this.directory !== undefined) closeSync(this.directory);
    this.directory = undefined;
  }
  private checkedDirectory() {
    if (this.directory === undefined) throw Error("Project is closed.");
    const fd = openSync(this.root, directoryFlags);
    try {
      const identity = fstatSync(fd);
      if (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino)
        throw Error("Checkout directory was replaced. Reopen the project.");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  async discover(query: string, signal: AbortSignal, history?: readonly string[]): Promise<import("@escode/contracts").LookupResult> {
    if (history !== undefined) {
      if (!Array.isArray(history) || history.length > maximumRecentFiles ||
        history.some(p => typeof p !== "string" || !p || p.length > 4096 || isAbsolute(p) || p.includes("\0") || p.split("/").some(c => !c || c === "." || c === "..")) ||
        history.reduce((n, p) => n + p.length, 0) > maximumRecentUnits) throw Error("Invalid lookup history");
      if (query.length > 256 || query.includes("\0")) throw Error("Invalid lookup query");
      if (signal.aborted) throw Error("Lookup cancelled");
      this.checkoutIdentity();
      const recent: import("@escode/contracts").LookupResult["results"][number][] = [];
      let cells = 0, processed = 0, partial = false;
      for (const path of new Set(history)) {
        if (signal.aborted) throw Error("Lookup cancelled");
        // Default **/name globs match the target basename, not all descendants of ignored folders.
        const name = path.split("/").at(-1)!;
        if ([".git", ".svn", ".hg", ".jj", ".DS_Store", "Thumbs.db", "node_modules", "bower_components"].includes(name) || name.endsWith(".code-search")) continue;
        cells += path.length * query.length;
        if (cells > 16 * 1024 * 1024) { partial = true; break; }
        const match = query.trim() ? scorePath(path, query) : { score: 0, positions: [] };
        if (match) recent.push({ path, ...match, recent: true });
        if (recent.length === 100) { partial = true; break; }
        if (++processed % 32 === 0) await new Promise<void>(done => setImmediate(done));
      }
      const discovered = query.trim() ? await this.discover(query, signal) : { results: [], partial: false, message: "" };
      const seen = new Set(recent.map(r => r.path));
      const combined = [...recent, ...discovered.results.filter(r => !seen.has(r.path))];
      let bytes = 0;
      const results = combined.filter((r, i) => {
        bytes += Buffer.byteLength(r.path) + r.positions.length * 8 + 80;
        if (i >= 100 || bytes > 512 * 1024) { partial = true; return false; }
        return true;
      });
      this.checkoutIdentity();
      return { results, partial: partial || discovered.partial, message: discovered.message || (partial ? "Search capped; refine your query." : "") };
    }
    if (!query.trim() || query.length > 256 || query.includes("\0")) throw Error("Invalid lookup query (maximum 256 characters).");
    if (activeLookups >= 2) throw Error("Lookup busy. Refresh to retry.");
    const fd = this.checkedDirectory();
    activeLookups++;
    try {
      this.repositoryGit.validateRepository();
      this.checkPolicyDirectory();
      const result = await new Promise<import("@escode/contracts").LookupResult>((resolve, reject) => {
        const args = ["--files", "--hidden", "--null", "--no-config", "--no-ignore-parent", "--no-ignore-global", "--threads", "1"];
        for (const name of [".git", ".svn", ".hg", ".jj", ".DS_Store", "Thumbs.db", "node_modules", "bower_components", "*.code-search"]) args.push("--glob", `!**/${name}`);
        const child = spawn(this.helper, ["lookup", join(dirname(this.helper), "ripgrep"), ...args, "."], { stdio: ["ignore", "pipe", "pipe", fd], env: { ...process.env, RIPGREP_CONFIG_PATH: "" } });
        let bytes = 0, count = 0, pending = Buffer.alloc(0), partial = false, failure = "", resultBytes = 0;
        const paths: string[] = [];
        const results: RankedPath[] = [];
        const cap = () => { partial = true; child.kill(); };
        const timer = setTimeout(cap, 5000);
        const abort = () => child.kill();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout!.on("data", (chunk: Buffer) => {
          if (partial || signal.aborted) return;
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) { cap(); return; }
          pending = Buffer.concat([pending, chunk]);
          let end: number;
          while ((end = pending.indexOf(0)) >= 0) {
            const path = pending.subarray(0, end).toString("utf8").replace(/^\.\//, "");
            pending = pending.subarray(end + 1);
            if (++count > 20000) { cap(); break; }
            if (path.length <= 4096) paths.push(path); else cap();
          }
          if (pending.length > 16384) cap();
        });
        child.stderr!.on("data", (chunk: Buffer) => { failure = (failure + chunk.toString()).slice(0, 2048); });
        child.on("error", reject);
        child.on("close", async code => {
          clearTimeout(timer); signal.removeEventListener("abort", abort);
          if (signal.aborted) { reject(Error("Lookup cancelled")); return; }
          let cells = 0, matches = 0;
          for (let i = 0; i < paths.length; i++) {
            if (i % 32 === 0) await new Promise<void>(done => setImmediate(done));
            if (signal.aborted) { reject(Error("Lookup cancelled")); return; }
            cells += paths[i].length * query.length;
            if (cells > 16 * 1024 * 1024) { partial = true; break; }
            const match = scorePath(paths[i], query);
            if (match) {
              matches++;
              const row = { path: paths[i], ...match };
              const size = (r: typeof row) => Buffer.byteLength(r.path) + r.positions.length * 8 + 64;
              results.push(row); resultBytes += size(row);
              results.sort((a,b) => comparePathScores(a,b,query));
              while (results.length > 100 || resultBytes > 512 * 1024) { resultBytes -= size(results.pop()!); partial = true; }
            }
          }
          if (matches > 100) partial = true;
          resolve({ results: results.map(({ path, score, positions }) => ({ path, score, positions })), partial: partial || count > 20000 || results.length === 100 || code !== 0 || !!failure, message: failure ? "Enumeration or ignore rules unavailable. Refresh to retry." : partial || results.length === 100 ? "Search capped; refine your query or Refresh." : "" });
        });
      });
      this.checkoutIdentity();
      return result;
    } finally { activeLookups--; closeSync(fd); }
  }
  private io(args: string[], input?: string) {
    const fd = this.checkedDirectory();
    try {
      try {
        return execFileSync(this.helper, args, {
          input,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe", this.directory],
        });
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString();
        if (!stderr || args[0] === "git") throw error;
        const number = Number(stderr.split(":", 1)[0]);
        const code = number > 0 ? getSystemErrorName(-number) : undefined;
        throw Object.assign(
          Error((code ? code + ": " : "") + stderr.slice(stderr.indexOf(":") + 1).trim()),
          { code },
        );
      }
    } finally {
      closeSync(fd);
    }
  }
  private git(args: string[]) {
    return this.io(["git", this.executable, "--literal-pathspecs", "--work-tree=.", ...args]);
  }
  private path(path: string) {
    if (
      typeof path !== "string" ||
      !path ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")
    )
      throw Error("Invalid project path");
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith("../") || isAbsolute(rel) || !rel) throw Error("Path outside checkout");
    return rel;
  }
  async files(path = ""): Promise<{ path: string; directory: boolean }[]> {
    const scoped = path ? this.path(path) : ".";
    return this.io(["list", scoped])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({
        path: path ? path + "/" + entry.slice(1) : entry.slice(1),
        directory: entry[0] === "d",
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
  }
  async filteredFiles(path = "") {
    const entries = await this.files(path);
    try {
      if (this.filesOnly) throw Error("Git unavailable");
      let output: Buffer;
      try {
        output = this.io(
          ["git", this.executable, "--work-tree=.", "check-ignore", "-z", "--stdin"],
          entries.map((e) => e.path).join("\0") + (entries.length ? "\0" : ""),
        );
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
        output = Buffer.alloc(0);
      }
      return { entries, ignored: output.toString("utf8").split("\0").filter(Boolean) };
    } catch {
      return {
        entries,
        ignored: [],
        filterError:
          "Git ignore filter unavailable. All files are shown. Restore Git or repository access, then Refresh.",
      };
    }
  }
  entryLocation(path: string) {
    if (path) this.operationIdentity(path);
    else this.checkoutIdentity();
    return path ? resolve(this.root, path) : this.root;
  }
  checkoutIdentity() {
    closeSync(this.checkedDirectory());
    return `${this.identity.dev}:${this.identity.ino}`;
  }
  operationIdentity(path: string) {
    this.checkoutIdentity();
    if (
      path !== this.path(path) ||
      relative(this.root, realpathSync(resolve(this.root, path))) !== path
    )
      throw Error("Use the exact checkout-relative path without aliases.");
    return this.io(["identity", this.path(path)]).toString();
  }
  validateName(name: string) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name === "." ||
      name === ".." ||
      /[/\\\0]/.test(name) ||
      name.toLowerCase() === ".git"
    )
      throw Error("Enter one file or folder name without separators or traversal.");
  }
  create(parent: string, name: string, kind: "file" | "folder") {
    this.validateName(name);
    if (kind !== "file" && kind !== "folder") throw Error("Invalid create kind.");
    const scoped = parent ? this.path(parent) : ".";
    if (parent && scoped !== parent) throw Error("Use the exact parent path.");
    const identity = this.io(["identity", scoped]).toString();
    this.io(["create", scoped, name, kind, identity]);
    return parent ? parent + "/" + name : name;
  }
  renameDestination(source: string, name: string) {
    this.validateName(name);
    this.path(source);
    return join(dirname(source), name);
  }
  validateMove(source: string, destination: string) {
    if (source !== this.path(source) || destination !== this.path(destination))
      throw Error("Use exact checkout-relative paths.");
    const parent = dirname(destination);
    if (parent !== "." && relative(this.root, realpathSync(resolve(this.root, parent))) !== parent)
      throw Error("Use the exact destination parent path without aliases.");
    if (destination === source || destination.startsWith(source + "/"))
      throw Error("Choose a different destination outside the source folder.");
  }
  move(source: string, destination: string, identity: string) {
    this.validateMove(source, destination);
    this.io(["move", source, destination, identity]);
    try {
      if (this.operationIdentity(destination) !== identity)
        throw Error("Destination object changed.");
    } catch (error) {
      throw Object.assign(Error(`Move outcome needs reconciliation: ${String(error)}`), {
        uncertain: true,
      });
    }
  }
  async preflightImport(native: import("./native-import").NativeImport) {
    native.validate();
    const fd = this.checkedDirectory();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.helper, ["import-check", native.path, native.parents], {
          stdio: ["ignore", "ignore", "pipe", fd, native.fd],
        });
        let error = "";
        child.stderr!.on("data", (chunk) => {
          error += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(Error(error))));
      });
      native.validate();
    } finally {
      closeSync(fd);
    }
  }
  async copy(
    source: string,
    destination: string,
    identity: string,
    temporary: string,
    native?: import("./native-import").NativeImport,
  ) {
    if (native) {
      this.path(destination);
      native.validate();
      if (native.containsDirectory(resolve(this.root, dirname(destination))))
        throw Error("Choose a destination outside the source folder.");
    } else this.validateMove(source, destination);
    const parent = dirname(destination);
    const parentIdentity =
      parent === "." ? this.checkoutIdentity() : this.operationIdentity(parent);
    const fd = this.checkedDirectory();
    let staging = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          this.helper,
          [
            native ? "import" : "copy",
            source,
            destination,
            identity,
            temporary,
            parentIdentity,
            ...(native ? [native.path, native.parents, this.root] : []),
          ],
          {
            stdio: ["ignore", "pipe", "pipe", fd, ...(native ? [native.fd] : [])],
          },
        );
        child.stdout!.on("data", (chunk) => {
          staging += chunk;
        });
        let errorText = "";
        child.stderr!.on("data", (chunk) => {
          errorText += chunk;
        });
        child.on("error", reject);
        child.on("close", (code, signal) =>
          code === 0
            ? resolve()
            : reject(
                Object.assign(
                  Error(
                    errorText + (staging ? ` Opened copy staging object: ${staging.trim()}` : ""),
                  ),
                  { uncertain: true, signalled: !!signal },
                ),
              ),
        );
      });
      this.checkoutIdentity();
    } catch (error) {
      const absent = (path: string) => {
        try {
          this.operationIdentity(path);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
      };
      if (staging || (error as { signalled?: boolean }).signalled)
        throw Object.assign(error as Error, { uncertain: true });
      if (absent(destination) && absent(temporary))
        throw Object.assign(error as Error, { uncertain: false });
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  trash(source: string, identity: string) {
    return this.io(["trash", this.path(source), "-", identity]).toString();
  }
  private document(bytes: Buffer): Document {
    if (bytes.length > limit) throw Error("Text unavailable: file exceeds 2 MiB.");
    if (bytes.includes(0)) throw Error("Text unavailable: binary file.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, version: createHash("sha256").update(bytes).digest("hex") };
  }
  private readDisk(path: string) {
    return this.document(this.io(["read", this.path(path)]));
  }
  async read(path: string) {
    return this.readDisk(path);
  }
  async save(path: string, text: string, version: string): Promise<SaveResult> {
    if (typeof text !== "string" || Buffer.byteLength(text) > limit || typeof version !== "string")
      throw Error("Invalid save");
    const saved = this.document(Buffer.from(text));
    const scoped = this.path(path);
    const disk = this.readDisk(path);
    if (disk.version !== version) return { kind: "conflict", disk };
    const temp = join(dirname(scoped), ".escode-" + randomUUID());
    let staged = false;
    try {
      this.io(["stage", scoped, temp], text);
      staged = true;
      const current = this.readDisk(path);
      if (current.version !== version) return { kind: "conflict", disk: current };
      // shortcut: VS Code's check-before-save guarantee accepts an unrelated writer
      // between this check and replacement; upgrade only if the save policy changes.
      this.io(["replace", scoped, temp]);
      return { kind: "saved", disk: saved };
    } finally {
      if (staged) this.io(["remove", temp]);
    }
  }
  async status() {
    let output: Buffer;
    try {
      if (this.filesOnly) {
        const live = await Checkout.open(this.root, this.helper);
        try {
          if (
            live.repositoryGit.repository() !== this.repositoryGit.repository() ||
            live.identity.dev !== this.identity.dev ||
            live.identity.ino !== this.identity.ino
          )
            throw Error("Checkout identity changed. Restore the original checkout.");
          this.executable = live.executable;
          this.repositoryGit.gitDirectory = live.repositoryGit.gitDirectory;
          this.repositoryGit.gitIdentity = live.repositoryGit.gitIdentity;
          this.policyDirectory = live.policyDirectory;
          this.filesOnly = false;
        } finally {
          live.close();
        }
      }
      output = this.git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]);
    } catch (error) {
      if (!this.filesOnly && typeof (error as { status?: unknown }).status !== "number")
        throw error;
      closeSync(this.checkedDirectory());
      return {
        project: this.repositoryGit.repository(),
        root: this.root,
        branch: "Git unavailable",
        changes: [] as Change[],
        gitError:
          "Git unavailable. Restore Git or repository access, then Retry Git. File editing and existing chats remain available.",
      };
    }
    const records = output.toString("utf8").split("\0").filter(Boolean);
    const changes: Change[] = [];
    for (const row of records) {
      const path = row.slice(3);
      if (row.startsWith("??")) changes.push({ path, area: "untracked" });
      else {
        if (row[0] !== " ") changes.push({ path, area: "staged" });
        if (row[1] !== " ") changes.push({ path, area: "unstaged" });
      }
    }
    let branch: string;
    try {
      branch = this.git(["symbolic-ref", "--short", "HEAD"]).toString().trim();
    } catch {
      branch = this.git(["rev-parse", "--short", "HEAD"]).toString().trim() + " (detached)";
    }
    return { project: this.repositoryGit.repository(), root: this.root, branch, changes };
  }
  async diff(change: Change) {
    if (!["staged", "unstaged", "untracked"].includes(change.area))
      throw Error("Invalid diff area");
    // Validate lexical scope even when a deleted path no longer exists.
    this.path(change.path);
    const blob = (ref: string) => {
      try {
        this.git(["rev-parse", "--verify", ref]);
      } catch {
        return "";
      }
      try {
        return this.document(this.git(["show", ref + ":" + change.path])).text;
      } catch (error) {
        const exists = this.git(["ls-tree", "-z", ref, "--", change.path]).length;
        if (!exists) return "";
        throw error;
      }
    };
    const index = () => {
      const entries = this.git(["ls-files", "--stage", "-z", "--", change.path]).toString();
      if (!entries) return "";
      const oid = entries.split(" ")[1];
      return this.document(this.git(["cat-file", "blob", oid])).text;
    };
    const disk = async () => {
      try {
        return (await this.read(change.path)).text;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw e;
      }
    };
    return {
      original:
        change.area === "untracked" ? "" : change.area === "staged" ? blob("HEAD") : index(),
      modified: change.area === "staged" ? index() : await disk(),
    };
  }
}

export interface ProjectBridge {
  (operation: "drag-capture", checkout: string, paths: string[]): Promise<string>;
  (
    operation: "clipboard-capture",
    checkout: string,
    kind: "copy" | "cut",
    paths: string[],
  ): Promise<string>;
  (
    operation: "transfer",
    checkout: string,
    kind: "paste" | "duplicate" | "drag-move" | "drag-copy" | "import",
    parent: string,
    paths: string[],
  ): Promise<{
    results: (import("./file-operations").OperationResult & { source: string })[];
    open: string[];
    uncertain?: boolean;
    requiresAck: boolean;
    message: string;
  }>;

  (
    operation: "trash-selection",
    checkout: string,
    paths: string[],
  ): Promise<{
    results: import("./file-operations").TrashResult[];
    saves: import("./file-operations").SavedFile[];
    requiresAck: boolean;
    message: string;
  }>;

  (
    operation: "file-operation",
    checkout: string,
    kind: "move" | "rename",
    source: string,
    destination: string,
  ): Promise<import("./file-operations").OperationResult>;
  (
    operation: "create-entry",
    checkout: string,
    parent: string,
    name: string,
    kind: "file" | "folder",
  ): Promise<string>;
  (operation: "file-operation-ack", checkout: string): Promise<void>;

  (
    operation: "worktree-managed",
    checkout: string,
  ): Promise<ReturnType<Checkout["repositoryGit"]["managedWorktrees"]>>;
  (operation: "worktree-remove", checkout: string, root: string): Promise<boolean>;
  (operation: "open-checkout", project: string, chat: string): Promise<Awaited<ReturnType<Checkout["status"]>>>;
  (operation: "open"): Promise<Awaited<ReturnType<Checkout["status"]>> | null>;
  (
    operation: "worktree-options",
    checkout: string,
  ): Promise<ReturnType<Checkout["repositoryGit"]["worktreeOptions"]>>;
  (operation: "status", checkout: string): ReturnType<Checkout["status"]>;
  (
    operation: "entry-action",
    checkout: string,
    path: string,
    action: "copy-path" | "copy-relative" | "finder",
  ): Promise<void>;
  (operation: "read", checkout: string, path: string): ReturnType<Checkout["read"]>;
  (
    operation: "save",
    checkout: string,
    path: string,
    text: string,
    version: string,
  ): ReturnType<Checkout["save"]>;
  (
    operation: "diff",
    checkout: string,
    path: string,
    area: Change["area"],
  ): ReturnType<Checkout["diff"]>;
}
