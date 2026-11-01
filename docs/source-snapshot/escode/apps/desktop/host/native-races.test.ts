import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = realpathSync(mkdtempSync(join(tmpdir(), "escode-native-races-")));
const helper = join(base, "filesystem");
const stagingHelper = join(base, "filesystem-staging");
beforeAll(() => {
  // The shipped helper is compiled without this define and has no pause protocol.
  for (const [binary, define] of [
    [helper, "ESCODE_TEST_PREFLIGHT"],
    [stagingHelper, "ESCODE_TEST_COPY_STAGE"],
  ])
    execFileSync("clang", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-D" + define,
      "host/filesystem.c",
      "-framework",
      "CoreServices",
      "-o",
      binary,
    ]);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
for (const [kind, replacement] of [
  ["copy", true],
  ["copy", false],
  ["move", true],
  ["trash", false],
  ["trash", true],
] as const) {
  test(`${kind} rejects a source ${replacement ? "replaced with protected contents" : "relocated outside the checkout"} during recursive preflight`, async () => {
    const fixture = mkdtempSync(join(base, "fixture-")),
      root = join(fixture, "repo");
    execFileSync("git", ["init", root]);
    const source = join(root, "source"),
      outside = join(fixture, "outside");
    mkdirSync(source);
    writeFileSync(join(source, "edits.txt"), "original disk bytes");
    const original = statSync(source);
    const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    const child = spawn(
      helper,
      [
        kind,
        "source",
        kind !== "trash" ? "destination" : "-",
        `${original.dev}:${original.ino}`,
        ...(kind === "copy" ? [".copy-stage", `${statSync(root).dev}:${statSync(root).ino}`] : []),
      ],
      { stdio: ["ignore", "pipe", "pipe", rootFd, "pipe", "pipe"] },
    );
    closeSync(rootFd);
    const closed = once(child, "close");
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr!.on("data", (bytes) => {
      stderr += bytes;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        once(child.stdio[4]!, "data"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Error("Native helper did not reach preflight")), 3000);
        }),
      ]);
      expect(String(ready[0])).toBe("ready");
      // The original source is already open; preflight will continue through that fd.
      renameSync(source, outside);
      if (replacement) {
        mkdirSync(source);
        mkdirSync(join(source, ".git"));
        writeFileSync(join(source, ".git/protected"), "replacement metadata");
      }
      (child.stdio.at(5) as import("node:stream").Writable).end("continue");
      const [code] = await closed;
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/Source changed after preflight|Open checkout path/);
      expect(stdout).toBe("");
      expect(existsSync(join(root, "destination"))).toBe(false);
      expect(statSync(outside).ino).toBe(original.ino);
      expect(readFileSync(join(outside, "edits.txt"), "utf8")).toBe("original disk bytes");
      if (replacement)
        expect(readFileSync(join(source, ".git/protected"), "utf8")).toBe("replacement metadata");
      else expect(existsSync(source)).toBe(false);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await closed;
      // A failing pre-fix run may actually Trash this test-owned object.
      if (stdout.includes("/.Trash/")) rmSync(stdout, { recursive: true, force: true });
    }
  });
}

test("copy rejects destination-parent replacement during native recursive preflight", async () => {
  const fixture = mkdtempSync(join(base, "destination-")),
    root = join(fixture, "repo");
  execFileSync("git", ["init", root]);
  mkdirSync(join(root, "source"));
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "source/file.bin"), Buffer.alloc(1024, 173));
  const source = statSync(join(root, "source")),
    target = statSync(join(root, "target"));
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
  const child = spawn(
    helper,
    [
      "copy",
      "source",
      "target/copy",
      `${source.dev}:${source.ino}`,
      "target/.stage",
      `${target.dev}:${target.ino}`,
    ],
    { stdio: ["ignore", "pipe", "pipe", fd, "pipe", "pipe"] },
  );
  closeSync(fd);
  const closed = once(child, "close");
  let error = "";
  child.stderr!.on("data", (bytes) => {
    error += bytes;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child.stdio[4]!, "data"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(Error("No preflight")), 3000);
      }),
    ]);
    renameSync(join(root, "target"), join(fixture, "original-target"));
    mkdirSync(join(root, "target"));
    (child.stdio.at(5) as import("node:stream").Writable).end("continue");
    expect((await closed)[0]).not.toBe(0);
    expect(error).toContain("Copy destination parent replaced");
    expect(existsSync(join(root, "target/copy"))).toBe(false);
    expect(existsSync(join(fixture, "original-target/copy"))).toBe(false);
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await closed;
  }
});

