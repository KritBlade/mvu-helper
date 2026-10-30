// sillytavern/extension-paths.js — where SillyTavern loads this extension from, and the settings
// namespace this extension owns. Two DIFFERENT things, deliberately not one constant.
//
// No imports by design, but this belongs to the HOST layer, not shared/: the folder layout
// (`/scripts/extensions/third-party/<name>`) is SillyTavern's contract, not ours. If ST ever
// changes it, this file is the single place that knows.
//
// THE PATH IS DERIVED, never written down. ST names the install folder after the repo it was
// installed from, and this source ships from two repos — the public `mvu-helper` and the private
// `mvu-helper-dev` — so it must run unedited under either folder name. `import.meta.url` is the
// folder the browser actually loaded us from, so no name can go stale and no release step has to
// remember to change one. (A hardcoded name 404s settings.html, the i18n files AND the logic-engine
// Worker modules on any other folder; the boot dies on the first await with the UI never built.)
// Two guards hold this, because one cannot: tests/extension-paths.test.js locks the derivation
// BELOW against both shipped folder names, and tools/check-derived-paths.mjs refuses a written-down
// path anywhere in src/ — which is where it actually broke, in files this one never sees.
//
// THE NAMESPACE IS PINNED, on purpose. It keys `extension_settings[...]` and tags the console, and
// it is NOT private to this repo: card-carried EJS/RES code and the galgame-companion bundle both
// read `extension_settings['mvu-helper'].debug_domain.<name>` as a literal, and neither can import
// this file. Deriving it from the folder would silence those gates on every install not named
// `mvu-helper`. Both installs therefore share one settings root — by decision (user), not accident.

/** Settings + logging namespace. Read by code OUTSIDE this repo — see above before changing it. */
export const EXTENSION_NAMESPACE = 'mvu-helper';

/**
 * The install folder of the module at `moduleUrl` — two levels up, since this file sits in
 * src/sillytavern/. No trailing slash.
 *
 * Pure, and exported for ONE reason: the constant below is computed at module load from this file's
 * own URL, so a test can only ever see the path it was loaded from — never the two folder names ST
 * actually installs under. Taking the URL as an argument is what makes the rule reachable (L6).
 */
export function extensionFolderPathFrom(moduleUrl) {
    return new URL('../../', moduleUrl).pathname.replace(/\/$/, '');
}

/** Absolute URL path of the install folder, whatever ST named it. No trailing slash. */
export const extensionFolderPath = extensionFolderPathFrom(import.meta.url);
