import {
  IconBook,
  IconBraces,
  IconBrandCpp,
  IconBrandCss3,
  IconBrandDocker,
  IconBrandGit,
  IconBrandGolang,
  IconBrandHtml5,
  IconBrandJavascript,
  IconBrandKotlin,
  IconBrandPython,
  IconBrandReact,
  IconBrandRust,
  IconBrandSass,
  IconBrandSwift,
  IconBrandTypescript,
  IconCoffee,
  IconDatabase,
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileTypePdf,
  IconFileZip,
  IconKey,
  IconLicense,
  IconLock,
  IconMarkdown,
  IconPackage,
  IconPhoto,
  IconSettings,
  IconTable,
  IconTerminal2,
  IconTestPipe,
  IconTool,
  IconTypography,
} from '@tabler/icons-react';

/** Outlined, monochrome icons for kinds of file; `file` is the fallback. */
export const fileIcons = {
  file: IconFile,
  typescript: IconBrandTypescript,
  javascript: IconBrandJavascript,
  react: IconBrandReact,
  test: IconTestPipe,
  json: IconBraces,
  markdown: IconMarkdown,
  readme: IconBook,
  license: IconLicense,
  css: IconBrandCss3,
  sass: IconBrandSass,
  html: IconBrandHtml5,
  image: IconPhoto,
  font: IconTypography,
  config: IconSettings,
  package: IconPackage,
  lock: IconLock,
  env: IconKey,
  docker: IconBrandDocker,
  git: IconBrandGit,
  build: IconTool,
  shell: IconTerminal2,
  python: IconBrandPython,
  rust: IconBrandRust,
  go: IconBrandGolang,
  swift: IconBrandSwift,
  kotlin: IconBrandKotlin,
  java: IconCoffee,
  cpp: IconBrandCpp,
  code: IconFileCode,
  database: IconDatabase,
  table: IconTable,
  text: IconFileText,
  pdf: IconFileTypePdf,
  archive: IconFileZip,
} as const;

export type FileIconName = keyof typeof fileIcons;

const names = new Map<string, FileIconName>([
  ['package.json', 'package'],
  ['go.mod', 'package'],
  ['go.work', 'package'],
  ['package-lock.json', 'lock'],
  ['npm-shrinkwrap.json', 'lock'],
  ['pnpm-lock.yaml', 'lock'],
  ['bun.lockb', 'lock'],
  ['go.sum', 'lock'],
  ['.gitignore', 'git'],
  ['.gitattributes', 'git'],
  ['.gitmodules', 'git'],
  ['.gitkeep', 'git'],
  ['.git-blame-ignore-revs', 'git'],
  ['.dockerignore', 'docker'],
  ['docker-compose.yml', 'docker'],
  ['docker-compose.yaml', 'docker'],
  ['compose.yml', 'docker'],
  ['compose.yaml', 'docker'],
  ['makefile', 'build'],
  ['gnumakefile', 'build'],
  ['.bashrc', 'shell'],
  ['.bash_profile', 'shell'],
  ['.bash_aliases', 'shell'],
  ['.zshrc', 'shell'],
  ['.profile', 'shell'],
  ['.zprofile', 'shell'],
  ['.envrc', 'env'],
  ['.editorconfig', 'config'],
  ['.npmrc', 'config'],
]);
/** `LICENSE`, `COPYING` or `UNLICENSE`, maybe naming its licence (`LICENSE-MIT`, `COPYING.LESSER`) and format. */
const license =
  /^(licen[cs]e|copying|unlicense)(-(mit|apache|bsd|isc|mpl|[al]?gpl|cc0|zlib|epl|eupl|bsl)(-?\d[\d.]*(-clause)?)?|\.lesser)?(\.(md|txt|rst))?$/;
