import { execFileSync } from "node:child_process";
import { realpathSync, statSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Repository/worktree policy bound to one checkout's identity-checked Git runner.
export class CheckoutRepository {
  gitDirectory = "";
  gitIdentity?: { dev: number; ino: number };
  constructor(
    private readonly root: string,
    private readonly git: (args: string[]) => Buffer,
    private readonly executable: () => string,
  ) {}
  repositoryIdentity?: string;
  checkouts() {
    return this.git(["worktree", "list", "--porcelain", "-z"])
      .toString()
      .split("\0")
      .filter((record) => record.startsWith("worktree "))
      .map((record) => record.slice(9));
  }
  repository() {
    if (!this.repositoryIdentity) {
      const first = this.checkouts()[0];
      if (!first) throw Error("Cannot identify repository.");
      this.repositoryIdentity = realpathSync(first);
    }
    return this.repositoryIdentity;
  }
  validateRepository() {
    const liveDirectory = realpathSync(
      this.git(["rev-parse", "--absolute-git-dir"]).toString().trim(),
    );
    const identity = statSync(liveDirectory);
    const checkouts = this.checkouts();
    if (
      liveDirectory !== this.gitDirectory ||
      identity.dev !== this.gitIdentity?.dev ||
      identity.ino !== this.gitIdentity?.ino ||
      !checkouts.includes(this.root) ||
      !checkouts[0] ||
      realpathSync(checkouts[0]) !== this.repository()
    )
      throw Error(
        "Repository metadata changed. Reopen the project before creating or reusing worktrees.",
      );
    return checkouts;
  }
  worktreeOptions() {
    const checkouts = this.validateRepository();
    const branches = this.git(["for-each-ref", "--format=%(refname)", "refs/heads/"])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    const resolveBase = (ref: string) => {
      try {
        return this.git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"])
          .toString()
          .trim();
      } catch {
        return null;
      }
    };
    const bases = [...branches, "HEAD"].flatMap((ref) => {
      const commit = resolveBase(ref);
      return commit ? [{ ref, commit }] : [];
    });
    let defaultRef = "HEAD";
    try {
      const remote = this.git(["symbolic-ref", "refs/remotes/origin/HEAD"]).toString().trim();
      const local = "refs/heads/" + remote.slice("refs/remotes/origin/".length);
      defaultRef = bases.some((b) => b.ref === local) ? local : remote;
      const commit = resolveBase(defaultRef);
      if (commit && !bases.some((b) => b.ref === defaultRef))
        bases.push({ ref: defaultRef, commit });
    } catch {
      // Without local default-branch metadata, HEAD is the only reliable fallback.
    }
    if (!bases.some((b) => b.ref === defaultRef)) defaultRef = "HEAD";
    return { bases, defaultRef, checkouts };
  }
  reserveWorktree(managedRoot: string, ref: string, commit: string) {
    const base = ref === commit && /^[a-f0-9]{40,64}$/.test(commit)
      ? { commit: this.git(["rev-parse", "--verify", commit + "^{commit}"]).toString().trim() }
      : this.worktreeOptions().bases.find((b) => b.ref === ref);
    if (!base || base.commit !== commit)
      throw Error(
        "Base is missing or changed. Refresh bases and choose again. Empty repositories need a first commit.",
      );
    let ancestor = resolve(managedRoot);
    const missing: string[] = [];
    while (true) {
      try {
        ancestor = realpathSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
    const canonicalRoot = join(ancestor, ...missing);
    for (const checkout of this.checkouts()) {
      let canonicalCheckout: string;
      try {
        canonicalCheckout = realpathSync(checkout);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const rel = relative(canonicalCheckout, canonicalRoot);
      if (!rel || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)))
        throw Error(
          "Managed worktrees must be outside project checkouts. Relaunch escode with --user-data-dir pointing outside this repository.",
        );
    }
    const repository = createHash("sha256").update(this.repository()).digest("hex");
    const parent = join(canonicalRoot, repository);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    // Reserve a unique container; Git gets a never-before-used child path.
    const container = mkdtempSync(join(parent, "worktree-"));
    const root = join(container, "checkout");
    const branch = "escode/" + randomUUID().slice(0, 12);
    return { root, branch, commit };
  }
  createWorktree(
    managedRoot: string,
    ref: string,
    commit: string,
    reservation = this.reserveWorktree(managedRoot, ref, commit),
  ) {
    const { root, branch } = reservation;
    const container = dirname(root);
    try {
      const base = ref === commit && /^[a-f0-9]{40,64}$/.test(commit)
      ? { commit: this.git(["rev-parse", "--verify", commit + "^{commit}"]).toString().trim() }
      : this.worktreeOptions().bases.find((b) => b.ref === ref);
      if (!base || base.commit !== commit) throw Error("Base is missing or changed. Choose again.");
      // Git accepts an existing empty path, so reserve it exclusively ourselves.
      mkdirSync(root, { mode: 0o700 });
      writeFileSync(
        join(container, "ownership.json"),
        JSON.stringify({
          repository: this.repository(),
          root,
          branch,
          dev: statSync(root).dev,
          ino: statSync(root).ino,
        }),
        { flag: "wx", mode: 0o600 },
      );
      this.validateRepository();
      this.git([
        "--git-dir=" + this.gitDirectory,
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "-b",
        branch,
        root,
        commit,
      ]);
      return { root, branch, commit, error: null };
    } catch (error) {
      // Preserve all leftovers: even an empty directory may now belong to another writer.
      return {
        root,
        branch,
        commit,
        error: `Creation failed. No chat started. Inspect possible residual branch ${branch} and directory ${container} externally; both are retained. The reservation is retained; Retry never replaces it. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  managedWorktrees(managedRoot: string) {
    const parent = join(managedRoot, createHash("sha256").update(this.repository()).digest("hex"));
    if (!existsSync(parent)) return [];
    return readdirSync(parent).flatMap((name) => {
      const file = join(parent, name, "ownership.json");
      if (!existsSync(file)) return [];
      const record = JSON.parse(readFileSync(file, "utf8")) as {
        repository: string;
        root: string;
        branch: string;
        dev: number;
        ino: number;
      };
      if (
        record.repository !== this.repository() ||
        record.root !== join(parent, name, "checkout") ||
        typeof record.dev !== "number" ||
        typeof record.ino !== "number" ||
        !record.branch.startsWith("escode/") ||
        realpathSync(dirname(file)) !== dirname(file)
      )
        throw Error("Uncertain worktree ownership. Inspect managed files externally.");
      return [record];
    });
  }
  removalCheck(managedRoot: string, root: string) {
    this.validateRepository();
    const record = this.managedWorktrees(managedRoot).find((r) => r.root === root);
    if (!record) throw Error("Only app-created worktrees are eligible for removal.");
    const commit = this.git(["rev-parse", "--verify", "refs/heads/" + record.branch + "^{commit}"])
      .toString()
      .trim();
    let present = true;
    try {
      lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      present = false;
    }
    const registered = this.checkouts().includes(root);
    if (!registered) {
      if (present) throw Error("Unregistered worktree leftovers are retained. Inspect externally.");
      return { ...record, commit, removed: true };
    }
    if (!present) {
      const records = this.git(["worktree", "list", "--porcelain", "-z"]).toString().split("\0\0");
      const metadata = records.find((r) => r.split("\0")[0] === "worktree " + root)?.split("\0");
      if (
        !metadata?.includes("branch refs/heads/" + record.branch) ||
        !metadata.includes("HEAD " + commit)
      )
        throw Error("Missing checkout has uncertain branch preservation. Removal blocked.");
      return { ...record, commit, removed: false };
    }
    if (
      realpathSync(root) !== root ||
      !lstatSync(root).isDirectory() ||
      statSync(root).dev !== record.dev ||
      statSync(root).ino !== record.ino
    )
      throw Error("Worktree path changed. Removal blocked.");
    const run = (args: string[]) =>
      execFileSync(this.executable(), ["-C", root, "--work-tree=.", ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    if (
      realpathSync(resolve(root, run(["rev-parse", "--git-common-dir"]))) !==
      realpathSync(
        resolve(this.root, this.git(["rev-parse", "--git-common-dir"]).toString().trim()),
      )
    )
      throw Error("Repository metadata changed. Removal blocked.");
    if (run(["symbolic-ref", "--short", "HEAD"]) !== record.branch)
      throw Error("Retained branch changed. Removal blocked.");
    if (run(["rev-parse", "HEAD"]) !== commit) throw Error("Checkout commit changed.");
    if (run(["rev-parse", "refs/heads/" + record.branch]) !== commit)
      throw Error("Branch does not preserve the checkout commit.");
    if (run(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]))
      throw Error("Tracked, untracked or ignored local files need preserving. Removal blocked.");
    // Sparse/hidden index entries and submodules make a clean status insufficient evidence.
    if (
      run(["ls-files", "-v"])
        .split("\n")
        .some((line) => line && !line.startsWith("H ")) ||
      run(["ls-files", "--stage"])
        .split("\n")
        .some((line) => line.startsWith("160000 "))
    )
      throw Error(
        "Uncertain preservation checks (hidden index entries or submodules). Removal blocked.",
      );
    return { ...record, commit, removed: false };
  }
  removeWorktree(managedRoot: string, root: string, commit: string) {
    const checked = this.removalCheck(managedRoot, root);
    if (checked.removed) return;
    if (checked.commit !== commit)
      throw Error("Checkout changed after confirmation. Retry removal.");
    // shortcut: match VS Code's Git removal guarantee; an external writer after the
    // final check can lose ignored files. Upgrade only if that chosen policy changes.
    this.git(["--git-dir=" + this.gitDirectory, "worktree", "remove", "--", root]);
    if (existsSync(root) || this.checkouts().includes(root))
      throw Error("Removal incomplete. Leftovers retained; retry revalidates them.");
  }
}
