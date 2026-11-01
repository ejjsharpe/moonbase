import { test, expect } from "vite-plus/test";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { NativeImport } from "./native-import";
import { Checkout } from "./project";

async function fixture(run: (base: string, project: Checkout) => Promise<void>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "escode-import-45-")));
  const root = join(base, "repo");
  execFileSync("git", ["init", root]);
  const project = await Checkout.open(root);
  try {
    await run(base, project);
  } finally {
    project.close();
    rmSync(base, { recursive: true, force: true });
  }
}
test("native source scope rejects traversal, links, replaced source and parent without granting Checkout access", async () => {
  await fixture(async (base, project) => {
    const parent = join(base, "external");
    mkdirSync(parent);
    const path = join(parent, "a");
    writeFileSync(path, "original");
    const source = new NativeImport(path, () => {});
    try {
      expect(() => new NativeImport(parent + "/../external/a", () => {})).toThrow();
      symlinkSync(path, join(parent, "link"));
      expect(() => new NativeImport(join(parent, "link"), () => {})).toThrow();
      expect(() => project.operationIdentity("../external/a")).toThrow();
      renameSync(parent, parent + "-old");
      mkdirSync(parent);
      renameSync(join(parent + "-old", "a"), path);
      expect(() => source.validate()).toThrow("parent changed");
      await expect(project.preflightImport(source)).rejects.toThrow();
    } finally {
      source.close();
    }
  });
});
test("large binary import copies original bytes and unsupported recursive contents preflight without publication", async () => {
  await fixture(async (base, project) => {
    const bytes = Buffer.alloc(32 * 1024 * 1024, 0xa5);
    bytes[0] = 0;
    const path = join(base, "binary");
    writeFileSync(path, bytes);
    const source = new NativeImport(path, () => {});
    try {
      await project.preflightImport(source);
      await project.copy(source.source, "binary", source.identity, ".stage", source);
      expect(readFileSync(join(project.root, "binary")).equals(bytes)).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      renameSync(path, path + "-old");
      writeFileSync(path, "replacement");
      await expect(
        project.copy(source.source, "other", source.identity, ".stage2", source),
      ).rejects.toThrow();
    } finally {
      source.close();
    }
    for (const type of ["symlink", "fifo", "git"]) {
      const dir = join(base, type);
      mkdirSync(dir);
      writeFileSync(join(dir, "good"), "disk");
      if (type === "symlink") symlinkSync(path, join(dir, "bad"));
      if (type === "fifo") execFileSync("mkfifo", [join(dir, "bad")]);
      if (type === "git") mkdirSync(join(dir, ".git"));
      const source = new NativeImport(dir, () => {});
      try {
        await expect(project.preflightImport(source)).rejects.toThrow();
        expect(existsSync(join(project.root, type))).toBe(false);
      } finally {
        source.close();
      }
    }
  });
});

test("native directory ancestry uses object identities across aliases without conflating distinct names", async () => {
  await fixture(async (base, project) => {
    const { statSync, linkSync } = await import("node:fs");
    const external = join(base, "Unicode-é");
    mkdirSync(external);
    mkdirSync(join(external, "child"));
    const source = new NativeImport(external, () => {});
    try {
      expect(source.containsDirectory(external)).toBe(true);
      expect(source.containsDirectory(join(external, "child"))).toBe(true);
      expect(source.containsDirectory(project.root)).toBe(false);
      for (const alias of [join(base, "UNICODE-É"), join(base, "Unicode-e\u0301")]) {
        let actual;
        try {
          actual = statSync(alias);
        } catch {
          /* Case-sensitive/non-normalizing filesystem. */
        }
        if (actual?.ino === statSync(external).ino && actual?.dev === statSync(external).dev)
          expect(source.containsDirectory(alias)).toBe(true);
        else {
          if (!actual) mkdirSync(alias);
          expect(source.containsDirectory(alias)).toBe(false);
        }
      }
      // A genuinely distinct directory is never classified by a lowercase/Unicode heuristic.
      const distinct = join(base, "distinct");
      mkdirSync(distinct);
      expect(source.containsDirectory(distinct)).toBe(false);
      const linked = join(base, "directory-link");
      symlinkSync(external, linked);
      expect(() => source.containsDirectory(linked)).toThrow();
    } finally {
      source.close();
    }
    const file = join(base, "original");
    writeFileSync(file, "disk");
    const captured = new NativeImport(file, () => {});
    try {
      linkSync(file, join(base, "hard-link"));
      expect(() => captured.validate()).toThrow("Native source changed");
      expect(() => new NativeImport(file, () => {})).toThrow("hard link");
    } finally {
      captured.close();
    }
  });
});
