// sillytavern/reply-integrity-core.js — PURE reply-damage diagnosis, no host imports.
//
// Split from reply-integrity.js for the reason L6 names: a decision that lives in a host-coupled
// file cannot be unit-tested AT ALL, so "add a test" is not a buildable fix until the decision is
// extracted first. Same core/host split this folder already uses for lorebook-core / lorebook.

import { COMPLETION_NORMAL_FINISHES } from '../shared/completion-finish.js';

// IS THE FINISHED REPLY DAMAGED? Cut off mid-write (an unterminated tag), or arrived whole with its update
// block written broken (a patch tag left open inside a closed block, or a well-closed body that will not
// parse) — either way MVU saves none of that block. Also NAMES THE LIKELY CAUSE, because the candidates want
// opposite fixes and are very easy to confuse (live 2026-08-11: a sexual line was blamed for a cut that
// landed 79 characters LATER, inside a JSON path — the model had already emitted the "offending" text happily):
//   · a provider CONTENT FILTER reports itself — the API sends a finish reason ("content_filter",
//     Google's "SAFETY"). The fix is the prompt or the content.
//   · a DROPPED STREAM cannot report anything, because nothing survived to send it. The fix is
//     transport (disable streaming), not rewriting prose to appease a filter that never fired.
// A finish reason we do not recognise is passed through VERBATIM rather than guessed at.
//
// THE FINISH REASON reaches this module through mvu-helper's own tap (sillytavern/
// finish-reason-tap.js) — SillyTavern itself still discards the field at every layer (verified
// against 1.18 source, and re-verified 2026-08-31: zero occurrences in public/). The tap is a
// user-decided doctrine exception, observation-only; its header carries the scope. When the reason
// is ABSENT here despite the tap being armed, the stream most likely died before the final chunk —
// that silence is itself a reading now, where it used to be the only reading.
//
// Pure + exported so the judgement is unit-testable independently of any host event.
export function diagnoseTruncatedReply(text, finishReason) {
    const s = String(text == null ? '' : text);
    if (!s.trim()) return { truncated: false };
    const s2 = structureOnly(s);
    const count = (re) => (s2.match(re) || []).length;
    const blockOpen = count(/<UpdateVariable>/gi) > count(/<\/UpdateVariable>/gi);
    const patchOpen = count(/<JSONPatch>/gi) > count(/<\/JSONPatch>/gi);
    // A <JSONPatch> the narrator never closed, with its </UpdateVariable> written AFTER it: the reply went on
    // past the open tag, so nothing cut it there — the block is broken as written. MVU reads only a CLOSED
    // patch tag and drops an open one without a word, so every op inside is lost all the same (live
    // 2026-11-08: a valid op list, no </JSONPatch>, none of its seven writes saved).
    const patchLeftOpen = !blockOpen && patchOpen && blockClosesOverOpenPatch(s2);
    const unterminated = (blockOpen || patchOpen) && !patchLeftOpen;
    let badJson = false;
    if (!unterminated && !patchLeftOpen) {
        const m = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(s2);
        if (m) badJson = !parsesAsPatch(m[1]);
    }
    // THE BLIND SPOT THIS CHECK WAS BORN WITH (live 2026-08-13, and it hid the WORST damage class):
    // both tests above measure the update block against ITSELF. A reply cut BEFORE that block ever
    // opens has zero opens and zero closes — perfectly balanced — so it read as healthy while being
    // more damaged than the cases that did fire: the prose, the log AND the whole update block were
    // lost. The turn recorded nothing and nothing said so.
    //
    // "No update block" cannot mean truncated on its own — a card that writes no variables this reply
    // is the normal quiet turn, and toasting that would be the false alarm this file exists to avoid.
    // (A pack or plugin that PROMISES a block in every reply is held to that promise by its own check,
    // hasUpdateVariableBlock below; this one only asks whether the reply was cut.)
    // So the shape is proved by TWO independent signals, and BOTH must hold:
    //   (1) an unterminated tag OPEN — a '<' that begins a tag and never reaches its '>'. A finished
    //       generation does not stop mid-tag; a killed one frequently does. Cannot simply look at the
    //       END of the text, because the host appends its own markup after the cut (live: the card's
    //       <StatusPlaceHolderImpl/> sat after the severed <font color="#56B4E).
    //   (2) a block tag left OPEN — some <x> whose </x> never arrives, with self-closing and HTML void
    //       elements excluded. This is what says the reply was mid-STRUCTURE, not mid-sentence.
    // Alone, either one false-alarms: models write sloppy unclosed <font>/<p> in perfectly complete
    // replies (2 without 1), and prose can contain a bare "a<b" (1 without 2). Together they describe
    // a generation that stopped while writing markup, which is what a killed stream looks like.
    const cutBeforeBlock = !unterminated && !patchLeftOpen && !badJson
        && !/<(UpdateVariable|JSONPatch)>/i.test(s2)
        && hasUnterminatedTagOpen(s) && hasUnclosedBlockTag(s);
    const fr = String(finishReason == null ? '' : finishReason).trim();
    // A provider-REPORTED cut is truncation even when the text shape looks whole: a filter can kill
    // between paragraphs, leaving balanced tags and a clean sentence — the shape tests see nothing,
    // but everything the reply would have written after the cut point (prose AND blocks) was never
    // generated. The reason word is the proof; the shape merely says where the damage is visible
    // (live 2026-08-31: a content_filter kill at 313 chars whose surviving text parsed perfectly).
    // Which words mean the model FINISHED is the one list the finish-reason tap reads too
    // (COMPLETION_NORMAL_FINISHES), a tool-call handoff included: a provider that ends a complete reply
    // on "tool_calls" is no cut.
    const reportedCut = Boolean(fr) && !COMPLETION_NORMAL_FINISHES.has(fr.toLowerCase());
    if (!unterminated && !patchLeftOpen && !badJson && !cutBeforeBlock && !reportedCut) return { truncated: false };
    // FIVE causes, because each wants a DIFFERENT fix and a label that covers two of them sends the
    // reader at the wrong one. `length`/`max_tokens` in particular is neither a drop nor a malformed
    // patch: the text really was cut, the provider really did say so, and the remedy is the token cap
    // (an earlier draft filed it as "complete-but-malformed" — a label that flatly contradicts the
    // finish reason printed beside it).
    // A broken block the reply WROTE PAST (a closing tag after the fault) is the narrator's, finish reason
    // or not: a dropped stream ends the text, it never writes on after the break. Blaming the connection
    // there sends the reader to fix a transport that delivered every byte.
    const writtenPastFault = patchLeftOpen || badJson;
    const cause = /content.?filter|safety|blocked|prohibited/i.test(fr) ? 'filter'
        : /^length$|^max_tokens$/i.test(fr) ? 'token-cap'
            : reportedCut ? 'reported'
                : (fr || writtenPastFault) ? 'complete-but-malformed' : 'no-finish-reason';
    const defect = cutBeforeBlock ? 'cut-before-update-block'
        : unterminated ? 'unterminated-tag'
            : patchLeftOpen ? 'patch-left-open'
                : badJson ? 'unparseable-json' : 'cut-mid-prose';
    return { truncated: true, defect, cause, finishReason: fr };
}

