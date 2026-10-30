// shared/card-artifact-store.js — the machinery every CARD-LEVEL ARTIFACT shares.
//
// An "artifact" is anything a tab installs onto a card and can later find again exactly: an Event Pack,
// a GameLogic Pack, a StatusMenu Pack, a GameLogic Plugin. All four answer the same questions — where
// is my registry, what did I install, what must uninstall remove, what state is my LED in, what does my
// card row say about it and which install buttons does it offer, and what does the user read when an
// install replaces their copies — and they answer them here, once.
//
// PURE — no host imports, no I/O, every function a decision a test can reach (L6). The lorebook half
// lives in shared/card-artifact-library.js, which imports this for its names.
//
// WHAT IS DELIBERATELY *NOT* HERE: the pack FILE formats. An Event Pack file is `<MvuEventPack>` blocks
// of JSON + prose; a GameLogic Pack file is one JSON object with typed sections. Those validators are
// each feature's own vocabulary and stay in their features (L1 — this module must not learn what a
// "trigger" or an "engine" MEANS). The export spine below copies the pieces an install RECORDED back by
// name — entries, section entries, an owned engine's text, regex rows — and reads none of them.

import { compareVersions } from './version-compare.js';
import { hash36 } from './string-hash.js';
import { exportRecordedRegexRows } from '../sillytavern/tavern-regex-core.js';

// ── the library ──────────────────────────────────────────────────────────────

// ROOT level, created on first use, never bound to a character — which is what makes artifacts survive
// a card rebuild: the card's own book dies with the card, this one does not. The name is fixed:
// renaming the book would orphan every installed library.
export const LIBRARY_BOOK_NAME = 'MVU_GameLogic_Library';

// Entry-comment prefix per artifact type. The SAME needle family appears in the library book (holding
// the artifact FILE) and in a card's book (holding the INSTALLED pieces); the BOOK provides the
// context, and no code path ever scans both books with one needle.
const TYPE_PREFIX = {
    gamelogic: 'GameLogicPack',
    statusmenu: 'StatusMenuPack',
    plugin: 'GameLogicPlugin',
    eventpack: 'EventPack',
};

// Every type the LIBRARY can hold — the same four as gamelogic-pack-core's PACK_TYPES, the pack-FILE
// validator's vocabulary. The library only stores text under a name; the event-pack lane stores an
// eventpack as its event-pack TEXT, one entry per pack (event-pack-library.js).
export const ARTIFACT_TYPES = Object.keys(TYPE_PREFIX);

// WHAT EACH ARTIFACT IS — the one definition of the taxonomy. Every consumer that tells these four apart
// (a display label, a reload-line clause, a refusal message) reads it here rather than spelling its own,
// so one artifact is never reported as another.
//
//   gamelogic   the BACKEND — the game's main brain. Resolves turns and owns the state tree. ONE.
//   plugin      an ADD-ON to that brain, third-party, fenced into its own state root. MANY.
//   eventpack   DATA, not code: events executed by the game engine's own eventpack.cjs (which is
//               version-locked across the engine, mvu-helper and the builder). Hosts NO Worker scope
//               of its own, which is why it never appears in the engine reload line. MANY.
//   statusmenu  the COUNTERPART of the logic engine, for display only — the same game seen from the
//               player's side. Not an add-on to the brain; the other half of it. ONE.
//
// `engineLabel` is the word the engine reload line groups that kind's scopes under; null means the
// kind hosts no engine scope at all. `activeAtOnce` is the registry invariant each lane enforces.
export const ARTIFACT_ROLES = {
    gamelogic: { label: 'GameLogic Pack', engineLabel: 'game engine', activeAtOnce: 1, role: 'the backend — the main brain' },
    plugin: { label: 'GameLogic Plugin', engineLabel: 'plugins', activeAtOnce: 'many', role: 'an add-on to the logic engine' },
    eventpack: { label: 'Event Pack', engineLabel: null, activeAtOnce: 'many', role: 'events executed by the engine eventpack runtime' },
    statusmenu: { label: 'StatusMenu Pack', engineLabel: 'display engine', activeAtOnce: 1, role: 'the display counterpart of the logic engine' },
};

// `[GameLogicPack:<id>]` — the library entry comment for an artifact (content = its file text verbatim).
export function libraryEntryComment(artifactType, id) {
    return '[' + (TYPE_PREFIX[artifactType] || 'GameLogicPack') + ':' + String(id || '') + ']';
}

// Match needles are lowercase comment substrings, case-insensitive — the event-pack convention.
export function libraryEntryMatch(artifactType, id) {
    return libraryEntryComment(artifactType, id).toLowerCase();
}

