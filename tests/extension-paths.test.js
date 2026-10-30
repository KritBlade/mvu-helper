/**
 * MVU Helper — install path and settings namespace (sillytavern/extension-paths.js).
 *
 * THE RULE THIS LOCKS: one source, two repos. The public `mvu-helper` and the private
 * `mvu-helper-dev` install into folders of their own names, and SillyTavern loads the extension from
 * whichever one it finds. So the PATH must be derived from the URL the browser loaded us from, while
 * the NAMESPACE must stay pinned — card-carried EJS/RES code and the galgame-companion bundle read
 * `extension_settings['mvu-helper']` as a literal and cannot import this file.
 *
 * The module imports nothing, so it loads under vitest unchanged.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { extensionFolderPathFrom, EXTENSION_NAMESPACE, extensionFolderPath } from '../src/sillytavern/extension-paths.js';

// The real shape: ST serves third-party extensions from /scripts/extensions/third-party/<folder>/,
// and this module sits at src/sillytavern/ inside it.
const moduleUrlIn = (folder) => `http://127.0.0.1:8000/scripts/extensions/third-party/${folder}/src/sillytavern/extension-paths.js`;

describe('the install path is derived, never written down', () => {
    it('resolves the folder under the PUBLIC repo name', () => {
        expect(extensionFolderPathFrom(moduleUrlIn('mvu-helper')))
            .toBe('/scripts/extensions/third-party/mvu-helper');
    });

    it('resolves the folder under the PRIVATE dev repo name', () => {
        expect(extensionFolderPathFrom(moduleUrlIn('mvu-helper-dev')))
            .toBe('/scripts/extensions/third-party/mvu-helper-dev');
    });

    it('MUTATION TARGET — the two names give DIFFERENT paths', () => {
        // Without this, a function that ignores its argument and returns the public path outright
        // passes the first test and proves nothing. This is the assertion a hardcoded name fails.
        expect(extensionFolderPathFrom(moduleUrlIn('mvu-helper')))
            .not.toBe(extensionFolderPathFrom(moduleUrlIn('mvu-helper-dev')));
    });

    it('MUTATION TARGET — it lands on the install folder, not src/ and not third-party/', () => {
        // The `../../` count is the whole derivation. One too few leaves us inside src/, so every
        // fetch resolves a level deep; one too many hands out third-party/, so every fetch escapes
        // into a sibling extension. Both 404 at boot, which is the failure this file exists to stop.
        const derived = extensionFolderPathFrom(moduleUrlIn('mvu-helper'));
        expect(derived.endsWith('/src')).toBe(false);
        expect(derived.endsWith('/sillytavern')).toBe(false);
        expect(derived.endsWith('/third-party')).toBe(false);
    });

    it('carries no trailing slash, so callers can append "/i18n/<lang>.json" directly', () => {
        expect(extensionFolderPathFrom(moduleUrlIn('mvu-helper')).endsWith('/')).toBe(false);
        // The boundary, recorded rather than supported: `../../` counts from the base's DIRECTORY,
        // and a trailing slash is one — so a directory-form URL lands a level higher than a file URL
        // in the same place. The only caller feeds import.meta.url, which always names a file.
        expect(extensionFolderPathFrom('http://h/a/b/c/src/sillytavern/')).toBe('/a/b/c');
    });

    it('the live constant is built by the same function, not separately', () => {
        // Guards the seam: the export below the function could drift back to its own inline
        // expression, and then the tests above would be locking a rule nothing uses.
        expect(extensionFolderPath).toBe(extensionFolderPathFrom(import.meta.url.replace('/tests/extension-paths.test.js', '/src/sillytavern/extension-paths.js')));
    });
});

describe('the settings namespace is pinned, not derived', () => {
    it('MUTATION TARGET — it is the literal outside code reads, whatever folder we are in', () => {
        // Deriving this from the folder would silence every `debug_domain` gate in card EJS and in
        // galgame-companion on any install not named `mvu-helper`. Both installs share one settings
        // root by decision (user, 2026-09-22), not by accident.
        expect(EXTENSION_NAMESPACE).toBe('mvu-helper');
    });

    it('MUTATION TARGET — namespace and folder path are NOT the same value', () => {
        // The one mistake that reads as a tidy-up: collapsing the two into one constant. It works on
        // the public install and breaks the dev one in whichever direction it is collapsed.
        expect(EXTENSION_NAMESPACE).not.toBe(extensionFolderPathFrom(moduleUrlIn('mvu-helper')));
    });
});
