// shared/engine-header.js — what an engine DECLARES about itself, read from source.
//
// Lives in shared/ (P3, second consumer): the GameLogic Pack validator (§3 rule 3) and the source
// gates check the same declarations the logic-engine feature does, so the convention is platform-wide
// rather than logic-engine's own. A feature-to-feature import could not carry it — the logic-engine
// barrel drags host imports (loader/UI), which a pure core must never load, and a deep import into
// another feature's internals is forbidden (P6). logic-engine-core re-exports declaredVersionOf for its
// own callers.
//
// COMPATIBILITY machinery, never vetting: a hostile artifact declares a false constant exactly as
// easily as it stamped a false header. The capability block is the security boundary, not this.

// ── the DECLARED identity, read COLD ─────────────────────────────────────────
// What an engine declares about itself, read from its SOURCE for the one situation the runtime channel
// cannot serve: validating an artifact that is not running yet (an uploaded pack, a pasted engine, the
// tab's view of an installed entry). A LOADED engine answers through the worker's `declared` report;
// these read the same declaration site, so there is no second source of truth — only a second reader,
// for text that has never been evaluated.
//
// NO leading-slice bound, deliberately. A platform cannot dictate where an author writes a line in
// their own file: a community engine may open with a licence block or a long design note and declare
// its identity anywhere (globalLogic's own ENGINE_NAME sits past 5600 bytes). A window would report a
// perfectly well-formed engine as undeclared. The LINE-ANCHORED NAMED declaration is what makes a
// stray match implausible — specificity doing the work position used to stand in for.
const declarationOf = (text, constName) => {
    const m = String(text || '').match(
        new RegExp('^\\s*(?:var|const|let)\\s+' + constName + '\\s*=\\s*[\'"]([^\'"]+)[\'"]', 'm'));
    return m ? m[1] : null;
};

export function declaredVersionOf(text) {
    return declarationOf(text, 'ENGINE_VERSION');
}

export function declaredNameOf(text) {
    return declarationOf(text, 'ENGINE_NAME');
}
