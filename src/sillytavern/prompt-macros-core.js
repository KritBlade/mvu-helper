// sillytavern/prompt-macros-core.js — SillyTavern's macro engine applied to a block of prompt text, PURE: the engine is
// passed in (`subFn`), so a caller chooses SillyTavern's substituteParams (prompt-macros.js) or TavernHelper's full
// decode (small-llm substituteCallMacros). Rules:
//   - requireDelimiter && no `{{` → returned unchanged (nothing to expand). Pass requireDelimiter:false for a decode
//                                   whose regex step is NOT `{{`-gated, so it must always run.
//   - subFn missing               → onMissing(raw), then the text as written (no engine to expand with).
//   - subFn throws                → onError(e, raw), then the text as written (one bad macro never sinks a prompt).
export function substituteMacrosBlock(subFn, text, opts = {}) {
    const src = String(text == null ? '' : text);
    const { onMissing = null, onError = null, requireDelimiter = true } = opts || {};
    if (requireDelimiter && !src.includes('{{')) return src;    // macro-only fast path → nothing to expand
    if (typeof subFn !== 'function') {
        if (typeof onMissing === 'function') onMissing(src);
        return src;
    }
    try {
        const out = subFn(src);
        return out == null ? src : String(out);
    } catch (e) {
        if (typeof onError === 'function') onError(e, src);
        return src;                                             // degrade to the raw block on decode error
    }
}
