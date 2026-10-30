// logic-engine/turn-runner-core.js — pure logic for the turn runner: no host imports,
// unit-testable. The stateful half (event listeners, fence, save) is turn-runner.js.
// (mvu-bridge-core and the shared files are themselves pure — the imports below cost no testability.)

import { WRITER_MESSAGE, WRITER_POST, MVU_TRANSIENT_KEY, MENU_PLACEHOLDER } from '../../sillytavern/mvu-bridge-core.js';
import { deepEqual } from '../../shared/deep-equal.js';
import { pageCodeTokenIn, pageCodeTokenAdded } from '../../shared/rendered-region.js';
import { placeAboveFirstAnchor } from '../../shared/reply-block-placement.js';
import { unknownKeysOf } from '../../shared/unknown-keys.js';

// The key the resolver dedups a turn on; both halves come from shared/latest-reply.js.
export function turnKeyOf(mid, swipe) {
    return `${mid}:${swipe}`;
}

// Does RES1 run on the reply MVU just parsed, and so stage the turn audit marker POST waits for? Two
// facts decide it: the profile has the logic engine on, and the loaded game engine exports resolveTurn.
// The reply's text is not one of them: MVU fires mag_variable_update_ended on every reply, zero commands
// included, and applies a <JSONPatch> with or without its <UpdateVariable> wrapper.
export function isTurnResolverActive({ isProfileEnabled, engineApi } = {}) {
    return isProfileEnabled === true && !!engineApi && typeof engineApi.resolveTurn === 'function';
}

// ── the POST relay: one plan, one save rule ──────────────────────────────────
//
// A parse that is not narrate's turn to resolve is a RELAY: POST's record parse (writer 'post'), or any
// second parse of a turn RES1 already resolved (a re-fire). Every relay runs through ONE executor
// (runPostRelay in turn-runner.js), planned here, on every card kind:
//   • the game half — the game engine's resolvePostRelay, when it exports one;
//   • the plugin half — every installed plugin's resolveRelay;
//   • the save — turnSavePlan below. POST's Mvu.parseMessage applies onto a copy and persists nothing,
//     so this save is the only thing that puts POST's ops on disk, whatever else runs or declines.
//
// Returns null when the parse is not a relay (narrate's own parse: RES1 or the engine-status arms take
// it). Otherwise { runsGameHalf, runsPluginHalf, mode } — `mode` is the log's words for a fire that runs
// without the game half, '' when the game half runs.
export function postRelayPlan({ isProfileEnabled, isRefire, writer, gameStatus, engineApi } = {}) {
    const isPostParse = writer === WRITER_POST;
    if (isProfileEnabled !== true) {
        return isPostParse ? { runsGameHalf: false, runsPluginHalf: false, mode: 'logic engine off, nothing resolves' } : null;
    }
    if (isRefire) {
        if (engineApi && typeof engineApi.resolvePostRelay === 'function') return { runsGameHalf: true, runsPluginHalf: true, mode: '' };
        return { runsGameHalf: false, runsPluginHalf: true, mode: engineApi ? 'alone (the game declines the relay)' : 'alone (no game engine loaded)' };
    }
    if (!isPostParse) return null;
    if (gameStatus === 'no-engine') return { runsGameHalf: false, runsPluginHalf: true, mode: 'alone (no game engine)' };
    // A loaded engine that has not resolved this turn yet resolves it now, on POST's parse (RES1, which
    // saves POST's ops by the same rule). Any other status is an engine that cannot resolve at all.
    if (engineApi && typeof engineApi.resolveTurn === 'function') return null;
    return { runsGameHalf: false, runsPluginHalf: false, mode: 'the game engine is ' + String(gameStatus || 'unavailable') + ', nothing resolves' };
}

// Does this fire save, and what does its `saved ✓` line name? ONE rule for RES1 and every relay:
// a fire carrying POST's parse ALWAYS saves (the save is that parse's only persist); any other fire
// saves what a resolver wrote, and nothing when nothing did (narrate's own parse is MVU's to save).
export function turnSavePlan({ isPostParse = false, didGameApply = false, didPluginsApply = false } = {}) {
    const parts = [];
    if (isPostParse === true) parts.push("POST's ops");
    if (didGameApply === true) parts.push('engine');
    if (didPluginsApply === true) parts.push('plugins');
    return { shouldSave: parts.length > 0, label: parts.join(' + ') };
}

