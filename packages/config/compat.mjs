import { builtinRules } from 'eslint/use-at-your-own-risk';

// Preserve checks missing from native rules, including Buffer() without `new` and sloppy CommonJS.
export default {
  meta: { name: 'universe-compat' },
  rules: {
    'no-buffer-constructor': builtinRules.get('no-buffer-constructor'),
    'no-dupe-args': builtinRules.get('no-dupe-args'),
    'no-octal': builtinRules.get('no-octal'),
    'no-octal-escape': builtinRules.get('no-octal-escape'),
  },
};
