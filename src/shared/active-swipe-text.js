// shared/active-swipe-text.js — a reply's text exists in TWO places, and both must move together.
//
// `message.mes` is what is rendered and prompted from; `message.swipes[message.swipe_id]` is the
// stored copy ST reads back on swipe navigation and on some re-render paths. A write that moves only
// `mes` looks correct until the player swipes away and back, at which point the stored copy is
// restored and the edit is silently gone — the regenerated picture reverts to the old one, the POST
// receipt disappears, the engine's rendered bars turn back into raw tags.
//
// Owned by no feature: imagegen, small-llm/POST and logic-engine all edit a finished reply, and each
// discovered this rule separately (P3 — three consumers, no single domain owner). One function, so a
// new writer inherits the rule instead of re-learning it from a bug report.
//
// A message with no `swipes` array (a greeting, a user turn) is left alone: there is no second copy
// to keep in step, and inventing one would hand ST a swipe it never created.
export function syncActiveSwipeText(message) {
    if (!message || typeof message.mes !== 'string') return false;
    const swipe = message.swipe_id ?? 0;
    if (!Array.isArray(message.swipes) || typeof message.swipes[swipe] !== 'string') return false;
    message.swipes[swipe] = message.mes;
    return true;
}
