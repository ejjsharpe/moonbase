#include <CoreServices/CoreServices.h>
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define LIMIT (2 * 1024 * 1024)
#define SCOPED (O_NOFOLLOW_ANY | O_RESOLVE_BENEATH | O_NONBLOCK)

static const char *owned_temp;

static void fail(const char *message) {
  fprintf(stderr, "%d:%s: %s\n", errno, message, strerror(errno));
  if (owned_temp &&
      unlinkat(3, owned_temp, AT_SYMLINK_NOFOLLOW_ANY | AT_RESOLVE_BENEATH) &&
      errno != ENOENT)
    fprintf(stderr, "Temporary file remains: %s\n", owned_temp);
  exit(1);
}

static int scoped_open(int dir, const char *path, int flags) {
  int fd = openat(dir, path, flags | SCOPED, 0600);
  if (fd < 0) {
    char message[PATH_MAX + 32];
    snprintf(message, sizeof(message), "Open checkout path %s", path);
    fail(message);
  }
  return fd;
}

// shortcut: preflight precedes ripgrep reads; use descriptor-owned enumeration if atomic policy snapshots become required.
static void lookup_policy(int fd, unsigned depth, unsigned *entries) {
  if (depth > 128) { errno = EOVERFLOW; fail("Ignore policy depth capped"); }
  DIR *dir = fdopendir(fd);
  if (!dir) fail("Inspect ignore policy directory");
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(dir);
    if (!entry) { if (errno) fail("Read ignore policy directory"); break; }
    const char *name = entry->d_name;
    if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
    if (++*entries > 20000) { errno = EOVERFLOW; fail("Ignore policy coverage capped"); }
    size_t len = strlen(name);
    if (!strcmp(name, ".git") || !strcmp(name, ".svn") || !strcmp(name, ".hg") ||
        !strcmp(name, ".jj") || !strcmp(name, ".DS_Store") || !strcmp(name, "Thumbs.db") ||
        !strcmp(name, "node_modules") || !strcmp(name, "bower_components") ||
        (len >= 12 && !strcmp(name + len - 12, ".code-search"))) continue;
    struct stat info;
    if (fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW)) fail("Inspect ignore policy entry");
    if (!strcmp(name, ".gitignore") || !strcmp(name, ".ignore") || !strcmp(name, ".rgignore")) {
      if (!S_ISREG(info.st_mode)) { errno = EINVAL; fail("Ignore policy must be a regular file without links"); }
      int policy = scoped_open(fd, name, O_RDONLY);
      close(policy);
    } else if (S_ISDIR(info.st_mode)) {
      lookup_policy(scoped_open(fd, name, O_RDONLY | O_DIRECTORY), depth + 1, entries);
    }
  }
  closedir(dir);
}

static void revalidate_source(const char *path, const struct stat *expected) {
  int current = scoped_open(3, path, O_RDONLY);
  struct stat actual;
  if (fstat(current, &actual)) fail("Reinspect operation source");
  if (actual.st_dev != expected->st_dev || actual.st_ino != expected->st_ino) {
    errno = ESTALE;
    fail("Source changed after preflight");
  }
  close(current);
}