// STRUCTURE vs MENTION. A model that reprints an instruction naming <UpdateVariable> writes the
// identical characters a real opener does, so nothing about the tag itself separates them — what
// separates them is WHAT COMES NEXT. An opener is followed by the block it opens: end of line, or
// another tag, or the '[' / '{' of the body. A mention is followed by the rest of a sentence. Every
// balance test below reads this instead of the raw text, because counting a sentence's mention as an
// opening tag makes a COMPLETE reply read as unbalanced, and the watchdog then reports damage that
// never happened — the same false-alarm cost parsesAsPatch below exists to avoid. It asks nothing
// about what a tag MEANS, only what follows it (L1).
//
// CLOSERS ARE LEFT ALONE deliberately: prose names the opening form ("emit an <UpdateVariable>"), and
// the balance test only fires when opens EXCEED closes, so an over-counted closer cannot raise a false
// alarm while a wrongly-erased one could hide a real cut.
function structureOnly(s) {
    return s.split('\n').map((line) => line.replace(/<(?:UpdateVariable|JSONPatch)>/gi, (tag, offset) => {
        const rest = line.slice(offset + tag.length).trim();
        return (rest === '' || /^[<[{]/.test(rest)) ? tag : '';
    })).join('\n');
}

// Does an </UpdateVariable> arrive while a <JSONPatch> is still open? Walks the two tag pairs in order, so it
// asks WHERE the closer landed, not how many there are: a patch cut at the end of the text has no closer after
// it, and only that one is a cut. Reads structureOnly's text, so a prose mention opens nothing.
function blockClosesOverOpenPatch(s2) {
    let isPatchOpen = false;
    for (const m of s2.matchAll(/<(\/?)(UpdateVariable|JSONPatch)>/gi)) {
        const isClosing = m[1] === '/';
        if (m[2].toLowerCase() === 'jsonpatch') isPatchOpen = !isClosing;
        else if (isClosing && isPatchOpen) return true;
    }
    return false;
}

// Signal (1): does any '<' start a tag and never reach its '>'? Scans EVERY candidate rather than the
// tail, because the host appends markup after the cut. A '<' not followed by a letter or '/' is not a
// tag start at all ("5 < 6", "<3"), which is what keeps ordinary prose out of this.
function hasUnterminatedTagOpen(s) {
    for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
        if (!/^<\/?[A-Za-z]/.test(s.slice(i, i + 2 + 1))) continue;
        const close = s.indexOf('>', i);
        const nextOpen = s.indexOf('<', i + 1);
        if (close < 0) return true;                       // nothing closes it before the text ends
        if (nextOpen >= 0 && nextOpen < close) return true; // a new tag started before this one closed
    }
    return false;
}

// Signal (2): is some block tag still open? Counts <x> against </x> per NAME, so it needs no
// vocabulary — it never learns what any tag MEANS, only that one is unbalanced (L1). Self-closing
// (<x/>) and HTML void elements close themselves and are excluded; a card's own marker tags (<roll/>,
// <StatusPlaceHolderImpl/>) are self-closing and so cost nothing here.
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track', 'wbr', 'col', 'area', 'base', 'embed', 'param']);
function hasUnclosedBlockTag(s) {
    const open = new Map(), close = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const m of s.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9_]*)\b[^<>]*?(\/?)>/g)) {
        const name = m[2].toLowerCase();
        if (VOID_ELEMENTS.has(name) || m[3] === '/') continue;   // closes itself
        bump(m[1] === '/' ? close : open, name);
    }
    for (const [name, n] of open) if (n > (close.get(name) || 0)) return true;
    return false;
}

