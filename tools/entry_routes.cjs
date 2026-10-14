/* ============================================================================
 * entry_routes.cjs — WHICH render pass each entry's EJS is compiled in. v0.1
 *
 * ST-Prompt-Template joins every entry rendered in ONE pass into ONE EJS scope, so two top-level
 * `let`/`const` of the same name collide only when their entries share a pass. The passes are the
 * narrator and each LLM call (PRE, POST, ...). The route is read from the entry's own sidecar:
 *
 *   GameLogic Pack entry   the call tag at the start of its comment: "[PRE] Reply_Request" -> PRE.
 *                          MVU Helper routes by that tag whether the entry is enabled or not.
 *   plugin entry           {PRE_CALL} / {POST_CALL} in its comment -> PRE / POST. That assumes the
 *                          player binds it to the game's own call, the usual case. Bound to a call of
 *                          its own, it never meets the game's entries, so a clash reported here is a
 *                          false alarm, never a miss.
 *   no call tag            the narrator, when SillyTavern sends it: enabled, and constant or with
 *                          keys. A disabled entry with no tag is rendered by nobody: no pass.
 * ========================================================================== */

// A tag that more than one call reads. Add your card's shared group tags here, like
// { llmshare: ['PRE', 'POST'] } for one tag both the PRE and the POST call pick up.
const GROUP_TAGS = {};

function passesFor(entry) {
    if (!entry) return [];
    const comment = String(entry.comment || '');
    if (comment.includes('{PRE_CALL}')) return ['PRE'];
    if (comment.includes('{POST_CALL}')) return ['POST'];
    const tag = /^\s*\[([A-Za-z0-9_-]+)\]/.exec(comment);
    if (tag) {
        const group = Object.keys(GROUP_TAGS).find((name) => name.toLowerCase() === tag[1].toLowerCase());
        return group ? GROUP_TAGS[group] : [tag[1].toUpperCase()];
    }
    const keys = [].concat(entry.keys || entry.key || []);
    const isSentToNarrator = entry.enabled !== false && (entry.type === 'constant' || keys.length > 0);
    return isSentToNarrator ? ['narrate'] : [];
}

module.exports = { GROUP_TAGS, passesFor };
