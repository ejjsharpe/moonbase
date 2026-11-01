// `oxlint --init` correctness baseline plus native React checks for this React/Electron monorepo.
export const base = {
  plugins: ['typescript', 'unicorn', 'oxc', 'react'],
  categories: { correctness: 'error' },
  env: { builtin: true },
};

export const node = {
  env: { node: true },
};

export const web = {
  env: { browser: true },
};