// DOES THIS <JSONPatch> BODY PARSE THE WAY ITS CONSUMER PARSES IT? MVU accepts a bare comma-separated
// op list with the enclosing [ ] missing: live 2026-08-11 a reply wrote `{ … }, { … }` unbracketed and
// every op APPLIED (Thoughts written, Intent/mundane cleared). A plain JSON.parse() calls that body
// broken, so this check announced "its <UpdateVariable> writes were LOST" about a turn that saved
// perfectly. A watchdog STRICTER than the thing it watches reports damage that never happened, and a
// false alarm costs more than silence — it sends the reader hunting a bug that is not there.
// This is not tolerance for a malformed reply: nothing here repairs or applies anything. It is the
// check agreeing with reality about what "lost" means. It stays strict where it matters — a body cut
// mid-op leaves an unterminated string or a dangling comma, and neither form parses either way.
function parsesAsPatch(body) {
    const trimmed = String(body == null ? '' : body).trim();
    if (!trimmed) return true;               // an empty block wrote nothing and lost nothing
    // EXPECTED throws ×2: failing to parse IS the question being asked, in both spellings.
    try { JSON.parse(trimmed); return true; } catch { /* try the bracket-less spelling MVU allows */ }
    try { JSON.parse('[' + trimmed + ']'); return true; } catch { return false; }
}

// IS THE DAMAGE A BROKEN BLOCK RATHER THAN A CUT? The reply arrived whole and the narrator wrote its update
// block wrong — nothing stopped the generation. Every surface opens with this distinction, because "cut
// off" sends the reader to the connection and "broken block" sends them to the model, and only one is true.
// A reply that stopped by itself before any block (a normal finish over a cut shape) is still a cut: it has
// no block to call broken.
export function isBrokenBlock(cut) {
    return cut.cause === 'complete-but-malformed' && cut.defect !== 'cut-before-update-block';
}

// The console line's opening words — what kind of damage this is.
export function headline(cut) {
    return isBrokenBlock(cut) ? "the reply's update block is BROKEN" : 'the reply is TRUNCATED';
}

// The toast's title — the same distinction in the player's words.
export function toastTitle(cut) {
    return isBrokenBlock(cut) ? 'MVU Helper — update block broken' : 'MVU Helper — reply cut off';
}

// The player-facing sentence for each cause. Split out so the wording lives in ONE place and the
// console line and the toast can never disagree about what happened (log-sanity).
export function explain(cut) {
    if (cut.cause === 'filter') return `the provider stopped it ("${cut.finishReason}") — this one IS a content block`;
    if (cut.cause === 'no-finish-reason') return 'no finish reason was observed — with the finish-reason tap armed that usually means the stream DIED before the final chunk (transport), not a content block; check the connection before rewriting prose';
    if (cut.cause === 'token-cap') return `the reply hit the TOKEN CAP ("${cut.finishReason}") — raise max tokens, or ask the card for a shorter update block`;
    if (cut.cause === 'reported') return `the provider reported "${cut.finishReason}"`;
    if (cut.finishReason) return `the provider said "${cut.finishReason}", so the text arrived complete and the narrator wrote it this way — not a cut, not the connection`;
    return 'the reply went on past the fault (a closing tag arrived after it), so nothing cut it — the narrator wrote the block broken, not the connection';
}