// ── section entries: `[<Prefix>:<id>:<Section>]` ─────────────────────────────
// An installer stores some SECTIONS of an artifact as silent card entries — a plugin's engine text,
// a StatusMenu layout, either lane's panel declaration — because the declaration must outlive the
// library file, and an entry is the one surface install, upgrade, uninstall, the dev loop's per-sink
// apply and the export walk already all know how to carry.
//
// The section name sits INSIDE the ownership bracket, after a second colon. That keeps the whole
// comment inside the control prefix rule 4 refuses anywhere in an author's entry, so no marker list
// has to be kept and nothing an author can write collides with an installer's own entry: the
// reservation is structural. An id is kebab-case (rule 1), so the second colon is unambiguous — the
// sweep matcher below reads `]` or `:` after the id as the boundary, and parseLibraryComment refuses
// a comment carrying that second colon. small-llm's call tag is the exact token `[<callName>]`, which
// `:Engine]` can never be.
//
// Every lane spells it through this ONE builder: two spellings of one contract is how a sweep stops
// matching what an install wrote, and an installed entry then reads as "missing from the book".
export function sectionEntryComment(artifactType, id, sectionName) {
    return '[' + (TYPE_PREFIX[artifactType] || 'GameLogicPack') + ':' + String(id || '') + ':' + String(sectionName || '') + ']';
}

// The panel declaration's entry (devdoc/side-panel-format.md). Here rather than in either feature because
// BOTH declare one: a GameLogic Plugin and a GameLogic Pack.
export function panelEntryComment(artifactType, id) {
    return sectionEntryComment(artifactType, id, 'Panel');
}

// The entry an install writes for a `panel` section — null when the artifact ships none, which is not
// a fault: an artifact with no display half is the ordinary case.
//
// `enabled: false` is load-bearing, not tidiness: this is data for a renderer on the main page and
// must never reach a prompt. The declaration is stored WHOLE and re-serialised pretty, so the
// installed copy is inspectable by hand and the renderer is handed the artifact rather than a
// summary of it.
export function planPanelEntry(artifactType, id, panel) {
    if (!panel || typeof panel !== 'object' || Array.isArray(panel)) return null;
    return {
        comment: panelEntryComment(artifactType, id),
        content: JSON.stringify(panel, null, 2),
        enabled: false, type: 'constant', key: [], keys: [],
    };
}

// ── the identity fields a registry records at install ────────────────────────
//
// The registry outlives the library file (the amber state), and the release export reads the registry,
// so what an artifact is CALLED is recorded where what it OWNS already is. One function serves both
// directions — building the record from the pack file at install, and carrying the fields through a
// registry parse: `name`/`description`/`format` always present (an absent one reads as ''),
// `builtWith`/`targetsPackId` only when the source has them (absent is "never declared", which an empty
// string would mis-state).
export function artifactIdentityRecord(source) {
    const src = (source && typeof source === 'object') ? source : {};
    const out = {
        name: String(src.name || ''),
        description: String(src.description || ''),
        format: String(src.format || ''),
    };
    if (src.builtWith !== undefined) out.builtWith = String(src.builtWith);
    if (src.targetsPackId !== undefined) out.targetsPackId = String(src.targetsPackId);
    return out;
}

// ── export: the recorded entries back off the card ───────────────────────────
//
// Uninstall deletes by needle and never needs content; export needs FULL records. This is the
// read-by-needle sibling of the delete-by-needle that exists: given the card's entries and the
// registry's recorded comments, return each recorded entry WHOLE — and name every comment the card
// no longer has, because export must REFUSE on a missing piece (shipping a silently incomplete
// artifact is the one outcome worse than not shipping) where uninstall would log and continue.
export function collectRecordedEntries(entries, recordedComments) {
    const list = Array.isArray(entries) ? entries : [];
    const found = [];
    const missing = [];
    for (const comment of (Array.isArray(recordedComments) ? recordedComments : [])) {
        const want = String(comment).toLowerCase();
        const hit = list.find((e) => String((e && e.comment) || '').toLowerCase() === want);
        if (hit) found.push(hit);
        else missing.push(String(comment));
    }
    return { found, missing };
}

// A card entry back to its pack-file shape: the ownership prefix off the comment, and the two
// fields install strips on the way IN (`uid`, `display_index` — the SOURCE book's identity) off the
// way out. Everything else ships verbatim: the card's copy is the tested truth, and entries[] in a
// pack file ARE TavernHelper LorebookEntry shapes.
export function exportedEntryFields(entry, prefix) {
    const { uid: _uid, display_index: _di, ...fields } = (entry && typeof entry === 'object') ? entry : {};
    const comment = String(fields.comment || '');
    const p = String(prefix || '');
    if (p && comment.toLowerCase().startsWith(p.toLowerCase())) fields.comment = comment.slice(p.length);
    return fields;
}

