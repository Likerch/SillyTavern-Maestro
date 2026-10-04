import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import globals from 'globals';

// Layer boundaries (docs/ARCHITECTURE.md): domain is pure; host is the only door to SillyTavern;
// core holds services; adapters talk to neighbour extensions; ui is generic; features compose;
// app wires everything together.
const zones = [
    {
        target: './src/shared',
        from: ['./src/domain', './src/host', './src/core', './src/adapters', './src/features', './src/ui', './src/app'],
        message: 'shared holds contracts and constants only and imports nothing from other layers.',
    },
    {
        target: './src/domain',
        from: ['./src/host', './src/core', './src/adapters', './src/features', './src/ui', './src/app'],
        message: 'domain must stay pure: no DOM, network or SillyTavern.',
    },
    {
        target: './src/host',
        from: ['./src/core', './src/adapters', './src/features', './src/ui', './src/app'],
        message: 'host only wraps SillyTavern and knows nothing above it.',
    },
    {
        target: './src/core',
        from: ['./src/adapters', './src/features', './src/ui', './src/app'],
        message: 'core services must not depend on adapters, features, ui or app.',
    },
    {
        target: './src/adapters',
        from: ['./src/features', './src/ui', './src/app'],
        message: 'adapters wrap neighbour extensions and must not depend on features, ui or app.',
    },
    {
        target: './src/ui',
        from: ['./src/adapters', './src/features', './src/app'],
        message: 'ui components are generic; features build views from them.',
    },
    {
        target: './src/features',
        from: ['./src/app'],
        message: 'features receive the App through init(); never import app/.',
    },
];

// User-visible strings must go through t(): flag literals passed straight into the DOM or toasts.
const hardcodedUiStrings = [
    {
        selector:
            "AssignmentExpression[left.property.name=/^(textContent|innerText|title|placeholder)$/][right.type='Literal'][right.value=/[A-Za-z\u0400-\u04FF]/]",
        message: 'User-visible text must come from t().',
    },
    {
        selector: "CallExpression[callee.object.name='toastr'] > Literal[value=/[A-Za-z\u0400-\u04FF]/]",
        message: 'Toast text must come from t().',
    },
];

export default tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'docs/**', 'tools/stand/runtime/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        plugins: { 'import-x': importX },
        languageOptions: { globals: { ...globals.browser } },
        settings: {
            'import-x/resolver-next': [createTypeScriptImportResolver({ project: './tsconfig.json' })],
        },
        rules: {
            'import-x/no-restricted-paths': ['error', { zones }],
            'no-restricted-syntax': ['error', ...hardcodedUiStrings],
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['src/domain/**/*.ts'],
        rules: {
            'no-restricted-globals': [
                'error',
                { name: 'fetch', message: 'domain has no network access.' },
                { name: 'document', message: 'domain has no DOM access.' },
                { name: 'window', message: 'domain has no DOM access.' },
                { name: 'localStorage', message: 'domain has no storage access.' },
                { name: 'SillyTavern', message: 'domain must not know SillyTavern.' },
                { name: 'toastr', message: 'domain has no UI.' },
                { name: 'console', message: 'domain reports warnings instead of logging.' },
            ],
        },
    },
    {
        files: ['tools/**/*.mjs', '*.config.ts', 'eslint.config.js'],
        languageOptions: { globals: { ...globals.node } },
    },
    {
        files: ['tests/**/*.ts'],
        languageOptions: { globals: { ...globals.node } },
        rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
);