static void revalidate_import(const char *path, const char *parents, const struct stat *expected) {
  char parent[PATH_MAX], actual[PATH_MAX], id[100];
  snprintf(parent, sizeof(parent), "%s", path);
  char *slash = strrchr(parent, '/');
  if (!slash) { errno = EINVAL; fail("Invalid import path"); }
  *slash = 0;
  actual[0] = 0;
  char prefix[PATH_MAX] = "/";
  const char *rest = parent;
  for (;;) {
    int fd = open(prefix, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
    struct stat info;
    if (fd < 0 || fstat(fd, &info)) fail("Open import ancestor");
    close(fd);
    snprintf(id, sizeof(id), "%s%llu:%llu", actual[0] ? "," : "", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
    if (strlen(actual) + strlen(id) >= sizeof(actual)) { errno = EINVAL; fail("Import ancestry too deep"); }
    strcat(actual, id);
    while (*rest == '/') rest++;
    if (!*rest) break;
    const char *end = strchr(rest, '/');
    size_t n = end ? (size_t)(end - rest) : strlen(rest);
    if (strlen(prefix) > 1) strcat(prefix, "/");
    strncat(prefix, rest, n);
    rest += n;
  }
  if (strcmp(actual, parents)) { errno = ESTALE; fail("Import ancestor replaced"); }
  int fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY);
  struct stat info;
  if (fd < 0 || fstat(fd, &info)) fail("Open native import source");
  close(fd);
  if (info.st_dev != expected->st_dev || info.st_ino != expected->st_ino || (info.st_mode & S_IFMT) != (expected->st_mode & S_IFMT)) {
    errno = ESTALE; fail("Native import source replaced");
  }
}

// Inspect only the approved checkout's destination ancestors. Never stage inside a source
// directory reached through a case/Unicode/mount spelling alias.
static void import_destination(const char *parent, const struct stat *source) {
  if (!S_ISDIR(source->st_mode)) return;
  char path[PATH_MAX];
  snprintf(path, sizeof(path), "%s", parent);
  for (;;) {
    int fd = scoped_open(3, path, O_RDONLY | O_DIRECTORY);
    struct stat info;
    if (fstat(fd, &info)) fail("Inspect import destination ancestry");
    close(fd);
    if (info.st_dev == source->st_dev && info.st_ino == source->st_ino) {
      errno = EINVAL; fail("Choose a destination outside the source folder");
    }
    if (!strcmp(path, ".")) break;
    char *slash = strrchr(path, '/');
    if (slash) *slash = 0; else strcpy(path, ".");
  }
}

static struct stat regular(int fd) {
  struct stat info;
  if (fstat(fd, &info)) fail("Inspect file");
  if (!S_ISREG(info.st_mode)) {
    errno = ENOTSUP;
    fail("Text unavailable: not a regular file");
  }
  if (info.st_size > LIMIT) {
    errno = EFBIG;
    fail("Text unavailable: file exceeds 2 MiB");
  }
  return info;
}

static void transfer(int from, int to) {
  char bytes[65536];
  size_t total = 0;
  for (;;) {
    ssize_t n = read(from, bytes, sizeof(bytes));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) fail("Read file");
    if (!n) return;
    total += (size_t)n;
    if (total > LIMIT) {
      errno = EFBIG;
      fail("Text unavailable: file exceeds 2 MiB");
    }
    for (ssize_t offset = 0; offset < n;) {
      ssize_t written = write(to, bytes + offset, (size_t)(n - offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) fail("Write file");
      offset += written;
    }
  }
}

static void safe_tree(int fd) {
  struct stat info;
  if (fstat(fd, &info)) fail("Inspect operation source");
  if (S_ISREG(info.st_mode)) {
    if (info.st_nlink != 1) { errno = ENOTSUP; fail("Operation unavailable: hard-linked file"); }
    return;
  }
  if (!S_ISDIR(info.st_mode)) { errno = ENOTSUP; fail("Unsupported source"); }
#ifdef ESCODE_TEST_PREFLIGHT
  // Only the separately compiled race-test helper has this synchronization point.
  static int paused;
  if (!paused) {
    paused = 1;
    char resume;
    if (write(4, "ready", 5) != 5 || read(5, &resume, 1) != 1) {
      errno = EIO; fail("Synchronize preflight test");
    }
  }
#endif
  if (lseek(fd, 0, SEEK_SET) < 0) fail("Rewind operation folder");
  DIR *dir = fdopendir(dup(fd));
  if (!dir) fail("Inspect operation folder");
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (!strcasecmp(entry->d_name, ".git")) { errno = EPERM; fail("Protected metadata"); }
    int child = scoped_open(fd, entry->d_name, O_RDONLY);
    safe_tree(child);
    close(child);
    errno = 0;
  }
  if (errno) fail("Inspect operation folder");
  closedir(dir);
}

static int same_name(const char *a, const char *b) {
  CFStringRef left = CFStringCreateWithCString(NULL, a, kCFStringEncodingUTF8);
  CFStringRef right = CFStringCreateWithCString(NULL, b, kCFStringEncodingUTF8);
  if (!left || !right) { errno = EINVAL; fail("Invalid UTF-8 destination name"); }
  int same = CFStringCompare(left, right, kCFCompareCaseInsensitive | kCFCompareNonliteral) == kCFCompareEqualTo;
  CFRelease(left); CFRelease(right);
  return same;
}