// ── export: the artifact file back from the card ─────────────────────────────
//
// The ONE export every JSON artifact type runs (GameLogic Pack, StatusMenu Pack, GameLogic Plugin), so a
// rule about exporting is written once. The record's own lists are the only thing walked (additive:
// nothing on the card outside them is read), the card's copies are the bytes shipped (the tested truth),
// and a recorded piece the card no longer has REFUSES BY NAME: uninstall may over-approximate on a
// mismatch, but export cannot invent, so it refuses. The caller re-validates and re-gates the result
// before offering the file — an export is not gate-free.
//
// The spine does, for every type: the identity header, the recorded entries (a panel section parsed back
// to `panel`), an owned engine's text, the recorded regex rows and their order. A type passes only what
// is its own:
//   identityFix       — how its user records a missing identity ("Repair the pack once …")
//   sections          — its other recorded comments that hold a SECTION, not an entry:
//                       { comment, field, json, label } (`json`: parse back; `label` names it in a refusal)
//   mapEntry          — reshape each exported entry (a plugin puts its tokens back)
//   engineText / engineSource — the owned engine's text, and where it was read, for the refusal
//   skipRegexNames    — recorded rows that are mvu-helper's, not the artifact's (the menu's marker-last row)
//   restoreRegexRows  — rows → { rows, problem }, for rows the card holds in another form (the menu's lift)
//   addTypeFields     — (pack, errors) => the type's own fields after the shared ones
// Returns { pack, errors }; pack is null whenever there is an error.
export function buildArtifactExportFile({
    artifactType, id, record, entries, identityFix,
    sections = [], mapEntry = null,
    engineText, engineSource = 'the engine entry',
    cardRegexes, skipRegexNames = [], restoreRegexRows = null,
    addTypeFields = null,
} = {}) {
    const errors = [];
    const rec = record || {};
    if (!rec.format) errors.push('the registry records no identity (name, description, format) — ' + identityFix + ', then export');

    const { format, name, description, ...declared } = artifactIdentityRecord(rec);
    const pack = { format, packType: artifactType, id, name, description, version: String(rec.ver || '0'), ...declared };

    const prefix = libraryEntryComment(artifactType, id) + ' ';
    const allSections = [{ comment: panelEntryComment(artifactType, id), field: 'panel', json: true, label: 'panel entry ' + panelEntryComment(artifactType, id) }, ...sections];
    const sectionByComment = new Map(allSections.map((s) => [String(s.comment).toLowerCase(), s]));
    const { found, missing } = collectRecordedEntries(entries, rec.installedComments);
    for (const m of missing) errors.push('recorded entry "' + m + '" is not on the card any more — export cannot invent it, so it refuses');
    const exportedEntries = [];
    for (const e of found) {
        const section = sectionByComment.get(String((e && e.comment) || '').toLowerCase());
        if (!section) {
            const fields = exportedEntryFields(e, prefix);
            exportedEntries.push(mapEntry ? mapEntry(fields) : fields);
            continue;
        }
        const content = String((e && e.content) || '');
        if (!section.json) { pack[section.field] = content; continue; }
        try { pack[section.field] = JSON.parse(content); }
        catch (err) { errors.push('the ' + section.label + ' no longer parses as JSON: ' + err.message); }
    }
    if (exportedEntries.length) pack.entries = exportedEntries;

    if (rec.engineOwned) {
        if (typeof engineText === 'string' && engineText) pack.engine = engineText;
        else errors.push('the registry records engine ownership but ' + engineSource + ' is empty or unreadable — export refuses rather than ship without it');
    }

    const skip = new Set(skipRegexNames.map(String));
    const regexNames = (Array.isArray(rec.installedRegexNames) ? rec.installedRegexNames : []).filter((n) => !skip.has(String(n)));
    if (regexNames.length) {
        const { rows, missing: missingRows } = exportRecordedRegexRows(cardRegexes, regexNames);
        for (const n of missingRows) errors.push('recorded regex "' + n + '" is not on the card any more — export cannot invent it');
        const restored = restoreRegexRows ? restoreRegexRows(rows) : { rows, problem: '' };
        if (restored.problem) errors.push(restored.problem);
        if (!missingRows.length && !restored.problem) pack.regex = restored.rows;
    }
    if (Array.isArray(rec.regexOrder)) pack.regexOrder = rec.regexOrder.map(String);

    if (addTypeFields) addTypeFields(pack, errors);
    return { pack: errors.length ? null : pack, errors };
}