// The plugin half for a reply that no POST parse fired the relay for. The relay's first trigger is POST's
// parse; this is every other reply, so a plugin's resolver runs once per reply, after the reply's last
// write. The turn runner asks once the reply is settled: narrate's parse is done (RES1 included) and the
// post-reply phase has signalled done. `postOutcome` is what that phase did:
//   'no-calls'          no POST call ran for this reply;
//   'no-block'          POST's calls ran and wrote no block;
//   'resolved-by-res1'  POST wrote a block, and RES1 resolved its parse (the engine had not resolved narrate's).
// Runs on a card with no game engine and on one whose engine resolves turns. An engine that cannot resolve
// runs nothing, as on POST's parse (postRelayPlan). Never twice for one turn: `lastFiredKey` is the
// `epoch:mid:swipe` the relay last ran for. Returns the relay plan for the one executor, or null.
const POST_OUTCOME_WORDS = {
    'no-calls': 'no POST call this reply',
    'no-block': 'POST wrote nothing',
    'resolved-by-res1': "RES1 resolved POST's parse",
};
export function postSilentRelayPlan({ gameStatus, engineApi, lastFiredKey, turnFireKey, postOutcome } = {}) {
    if (!Object.prototype.hasOwnProperty.call(POST_OUTCOME_WORDS, postOutcome)) {
        throw new Error('postSilentRelayPlan: unknown postOutcome ' + JSON.stringify(postOutcome));
    }
    if (typeof turnFireKey !== 'string' || !turnFireKey) return null;
    if (lastFiredKey === turnFireKey) return null;
    const words = POST_OUTCOME_WORDS[postOutcome];
    if (gameStatus === 'no-engine') return { runsGameHalf: false, runsPluginHalf: true, mode: 'alone (no game engine, ' + words + ')' };
    if (engineApi && typeof engineApi.resolveTurn === 'function') return { runsGameHalf: false, runsPluginHalf: true, mode: 'alone (' + words + ')' };
    return null;
}

// postSilentRelayPlan's trigger waits for two facts that arrive in either order: narrate's parse is done
// (RES1 included), and the post-reply phase is done with no POST parse coming (`postOutcome`). One record
// per reply, keyed `epoch:mid:swipe`; a note for another key starts a new record. `isReady` is true only on
// the note that completes the record, so a late duplicate note never asks for a second relay.
export function noteReplySettled(record, { fireKey, isParsed = false, postOutcome = '' } = {}) {
    const current = (record && record.fireKey === fireKey) ? record : { fireKey, isParsed: false, postOutcome: '' };
    const wasReady = current.isParsed === true && !!current.postOutcome;
    const next = { fireKey, isParsed: current.isParsed === true || isParsed === true, postOutcome: postOutcome || current.postOutcome };
    return { record: next, isReady: !wasReady && next.isParsed && !!next.postOutcome };
}

// ── the relay machinery ──────────────────────────────────────────────────────

// The turn's APPLIED variable operations — collected by DIFFING the two arguments of
// VARIABLE_UPDATE_ENDED (`(variables, variables_before_update)`, both full MvuData).
//
// ⚠ NOT from `mag_variable_updated` (SINGLE_VARIABLE_UPDATED). MVU emits it per applied op from its
// verb lanes, but on a card with a Zod schema the zod util applies commands itself, the verb lanes —
// which own the emits — never run, and the per-op event NEVER FIRES: a turn that applied ops would
// report none. The diff works no matter WHO applied the write.
// Granularity cost, accepted: several writes to one path inside one parse collapse into one delta.
//
// Values are snapshotted AT CAPTURE (structuredClone), because `after` is a live reference into
// stat_data and the relay that consumes this list runs later.
//
// The cap is a memory fence, not a feature, and hitting it is SAID (`capped` → the caller warns):
// a silently truncated op list reads as "the turn did this and nothing else", which is a lie.

