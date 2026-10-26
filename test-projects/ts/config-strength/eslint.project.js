// The project's additions to the generated ESLint base (eslint.config.js).
export default {
  ignores: ['src/skipped.ts'],
  defaultProject: [],
  configs: [{ rules: { complexity: ['error', 30], 'no-console': 'error' } }],
};
