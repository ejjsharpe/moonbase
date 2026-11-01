import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

const flags = constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000; // macOS O_NOFOLLOW_ANY
const identity = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;
// Only constructed from privileged preload webUtils or the main-process native clipboard.
// Retain the source descriptor, never a parent-directory descriptor or Project approval.
export class NativeImport {
  readonly source: string;
  readonly identity: string;
  readonly directory: boolean;
  readonly parents: string;
  readonly fd: number;
  constructor(
    readonly path: string,
    protectedPath: (path: string) => void,
  ) {
    if (
      !isAbsolute(path) ||
      path.includes("\0") ||
      path.split("/").some((p) => p === "." || p === ".." || p.toLowerCase() === ".git")
    )
      throw Error("Invalid native file reference.");
    protectedPath(path);
    this.source = basename(path);
    if (!this.source) throw Error("Cannot import a filesystem root.");
    this.parents = this.parentIdentities();
    this.fd = openSync(path, flags);
    try {
      const stat = fstatSync(this.fd);
      if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1))
        throw Error("Unsupported native source type or hard link.");
      this.identity = identity(stat);
      this.directory = stat.isDirectory();
      this.validate();
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  private parentIdentities(directory = dirname(this.path)) {
    const paths = ["/"];
    let current = "";
    for (const part of directory.split("/").filter(Boolean)) {
      current += "/" + part;
      paths.push(current);
    }
    return paths
      .map((path) => {
        const fd = openSync(path, flags | constants.O_DIRECTORY);
        try {
          return identity(fstatSync(fd));
        } finally {
          closeSync(fd);
        }
      })
      .join(",");
  }
  containsDirectory(directory: string) {
    // Compare actual ancestor objects after no-follow opens, not path spelling or case folding.
    // Descriptors are closed immediately; this grants no ongoing parent authority.
    return this.directory && this.parentIdentities(directory).split(",").includes(this.identity);
  }
  validate() {
    if (this.parentIdentities() !== this.parents) throw Error("Native source parent changed.");
    const fd = openSync(this.path, flags);
    try {
      const stat = fstatSync(fd);
      if (
        identity(stat) !== this.identity ||
        stat.isDirectory() !== this.directory ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw Error("Native source changed. Drop or copy it again.");
    } finally {
      closeSync(fd);
    }
  }
  close() {
    closeSync(this.fd);
  }
}