static void free_case_name(const char *path, const char *excluded) {
  char parent[PATH_MAX];
  snprintf(parent, sizeof(parent), "%s", path);
  char *name = strrchr(parent, '/');
  const char *leaf = path;
  if (name) { *name = 0; leaf = strrchr(path, '/') + 1; }
  else strcpy(parent, ".");
  int fd = scoped_open(3, parent, O_RDONLY | O_DIRECTORY);
  DIR *dir = fdopendir(fd);
  if (!dir) fail("Inspect destination names");
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    char candidate[PATH_MAX];
    if (!strcmp(parent, ".")) snprintf(candidate, sizeof(candidate), "%s", entry->d_name);
    else snprintf(candidate, sizeof(candidate), "%s/%s", parent, entry->d_name);
    if (excluded && !strcmp(candidate, excluded)) continue;
    if (same_name(entry->d_name, leaf)) { errno = EEXIST; fail("Destination case variant occupied"); }
  }
  closedir(dir);
}

static void copy_tree(int from, int to) {
  struct stat info;
  if (fstat(from, &info)) fail("Inspect copy source");
  if (S_ISREG(info.st_mode)) {
    if (info.st_nlink != 1) { errno = ENOTSUP; fail("Hard-linked copy source"); }
    if (fcopyfile(from, to, NULL, COPYFILE_DATA) || fchmod(to, info.st_mode & 0777) || fsync(to))
      fail("Copy file bytes");
    return;
  }
  if (!S_ISDIR(info.st_mode)) { errno = ENOTSUP; fail("Unsupported copy source"); }
  if (lseek(from, 0, SEEK_SET) < 0) fail("Rewind copy folder");
  DIR *dir = fdopendir(dup(from));
  if (!dir) fail("Browse copy source");
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (!strcasecmp(entry->d_name, ".git")) { errno = EPERM; fail("Protected metadata"); }
    int child = scoped_open(from, entry->d_name, O_RDONLY);
    struct stat actual;
    if (fstat(child, &actual)) fail("Inspect copy child");
    if (!S_ISDIR(actual.st_mode) && !S_ISREG(actual.st_mode)) { errno = ENOTSUP; fail("Unsupported copy child"); }
    if (S_ISDIR(actual.st_mode) && mkdirat(to, entry->d_name, 0700)) fail("Create copy folder");
    int target = scoped_open(to, entry->d_name, S_ISDIR(actual.st_mode) ? O_RDONLY | O_DIRECTORY : O_WRONLY | O_CREAT | O_EXCL);
    copy_tree(child, target);
    close(child); close(target);
    errno = 0;
  }
  if (errno) fail("Browse copy source");
  closedir(dir);
}