// Inverse of libraryEntryComment — { packType, id } from a library entry's comment, or null when the
// comment is not a library entry at all. How a library listing is built from the book without a second
// registry. 'Registry' is NOT an artifact: `[GameLogicPack:Registry]` is a CARD book's bookkeeping
// entry, and returning it as an id here would list a phantom pack (and let a sweep treat it as
// installable). A second colon is a SECTION entry (`[GameLogicPlugin:rpg:Engine]`), never an artifact
// whose id is "rpg:Engine" — an id cannot carry a colon (rule 1). The field is named `packType`
// because every caller already speaks that word.
export function parseLibraryComment(comment) {
    const m = String(comment || '').trim().match(/^\[([A-Za-z]+):([^\]:]+)\]$/);
    if (!m) return null;
    if (m[2].toLowerCase() === 'registry') return null;
    const packType = ARTIFACT_TYPES.find((t) => TYPE_PREFIX[t].toLowerCase() === m[1].toLowerCase());
    return packType ? { packType, id: m[2] } : null;
}

// ── finding entries by comment (the ONE way anything here is addressed) ──────

// An entry is found by NAME, never by position, and the match is ANYWHERE in the comment — not
// `startsWith`: installing prefixes an entry's comment with its owner's tag, so a reader matching the
// head would miss every installed entry (small-llm call routing and roster DNA read these too).
//
// A needle is one of two things, and THIS predicate is the only place that knows which:
//   • a LOWERCASE substring — a whole comment, a registry marker, a call tag;
//   • a RegExp — the uninstall sweep (installedSweepNeedle), whose boundary after the id is one of
//     two characters and so cannot be a substring.
// Every reader here and the host's delete go through it, so a sweep COUNT can never disagree with
// what a delete then removes — the uninstall exactness report would otherwise lie in exactly the
// hand-edited case it exists to catch.
export function commentMatchesNeedle(comment, needle) {
    const c = String(comment || '').toLowerCase();
    if (needle instanceof RegExp) return needle.test(c);
    const n = String(needle || '').toLowerCase();
    return n !== '' && c.includes(n);
}

export function findEntryByNeedle(entries, needle) {
    if (!needle) return null;
    return (Array.isArray(entries) ? entries : []).find((e) => commentMatchesNeedle(e && e.comment, needle)) || null;
}

// Would writing `fields` over `existing` change anything? An upsert always writes, so "was it written"
// says nothing about whether the card MOVED — and the difference is what decides whether the rendered
// chat has to reload (sillytavern/chat-reload.js). Only the fields the caller is writing are compared:
// an entry carries host bookkeeping (uid, position, order, probability) nobody here is setting, and a
// difference there is not this write's doing. Order-blind on objects and exact on arrays — key order is
// not a change, element order is. (The regex lane answers the same question about a whole script with
// its own `scriptsEqual`; that one compares every field, this one a written subset.)
//   existing = null/undefined (a create) → true: there was no entry, so the card changes.
export function entryFieldsDiffer(existing, fields) {
    if (!existing) return true;
    const f = fields || {};
    return Object.keys(f).some((k) => canonicalFieldValue(f[k]) !== canonicalFieldValue(existing[k]));
}