// What was actually LOST, per defect. Split from the cause for the same single-source reason: the two
// answer different questions ("what broke" vs "who broke it") and a line that fuses them mis-describes
// one of them. A reply cut before its update block did not lose a HALF-WRITTEN record — it never
// reached the record at all, and saying "its writes were lost" implies a block that existed.
export function damage(cut) {
    if (cut.defect === 'cut-before-update-block') return 'it stopped mid-scene and NEVER REACHED its <UpdateVariable> block, so this turn recorded nothing at all';
    if (cut.defect === 'patch-left-open') return 'its <JSONPatch> was never closed (</UpdateVariable> came first), and MVU reads only a closed patch, so NONE of its writes were saved';
    if (cut.defect === 'unparseable-json') return 'its <JSONPatch> body does not parse, so its writes were LOST';
    if (cut.defect === 'cut-mid-prose') return 'the surviving text looks whole, but everything the reply would have written after the cut point — prose and any blocks — was never generated';
    return 'its <UpdateVariable> writes were LOST';
}

// The same fact in the toast's plainer register — one function per SURFACE, matching explain/remedy,
// so the two can never drift into describing different damage. Kept separate from damage() rather
// than shared because the console reader wants the tag names and the player wants the consequence.
// No tag names here at all: the toast renders HTML, so a written <tag> would vanish from the sentence.
export function damagePlain(cut) {
    if (cut.defect === 'cut-before-update-block') return 'This reply was cut off in the middle of the scene, before it reached its update block, so NOTHING from this turn was saved.';
    if (cut.defect === 'cut-mid-prose') return 'The provider stopped this reply early. What you see reads complete, but the rest of the reply was never generated.';
    if (cut.defect === 'patch-left-open') return "This reply's update block is broken: the narrator never closed its patch tag, so MVU skipped the patch and none of its changes were saved.";
    if (cut.defect === 'unparseable-json') return "This reply's update block is broken: its patch is not valid JSON, so MVU skipped it and its changes were NOT saved.";
    return 'This reply was cut off mid-update, so its variable changes did NOT save.';
}

// The toast's second sentence — the ACTION, one per cause. Same single-source rule as explain().
export function remedy(cut) {
    if (cut.cause === 'no-finish-reason') return 'No finish reason arrived — the stream likely died in transport. Check the connection; this is probably not a content block.';
    if (cut.cause === 'token-cap') return 'It hit the token cap — raise max tokens for this connection.';
    if (cut.cause === 'filter') return 'The provider blocked it on content.';
    if (cut.cause === 'complete-but-malformed') return 'The reply arrived whole, so this is not the connection or a content block — the narrator wrote it wrong.';
    return 'The provider stopped the generation.';
}

// IS THIS MESSAGE A NARRATOR'S REPLY? The MESSAGE_RECEIVED types a GENERATION produces (SillyTavern's
// saveReply and stream end). The others are messages no narrator wrote: 'first_message' (a greeting),
// 'command' (/sendas and kin), 'extension' (an image post). A missing block on those is no lost turn, and a
// type SillyTavern adds later stays silent until it is named here.
const GENERATION_REPLY_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
export function isGenerationReplyType(type) {
    return GENERATION_REPLY_TYPES.has(String(type));
}

// DOES THE REPLY CARRY ITS OWN <UpdateVariable> BLOCK? An opener read the way the balance test reads one
// (structureOnly), so a prose MENTION of the tag is not a block. <POSTUpdateVariable> is a different tag and
// never counts: it is the bookkeeper's block, written after the narrator, and a reply holding only that one
// is exactly the turn whose narrator recorded nothing (live 2026-10-31: POST's block present, no
// <UpdateVariable>, the engine resolved nothing and the clock stood still).
export function hasUpdateVariableBlock(text) {
    return /<UpdateVariable>/i.test(structureOnly(String(text == null ? '' : text)));
}

// Who promised the block, by kind and id, so a false alarm can be traced to the declaration that raised it.
const DECLARER_KIND = { gamelogic: 'GameLogic Pack', plugin: 'GameLogic Plugin' };
function declarerNames(declarers) {
    return (declarers || []).map((d) => (DECLARER_KIND[d.packType] || d.packType) + ' "' + d.id + '"').join(', ');
}

// The missing-block report, one wording per surface: the console names the tag and the declaration, the
// toast says what it cost and what to do. `declarers` is pack-info's readUpdateVariableDeclarers rows.
export function missingUpdateVariableLog(declarers) {
    return 'the reply carries no <UpdateVariable> block, though every reply must carry one (requiresUpdateVariable, declared by '
        + declarerNames(declarers) + ') — none of the narrator\'s updates for this turn were recorded';
}
export function missingUpdateVariableToast() {
    return 'This reply carries no <UpdateVariable> block, so the game state did not move this turn. Swipe to retry.';
}