int main(int argc, char **argv) {
  // Descriptor 3 is the host-validated checkout, inherited without a path lookup.
  struct stat root;
  if (fstat(3, &root) || !S_ISDIR(root.st_mode) || argc < 3) {
    errno = EINVAL;
    fail("Invalid filesystem request");
  }
  const char *operation = argv[1];
  if (!strcmp(operation, "lookup")) {
    unsigned entries = 0;
    lookup_policy(scoped_open(3, ".", O_RDONLY | O_DIRECTORY), 0, &entries);
  }
  if (!strcmp(operation, "git") || !strcmp(operation, "lookup")) {
    if (fchdir(3) || fcntl(3, F_SETFD, FD_CLOEXEC)) fail("Enter checkout");
    execv(argv[2], argv + 2);
    fail("Start Git");
  }
  if (!strcmp(operation, "read")) {
    int fd = scoped_open(3, argv[2], O_RDONLY);
    regular(fd);
    transfer(fd, STDOUT_FILENO);
    return 0;
  }
  if (!strcmp(operation, "list")) {
    int fd = scoped_open(3, argv[2], O_RDONLY | O_DIRECTORY);
    DIR *dir = fdopendir(fd);
    if (!dir) fail("Browse directory");
    struct dirent *entry;
    for (;;) {
      errno = 0;
      entry = readdir(dir);
      if (!entry) {
        if (errno) fail("Browse directory");
        break;
      }
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") ||
          !strcasecmp(entry->d_name, ".git")) continue;
      struct stat info;
      if (fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW)) {
        if (errno == ENOENT) continue;
        fail("Inspect directory entry");
      }
      if (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode)) continue;
      putchar(S_ISDIR(info.st_mode) ? 'd' : 'f');
      fwrite(entry->d_name, 1, strlen(entry->d_name) + 1, stdout);
    }
    if (ferror(stdout) || closedir(dir)) fail("Browse directory");
    return 0;
  }

  if (!strcmp(operation, "create")) {
    if (argc != 6 || !argv[3][0] || strchr(argv[3], '/') || strchr(argv[3], '\\') ||
        !strcmp(argv[3], ".") || !strcmp(argv[3], "..") || !strcasecmp(argv[3], ".git")) {
      errno = EINVAL; fail("Invalid basename");
    }
    int parent = scoped_open(3, argv[2], O_RDONLY | O_DIRECTORY);
    struct stat info;
    if (fstat(parent, &info)) fail("Inspect create parent");
    char identity[100];
    snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
    if (strcmp(identity, argv[5])) { errno = ESTALE; fail("Create parent replaced"); }
    revalidate_source(argv[2], &info);
    if (!strcmp(argv[4], "folder")) {
      if (mkdirat(parent, argv[3], 0700)) fail("Create folder (name must be free)");
    } else if (!strcmp(argv[4], "file")) {
      int fd = scoped_open(parent, argv[3], O_WRONLY | O_CREAT | O_EXCL);
      if (close(fd)) fail("Close new file");
    } else { errno = EINVAL; fail("Invalid create kind"); }
    return 0;
  }

  if (!strcmp(operation, "identity") || !strcmp(operation, "move") || !strcmp(operation, "trash")) {
    int fd = scoped_open(3, argv[2], O_RDONLY);
    struct stat info;
    if (fstat(fd, &info)) fail("Inspect source");
    if (!strcmp(operation, "identity")) {
      printf("%llu:%llu", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
      return 0;
    }
    if (argc != 5) { errno = EINVAL; fail("Invalid operation"); }
    char identity[100];
    snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
    if (strcmp(identity, argv[4])) { errno = ESTALE; fail("Source replaced"); }
    safe_tree(fd);
    // shortcut: this final scoped identity check is not atomic with the native mutation;
    // upgrade if cross-process transactional file operations become a requirement.
    revalidate_source(argv[2], &info);
    if (!strcmp(operation, "move")) {
      free_case_name(argv[3], argv[2]);
      if (renameatx_np(3, argv[2], 3, argv[3], RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH))
        fail("Move source (destination must be free)");
      return 0;
    }
    // Native Trash uses a filesystem object reference, never a late path lookup.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    char path[PATH_MAX];
    FSRef source, target;
    if (fcntl(fd, F_GETPATH, path)) fail("Locate Trash source");
    OSStatus status = FSPathMakeRefWithOptions((UInt8 *)path, kFSPathMakeRefDoNotFollowLeafSymlink, &source, NULL);
    if (status) { errno = EIO; fail("Create Trash reference"); }
    if (FSRefMakePath(&source, (UInt8 *)path, sizeof(path))) { errno = EIO; fail("Resolve Trash reference"); }
    int referenced = open(path, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK);
    struct stat actual;
    if (referenced < 0 || fstat(referenced, &actual) || actual.st_dev != info.st_dev || actual.st_ino != info.st_ino) {
      errno = ESTALE; fail("Trash source changed");
    }
    close(referenced);
    // A matching native reference alone does not prove the source is still in scope.
    revalidate_source(argv[2], &info);
    status = FSMoveObjectToTrashSync(&source, &target, 0);
    if (status) { fprintf(stderr, "5:Native Trash failed (%d); no permanent deletion attempted\n", (int)status); return 1; }
    if (!FSRefMakePath(&target, (UInt8 *)path, sizeof(path))) printf("%s", path);
#pragma clang diagnostic pop
    return 0;
  }

  if (!strcmp(operation, "import-check")) {
    if (argc != 4) { errno = EINVAL; fail("Invalid import preflight"); }
    struct stat info;
    if (fstat(4, &info)) fail("Inspect native source");
    revalidate_import(argv[2], argv[3], &info);
    safe_tree(4);
    revalidate_import(argv[2], argv[3], &info);
    return 0;
  }

  if (!strcmp(operation, "copy") || !strcmp(operation, "import")) {
    int importing = !strcmp(operation, "import");
    if (argc != (importing ? 10 : 7)) { errno = EINVAL; fail("Invalid copy request"); }
    int source = importing ? dup(4) : scoped_open(3, argv[2], O_RDONLY);
    struct stat info;
    if (fstat(source, &info)) fail("Inspect copy source");
    char identity[100];
    snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
    if (strcmp(identity, argv[4])) { errno = ESTALE; fail("Copy source replaced"); }
    safe_tree(source);
    if (importing) {
      int current = open(argv[9], O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
      struct stat actual;
      if (current < 0 || fstat(current, &actual) || actual.st_dev != root.st_dev || actual.st_ino != root.st_ino) { errno = ESTALE; fail("Import checkout replaced"); }
      close(current);
    }
    if (importing) revalidate_import(argv[7], argv[8], &info);
    else revalidate_source(argv[2], &info);
    char parent_path[PATH_MAX];
    snprintf(parent_path, sizeof(parent_path), "%s", argv[3]);
    char *slash = strrchr(parent_path, '/');
    if (slash) *slash = 0; else strcpy(parent_path, ".");
    int parent = scoped_open(3, parent_path, O_RDONLY | O_DIRECTORY);
    struct stat parent_info;
    if (fstat(parent, &parent_info)) fail("Inspect copy destination parent");
    snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)parent_info.st_dev, (unsigned long long)parent_info.st_ino);
    if (strcmp(identity, argv[6])) { errno = ESTALE; fail("Copy destination parent replaced"); }
    if (importing) import_destination(parent_path, &info);
    free_case_name(argv[3], NULL);
    // Build under an exclusive sibling; failed staging is retained for inspection.
    if (S_ISDIR(info.st_mode) && mkdirat(3, argv[5], 0700)) fail("Stage copy folder");
    int target = scoped_open(3, argv[5], S_ISDIR(info.st_mode) ? O_RDONLY | O_DIRECTORY : O_WRONLY | O_CREAT | O_EXCL);
    struct stat staging_info;
    if (fstat(target, &staging_info)) fail("Inspect open copy staging object");
    // The marker records that staging exists; its pathname never grants identity or cleanup authority.
    printf("staged:%llu:%llu\n", (unsigned long long)staging_info.st_dev, (unsigned long long)staging_info.st_ino);
    if (fflush(stdout)) fail("Report copy staging object");
    copy_tree(source, target);
#ifdef ESCODE_TEST_COPY_STAGE
    // Only the separate staging-race test build pauses before final publication checks.
    char resume;
    if (write(importing ? 5 : 4, "staged", 6) != 6 || read(importing ? 6 : 5, &resume, 1) != 1) {
      errno = EIO; fail("Synchronize copy staging test");
    }
#endif
    if (importing) revalidate_import(argv[7], argv[8], &info);
    else revalidate_source(argv[2], &info);
    if (importing) {
      int current = open(argv[9], O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
      struct stat actual;
      if (current < 0 || fstat(current, &actual) || actual.st_dev != root.st_dev || actual.st_ino != root.st_ino) { errno = ESTALE; fail("Import checkout replaced"); }
      close(current);
    }
    revalidate_source(parent_path, &parent_info);
    if (importing) import_destination(parent_path, &info);
    free_case_name(argv[3], NULL);
    // shortcut: scoped identity checking is not atomic with rename; upgrade if cross-process transactional publication is required.
    revalidate_source(argv[5], &staging_info);
    if (renameatx_np(3, argv[5], 3, argv[3], RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH))
      fail("Publish copy (destination must be free)");
    close(target);
    return 0;
  }

  if (!strcmp(operation, "remove")) {
    if (unlinkat(3, argv[2], AT_SYMLINK_NOFOLLOW_ANY | AT_RESOLVE_BENEATH) && errno != ENOENT)
      fail("Remove temporary file");
    return 0;
  }
  if (argc != 4 || !argv[3][0]) {
    errno = EINVAL;
    fail("Invalid save request");
  }
  if (!strcmp(operation, "stage")) {
    int original = scoped_open(3, argv[2], O_RDONLY);
    struct stat info = regular(original);
    if (info.st_nlink != 1) {
      errno = ENOTSUP;
      fail("Save unavailable: file has hard links");
    }
    int temp = scoped_open(3, argv[3], O_RDWR | O_CREAT | O_EXCL);
    owned_temp = argv[3];
    transfer(STDIN_FILENO, temp);
    if (fcopyfile(original, temp, NULL, COPYFILE_METADATA) ||
        fchmod(temp, info.st_mode & 07777) || fsync(temp) || close(temp))
      fail("Stage file");
    return 0;
  }
  if (!strcmp(operation, "replace")) {
    if (renameatx_np(3, argv[3], 3, argv[2],
                     RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH))
      fail("Replace file");
    return 0;
  }
  errno = EINVAL;
  fail("Unknown filesystem request");
}
