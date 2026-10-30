// imagegen/image-splice-core.js — PURE message-text surgery for the draw pass and the registration's
// stray-closer write-back.
// No ST imports, no globals (unit-tested in tests/image-splice-core.test.js).
//
// WHY: image generation is async, and the message object is mutated by OTHER passes on the same reply
// while we await /sd (MVU's write-back, the stray-closer removal). Any edit landing before a `<pic>`
// shifts every offset captured at detection time. Splicing at a stale offset inserts the finished image
// somewhere else in the prose, deletes an equal number of unrelated characters, and leaves the real
// `<pic>` behind for the leftover sweep to delete — an image that never reaches the message, no `<img>`,
// no regen control, and (downstream) no `<background scene>` tags for the galgame beat-shaper.
//
// RULE: never persist a string offset across an await. Re-anchor on the tag text itself.

/**
 * Replace the FIRST occurrence of `rawTag` in `mes` that sits outside the narrator's thinking
 * (reasoningSpans) with `replacement`. Re-anchors by search, so it is immune to edits made since the tag
 * was detected; a copy inside a thinking block is never the anchor.
 * @returns {{text: string, spliced: boolean}} spliced=false ⇒ anchor gone, text returned unchanged.
 */
export function spliceTagIntoMessage(mes, rawTag, replacement) {
    const text = String(mes || '');
    const needle = String(rawTag || '');
    if (!needle) return { text, spliced: false };
    const at = indexOutsideReasoning(text, needle);
    if (at === -1) return { text, spliced: false };
    return { text: text.slice(0, at) + replacement + text.slice(at + needle.length), spliced: true };
}

// ── the narrator's thinking is never the reply ───────────────────────────────
// A narrator that thinks in the reply text drafts its <pic> there, often word for word the tag it then
// writes in the prose. A draft is not a picture: counted, it takes a place under the per-reply cap, and as
// the first occurrence of an identical tag it took the splice, so the finished image went INTO the
// thinking — which ST's reasoning parse or galgame-companion's beat-shaper then moves out of the reply, the
// image with it (staging msg 442, 2026-10-20). So a <pic> inside <think>, <thinking> or <thinking_*> is never
// detected, drawn, counted, swept or spliced (the user's ruling, 2026-10-20).
//   • a closed block masks from its open through its close;
//   • a close with no open masks everything before it, back to the previous block: its open came before
//     the text (a prefill, or a reasoning field that took it);
//   • an open never closed masks the rest of the text only while the reply is still arriving — while a
//     reply streams its thinking simply has not ended yet. In a finished reply it masks nothing, because
//     nothing says where it ends, and a tag after it may be the prose's own.
// A nested open inside an open block is part of that block; any close ends it.
const REASONING_TAG_RE = /<(\/?)(?:think|thinking(?:_[a-z0-9]+)*)(?:\s[^<>]*)?>/gi;

/**
 * Where the narrator's thinking sits in `text`, as [start, end) character ranges in text order.
 * @param {string} text
 * @param {{isTextComplete?: boolean}} [opts] false while the reply is still streaming in
 * @returns {Array<{start: number, end: number}>}
 */
export function reasoningSpans(text, { isTextComplete = true } = {}) {
    const source = String(text || '');
    const spans = [];
    let openAt = -1;
    let previousEnd = 0;
    for (const match of source.matchAll(REASONING_TAG_RE)) {
        if (match[1] !== '/') {
            if (openAt === -1) openAt = match.index;
            continue;
        }
        const end = match.index + match[0].length;
        spans.push({ start: openAt === -1 ? previousEnd : openAt, end });
        previousEnd = end;
        openAt = -1;
    }
    if (openAt !== -1 && !isTextComplete) spans.push({ start: openAt, end: source.length });
    return spans;
}

/** Is character `index` inside one of `spans` (reasoningSpans)? */
export function isInsideReasoning(spans, index) {
    return (Array.isArray(spans) ? spans : []).some((span) => index >= span.start && index < span.end);
}

/**
 * Split detected tags (`{ index }` into `text`) into those in the reply and those inside the narrator's
 * thinking.
 * @param {string} text the text the indexes point into
 * @param {Array<{index: number}>} tags
 * @param {{isTextComplete?: boolean}} [opts] as reasoningSpans
 * @returns {{outside: Array, inside: Array}}
 */