// One parse's ops: diff two stat_data trees into [{ path, old, new }] with dotted paths.
// MVU's transient key (MVU_TRANSIENT_KEY) is skipped at the TOP LEVEL: when VARIABLE_UPDATE_ENDED fires, `after`
// carries it and `before` does not, so a diff would report a write nobody made. A key of the same name deeper in a
// consumer's own tree is that consumer's data and is reported normally.
// Objects recurse; ARRAYS ARE LEAVES — a changed array reports once, at the array's own path, with
// the whole old/new values. Deliberate: this domain treats arrays as values (tuples, whole-list
// rewrites), and an index-wise diff of a spliced list reports shifted pairs that describe nothing
// anyone wrote.
export function diffStatOps(before, after, { cap = 500 } = {}) {
    const ops = [];
    let capped = false;
    const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    const push = (path, oldValue, newValue) => {
        if (ops.length >= cap) { capped = true; return; }
        ops.push({ path, old: oldValue, new: newValue });
    };
    const walk = (a, b, prefix) => {
        if (capped) return;
        const keys = new Set([...Object.keys(isRecord(a) ? a : {}), ...Object.keys(isRecord(b) ? b : {})]);
        for (const key of keys) {
            if (capped) return;
            if (!prefix && key === MVU_TRANSIENT_KEY) continue;
            const path = prefix ? prefix + '.' + key : key;
            const oldValue = isRecord(a) ? a[key] : undefined;
            const newValue = isRecord(b) ? b[key] : undefined;
            if (isRecord(oldValue) && isRecord(newValue)) { walk(oldValue, newValue, path); continue; }
            if (!deepEqual(oldValue, newValue)) push(path, oldValue, newValue);
        }
    };
    walk(before, after, '');
    return { ops, capped };
}

export function createTurnOpsCollector({ cap = 500 } = {}) {
    let bucket = { epoch: null, ops: [], capped: false };
    const keep = (value) => {
        try { return structuredClone(value); }
        catch (e) { void e; return String(value); }   // EXPECTED: functions/symbols cannot clone — a string is still evidence
    };
    return {
        // `by` = the writer label the bridge had on its stack when this parse's ENDED fired
        // ('message' · 'pre-sim' · 'post' · 'plugin:<id>' · 'host'). Defaulted to WRITER_MESSAGE
        // with the SAME sentinel currentWriter() uses, so an unlabeled note and an un-initiated
        // parse read as one thing instead of two spellings of it.
        note(epoch, path, oldValue, newValue, by) {
            if (bucket.epoch !== epoch) bucket = { epoch, ops: [], capped: false };
            if (bucket.ops.length >= cap) { bucket.capped = true; return; }
            bucket.ops.push({ path: String(path == null ? '' : path), old: keep(oldValue), new: keep(newValue), by: String(by || WRITER_MESSAGE) });
        },
        // Only the CURRENT epoch's ops — asking about any other epoch returns empty, so a stale
        // buffer can never describe a regenerated turn.
        snapshot(epoch) {
            if (bucket.epoch !== epoch) return { ops: [], capped: false };
            return { ops: bucket.ops.slice(), capped: bucket.capped };
        },
    };
}

// Which relay participants RUN on this fire, per the host-side once-guard (one resolve per plugin
// per fire identity; the guard is the HOST's job, never the plugin's). The caller keys the guard on
// {generation epoch, turnKey}, because a REGEN replaces the message in place (same mid:swipe) — a
// guard on the turnKey alone would skip every plugin on the regenerated reply.
export function planRelayParticipants(participants, guard, guardKey) {
    const run = [];
    const skipped = [];
    for (const p of (Array.isArray(participants) ? participants : [])) {
        if (!p || typeof p.id !== 'string' || !p.id) continue;
        if (guard && typeof guard.get === 'function' && guard.get(p.id) === guardKey) skipped.push(p.id);
        else run.push(p);
    }
    return { run, skipped };
}

// One Intent channel's value → its log token. Genre-blind by SHAPE, not by name:
//   #tuple [value,"Label"]  → the value  (true ⇒ YES, any other falsy ⇒ '-')
//   #record {key:{…}}       → its keys, comma-joined
//   bare scalar             → itself
// The tuple/record split is MVU's own value grammar, which every consumer shares — so this reads
// a channel it has never heard of correctly.
function intentChannelToken(value) {
    if (Array.isArray(value)) {
        const v = value[0];
        return v === true ? 'YES' : (v || '-');
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        return keys.length ? keys.join(',') : '-';
    }
    return value === true ? 'YES' : (value || '-');
}

