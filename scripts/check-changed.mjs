// Runs the fast checks for what this branch changed; CI still runs everything.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const lines = (output) => output.split('\0').filter(Boolean);
const run = (command, args) => {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const { status } = spawnSync(command, args, { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
};
const findBase = () => {
  for (const ref of ['origin/main', 'main']) {
    try {
      return git('merge-base', ref, 'HEAD').trim();
    } catch {
      // Try the next ref.
    }
  }
  console.error('No origin/main or main to compare with; pass a base ref: check-changed <ref>');
  process.exit(1);
};

const base = process.argv[2] ?? findBase();
const changed = [
  ...lines(git('diff', '-z', '--name-only', '--diff-filter=d', base)),
  ...lines(git('ls-files', '-z', '--others', '--exclude-standard')),
];
if (changed.length === 0) {
  console.log('Nothing changed since', base.slice(0, 8));
  process.exit(0);
}

const source = changed.filter((file) => /\.(c|m)?[jt]sx?$|\.(json|css)$/.test(file));
run('node', ['scripts/check-foundation.mjs']);
if (changed.some((file) => file.startsWith('scripts/')))
  run('node', [
    '--test',
    ...readdirSync('scripts')
      .filter((file) => file.endsWith('.test.mjs'))
      .map((file) => `scripts/${file}`),
  ]);
if (source.length > 0) {
  run('bunx', ['oxfmt', '--check', ...source]);
  run('bunx', ['oxlint', '--report-unused-disable-directives', ...source]);
}
// Measured: 4-way parallel ran every suite in ~110s against ~260s serial. nx caches typecheck.
run('bunx', ['nx', 'affected', '-t', 'typecheck', 'test', `--base=${base}`, '--parallel=4']);
