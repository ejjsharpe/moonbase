// Native correctness baseline plus the project's explicit safety and consistency rules.
export const base = {
  plugins: ['typescript', 'unicorn', 'oxc', 'react'],
  categories: { correctness: 'error' },
  env: { builtin: true },
  rules: {
    'react/rules-of-hooks': 'error',
    'eslint/eqeqeq': ['error', 'always', { null: 'ignore' }],
    'eslint/no-fallthrough': 'error',
    'eslint/no-case-declarations': 'error',
    'react/no-unknown-property': 'error',
    'eslint/prefer-const': 'error',
    'eslint/no-var': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/ban-ts-comment': [
      'error',
      {
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-check': false,
        'ts-expect-error': 'allow-with-description',
        minimumDescriptionLength: 10,
      },
    ],
    'typescript/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    'typescript/array-type': ['error', { default: 'array' }],
    'eslint/no-nested-ternary': 'error',
    'unicorn/prefer-node-protocol': 'error',
  },
};

export const node = {
  env: { node: true },
};

export const web = {
  env: { browser: true },
};