// The RES "fired — pending:" enumeration. It ENUMERATES, so the log-sanity rule applies: a turn
// firing only a new channel must never read as "nothing pending". The only way to satisfy that for
// EVERY consumer is to print what is ACTUALLY THERE — `Object.keys(intent)`, in the card's own
// declaration order — rather than a fixed list, which prints `-` for every channel a card lacks and
// never shows the channels it has.
export function pendingIntentSummary(intent) {
    const I = (intent && typeof intent === 'object') ? intent : {};
    const keys = Object.keys(I);
    if (!keys.length) return '(this card declares no Intent channels)';
    return keys.map((k) => `${k}=${intentChannelToken(I[k])}`).join('  ');
}

// A patch op whose path names an Intent channel's TUPLE ROOT instead of its `/0` value slot —
// `{"op":"replace","path":"/Intent/eventFire","value":"…"}` where `/Intent/eventFire/0` was meant.
// MVU refuses it, and refusing is CORRECT: applying it would replace the `[value,"Label"]` pair with
// a bare string and destroy the label. But the refusal is silent from here — the channel simply stays
// empty, so the turn's write is LOST and `pending:` above prints `eventFire=-`, which reads exactly
// like "the narrator never fired anything". Those two are not the same thing and must not log the same.
//
// SURFACE, NEVER REPAIR (CLAUDE.md L7 corollary). Rewriting the path to `/0` would silently accept a
// malformed op forever and hide the defect from the layer that owns it — the CARD's prompt, which is
// where the spelling is taught. Here we only say what was lost and why.
//
// GENRE-NEUTRAL by construction (L1/L2): the channel list comes from `Object.keys(intent)` — the
// consumer's own declaration — so this names no genre's vocabulary and works for a card that has
// never heard of `eventFire`. It reports a channel ONLY when the card declares it AND it is still
// empty, so a write that actually landed (or a path this card does not own) is never flagged.
//
// For an event fire the loss compounds: the beat is already narrated, so the player sees it, but its
// fx never apply, the one-shot never marks done, and the armed event replays the same scene every
// reply — with nothing in the log to pull on.
// TUPLE CHANNELS ONLY — the `/0` rule is a property of the SHAPE, not of the path. A RECORD channel
// (`{}`, e.g. `/Intent/newClassmate`) is correctly written with `replace` on its container path — a
// card may even forbid `/Intent/<channel>/<Key>`, because MVU rejects adding a key — and a record has
// no index 0, so the warning's advice ("the correct path is /Intent/<channel>/0") would break a working
// prompt. A surfaced defect that is not one costs more than silence: it sends the reader to edit the
// one file that was right.
export function droppedIntentWrites(replyText, intent) {
    const I = (intent && typeof intent === 'object') ? intent : {};
    const declared = new Set(Object.keys(I));
    if (!declared.size) return [];
    const out = [];
    // The closing quote immediately after the channel is the whole test: `/Intent/check/0` cannot
    // match, `/Intent/check` must. Whitespace around the JSON colon is tolerated because models vary.
    const re = /"path"\s*:\s*"\/Intent\/([A-Za-z0-9_]+)"/g;
    let m;
    while ((m = re.exec(String(replyText || '')))) {
        const channel = m[1];
        if (!declared.has(channel)) continue;                      // not this card's channel — a different bug
        if (!Array.isArray(I[channel])) continue;                  // record/scalar — the container path is CORRECT
        if (intentChannelToken(I[channel]) !== '-') continue;       // it landed after all (or was already set)
        if (!out.includes(channel)) out.push(channel);
    }
    return out;
}

// ── engine-authored text replacements ────────────────────────────────────────
// A resolver may return `textReplacements`: an OPAQUE {findLiteral: putLiteral} map the host applies
// to the resolved message's text verbatim. This function is the whole platform-side semantics —
// literal split/join, never a regex (an engine key must not smuggle pattern syntax), no formatting, no
// default when a find is absent: 0 occurrences stays 0, reported in `counts` for the engine's own log to
// surface (L1: every line here is correct with no engine installed at all). Non-string pairs land in
// `skipped` — the caller warns, the text is untouched by them.
//
// The one inspection: a swap that would ADD a page-code token to the reply (pageCodeTokenAdded — a
// TavernHelper render token or ST-Prompt-Template's opener) is not applied and lands in `refused` as
// { find, token }. The engine runs in the Worker so that its code never reaches the page; a reply
// carrying such a token would hand its text to the page anyway.
export function applyTextReplacements(text, pairs) {
    const out = { text: String(text == null ? '' : text), counts: {}, skipped: [], refused: [] };
    if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs)) return out;
    for (const find of Object.keys(pairs)) {
        const put = pairs[find];
        if (!find || typeof put !== 'string') { out.skipped.push(find); continue; }
        const parts = out.text.split(find);
        out.counts[find] = parts.length - 1;
        if (parts.length < 2) continue;
        const next = parts.join(put);
        const token = pageCodeTokenAdded(out.text, next);
        if (token) { out.refused.push({ find, token }); continue; }
        out.text = next;
    }
    return out;
}

