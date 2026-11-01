import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Universe's default/node/web presets, with formatting delegated to Oxfmt.
export const base = {
  categories: {
    correctness: 'off',
  },
  plugins: ['eslint', 'typescript', 'import', 'node', 'react', 'unicorn'],
  jsPlugins: [
    {
      name: 'import-js',
      specifier: require.resolve('eslint-plugin-import'),
    },
    {
      name: 'react-js',
      specifier: require.resolve('eslint-plugin-react'),
    },
  ],
  env: {
    es2022: true,
    jest: true,
  },
  globals: {
    console: 'readonly',
    exports: 'readonly',
    global: 'readonly',
    module: 'readonly',
    require: 'readonly',
  },
  settings: {
    'import/resolver': {
      node: { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'] },
    },
  },
  rules: {
    'eslint/constructor-super': 'warn',
    'eslint/eqeqeq': ['warn', 'smart'],
    'eslint/getter-return': 'warn',
    'eslint/no-alert': 'off',
    'eslint/no-array-constructor': 'warn',
    'eslint/no-caller': 'warn',
    'eslint/no-case-declarations': 'warn',
    'eslint/no-compare-neg-zero': 'warn',
    'eslint/no-cond-assign': 'warn',
    'eslint/no-const-assign': 'error',
    'eslint/no-constant-condition': [
      'warn',
      {
        checkLoops: false,
      },
    ],
    'eslint/no-control-regex': 'off',
    'eslint/no-debugger': 'warn',
    'eslint/no-delete-var': 'error',
    'eslint/no-dupe-class-members': 'error',
    'eslint/no-dupe-keys': 'error',
    'eslint/no-duplicate-case': 'error',
    'eslint/no-empty-character-class': 'warn',
    'eslint/no-empty-pattern': 'warn',
    'eslint/no-eval': 'warn',
    'eslint/no-ex-assign': 'warn',
    'eslint/no-extend-native': 'warn',
    'eslint/no-extra-bind': 'warn',
    'eslint/no-extra-boolean-cast': 'warn',
    'eslint/no-fallthrough': 'warn',
    'eslint/no-func-assign': 'error',
    'eslint/no-global-assign': 'warn',
    'eslint/no-implied-eval': 'warn',
    'eslint/no-inner-declarations': 'warn',
    'eslint/no-invalid-regexp': 'error',
    'eslint/no-irregular-whitespace': 'warn',
    'eslint/no-iterator': 'warn',
    'eslint/no-label-var': 'warn',
    'eslint/no-labels': [
      'warn',
      {
        allowLoop: true,
        allowSwitch: true,
      },
    ],
    'eslint/no-lone-blocks': 'warn',
    'eslint/no-multi-assign': 'warn',
    'eslint/no-new': 'warn',
    'eslint/no-new-func': 'warn',
    'eslint/no-object-constructor': 'warn',
    'eslint/no-new-native-nonconstructor': 'error',
    'eslint/no-obj-calls': 'warn',
    'eslint/no-proto': 'warn',
    'eslint/no-redeclare': 'warn',
    'eslint/no-return-assign': 'warn',
    'eslint/no-script-url': 'warn',
    'eslint/no-self-assign': 'warn',
    'eslint/no-self-compare': 'warn',
    'eslint/no-sequences': 'warn',
    'eslint/no-shadow-restricted-names': 'warn',
    'eslint/no-sparse-arrays': 'warn',
    'eslint/no-this-before-super': 'warn',
    'eslint/no-throw-literal': 'warn',
    'eslint/no-undef': 'error',
    'eslint/no-unneeded-ternary': 'warn',
    'eslint/no-unreachable': 'warn',
    'eslint/no-unsafe-negation': 'warn',
    'eslint/no-unused-expressions': [
      'warn',
      {
        allowShortCircuit: true,
        enforceForJSX: true,
      },
    ],
    'eslint/no-unused-labels': 'warn',
    'eslint/no-unused-vars': [
      'warn',
      {
        vars: 'all',
        args: 'none',
        ignoreRestSiblings: true,
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'eslint/no-useless-computed-key': 'warn',
    'eslint/no-useless-concat': 'warn',
    'eslint/no-useless-constructor': 'warn',
    'eslint/no-useless-escape': 'warn',
    'eslint/no-useless-rename': 'warn',
    'eslint/no-useless-return': 'warn',
    'eslint/no-var': 'warn',
    'eslint/no-void': 'warn',
    'eslint/no-with': 'warn',
    'eslint/object-shorthand': 'warn',
    'eslint/prefer-const': [
      'warn',
      {
        destructuring: 'all',
        ignoreReadBeforeAssign: true,
      },
    ],
    'eslint/prefer-promise-reject-errors': 'warn',
    'eslint/prefer-rest-params': 'warn',
    'eslint/prefer-spread': 'warn',
    'eslint/radix': 'warn',
    'eslint/unicode-bom': ['warn', 'never'],
    'eslint/use-isnan': 'error',
    'eslint/valid-typeof': 'error',
    'eslint/yoda': [
      'warn',
      'never',
      {
        exceptRange: true,
      },
    ],
    'import/default': 'off',
    'import/no-named-as-default': 'off',
    'import/export': 'error',
    'import/first': 'warn',
    'import/namespace': [
      'error',
      {
        allowComputed: true,
      },
    ],
    'import/no-duplicates': 'error',
    'import-js/order': [
      'warn',
      {
        groups: [['builtin', 'external'], 'internal', ['parent', 'index', 'sibling']],
        'newlines-between': 'always',
        alphabetize: {
          order: 'asc',
        },
      },
    ],
    'node/handle-callback-err': ['warn', '^(e|err|error|.+Error)$'],
    'node/no-new-require': 'warn',
  },
  overrides: [
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      rules: {
        'typescript/array-type': [
          'warn',
          {
            default: 'array',
          },
        ],
        'typescript/no-empty-object-type': [
          'warn',
          {
            allowInterfaces: 'with-single-extends',
          },
        ],
        'typescript/no-wrapper-object-types': 'warn',
        'typescript/consistent-type-assertions': [
          'warn',
          {
            assertionStyle: 'as',
            objectLiteralTypeAssertions: 'allow',
          },
        ],
        'typescript/no-extra-non-null-assertion': 'warn',
        'eslint/no-dupe-class-members': 'warn',
        'eslint/no-redeclare': 'warn',
        'eslint/no-unused-expressions': [
          'warn',
          {
            allowShortCircuit: true,
            enforceForJSX: true,
          },
        ],
        'eslint/no-unused-vars': [
          'warn',
          {
            vars: 'all',
            args: 'none',
            ignoreRestSiblings: true,
            caughtErrors: 'all',
          },
        ],
        'eslint/no-useless-constructor': 'warn',
        'eslint/no-undef': 'off',
        'import/no-named-as-default': 'off',
      },
    },
    {
      files: ['**/*.d.{ts,mts,cts}'],
      rules: {
        'import-js/order': 'off',
      },
    },
  ],
};

export const node = {
  env: {
    node: true,
  },
  rules: {
    'unicorn/no-new-buffer': 'warn',
    'node/no-path-concat': 'warn',
  },
};

export const web = {
  env: {
    browser: true,
    commonjs: true,
  },
  rules: {
    'react/jsx-boolean-value': ['warn', 'never'],
    'react/jsx-curly-brace-presence': ['warn', 'never'],
    'react/jsx-fragments': ['warn', 'syntax'],
    'react-js/jsx-no-bind': [
      'warn',
      {
        allowArrowFunctions: true,
        allowFunctions: true,
      },
    ],
    'react/jsx-no-duplicate-props': 'error',
    'react/jsx-no-undef': 'error',
    'react-js/no-access-state-in-setstate': 'warn',
    'react/no-did-mount-set-state': 'warn',
    'react/no-did-update-set-state': 'warn',
    'react/no-direct-mutation-state': 'warn',
    'react/no-redundant-should-component-update': 'warn',
    'react/no-this-in-sfc': 'warn',
    'react/no-unknown-property': 'warn',
    'react/no-will-update-set-state': 'warn',
    'react/require-render-return': 'warn',
    'react/self-closing-comp': 'warn',
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'off',
  },
};
