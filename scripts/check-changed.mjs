// Runs the fast checks for what this branch changed; CI still runs everything.
//   check-changed [base] [--full] [--integration]
// By default it tests only the packages that own a changed file and typechecks every affected package.
// --full also tests their dependents; --integration also runs both root integration suites.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

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

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const base = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? findBase();
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

const code = changed.filter((file) => !file.endsWith('.md'));
if (code.length === 0) process.exit(0);

// Files every package's checks read.
const shared =
  /^(bun\.lock|nx\.json|tsconfig\.base\.json|oxlint\.config\.mts|oxfmt\.config\.mts|packages\/config\/)/;
// Measured: 4-way parallel ran every suite in ~110s against ~260s serial. nx caches typecheck.
const parallel = '--parallel=4';
if (flags.has('--full') || code.some((file) => shared.test(file))) {
  run('bunx', ['nx', 'affected', '-t', 'typecheck', 'test', `--base=${base}`, parallel]);
} else {
  run('bunx', ['nx', 'affected', '-t', 'typecheck', `--base=${base}`, parallel]);
  const edited = new Set();
  for (const file of code) {
    const folder = file.match(/^(apps|packages)\/[^/]+\//)?.[0];
    if (folder && existsSync(`${folder}package.json`))
      edited.add(JSON.parse(readFileSync(`${folder}package.json`, 'utf8')).name);
  }
  if (edited.size > 0)
    run('bunx', ['nx', 'run-many', '-t', 'test', `--projects=${[...edited].join(',')}`, parallel]);
}

// The root integration suites run a real daemon; locally they run only when edited or asked for.
const integration = flags.has('--integration');
if (integration || code.some((file) => file.startsWith('test/chat/')))
  run('bun', ['run', 'test:chat-integration']);
if (integration || code.some((file) => file.startsWith('test/editor-workspace/')))
  run('bun', ['run', 'test:editor-integration']);