// ── the engine's lead and end text ───────────────────────────────────────────
// A resolver may return `leadText` and `endText`: text the engine writes into the reply itself, on every reply,
// whatever the model wrote — a card's date and location bars, a closing line. mvu-helper wraps each in a tag of its
// OWN, for the reason it wraps resBlock: a later resolve of the same reply (RES2, a re-fire) must find the block
// again and refresh it in place, never add a second one.
//   <LeadText>…</LeadText>  at the top of the story (storyStartIndex below), whose block the card names in its
//                           [Initmvuhelper] leadText section (normalizeLeadTextSection);
//   <EndText>…</EndText>    directly above MVU's menu placeholder, or after the text while the reply has none yet:
//                           MVU appends the placeholder after RES1's listeners return, so below the end text.
// Every other block a writer puts above the menu goes above the end text (REPLY_TAIL_ANCHORS with
// placeAboveFirstAnchor), so the end text stays the last block above the menu.
//
// Per field: absent (undefined or null) leaves the reply's block as it is; a string is the block's new text, and
// an empty one removes the block. A value that is not a string lands in `skipped`. A text carrying a page-code
// token (pageCodeTokenIn), or one of the two tags, lands in `refused` and its block is left as it is. A lead text
// on a card that names no story block lands in `undeclared`, the reply untouched. A reply that carries a block's
// opening tag without its closing tag, or the reverse, lands in `unpaired`: that block is not written, because
// neither the old block nor the place for a new one can be found.
export const LEAD_TEXT_TAG = 'LeadText';
export const END_TEXT_TAG = 'EndText';
export const REPLY_TAIL_ANCHORS = Object.freeze([`<${END_TEXT_TAG}>`, MENU_PLACEHOLDER]);
const LEAD_AND_END_TAGS = [LEAD_TEXT_TAG, END_TEXT_TAG];

// Does a resolve's result carry text for the reply? The turn runner writes the reply's text only then, or when
// the card declares a stat box.
export function resolverWritesReplyText(r) {
    return !!r && (r.textReplacements != null || r.leadText != null || r.endText != null);
}

// Where a block stands: `{ at, end }` for its first complete pair, null when the text carries neither of its
// tags, 'unpaired' when it carries a tag but no complete pair. A pair is a closing tag and the opening tag NEAREST
// before it, so an opening tag quoted earlier in the reply (a reasoning block naming the tag) never widens the
// block over the text between.
function blockSpan(text, tag) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    for (let from = 0, closeAt = text.indexOf(close); closeAt >= 0; from = closeAt + close.length, closeAt = text.indexOf(close, from)) {
        const at = text.lastIndexOf(open, closeAt);
        if (at >= from) return { at, end: closeAt + close.length };
    }
    return text.includes(open) || text.includes(close) ? 'unpaired' : null;
}

// ── the top of the story: where the lead text goes ───────────────────────────
// A reply may open with blocks of the model's own above its story: a preset's thinking written into the reply,
// under whatever tag the preset chose (<thinking>, <konatan_planning~>), or a commentary block (<tucao>). A preset's
// display regex often turns everything from the reply's first character through such a block's closing tag into
// one collapsed box, and a lead text placed above the block vanishes into it. So the lead text goes where the
// story starts, which storyStartIndex finds by walking the reply from the top:
//   • a complete tag block, whatever its name, is skipped — except the story block: the walk steps past its
//     opening tag and walks on INSIDE it (galgame-companion opens <maintext> at the reply's first character when
//     the model wrote no story tag, so the blocks above the story end up inside it);
//   • <p> wrappers (one per galgame beat), closing tags and comments are passed over;
//   • it stops at the first story line (text outside every block), at a tag that is no complete block (a <pic>
//     tag, a self-closing tag, a block never closed), or at the story block's own closing tag.
// The lead text goes there: in front of the <p> wrappers that open that line, and never outside a story block the
// walk stepped into. Thinking the reply carries without its opening tag (a preset that pre-fills the tag) reads as
// story to this walk, so the lead text goes above it.
const TAG_AT_START = /^<(\/?)([A-Za-z][\w:.~-]*)(?:\s[^<>]*?)?(\/?)>/;
const BEAT_WRAPPER = 'p';