export function partitionByReasoning(text, tags, { isTextComplete = true } = {}) {
    const spans = reasoningSpans(text, { isTextComplete });
    const outside = [];
    const inside = [];
    for (const tag of (Array.isArray(tags) ? tags : [])) (isInsideReasoning(spans, tag.index) ? inside : outside).push(tag);
    return { outside, inside };
}

// The first occurrence of `needle` in `text` outside the narrator's thinking, or -1.
function indexOutsideReasoning(text, needle) {
    const spans = reasoningSpans(text);
    let at = text.indexOf(needle);
    while (at !== -1 && isInsideReasoning(spans, at)) at = text.indexOf(needle, at + 1);
    return at;
}

// One rendered image wrap, as built by the REPLACE splice above: the auto-img-wrap span carrying the
// original <pic> tag HTML-escaped in data-rawtag, the <img>, and the regen-button span. Non-greedy to
// the wrap's own `</span></span>` close; tolerant of attribute additions inside (title/alt/style).
const RENDERED_WRAP_RE = /<span class="auto-img-wrap" data-rawtag="([^"]*)">[\s\S]*?<\/span>\s*<\/span>/g;

// The strip-OFF debug line: the tag kept VISIBLE as escaped text (in the wrap under the image, or
// standalone where the sweep found a failed/over-cap tag). Escaped so galgame's raw-<pic> detection
// can't trip on it in message.mes.
const DEBUG_PICTAG_RE = /<code class="auto-img-pictag"[^>]*>([\s\S]*?)<\/code>/g;

// The strip-OFF sweep keeps a failed / over-cap `<pic>` tag VISIBLE as escaped text. Every consumer
// recognises our image machinery by the `auto-img-wrap` span — ours at RENDERED_WRAP_RE above,
// galgame-companion's beat-shaper by the same shape — so a BARE `<code class="auto-img-pictag">` would be
// invisible to all of them, treated as ordinary prose and wrapped in a `<p>`, where a `display:block`
// element corrupts that consumer's display. The escaping keeps the consumer's <pic> DETECTION from
// tripping; the wrapper keeps its PROSE handling from touching it. Both couplings matter.
//
// So a leftover carries the SAME envelope as a rendered image: `auto-img-wrap` + `data-rawtag`, and
// an inner span so the wrap closes with the `</span></span>` both regexes are written against. Nothing
// downstream needs to learn a second class name. It deliberately does NOT get the regen affordance —
// that handler places its result into an `<img>` this wrap has never had.
//
// Note this also makes a leftover match RENDERED_WRAP_RE, so the revert below now recovers it from
// data-rawtag rather than from the DEBUG_PICTAG_RE pass. Same output, one path instead of two.
export function buildUnrenderedTagWrap(escapedTag) {
    const esc = String(escapedTag == null ? '' : escapedTag);
    return `<span class="auto-img-wrap" data-rawtag="${esc}">`
        + `<code class="auto-img-pictag" style="display:block;font-size:0.75em;opacity:0.65;overflow-wrap:anywhere;">${esc}</code>`
        + '<span class="auto-img-unrendered" title="This pic tag was not rendered (generation failed, or it was over the per-reply image cap)"></span>'
        + '</span>';
}

// A <pic> a pass takes out of the reply — drawn into an inline image or a message of its own, written under
// Insert Type "Tags only", or left over in Replace mode — leaves this INVISIBLE trace where it stood: the
// placeholder's auto-img-wrap envelope carrying the tag in data-rawtag, with nothing visible inside. So the
// reply keeps the record of whom it drew in what clothes, which the worn-outfit store and a regenerate read, the
// same in every insert mode; the revert below shows the narrator its tag again; and every
// consumer treats the trace as image machinery holding no image (galgame's <p>-wrap guard yes, its image census
// no). It is not a raw <pic>, so nothing waits on it.
export function buildTagTraceWrap(escapedTag) {
    return `<span class="auto-img-wrap" data-rawtag="${String(escapedTag == null ? '' : escapedTag)}"><span class="auto-img-trace"></span></span>`;
}

