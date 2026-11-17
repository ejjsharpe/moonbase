// Fast pre-push check: typecheck affected projects (cached, catches dependents),
// test only projects whose files changed, lint/format only changed files.
// CI runs dependents' tests, integration suites and Playwright; `bun run check` is the full local check.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = git('merge-base', 'HEAD', 'origin/main');
const changed = [
  ...new Set([
    ...git('diff', '--name-only', '--diff-filter=d', base).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ]),
].filter(Boolean);

if (changed.length === 0) {
  console.log('check:fast: no changes');
  process.exit(0);
}

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Directly changed projects. Root integration suites (test/*) are left to CI.
const projects = new Set();
for (const file of changed) {
  const match = /^(apps|packages)\/([^/]+)\//.exec(file);
  if (!match) continue;
  projects.add(JSON.parse(readFileSync(`${match[1]}/${match[2]}/package.json`, 'utf8')).name);
}

const sourceFiles = changed.filter((file) => /\.(m?[jt]sx?|json)$/.test(file));
const lintable = changed.filter((file) => /\.(m?[jt]sx?)$/.test(file));

run('bunx', ['nx', 'affected', '-t', 'typecheck']);
if (projects.size > 0) {
  run('bunx', ['nx', 'run-many', '-t', 'test', '-p', [...projects].join(',')]);
}
if (changed.some((file) => file.startsWith('scripts/'))) {
  run('node', ['--test', 'scripts/*.test.mjs']);
}
if (lintable.length > 0) run('bunx', ['oxlint', '--report-unused-disable-directives', ...lintable]);
if (sourceFiles.length > 0) run('bunx', ['oxfmt', '--check', ...sourceFiles]);
run('node', ['scripts/check-foundation.mjs']);