// The position after the whitespace and comments that start at `at`.
function skipBlankAndComments(text, at) {
    for (;;) {
        while (at < text.length && /\s/.test(text[at])) at++;
        if (!text.startsWith('<!--', at)) return at;
        const end = text.indexOf('-->', at + 4);
        if (end < 0) return at;
        at = end + 3;
    }
}

// The end of the first `</name>` (blanks allowed before `>`) at or after `from` in the lower-cased text, or -1.
function endOfClosingTag(lowerText, name, from) {
    const head = `</${name}`;
    for (let at = lowerText.indexOf(head, from); at >= 0; at = lowerText.indexOf(head, at + 1)) {
        const rest = /^\s*>/.exec(lowerText.slice(at + head.length));
        if (rest) return at + head.length + rest[0].length;
    }
    return -1;
}

function storyStartIndex(text, storyEnvelope) {
    const storyTags = new Set(storyEnvelope.map((tag) => tag.slice(1, -1).toLowerCase()));
    const lowerText = text.toLowerCase();
    let at = 0;
    let wrappersAt = -1;   // where the <p> wrappers in front of `at` begin
    for (;;) {
        at = skipBlankAndComments(text, at);
        const m = TAG_AT_START.exec(text.slice(at));
        if (!m) break;
        const [tag, slash, rawName, selfClosing] = m;
        const name = rawName.toLowerCase();
        if (slash) {
            if (storyTags.has(name)) break;
            at += tag.length;
            wrappersAt = -1;
        } else if (name === BEAT_WRAPPER) {
            if (wrappersAt < 0) wrappersAt = at;
            at += tag.length;
        } else if (storyTags.has(name)) {
            at += tag.length;
            wrappersAt = -1;
        } else {
            if (selfClosing) break;
            const end = endOfClosingTag(lowerText, name, at + tag.length);
            if (end < 0) break;
            at = end;
            wrappersAt = -1;
        }
    }
    return wrappersAt >= 0 ? wrappersAt : at;
}

// The lead block at the top of the story, a blank line below it. The whitespace above the story line stays as it
// was (whitespace alone above it is dropped), so removing the block gives back the reply it was placed into.
function insertAtStoryStart(text, block, storyEnvelope) {
    const at = storyStartIndex(text, storyEnvelope);
    const before = text.slice(0, at);
    const after = text.slice(at);
    const below = after ? '\n\n' + after : '';
    if (!before.trim()) return block + below;
    return before + (/\s$/.test(before) ? '' : '\n\n') + block + below;
}

const insertAboveMenu = (text, block) => placeAboveFirstAnchor(text, block, [MENU_PLACEHOLDER]);

// The block's text written into `text`: placed when the reply has no such block, refreshed in place when it has
// one, removed when `body` is empty. Returns `{ text, action }`, action 'placed' | 'refreshed' | 'removed' |
// 'unchanged' | 'unpaired'.
function writeTaggedBlock(text, tag, body, insert) {
    const span = blockSpan(text, tag);
    if (span === 'unpaired') return { text, action: 'unpaired' };
    if (!body) {
        if (!span) return { text, action: 'unchanged' };
        const before = text.slice(0, span.at);
        const after = text.slice(span.end);
        return { text: after.trim() ? before + after.replace(/^\s+/, '') : before.replace(/\s+$/, ''), action: 'removed' };
    }
    const block = `<${tag}>${body}</${tag}>`;
    if (!span) return { text: insert(text, block), action: 'placed' };
    if (text.slice(span.at, span.end) === block) return { text, action: 'unchanged' };
    return { text: text.slice(0, span.at) + block + text.slice(span.end), action: 'refreshed' };
}