for (const kind of ["folder", "file"] as const) {
  test(`copy rejects replacement of its open ${kind} staging object without publishing or cleaning the replacement`, async () => {
    const root = mkdtempSync(join(base, "staging-"));
    if (kind === "folder") {
      mkdirSync(join(root, "source"));
      for (let i = 0; i < 2000; i++) writeFileSync(join(root, `source/${i}.txt`), `correct ${i}`);
    } else writeFileSync(join(root, "source"), Buffer.alloc(4 * 1024 * 1024, 173));
    const source = statSync(join(root, "source")),
      parent = statSync(root);
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    const child = spawn(
      stagingHelper,
      [
        "copy",
        "source",
        "destination",
        `${source.dev}:${source.ino}`,
        ".stage",
        `${parent.dev}:${parent.ino}`,
      ],
      { stdio: ["ignore", "pipe", "pipe", fd, "pipe", "pipe"] },
    );
    closeSync(fd);
    const closed = once(child, "close");
    let error = "",
      output = "";
    child.stderr!.on("data", (bytes) => {
      error += bytes;
    });
    child.stdout!.on("data", (bytes) => {
      output += bytes;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        once(child.stdio[4]!, "data"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Error("No staging pause")), 10000);
        }),
      ]);
      expect(String(ready[0])).toBe("staged");
      const original = statSync(join(root, ".stage"));
      renameSync(join(root, ".stage"), join(root, "retained-stage"));
      if (kind === "folder") {
        mkdirSync(join(root, ".stage"));
        writeFileSync(join(root, ".stage/WRONG"), "replacement bytes");
      } else writeFileSync(join(root, ".stage"), "replacement bytes");
      (child.stdio.at(5) as import("node:stream").Writable).end("continue");
      expect((await closed)[0]).not.toBe(0);
      expect(error).toContain("Source changed after preflight");
      expect(output).toBe(`staged:${original.dev}:${original.ino}\n`);
      expect(existsSync(join(root, "destination"))).toBe(false);
      expect(readFileSync(join(root, kind === "folder" ? ".stage/WRONG" : ".stage"), "utf8")).toBe(
        "replacement bytes",
      );
      expect(statSync(join(root, "retained-stage")).ino).toBe(original.ino);
      if (kind === "folder")
        for (let i = 0; i < 2000; i++)
          expect(readFileSync(join(root, `retained-stage/${i}.txt`), "utf8")).toBe(`correct ${i}`);
      else
        expect(
          readFileSync(join(root, "retained-stage")).equals(Buffer.alloc(4 * 1024 * 1024, 173)),
        ).toBe(true);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await closed;
    }
  });
}

for (const swap of ["source", "ancestor", "parent", "root", "stage"] as const) {
  test(`native import rejects ${swap} replacement before publish and retains staging without cleanup`, async () => {
    const { NativeImport } = await import("./native-import");
    const fixture = mkdtempSync(join(base, "import-"));
    const root = join(fixture, "repo"),
      external = join(fixture, "external");
    mkdirSync(root);
    mkdirSync(external);
    mkdirSync(join(root, "target"));
    writeFileSync(join(external, "source"), Buffer.alloc(4096, 173));
    const source = new NativeImport(join(external, "source"), () => {});
    const parent = statSync(join(root, "target"));
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    const child = spawn(
      stagingHelper,
      [
        "import",
        source.source,
        "target/result",
        source.identity,
        "target/.stage",
        `${parent.dev}:${parent.ino}`,
        source.path,
        source.parents,
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe", fd, source.fd, "pipe", "pipe"] },
    );
    closeSync(fd);
    const closed = once(child, "close");
    let error = "";
    child.stderr!.on("data", (bytes) => {
      error += bytes;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child.stdio.at(5)!, "data"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Error("No import staging pause")), 5000);
        }),
      ]);
      if (swap === "source") {
        renameSync(source.path, source.path + "-old");
        writeFileSync(source.path, "replacement");
      }
      if (swap === "ancestor") {
        renameSync(external, external + "-old");
        mkdirSync(external);
        renameSync(join(external + "-old", "source"), source.path);
      }
      if (swap === "parent") {
        renameSync(join(root, "target"), join(root, "old-target"));
        mkdirSync(join(root, "target"));
      }
      if (swap === "root") {
        renameSync(root, root + "-old");
        mkdirSync(root);
        mkdirSync(join(root, "target"));
      }
      if (swap === "stage") {
        renameSync(join(root, "target/.stage"), join(root, "target/old-stage"));
        writeFileSync(join(root, "target/.stage"), "replacement stage");
      }
      (child.stdio.at(6) as import("node:stream").Writable).end("continue");
      expect((await closed)[0]).not.toBe(0);
      expect(error).toMatch(/replaced|changed/);
      expect(existsSync(join(root, "target/result"))).toBe(false);
      expect(existsSync(join(root + "-old", "target/result"))).toBe(false);
      expect(existsSync(join(root, "old-target/result"))).toBe(false);
      if (swap === "stage")
        expect(readFileSync(join(root, "target/.stage"), "utf8")).toBe("replacement stage");
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await closed;
      source.close();
    }
  });
}

test("native helper rejects destination ancestry before any staging even without the host preflight", async () => {
  const { NativeImport } = await import("./native-import");
  const root = mkdtempSync(join(base, "import-descendant-"));
  mkdirSync(join(root, "source"));
  mkdirSync(join(root, "source/child"));
  writeFileSync(join(root, "source/child/original"), "original bytes");
  const source = new NativeImport(join(root, "source"), () => {});
  const parent = statSync(join(root, "source/child"));
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
  try {
    expect(() =>
      execFileSync(
        stagingHelper,
        [
          "import",
          "source",
          "source/child/result",
          source.identity,
          "source/child/.stage",
          `${parent.dev}:${parent.ino}`,
          source.path,
          source.parents,
          root,
        ],
        { stdio: ["ignore", "pipe", "pipe", fd, source.fd], timeout: 2000 },
      ),
    ).toThrow(/outside the source folder/);
    expect(existsSync(join(root, "source/child/.stage"))).toBe(false);
    expect(existsSync(join(root, "source/child/result"))).toBe(false);
    expect(readFileSync(join(root, "source/child/original"), "utf8")).toBe("original bytes");
  } finally {
    closeSync(fd);
    source.close();
  }
});
