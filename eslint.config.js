import js from '@eslint/js';
import json from '@eslint/json';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'package-lock.json'] },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    files: ['**/*.json'],
    language: 'json/json',
    ...json.configs.recommended,
  },
];