/**
 * The reply's text with the engine's lead and end text written (the rules above). `storyEnvelope` is the opening
 * tags of the card's story block (storyEnvelopeOf), null while the card names none. `actions` names what happened
 * to each field: 'absent' (not returned) or one of writeTaggedBlock's actions, else 'skipped' / 'refused' /
 * 'undeclared'.
 * @returns {{ text: string, actions: { leadText: string, endText: string }, skipped: string[],
 *   refused: { field: string, token: string, isOwnTag: boolean }[], undeclared: string[], unpaired: { field: string, tag: string }[] }}
 */
export function placeLeadAndEndText(text, { leadText, endText } = {}, { storyEnvelope = null } = {}) {
    const out = { text: String(text == null ? '' : text), actions: {}, skipped: [], refused: [], undeclared: [], unpaired: [] };
    const isStoryDeclared = Array.isArray(storyEnvelope) && storyEnvelope.length > 0;
    const fields = [
        { field: 'leadText', value: leadText, tag: LEAD_TEXT_TAG, isDeclared: isStoryDeclared, insert: (t, block) => insertAtStoryStart(t, block, storyEnvelope) },
        { field: 'endText', value: endText, tag: END_TEXT_TAG, isDeclared: true, insert: insertAboveMenu },
    ];
    for (const { field, value, tag, isDeclared, insert } of fields) {
        if (value == null) { out.actions[field] = 'absent'; continue; }
        if (typeof value !== 'string') { out.skipped.push(field); out.actions[field] = 'skipped'; continue; }
        const ownTag = LEAD_AND_END_TAGS.flatMap((t) => [`<${t}>`, `</${t}>`]).find((t) => value.includes(t));
        const token = ownTag || pageCodeTokenIn(value);
        if (token) { out.refused.push({ field, token, isOwnTag: !!ownTag }); out.actions[field] = 'refused'; continue; }
        if (!isDeclared) { out.undeclared.push(field); out.actions[field] = 'undeclared'; continue; }
        const res = writeTaggedBlock(out.text, tag, value.trim(), insert);
        if (res.action === 'unpaired') out.unpaired.push({ field, tag });
        out.actions[field] = res.action;
        out.text = res.text;
    }
    return out;
}

// The text without the engine's lead and end text, for a reader that must not take them for the reply's own words
// (the POST calls' input, the reply-cast name scan): the readers that leave the stat box out, for the same reason.
export function stripLeadAndEndText(text) {
    let s = String(text == null ? '' : text);
    for (const tag of LEAD_AND_END_TAGS) {
        for (let span = blockSpan(s, tag); span && span !== 'unpaired'; span = blockSpan(s, tag)) {
            s = s.slice(0, span.at) + s.slice(span.end);
        }
    }
    return s;
}

// ── the card's leadText section ([Initmvuhelper]) ────────────────────────────
// `"leadText": { "storyEnvelope": ["<gametxt>", "<maintext>"] }` — the opening tags of the card's story block, in
// every spelling a reply can have (School writes <gametxt>, and galgame-companion renames it <maintext>). Only the
// card knows which block holds its story; without it the walk above cannot tell the story from a block that opens
// the reply, so a card that names none gets no lead text. The card owns the section whole: features/card-config
// registers these with its wholeCardOwnedSection handler.
const KNOWN_LEAD_TEXT_FIELDS = ['storyEnvelope'];
const OPENING_TAG = /^<[A-Za-z][\w:.~-]*>$/;

// The card's section → `{ storyEnvelope }`, or null (absent, or no usable tag). What it drops goes into the import's
// `report`: unknown keys in report.unknown, refused values in report.blocked with the reason.
export function normalizeLeadTextSection(raw, report) {
    if (raw === undefined) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        report.blocked.push({ path: 'leadText', why: 'expected an object — the section was ignored' });
        return null;
    }
    report.unknown.push(...unknownKeysOf(raw, KNOWN_LEAD_TEXT_FIELDS, 'leadText'));
    if (!Array.isArray(raw.storyEnvelope)) {
        report.blocked.push({ path: 'leadText.storyEnvelope', why: 'must be a list of the story block\'s opening tags, such as "<gametxt>" — the section was ignored' });
        return null;
    }
    const storyEnvelope = [];
    raw.storyEnvelope.forEach((tag, i) => {
        if (typeof tag === 'string' && OPENING_TAG.test(tag.trim())) storyEnvelope.push(tag.trim());
        else report.blocked.push({ path: `leadText.storyEnvelope[${i}]`, why: 'must be an opening tag without attributes, such as "<gametxt>" — that entry was ignored' });
    });
    if (!storyEnvelope.length) {
        report.blocked.push({ path: 'leadText.storyEnvelope', why: 'holds no usable tag, so the story cannot be found — the section was ignored' });
        return null;
    }
    return { storyEnvelope };
}