const patterns: [RegExp, FileIconName][] = [
  [/^[jt]sconfig([.-].+)?\.json$/, 'config'],
  [/^readme(\.(md|mdx|txt|rst))?$/, 'readme'],
  [license, 'license'],
  [/^\.env(\..+)?$/, 'env'],
];
const dockerfile = /^(docker|container)file(\.(.+))?$/;
const extensions = new Map<string, FileIconName>([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'react'],
  ['jsx', 'react'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['json5', 'json'],
  ['md', 'markdown'],
  ['mdx', 'markdown'],
  ['markdown', 'markdown'],
  ['css', 'css'],
  ['less', 'css'],
  ['scss', 'sass'],
  ['sass', 'sass'],
  ['html', 'html'],
  ['htm', 'html'],
  ['svg', 'image'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['avif', 'image'],
  ['ico', 'image'],
  ['ttf', 'font'],
  ['otf', 'font'],
  ['woff', 'font'],
  ['woff2', 'font'],
  ['yml', 'config'],
  ['yaml', 'config'],
  ['toml', 'config'],
  ['ini', 'config'],
  ['lock', 'lock'],
  ['env', 'env'],
  ['dockerfile', 'docker'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['fish', 'shell'],
  ['py', 'python'],
  ['rs', 'rust'],
  ['go', 'go'],
  ['swift', 'swift'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['java', 'java'],
  ['c', 'code'],
  ['h', 'code'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['sql', 'database'],
  ['sqlite', 'database'],
  ['db', 'database'],
  ['csv', 'table'],
  ['tsv', 'table'],
  ['txt', 'text'],
  ['log', 'text'],
  ['pdf', 'pdf'],
  ['zip', 'archive'],
  ['tar', 'archive'],
  ['gz', 'archive'],
  ['tgz', 'archive'],
  ['bz2', 'archive'],
  ['xz', 'archive'],
  ['7z', 'archive'],
  ['rar', 'archive'],
]);
/** Script extensions whose `.test` and `.spec` files show as tests. */
const testable = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

/** How a file's icon was chosen: `extension` is set only when its extension, not its name, chose it. */
type FileIconMatch = { icon: FileIconName; extension?: string };

/**
 * The icon for a file named `name` (a base name or a path), ignoring case: a known whole name,
 * such as `package.json` or `Dockerfile`, first, then its last extension; `file` when neither is known.
 */
function matchFileIcon(name: string): FileIconMatch {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  const named = names.get(base) ?? patterns.find(([pattern]) => pattern.test(base))?.[1];
  if (named) return { icon: named };
  // `Dockerfile.dev` is a Dockerfile, but `Dockerfile.md` is Markdown.
  const docker = dockerfile.exec(base);
  if (docker && !extensions.has(docker[3]?.split('.').at(-1) ?? '')) return { icon: 'docker' };
  // A leading dot starts a dotfile's name, not an extension.
  const parts = base.replace(/^\.+/, '').split('.');
  if (parts.length < 2) return { icon: 'file' };
  const extension = parts.at(-1)!;
  const role = parts.length > 2 ? parts.at(-2) : undefined;
  if (testable.has(extension) && (role === 'test' || role === 'spec')) return { icon: 'test' };
  const icon = extensions.get(extension);
  return icon ? { icon, extension } : { icon: 'file' };
}

/** The icon for a file named `name`; see `matchFileIcon`. */
export function findFileIcon(name: string): FileIconName {
  return matchFileIcon(name).icon;
}

/** A short coloured mark standing in for a file's icon, such as TS or MD, and its project hue. */
export type FileTypeMark = {
  label: string;
  hue: 'silver' | 'periwinkle' | 'green' | 'pink' | 'lavender' | 'sand';
};

/**
 * Marks by icon, so extensions sharing an icon share a mark; `variants` gives an extension its own.
 * An icon without a mark, or one chosen by a file's whole name, shows as the icon itself.
 */
const typeMarks = new Map<FileIconName, FileTypeMark & { variants?: Map<string, FileTypeMark> }>([
  ['typescript', { label: 'TS', hue: 'periwinkle' }],
  [
    'react',
    {
      label: 'TSX',
      hue: 'periwinkle',
      variants: new Map([['jsx', { label: 'JSX', hue: 'sand' }]]),
    },
  ],
  ['javascript', { label: 'JS', hue: 'sand' }],
  ['json', { label: '{}', hue: 'sand' }],
  [
    'markdown',
    { label: 'MD', hue: 'silver', variants: new Map([['mdx', { label: 'MDX', hue: 'silver' }]]) },
  ],
  ['css', { label: '#', hue: 'pink' }],
  ['sass', { label: '#', hue: 'pink' }],
  ['html', { label: '<>', hue: 'pink' }],
  ['python', { label: 'PY', hue: 'green' }],
  ['rust', { label: 'RS', hue: 'sand' }],
  ['go', { label: 'GO', hue: 'periwinkle' }],
  ['shell', { label: '$', hue: 'green' }],
  [
    'config',
    {
      label: 'YML',
      hue: 'lavender',
      variants: new Map([
        ['toml', { label: 'TML', hue: 'lavender' }],
        ['ini', { label: 'INI', hue: 'lavender' }],
      ]),
    },
  ],
]);

/** The mark for a file named `name` when its extension chose an icon that has one, else null. */
export function findFileTypeMark(name: string): FileTypeMark | null {
  const { icon, extension } = matchFileIcon(name);
  if (extension === undefined) return null;
  const mark = typeMarks.get(icon);
  if (!mark) return null;
  const { label, hue } = mark.variants?.get(extension) ?? mark;
  return { label, hue };
}