function canonicalFieldValue(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalFieldValue).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalFieldValue(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

// Do the entries an installer is ABOUT to write differ from what the card holds now? Asked BEFORE the
// write, because an install that replaces a previous version DELETES its entries first — after that
// sweep every write is a create, and a per-write answer would call an identical re-apply a change.
// A comment the card had and the plan no longer carries is a change too: the entry is about to vanish.
export function plannedEntriesChanged(previousEntries, plannedEntries, previousComments = []) {
    const planned = Array.isArray(plannedEntries) ? plannedEntries : [];
    const plannedNeedles = planned.map((e) => String((e && e.comment) || '').toLowerCase());
    const dropped = (Array.isArray(previousComments) ? previousComments : [])
        .map((c) => String(c || '').toLowerCase())
        .some((c) => c && !plannedNeedles.some((n) => n === c || n.includes(c) || c.includes(n)));
    if (dropped) return true;
    return planned.some((entry) => entryFieldsDiffer(
        findEntryByNeedle(previousEntries, String((entry && entry.comment) || '').toLowerCase()), entry));
}

// Every comment in the book carrying `needle` — the read half of a needle sweep, returned VERBATIM
// (original case) because the exactness report compares it against the registry's recorded strings.
export function commentsMatchingNeedle(entries, needle) {
    if (!needle) return [];
    return (Array.isArray(entries) ? entries : [])
        .map((e) => String((e && e.comment) || ''))
        .filter((c) => commentMatchesNeedle(c, needle));
}

// ── registry text ────────────────────────────────────────────────────────────

// Strip '#' header lines, then JSON.parse what remains. THROWS on malformed JSON, and every caller
// must let it: a broken registry read as "nothing installed" would make the next sweep or init
// destructive off a typo. `whenEmpty` is the literal an EMPTY body parses as, and the two callers
// differ honestly — event-pack's registry is a MAP of packs ('{}' = none installed), a pack registry
// is ONE active record ('null' = no pack active), and neither may inherit the other's default.
//
// The SHAPE check stays with each caller: what a valid registry looks like is that feature's own
// vocabulary, and so is the sentence a user reads when it is wrong.
export function parseRegistryJson(raw, { whenEmpty = '{}' } = {}) {
    const text = String(raw || '');
    const body = text.split('\n').filter((ln) => !/^\s*#/.test(ln)).join('\n').trim();
    return JSON.parse(body || whenEmpty);
}

// Serialize a registry for its worldbook entry. Round-trips through parseRegistryJson — the '#' header
// line is stripped by its comment tolerance. `tabName` is the tab a user must go to, spelled the way
// the UI spells it, because this line is the only instruction someone hand-editing the entry will see.
export function buildRegistryText(comment, tabName, value) {
    return '# ' + comment + ' — tab-owned pack registry. Do not hand-edit; use the ' + tabName + ' tab.\n'
        + JSON.stringify(value || {}, null, 2);
}

// ── install / uninstall needles ──────────────────────────────────────────────

// The belt-and-braces uninstall sweep: every installed comment CARRIES the artifact's prefix, so one
// case-insensitive sweep catches entries whose registry record was lost. A RegExp, not a substring,
// because what follows the id is one of TWO characters — `]` on a prompt entry
// (`[GameLogicPack:rpg] Worldview`) and `:` on a section entry (`[GameLogicPack:rpg:Panel]`) — and
// either one is the boundary that stops id "rpg" sweeping "rpg-artific". No flags: commentMatchesNeedle
// lowercases the comment, and a `g` flag would make `.test` stateful across calls. The id is escaped
// because an event pack's carries dots.
export function installedSweepNeedle(artifactType, id) {
    const open = libraryEntryMatch(artifactType, id).slice(0, -1);   // '[gamelogicpack:rpg' — the ']' becomes one of the two boundaries
    return new RegExp(escapeRegExpLiteral(open) + '(?:\\]|:)');
}

function escapeRegExpLiteral(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// What an install must DELETE before it writes. Two needle sets, deliberately the same two uninstall
// uses, so an upgrade never leaves behind anything an uninstall would have removed:
//   • recorded — every comment the registry listed, so an entry RENAMED between versions cannot
//     survive under its old name;
//   • sweep    — the prefix needle, which also catches an entry whose comment was edited by hand (it
//     has fallen out of the recorded list) or left by a crashed earlier install.
// Returns the recorded comments lowercased for the case-insensitive delete, and the sweep as
// installedSweepNeedle builds it. Empty recorded set + sweep is still correct: the sweep alone is the
// belt-and-braces half.
export function preDeleteNeedles(registry, artifactType, artifactId) {
    const recorded = (registry && Array.isArray(registry.installedComments) ? registry.installedComments : [])
        .map((c) => String(c).toLowerCase());
    return { recorded, sweep: installedSweepNeedle(artifactType, artifactId) };
}

// Uninstall exactness: the registry's record and the book's reality must agree. `recorded` =
// installedComments; `swept` = the comments the needle sweep actually found. Disagreement in EITHER
// direction is reported, never hidden: onlyInRecord = entries someone hand-deleted (red LED case),
// onlyInSweep = entries the record lost (a crashed install) — both are the user's to know about.
export function uninstallExactness(recorded, swept) {
    const rec = new Set((recorded || []).map(String));
    const sw = new Set((swept || []).map(String));
    const onlyInRecord = [...rec].filter((c) => !sw.has(c));
    const onlyInSweep = [...sw].filter((c) => !rec.has(c));
    return { agree: onlyInRecord.length === 0 && onlyInSweep.length === 0, onlyInRecord, onlyInSweep };
}

// The registry's OWN removal, which is not part of the artifact's needle sweep. When the last artifact
// of a type leaves, its `[<Prefix>:Registry]` bookkeeping entry is deleted by a SECOND call, and its
// result decides what the uninstall line says. A registry that outlives its last artifact is not
// cosmetic: the next install reads it and finds a record whose entries do not exist.
//
// `wasPresent` must be read from the book BEFORE the delete — without it, 0 removed cannot be told
// apart from "there was nothing there", and warning on the benign case is how a warning stops being
// read. Returns 'removed' | 'absent' (nothing to do, say nothing) | 'failed' (say it loudly).
export function registryRemovalOutcome({ wasPresent, removedCount } = {}) {
    if (!wasPresent) return 'absent';
    return Number(removedCount) > 0 ? 'removed' : 'failed';
}

// ── LED ──────────────────────────────────────────────────────────────────────

// The four states every artifact tab shows, derived from four facts:
//   green — installed here, enabled, every recorded piece present
//   red   — the registry says installed but recorded pieces are MISSING (deleted by hand or by another writer; offer reinstall)
//   amber — installed and intact, but the LIBRARY copy is gone (still functional; the source is not)
//   grey  — not installed on this card, or installed and deliberately disabled
// `presentComments` = the card-book comments found by the sweep; missing = recorded minus present.
//
// ORDER IS THE DECISION, not a formality. MISSING beats DISABLED (a pack with pieces gone cannot run
// even if re-enabled), and DISABLED beats the library question (a switched-off pack's missing source is
// not what the user needs told). `isEnabled` defaults true for the artifact types with no disable switch.
//
// ── the REGEX dimension ──────────────────────────────────────────────────────
// A pack's pieces include REGEXES, and one deleted by hand in ST's regex editor must turn the LED red
// like a missing entry does — otherwise the game silently stops hiding a block while the LED stays green.
//
// TWO lists out, never one. `missing` holds entry COMMENTS and `missingRegexes` holds regex NAMES; they
// are different things, they are fixed differently (reinstall the entries vs re-run the regex install),
// and folding them into one array would make the UI name a "missing entry" that was never an entry.
//
// `regexReadable` defaults TRUE and exists for the "could not look" case: TavernHelper's regex API
// attaches after mvu-helper loads, so an unreadable surface reports an EMPTY present-list — which,
// compared against a full record, would turn every LED red on every reload. Absence of evidence is not
// evidence of absence; when it is false the regex half is SKIPPED, not failed. Same rule the script API
// follows in decideActivation.
//
// ── the OWNED SLOT dimension ─────────────────────────────────────────────────
// A slot is one named piece an install writes whole and records as its own: the game's [MVU_LogicEngine] entry and
// `Scheme` script, the menu's [MVU_StatusMenuEngine] entry. Other writers fill the same slot (the Development tab's
// engine uploads, LogicEngine's Remove engine, a plugin's own schema, a hand edit), so presence alone cannot say whose
// copy is there: the install records the slotFingerprint of the text it wrote, and the LED compares. An entry needs no
// fingerprint, since only its install writes under its name.
//
// `ownedSlots` are { name, isOwned, recordedFingerprint, text }, where `text` is what the slot holds now: null when it
// is empty, undefined when it could not be read (could not look, so that slot is skipped, as the regex half is). An
// owned slot that is empty is a missing piece, named in `missing`. One whose text does not match the recorded
// fingerprint has DRIFTED: it is still there, so the state does not change, and `drifted` names it for the card row's
// Drift pill. A record with no fingerprint matches no text, so its slot reads as drifted until an install records one.
export function slotFingerprint(text) {
    return hash36(String(text));
}
export function deriveArtifactLed({
    inLibrary, isActive, isEnabled = true, recordedComments, presentComments,
    recordedRegexNames, presentRegexNames, regexReadable = true, ownedSlots = [],
} = {}) {
    if (!isActive) return { state: 'grey', missing: [], missingRegexes: [], drifted: [] };
    const present = new Set((presentComments || []).map(String));
    const readSlots = (ownedSlots || []).filter((slot) => slot && slot.isOwned && slot.text !== undefined);
    const missing = [
        ...(recordedComments || []).map(String).filter((c) => !present.has(c)),
        ...readSlots.filter((slot) => slot.text === null).map((slot) => String(slot.name)),
    ];
    const drifted = readSlots
        .filter((slot) => slot.text !== null && slotFingerprint(slot.text) !== String(slot.recordedFingerprint || ''))
        .map((slot) => String(slot.name));
    const presentRegex = new Set((presentRegexNames || []).map(String));
    const missingRegexes = regexReadable
        ? (recordedRegexNames || []).map(String).filter((n) => !presentRegex.has(n))
        : [];
    if (missing.length || missingRegexes.length) return { state: 'red', missing, missingRegexes, drifted };
    const none = { missing: [], missingRegexes: [], drifted };
    if (!isEnabled) return { state: 'grey', ...none };
    if (!inLibrary) return { state: 'amber', ...none };
    return { state: 'green', ...none };
}

// ── the card row and the install toast — one rule for every lane ─────────────

// The past tense of an install action, for the success toast. Every lane's install returns one of
// these words; one table spells all of them.
const INSTALL_ACTION_DONE = {
    install: 'installed', activate: 'installed', reinstall: 'reinstalled', repair: 'repaired',
    upgrade: 'upgraded', downgrade: 'downgraded', switch: 'switched',
};
export function installActionDone(action) {
    const word = String(action || '');
    return INSTALL_ACTION_DONE[word] || word;
}

// Which install buttons an INSTALLED artifact's card row offers. The library row hides its Install
// button for an artifact already on the card, so these two are the way to run the install again:
//   repair  — pieces are missing (LED red), an owned slot holds another writer's copy (`drifted`, from the
//             LED), or the lane knows the install must run again (`needsReinstall` — a plugin on a card that
//             lost its schema), and the library holds a copy to install from. The install that runs decides
//             repair / upgrade / downgrade itself.
//   upgrade — the library copy is NEWER (compareVersions; validation makes every version comparable).
// No library copy → neither: there is nothing to install from. An older library copy offers neither:
// installing it is a downgrade, made by Uninstall then Install from the library.
export function cardRowInstallButtons({ ledState, libraryVersion, installedVersion, hasLibraryCopy, drifted = [], needsReinstall = false } = {}) {
    if (hasLibraryCopy !== true) return { repair: false, upgrade: false };
    if (ledState === 'red' || drifted.length > 0 || needsReinstall === true) return { repair: true, upgrade: false };
    return { repair: false, upgrade: compareVersions(String(libraryVersion || ''), String(installedVersion || '0')) > 0 };
}

// An artifact's first row line, on its library row and its card row: the version, then the id as a code chip.
export function artifactIdLine({ id, version } = {}) {
    return { parts: [{ name: `v${version || '?'} · ` }, { code: String(id || '?') }] };
}

// Where a lane's card group stops before its rows — one rule for the pack, plugin and menu groups. null: draw the rows.
// A card that cannot be written stops the group with nothing in it, since the page's notices already say why (the
// card gate's for no chat, the artifact tab's for an unreadable lorebook); a registry that will not parse stops it with
// a danger notice carrying the parse error.
export function cardGroupStop({ canOperateOnCard, registryError } = {}) {
    if (!canOperateOnCard) return { notice: null };
    if (registryError) return { notice: { text: 'Registry unreadable', status: 'danger', name: String(registryError) } };
    return null;
}

// What an INSTALLED artifact's card row says about its state — one rule for the pack, plugin and menu rows: its pills,
// and for the states a user must act on, the lines saying what to do (the panel's line shape, gui-dna-core.js). A red row
// counts its missing pieces and names the regexes among them, because the two are fixed in different places: a missing
// entry is a book problem, a missing regex is in SillyTavern's regex editor. An unknown state reads as red.
//
// DRIFT is a change since the install that is not a missing piece: an owned slot holding another writer's copy
// (`drifted`, the LED's slot names, worded here), or a lane's own findings (`drift`, lines the lane words: a plugin's
// bound call gone). Drift adds a Drift pill, which replaces Installed and never masks another state: missing pieces stay
// on the row beside it. `pill` is the first of `pills`, the state the page header names.
const ARTIFACT_ROW_PILLS = {
    green: { text: 'Installed', status: 'success' },
    grey: { text: 'Disabled', status: 'neutral' },
    red: { text: 'Pieces missing', status: 'danger' },
    amber: { text: 'No library copy', status: 'warning' },
};
const DRIFT_PILL = { text: 'Drift', status: 'warning' };
const NO_REPAIR_COPY_LINE = { text: 'The library has no copy to repair from: import it again, or uninstall it.' };
export function artifactRowStatus({ led, missing = [], missingRegexes = [], hasLibraryCopy = false, drifted = [], drift = [] } = {}) {
    const state = ARTIFACT_ROW_PILLS[led] ? led : 'red';
    const isDrifted = drifted.length > 0 || drift.length > 0;
    const pills = [...(isDrifted && state === 'green' ? [] : [ARTIFACT_ROW_PILLS[state]]), ...(isDrifted ? [DRIFT_PILL] : [])];
    return { pill: pills[0], pills, sub: [...stateLines(state, { missing, missingRegexes, hasLibraryCopy }), ...slotDriftLines(drifted, { hasLibraryCopy, isRed: state === 'red' }), ...drift] };
}
function stateLines(state, { missing, missingRegexes, hasLibraryCopy }) {
    if (state === 'amber') return [{ text: 'Not in the library: import it again to keep a copy a card rebuild cannot lose.' }];
    if (state !== 'red') return [];
    const regexCount = missingRegexes.length;
    const count = {
        parts: [
            { name: `${missing.length + regexCount} ` }, { text: 'pieces missing' },
            ...(regexCount ? [{ name: ` (${regexCount} ` }, { text: 'regex' }, { name: ')' }] : []),
        ],
    };
    return [count, hasLibraryCopy ? { text: 'Repair puts them back from the library.' } : NO_REPAIR_COPY_LINE];
}
// The drifted slots as one line, each a code chip, then what Repair does: a red row's own line already says it.
function slotDriftLines(drifted, { hasLibraryCopy, isRed }) {
    if (!drifted.length) return [];
    const names = drifted.flatMap((name, index) => [...(index ? [{ name: ', ' }] : []), { code: String(name) }]);
    const line = { parts: [{ text: 'Not what this install recorded:' }, { name: ' ' }, ...names] };
    if (isRed) return [line];
    return [line, hasLibraryCopy ? { text: 'Repair puts the library copy back.' } : NO_REPAIR_COPY_LINE];
}

// An installed artifact's card row from its LED (deriveArtifactLed) and its library copy: what it says (artifactRowStatus)
// and which install buttons it offers (cardRowInstallButtons), decided together so a drifted slot that shows Drift also
// offers its Repair. The pack and menu rows read it alike.
export function decideCardRow({ led, libraryCopy = null, installedVersion } = {}) {
    const hasLibraryCopy = Boolean(libraryCopy);
    return {
        status: artifactRowStatus({ led: led.state, missing: led.missing, missingRegexes: led.missingRegexes, drifted: led.drifted, hasLibraryCopy }),
        offer: cardRowInstallButtons({ ledState: led.state, drifted: led.drifted, hasLibraryCopy, libraryVersion: libraryCopy && libraryCopy.version, installedVersion }),
    };
}

// The questions every artifact lane asks the same way, as dialog lines (sillytavern/popup-core.js): a one-line
// question, the things it touches one per line, then one line per answer, which names the caller's button.

// Each question's buttons sit beside it, so its answer lines and its buttons cannot drift apart.
export const ADOPT_QUESTION_BUTTONS = { okButton: 'Replace', isDestructive: true };
export const DOWNGRADE_QUESTION_BUTTONS = { okButton: 'Downgrade', isDestructive: true };
export const LIBRARY_REMOVE_BUTTONS = { okButton: 'Remove', isDestructive: true };

// Before an install replaces copies the CARD owns (a "Scheme" script, a regex, an engine entry) — asked on the
// artifact tabs and by the dev loop. `surfaces` are the lane's dialog lines, one per copy; `answers` say what each
// button does (Replace, Cancel).
export function adoptQuestion({ artifactName, version, surfaces, answers } = {}) {
    return [
        { text: "Replace this card's own copies?" },
        { name: String(artifactName || '?') + ' v' + String(version || '?') },
        ...(Array.isArray(surfaces) ? surfaces : []),
        ...(Array.isArray(answers) ? answers : []),
    ];
}

// Before an install puts an OLDER library copy over the installed one.
export function downgradeQuestion({ artifactName, installedVersion, libraryVersion } = {}) {
    return [
        { text: 'Install the older version?' },
        { name: String(artifactName || '?') },
        { text: 'Installed:', name: 'v' + String(installedVersion || '?') },
        { text: 'Library copy:', name: 'v' + String(libraryVersion || '?') },
    ];
}

// Before a pack leaves the library — the Event Packs, GameLogic Packs and StatusMenu Packs tabs ask it the same way.
export function libraryRemoveQuestion(id) {
    return [
        { text: 'Remove this pack from the library?' },
        { name: String(id || '?') },
        { text: 'Cards that have it installed keep working.' },
        { text: 'A rebuilt card can no longer get it back from here.' },
    ];
}

// A plugin's FLAVOR is its `requires` and nothing else. One required interface makes it GAME-BOUND: it
// installs only where the active GameLogic Pack exposes every interface it requires. None makes it
// STANDALONE: it installs on any card, with or without a game. No field names the flavor: a second
// spelling could disagree with what install enforces. Read by the plugin's install refusal, its library
// and card rows, and packInfo().
export const PLUGIN_FLAVOR_GAME_BOUND = 'game-bound';
export const PLUGIN_FLAVOR_STANDALONE = 'standalone';
export function pluginFlavorSummary(plugin) {
    const needs = (plugin && Array.isArray(plugin.requires)) ? plugin.requires.map(String) : [];
    return { flavor: needs.length ? PLUGIN_FLAVOR_GAME_BOUND : PLUGIN_FLAVOR_STANDALONE, needs };
}
// The flavor as a plugin's library row and card row show it, as a line: "standalone", or "game-bound — needs cast@1"
// with each required interface as a code chip.
export function pluginFlavorLine(plugin) {
    const { needs } = pluginFlavorSummary(plugin);
    if (!needs.length) return { parts: [{ text: 'standalone' }] };
    const interfaces = needs.flatMap((name, index) => [...(index ? [{ name: ', ' }] : []), { code: name }]);
    return { parts: [{ text: 'game-bound' }, { name: ' — ' }, { text: 'needs' }, { name: ' ' }, ...interfaces] };
}
