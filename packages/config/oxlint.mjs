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

/** What a restriction asks for instead. */
const useEffectTime = 'Use Effect time: Clock, Effect.sleep or Schedule.';
const runAtRoot =
  "Run Effects only at a process root; elsewhere return them, or use the root's runner.";
const restrictedGlobals = {
  setTimeout: useEffectTime,
  setInterval: useEffectTime,
  AbortController: 'Use fiber interruption; Effect.tryPromise hands a Promise API its signal.',
};
const restrictedProperties = {
  'Date.now': useEffectTime,
  'performance.now': useEffectTime,
};
const restrictedRuns = [
  'runPromise',
  'runPromiseExit',
  'runPromiseWith',
  'runPromiseExitWith',
  'runFork',
  'runForkWith',
  'runSync',
  'runSyncExit',
  'runSyncWith',
  'runSyncExitWith',
  'runCallback',
  'runCallbackWith',
  'runMain',
  'makeRunMain',
];

/**
 * D15's rules for production code: no timers, clock reads, AbortControllers, `new Promise` or
 * runtime `run*` calls. `allowed` lifts some for an edge file: a global (`'setTimeout'`, with its
 * `globalThis.` and `window.` forms), a property (`'Date.now'`, `'runSync'`), `'new Promise'`, or
 * a run on one object (`'runner.runSync'`).
 */
export function effectNativeRules(allowed = []) {
  const allows = new Set(allowed);
  const onObjects = (property) =>
    allowed.filter((name) => name.endsWith(`.${property}`)).map((name) => name.split('.')[0]);
  const globals = Object.entries(restrictedGlobals).filter(([name]) => !allows.has(name));
  return {
    'promise/avoid-new': allows.has('new Promise') ? 'off' : 'error',
    'no-restricted-globals': ['error', ...globals.map(([name, message]) => ({ name, message }))],
    'no-restricted-properties': [
      'error',
      ...globals.flatMap(([property, message]) =>
        ['globalThis', 'window'].map((object) => ({ object, property, message })),
      ),
      ...Object.entries(restrictedProperties)
        .filter(([name]) => !allows.has(name))
        .map(([name, message]) => {
          const [object, property] = name.split('.');
          return { object, property, message };
        }),
      ...restrictedRuns
        .filter((property) => !allows.has(property))
        .map((property) => {
          const objects = onObjects(property);
          return {
            property,
            message: runAtRoot,
            ...(objects.length ? { allowObjects: objects } : {}),
          };
        }),
    ],
  };
}

/** The Effect-native rules lifted, for test code under `src/`. */
export const effectNativeOff = {
  'promise/avoid-new': 'off',
  'no-restricted-globals': 'off',
  'no-restricted-properties': 'off',
};