export function serializeLeadTextSection(current) {
    return isLeadTextConfigured(current) ? { storyEnvelope: [...current.storyEnvelope] } : undefined;
}

export function isLeadTextConfigured(value) {
    return !!value && typeof value === 'object' && Array.isArray(value.storyEnvelope) && value.storyEnvelope.length > 0;
}

// PER-CARD defaults (PROFILE scope), merged into profileDefaults by index.js: no story block until the card names one.
export const leadTextProfileDefaults = { leadText: null };

// The opening tags of the card's story block, or null while the card names none.
export function storyEnvelopeOf(profile) {
    const section = profile && profile.leadText;
    return isLeadTextConfigured(section) ? section.storyEnvelope : null;
}

// ── the audit blocks: the engine's content, mvu-helper's tags ────────────────
// A resolver may return `resBlock`: the BODY of a player-visible audit of what it changed. mvu-helper
// wraps it in a tag of its OWN before writing it into the reply, because mvu-helper is what must find
// the block again — POST's write checks whether the reply already carries one, and the relay's block
// is placed straight after it. A tag each engine chose could only be found by a platform that knew
// that engine. One tag per stage: the turn's resolve and the POST relay's resolve list the same values
// with different numbers, and one tag twice would read as a duplicate.
export const TURN_AUDIT_TAG = 'RES_Variable';
export const RELAY_AUDIT_TAG = 'RES_POST_Variable';

export function wrapAuditBlock(body, tag) {
    const text = String(body == null ? '' : body).trim();
    return text ? `<${tag}>\n${text}\n</${tag}>` : '';
}

// The block an engine's body becomes in the reply: `{ block, refusedToken }`. A body carrying a page-code
// token (pageCodeTokenIn) writes NO block, for the reason applyTextReplacements refuses such a swap, and
// `refusedToken` names the token for the caller's warning. The wrapping tags carry none, so the body is
// the whole question.
export function auditBlockFromBody(body, tag) {
    const refusedToken = pageCodeTokenIn(body);
    if (refusedToken) return { block: '', refusedToken };
    return { block: wrapAuditBlock(body, tag), refusedToken: null };
}

// Does an engine's body already carry an audit tag of its own? The caller SAYS so and wraps as given;
// nothing is stripped (the no-fallback rule: the engine owns that fix, and the doubled tag is its
// visible symptom).
export function auditBodyCarriesTag(body) {
    const text = String(body == null ? '' : body);
    return [TURN_AUDIT_TAG, RELAY_AUDIT_TAG].some((tag) => text.includes(`<${tag}>`) || text.includes(`</${tag}>`));
}

// ── the staged <RES_Variable> marker's lifetime ──────────────────────────────
// POST reads the staged marker by {mid, swipe} ONLY (readResStaged / awaitResStaged). A REGEN keeps
// BOTH — it replaces the latest reply in place, same mid, same swipe 0 — so a previous take's marker
// left in place still reads `done`, the new generation's POST gate resolves INSTANTLY with it,
// decideResCarry prefers that gate hit over the fresh block staged seconds later ("a gate hit always
// WINS"), and the dead generation's audit lands in the new reply: the second take's prose under the
// first take's numbers, from a check the regenerate discarded. stat_data stays correct; only the
// audit the reader trusts is wrong, which is worse than no audit at all.
//
// This is the DISPLAY half of the regen case whose STATE half `lastHandled = ''` handles. The epoch
// it compares is the one the marker ALREADY carries — the block's text is never touched for it.
//
// Stale = anything not stamped with the generation now starting: an older epoch, or no epoch at all
// (a marker from a card's own baked resolver, which is never trusted).
export function isStagedBlockStale(marker, currentEpoch) {
    if (!marker || typeof marker !== 'object') return false;   // nothing staged ⇒ nothing to drop
    return marker.epoch !== currentEpoch;
}