// One rendered image, as the REPLACE splice writes it into message.mes. The resolved /sd prompt is
// stored ONCE, in `title` (the hover tooltip, and the regenerate fallback for an image written before
// data-rawtag existed); `alt` carries a fixed label, since a second copy of the prompt is ~1000
// characters of dead weight in every message that holds an image. Every argument arrives HTML-escaped;
// `debugTagLine` is the strip-OFF escaped tag, '' when the tag is stripped.
export function buildRenderedImageWrap({ escapedRawTag = '', escapedUrl = '', escapedPrompt = '', debugTagLine = '' } = {}) {
    return `<span class="auto-img-wrap" data-rawtag="${escapedRawTag}"><img src="${escapedUrl}" title="${escapedPrompt}" alt="generated image">${debugTagLine}`
        + '<span class="auto-img-regen fa-solid fa-arrows-rotate" title="Regenerate image" role="button" tabindex="0" style="cursor:pointer;margin-inline-start:6px;opacity:0.7;"></span></span>';
}

/**
 * Swap every rendered image wrap — a placeholder or a trace too — back to its original `<pic …>` tag
 * (recovered from data-rawtag), and every strip-OFF escaped debug line back to its raw tag. For the
 * OUTGOING PROMPT and for reading which pictures a reply drew — never write this back to message.mes.
 *
 * WHY: the narrate model sees its PAST replies with our rendered `<span class="auto-img-wrap"…><img
 * src="…">` HTML where its `<pic>` tags were — so instead of following the <image_generation> contract
 * it MIMICS the rendered HTML, fabricating plausible-looking
 * image filenames (404s) and complete wrap markup, and no real <pic> is ever emitted. Reverting the
 * wraps in context shows the model its own CORRECT <pic> examples instead of the mimic bait. The
 * escaped debug lines revert for the same reason — the model must never learn to emit &lt;pic…&gt;.
 *
 * @param {(escaped: string) => string} unescapeAttr shared/html-escape unescapeHtmlAttribute (injected
 *   so this file stays dependency-free / unit-testable).
 * @returns {{text: string, reverted: number}} reverted = total swaps (0 ⇒ text returned unchanged).
 */
export function revertRenderedImagesToPicTags(text, unescapeAttr) {
    let reverted = 0;
    // Wraps first — each swallows its own inner debug line (it sits before the regen span), so the
    // standalone pass below only ever sees the sweep-kept leftovers.
    let out = String(text || '').replace(RENDERED_WRAP_RE, (whole, escapedRawTag) => {
        const rawTag = unescapeAttr(escapedRawTag);
        if (!rawTag || !/^<pic\b/.test(rawTag)) return whole;   // foreign/fabricated wrap without a usable tag — leave it
        reverted++;
        return rawTag;
    });
    out = out.replace(DEBUG_PICTAG_RE, (whole, escapedTag) => {
        const rawTag = unescapeAttr(escapedTag);
        if (!rawTag || !/^<pic\b/.test(rawTag)) return whole;
        reverted++;
        return rawTag;
    });
    return { text: reverted ? out : String(text || ''), reverted };
}

// A raw <pic> picture tag, read the way DEFAULT_REGEX reads one: it carries prompt=, so the bare word "<pic>" in an
// instruction is never taken for one.
const RAW_PICTURE_TAG_RE = /<pic\b(?:"[^"]*"|[^"<])*?\bprompt\s*=\s*"[^"]*"[^<>]*>/gi;

/**
 * Every past picture taken out of a text: each rendered image, trace, placeholder and kept debug line (markup only
 * this extension writes), and, with `removesRawTags`, each raw <pic> tag. For the OUTGOING PROMPT of a narrator that
 * writes no pictures (a POST call writes them): a picture in its history invites one. Raw tags are removed only from
 * a past reply's own text, so an instruction that shows a tag as an example is never cut. Never written back to
 * message.mes.
 * @returns {{text: string, removed: number}} removed = pictures taken out (0 ⇒ text returned unchanged).
 */
export function removePastPictures(text, { removesRawTags = false } = {}) {
    let removed = 0;
    const drop = () => { removed++; return ''; };
    let out = String(text || '').replace(RENDERED_WRAP_RE, drop).replace(DEBUG_PICTAG_RE, drop);
    if (removesRawTags) out = out.replace(RAW_PICTURE_TAG_RE, drop);
    return { text: removed ? out : String(text || ''), removed };
}

