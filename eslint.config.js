// eslint.config.js — the guard for the defect class the test suite CANNOT see.
//
// WHY THIS EXISTS: only pure `-core.js` files are unit-tested. Every file that imports SillyTavern
// (image-gen, card-sync, extra-llm-calls, the UI panels…) is never loaded by vitest, so a broken
// reference in one of them is invisible until it throws in the browser. That is exactly how a
// helper stranded by a refactor shipped to the live install on 2026-07-23: moving the event-pack
// reconciler out of card-sync.js also deleted `findEntry`, which card-sync still used to locate its
// OWN payload entry. 302 green tests, and the card→save sync was dead.
//
// `no-undef` catches that in milliseconds. It is the cheapest insurance in the repo and it matters
// most during exactly the work we keep doing — moving code between files.

import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['node_modules/**', 'dist/**', 'plans/**', 'devdoc/**'] },

    // ── extension source: runs in the SillyTavern page ──────────────────────────
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Provided by the ST page, not imported — declaring them is what lets no-undef
                // stay strict everywhere else instead of being switched off.
                $: 'readonly',            // jQuery, bundled by ST
                jQuery: 'readonly',
                toastr: 'readonly',       // ST's toast library
                SillyTavern: 'readonly',  // ST's public context accessor
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            // THE point of this config.
            'no-undef': 'error',
            // Catches the other half of a botched move: an import left behind after its last use.
            // `_`-prefixed args/vars are the documented opt-out (e.g. `catch (_ignored)`).
            'no-unused-vars': ['error', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                // `const { drop, ...rest } = obj` is the idiomatic omit-a-key pattern — the named
                // binding exists precisely so it is NOT in `rest`. Flagging it would push us to
                // mangle correct code to satisfy the linter.
                ignoreRestSiblings: true,
            }],
            // Style/format is not this tool's job — it only reports things that BREAK at runtime.
            'no-empty': ['error', { allowEmptyCatch: false }],   // aligns with "never hide a caught error"
        },
    },

    // ── build/deploy tooling: Node ──────────────────────────────────────────────
    {
        files: ['tools/**/*.{js,mjs}', 'mytools/**/*.{js,mjs}', '*.config.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-undef': 'error',
            'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
        },
    },

    // ── tests: vitest globals are imported explicitly, but node globals are used ─
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-undef': 'error',
            'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
        },
    },
];