// The <img> src inside one wrap. Non-greedy attribute scan, first <img> only: a wrap holds exactly one.
const WRAP_IMG_SRC_RE = /(<img\b[^>]*\bsrc\s*=\s*")([^"]*)(")/;

/**
 * Point the regenerate button's result at the wrap it was clicked on. The old swap replaced the first
 * `src="<old>"` in the whole message, so two images sharing a URL (a repeated beat, a cached
 * generation) swapped the WRONG one — invisible until the player scrolled up. Identity, in order:
 * the wrap's own data-rawtag when exactly one wrap carries it, else the clicked wrap's ORDINAL among
 * all wraps (DOM order is text order — an unrendered leftover wrap or a trace counts in both). Ambiguous means
 * REFUSED, never a guess: the generated file is on disk and a wrong swap is silent corruption.
 *
 * @param {string} text
 * @param {{rawTag?: string, ordinal?: number, newSrcEscaped?: string}} opts rawTag = the ESCAPED form,
 *   as it appears in data-rawtag (the caller escapes what it read from the DOM).
 * @returns {{ok: boolean, text: string, reason: string, matchedBy?: string, wrapBefore?: string, wrapAfter?: string}}
 *   on a swap, wrapBefore = the clicked wrap as the text held it, wrapAfter = that wrap with the new picture
 *   (what the lost-image record follows: recordsAfterImageSwap).
 */
export function planImageSrcSwap(text, { rawTag = '', ordinal = -1, newSrcEscaped = '' } = {}) {
    const src = String(text == null ? '' : text);
    const scan = new RegExp(RENDERED_WRAP_RE.source, RENDERED_WRAP_RE.flags);
    const wraps = [];
    let m;
    while ((m = scan.exec(src)) !== null) wraps.push({ at: m.index, body: m[0], rawTag: m[1] });
    if (!wraps.length) return { ok: false, text: src, reason: 'no-wraps' };
    const want = String(rawTag || '');
    const byTag = want ? wraps.filter((w) => w.rawTag === want) : [];
    const inRange = Number.isInteger(ordinal) && ordinal >= 0 && ordinal < wraps.length;
    const target = byTag.length === 1 ? byTag[0] : (inRange ? wraps[ordinal] : null);
    if (!target) return { ok: false, text: src, reason: byTag.length > 1 ? 'ambiguous' : 'not-found' };
    if (!WRAP_IMG_SRC_RE.test(target.body)) return { ok: false, text: src, reason: 'no-image-in-wrap' };
    // Function replacement: `newSrcEscaped` is a generated path and must never be read as $-syntax.
    const body = target.body.replace(WRAP_IMG_SRC_RE, (_all, open, _old, close) => open + String(newSrcEscaped || '') + close);
    return {
        ok: true,
        text: src.slice(0, target.at) + body + src.slice(target.at + target.body.length),
        reason: 'swapped',
        matchedBy: byTag.length === 1 ? 'rawtag' : 'ordinal',
        wrapBefore: target.body,
        wrapAfter: body,
    };
}

// ── WHAT A DETECTED TAG IS FOR ───────────────────────────────────────────────────────────────────
// Two questions, two lists: a `<pic … prompt="">` cannot be DRAWN (there is no prompt to draw from),
// but it must still be DISPOSED of — one raw `<pic>` left in the finalized reply holds
// galgame-companion's backdrop binding forever. One filtered list answering both would let the
// narrower answer silently become the wider one.
// DRAWABLE = carries a prompt. DISPOSABLE = is a tag at all. Every tag the scanner accepted is
// disposable; only some are drawable. Callers take the one they mean.
export function partitionDetectedTags(scanned) {
    const list = Array.isArray(scanned) ? scanned : [];
    return {
        drawable: list.filter((t) => t && String(t.prompt == null ? '' : t.prompt).trim()),
        disposable: list.map((t) => (t && t.rawTag) || '').filter(Boolean),
    };
}

// ── PINPOINT REMOVAL ──────────────────────────────────────────────────────────────────────────────
// Every write in this lane that DELETES text follows the rule the splice above lives by: act on the
// exact tag string, first occurrence, re-anchored per removal — and tidy ONLY the blank-line run the
// removal leaves at that one join. A whole-message tidy would rewrite blank-line runs inside another
// extension's block, a <pre> or ASCII art, and a re-scan with the user-editable detection regex would
// delete tags this pass never attempted, a third party's <img prompt=…>, or with a stale unbounded
// regex a span of real prose. Nothing scans the finished message, nothing trims it, and a string that is not in the list is
// not touched no matter what it looks like. That is the whole guarantee: this extension cannot rewrite
// another extension's or a preset's <tag> by mistake, because it never looks for one.

// Tidy the join a removal leaves at `left | right`: collapse ONLY the blank-line run that now spans the
// join (a tag on its own line meets as `\n\n` + `\n\n`), and drop the run entirely when the join is at
// the very start or end of the text — the two places the old whole-message trim did something a
// reader would notice. Inline whitespace (a tag mid-sentence) is left exactly as it falls.
function joinAfterRemoval(left, right) {
    const leftWs = /\s*$/.exec(left)[0];
    const rightWs = /^\s*/.exec(right)[0];
    const leftBody = left.slice(0, left.length - leftWs.length);
    const rightBody = right.slice(rightWs.length);
    if (!leftBody) return rightBody;
    if (!rightBody) return leftBody;
    return leftBody + (leftWs + rightWs).replace(/\n{3,}/g, '\n\n') + rightBody;
}

/**
 * Replace each of `rawTags` in `text` with its invisible trace (buildTagTraceWrap) — EXACT string, first
 * occurrence, re-anchored per tag like removeTagsPinpoint below. The trace takes the tag's place, so there is
 * no blank-line join to tidy.
 * @param {string} text
 * @param {string[]} rawTags
 * @param {(s: string) => string} escapeAttr shared/html-escape escapeHtmlAttribute (injected so this file
 *   stays dependency-free).
 * @returns {{text: string, traced: string[], missing: string[]}} missing = not found, left alone.
 */
export function replaceTagsWithTraces(text, rawTags, escapeAttr) {
    let out = String(text || '');
    const traced = [];
    const missing = [];
    for (const raw of (Array.isArray(rawTags) ? rawTags : [])) {
        const needle = String(raw || '');
        const r = spliceTagIntoMessage(out, needle, buildTagTraceWrap(escapeAttr(needle)));
        out = r.text;
        (r.spliced ? traced : missing).push(needle);
    }
    return { text: out, traced, missing };
}

/**
 * Remove each of `rawTags` from `text` — EXACT string, first occurrence, re-anchored per removal so
 * duplicates resolve left-to-right and an edit made since detection cannot move the cut. The blank
 * lines each removal leaves behind are tidied at that join only (joinAfterRemoval).
 * @param {string} text
 * @param {string[]} rawTags
 * @returns {{text: string, removed: string[], missing: string[]}} missing = not found, left alone.
 */
export function removeTagsPinpoint(text, rawTags) {
    let out = String(text || '');
    const removed = [];
    const missing = [];
    for (const raw of (Array.isArray(rawTags) ? rawTags : [])) {
        const needle = String(raw || '');
        const at = needle ? out.indexOf(needle) : -1;
        if (at === -1) { missing.push(needle); continue; }
        out = joinAfterRemoval(out.slice(0, at), out.slice(at + needle.length));
        removed.push(needle);
    }
    return { text: out, removed, missing };
}

// The one tag shape the leftover disposition acts on. The DEFAULT detection regex matches nothing
// else, but the regex is a user-editable setting, so an install that added an <img> alias still hands
// <img> matches to this list. One of those is not ours
// to remove — it may be a preset's or the prose's own element, and nothing downstream is held back by
// it (galgame-companion's beat-shaper gates on `/<pic\b/` alone).
const LEFTOVER_PIC_RE = /^<pic\b/i;

/**
 * REPLACE-mode disposition of the <pic> tags a draw pass did NOT consume (over the per-reply cap, or
 * generation failed): each becomes the unrendered placeholder wrap (`keepVisible`, strip OFF) or its
 * invisible trace (strip ON) — by exact string, from the list the pass detected at its start. A finalized
 * reply must carry ZERO raw <pic>: the galgame beat-shaper holds its backdrop binding while one
 * remains.
 *
 * @param {string} text
 * @param {string[]} leftoverTags raw tag strings detected at pass start, minus the ones consumed
 * @param {{keepVisible?: boolean, escapeAttr: (s: string) => string}} opts escapeAttr =
 *   shared/html-escape escapeHtmlAttribute (injected so this file stays dependency-free).
 * @returns {{text: string, swept: string[], missing: string[], skipped: string[]}} skipped = listed
 *   tags that are not <pic> (the <img> alias), reported and left exactly as written.
 */
export function disposeLeftoverPicTags(text, leftoverTags, { keepVisible = false, escapeAttr } = {}) {
    const list = (Array.isArray(leftoverTags) ? leftoverTags : []).map((t) => String(t || ''));
    const skipped = list.filter((t) => !LEFTOVER_PIC_RE.test(t));
    const pics = list.filter((t) => LEFTOVER_PIC_RE.test(t));
    if (!keepVisible) {
        const r = replaceTagsWithTraces(text, pics, escapeAttr);
        return { text: r.text, swept: r.traced, missing: r.missing, skipped };
    }
    let out = String(text || '');
    const swept = [];
    const missing = [];
    for (const raw of pics) {
        const r = spliceTagIntoMessage(out, raw, buildUnrenderedTagWrap(escapeAttr(raw)));
        out = r.text;
        (r.spliced ? swept : missing).push(raw);
    }
    return { text: out, swept, missing, skipped };
}

// ── the audit: did a rendered image SURVIVE in the reply we put it in? ───────
// A writer that rewrites the reply from a copy read before the splice replaces the finished picture
// with the raw <pic> tag it was spliced over, and nothing logs it — from the writer's side nothing
// failed. Any module that snapshots a reply and writes the copy back produces this shape; this is what
// says so out loud.
//
// This is the DETECTOR, and it answers "is what we wrote still there" and nothing else. It does NOT
// repair: another module's defect is reported from here, never written around (CLAUDE.md L7).
//
// The two outcomes are distinguished because they have DIFFERENT causes and must not be read as one:
//   revertedToTag — the wrap is gone and the raw <pic> it replaced is back. That is a REVERT to text
//                   older than the splice: a stale-snapshot write.
//   inReasoning   — the wrap is gone from the text and sits whole in the reply's reasoning (ST's Thinking
//                   panel): it was spliced into a thinking block that ST's reasoning parse or the galgame
//                   beat-shaper then moved out of the reply. Not a revert, and not a removal.
//   vanished      — the wrap is gone and its tag did not come back. Something removed it outright;
//                   a revert cannot produce this, so do not blame one.
//
// @param {string} text     the reply's CURRENT text
// @param {Array<{wrap: string, rawTag: string, imageUrl: string}>} records what we spliced, verbatim
// @param {string} [reasoning] the reply's reasoning (message.extra.reasoning)
// @returns {{present: Array, revertedToTag: Array, inReasoning: Array, vanished: Array}}
export function auditRenderedImages(text, records, reasoning = '') {
    const haystack = String(text == null ? '' : text);
    const thinking = String(reasoning == null ? '' : reasoning);
    const present = [], revertedToTag = [], inReasoning = [], vanished = [];
    for (const record of (Array.isArray(records) ? records : [])) {
        if (!record || typeof record.wrap !== 'string' || !record.wrap) continue;
        if (haystack.includes(record.wrap)) { present.push(record); continue; }
        const tag = typeof record.rawTag === 'string' ? record.rawTag : '';
        if (tag && haystack.includes(tag)) revertedToTag.push(record);
        else if (thinking.includes(record.wrap)) inReasoning.push(record);
        else vanished.push(record);
    }
    return { present, revertedToTag, inReasoning, vanished };
}

// The regenerate button swaps the picture inside one wrap a draw pass recorded, so that recorded wrap is no
// longer in the reply, and the audit above would report mvu-helper's own swap as a lost picture. The record
// follows the swap: the first one holding `wrapBefore` now holds `wrapAfter` and the new file, and is audited
// afresh. With identical wraps the record moved does not matter — each copy still in the text satisfies one
// record. A swap of a wrap no record holds (a picture drawn before this page loaded) changes nothing.
// Returns a new list; the records passed in are not changed.
//
// @param {Array<{wrap: string, rawTag: string, imageUrl: string, reported: boolean}>} records
// @param {{wrapBefore: string, wrapAfter: string, imageUrl: string}} swap planImageSrcSwap's wraps + the new file
// @returns {Array} the records, the swapped one replaced
export function recordsAfterImageSwap(records, { wrapBefore = '', wrapAfter = '', imageUrl = '' } = {}) {
    const list = Array.isArray(records) ? records : [];
    const at = list.findIndex((record) => record && record.wrap === wrapBefore);
    if (at === -1) return [...list];
    const moved = { ...list[at], wrap: String(wrapAfter), imageUrl: String(imageUrl), reported: false };
    return [...list.slice(0, at), moved, ...list.slice(at + 1)];
}
