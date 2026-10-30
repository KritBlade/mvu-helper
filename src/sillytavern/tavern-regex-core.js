// sillytavern/tavern-regex-core.js — PURE TavernHelper-regex helpers (zero imports, zero globals), so they
// load under vitest. The I/O glue that calls getTavernRegexes/updateTavernRegexesWith lives in
// sillytavern/tavern-regex.js and delegates every DECISION here (mirrors the tavern-script.js ↔
// tavern-script-core.js split, and for the same L6 reason: a host-coupled file cannot be tested at all).
//
// Shape reference (JS-Slash-Runner @types/function/tavern_regex.d.ts, TavernRegex):
//   { id, script_name, enabled, find_regex, replace_string, trim_strings,
//     source: { user_input, ai_output, slash_command, world_info, reasoning },
//     destination: { display, prompt }, run_on_edit, min_depth, max_depth }
// This is NOT the shape a character card stores on disk (that one is `scriptName` / `findRegex` /
// `placement:[2]` / `markdownOnly`). TavernHelper converts between them; we speak ONLY the API shape, so
// nothing here has to know ST's placement enum.
//
// ⚠ IDENTITY IS `script_name`, NOT `id`. A pack is installed on many cards and `id` is per-installation,
// so matching on it would make every reinstall a duplicate. Names are also what a user sees in ST's regex
// editor, which is what makes an install auditable by hand.

// The regex list is flat — unlike scripts, there are no folders. Kept as its own function anyway so callers
// read the same way in both files, and so a non-array from the host yields [] instead of throwing.
export function regexList(regexes) {
    return Array.isArray(regexes) ? regexes.filter((r) => r && typeof r === 'object') : [];
}

// Every script_name in a list, in order. Duplicates are PRESERVED — the caller deciding "is this name
// already here" and the caller reporting "this card has two of these" need different answers.
export function regexNames(regexes) {
    return regexList(regexes).map((r) => String(r.script_name || ''));
}

// The first regex with this exact name, or null. Case-SENSITIVE, same reasoning as findScriptByName: the
// name is a contract with the pack author, and ST treats two casings as two different regexes — silently
// matching both would let one of them claim to be the one we manage.
export function findRegexByName(regexes, name) {
    const wanted = String(name || '');
    if (!wanted) return null;
    return regexList(regexes).find((r) => String(r.script_name || '') === wanted) || null;
}

// Fill a pack-supplied regex out to the full TavernRegex shape. A pack may write only what it means
// (`script_name` + `find_regex` + where it applies) and inherit the rest, because every omitted field here
// has an unambiguous inert default — an empty replacement, no trimming, no depth window.
//
// `source`/`destination` MERGE onto the defaults rather than replacing them, so a pack that names one flag
// does not silently switch the others off. The defaults are ST's own for a new regex: applies to AI output,
// affects the DISPLAY only. A pack that wants a prompt-side regex must say `destination.prompt`, which is
// the one decision that must never be inherited by accident — it changes what the model reads.
export function normalizeTavernRegex(raw, newId) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const src = (r.source && typeof r.source === 'object') ? r.source : {};
    const dst = (r.destination && typeof r.destination === 'object') ? r.destination : {};
    return {
        id: String(r.id || newId || ''),
        script_name: String(r.script_name || ''),
        enabled: r.enabled !== false,
        find_regex: String(r.find_regex || ''),
        replace_string: String(r.replace_string == null ? '' : r.replace_string),
        trim_strings: Array.isArray(r.trim_strings) ? r.trim_strings.map(String) : [],
        source: {
            user_input: src.user_input === true,
            ai_output: src.ai_output === undefined ? true : src.ai_output === true,
            slash_command: src.slash_command === true,
            world_info: src.world_info === true,
            reasoning: src.reasoning === true,
        },
        destination: {
            display: dst.display === undefined ? true : dst.display === true,
            prompt: dst.prompt === true,
        },
        run_on_edit: r.run_on_edit === undefined ? true : r.run_on_edit === true,
        min_depth: r.min_depth === undefined ? null : r.min_depth,
        max_depth: r.max_depth === undefined ? null : r.max_depth,
    };
}

// Upsert BY NAME into a list, returning a NEW list (the input is never mutated — updateTavernRegexesWith
// hands us the live array, and mutating it in place would make a failed write half-applied).
//
// Update KEEPS THE EXISTING `id`: it is that installation's identity, and ST's own editor holds references
// to it. Position is kept too — the list order IS the apply order (the .d.ts says so explicitly), so moving
// a regex on update would change which pattern sees the text first. Create appends at the end.
export function upsertRegexInList(regexes, regex, newId) {
    const name = String((regex && regex.script_name) || '');
    const list = regexList(regexes);
    if (!name) return { list, created: false };

    let found = false;
    const mapped = list.map((node) => {
        if (String(node.script_name || '') !== name) return node;
        found = true;
        return { ...normalizeTavernRegex(regex, node.id), id: node.id };
    });
    if (found) return { list: mapped, created: false };
    return { list: [...mapped, normalizeTavernRegex(regex, newId)], created: true };
}

// Upsert MANY in one pass. Exists because every write reaches ST through replaceTavernRegexes, which
// RELOADS the whole chat — so a per-regex loop would reload it once per regex. Returns the counts so the
// caller's log can say created vs updated without asking again.
export function upsertRegexesInList(regexes, incoming, idFor) {
    let list = regexList(regexes);
    let created = 0;
    let updated = 0;
    (Array.isArray(incoming) ? incoming : []).forEach((regex, i) => {
        const res = upsertRegexInList(list, regex, typeof idFor === 'function' ? idFor(i) : '');
        list = res.list;
        if (res.created) created++; else updated++;
    });
    return { list, created, updated };
}

// Remove every regex whose name is in `names`, returning { list, removed } (count). Names not present are
// simply not found — removing what is already gone is the uninstall's normal case after a hand-edit.
export function removeRegexesByName(regexes, names) {
    const wanted = new Set((Array.isArray(names) ? names : []).map(String).filter(Boolean));
    if (!wanted.size) return { list: regexList(regexes), removed: 0 };
    let removed = 0;
    const list = regexList(regexes).filter((r) => {
        if (!wanted.has(String(r.script_name || ''))) return true;
        removed++;
        return false;
    });
    return { list, removed };
}

// One install pass: drop the names a previous version wrote that this one no longer ships, then upsert what
// it does. ONE function because it must be ONE host write — every write reloads the chat, so doing the
// removal and the upsert as two calls would reload it twice and, in the window between them, leave the card
// with the old regexes gone and the new ones not yet there.
//
// `removeNames` is filtered against `incoming` first: a name in BOTH lists is a regex the new version still
// ships, and removing-then-adding it would throw away the id ST's editor holds. Order is remove-then-upsert
// so a renamed-away regex cannot be resurrected by its own stale entry.
export function syncRegexesInList(regexes, incoming, removeNames, idFor) {
    const keep = new Set((Array.isArray(incoming) ? incoming : [])
        .map((r) => String((r && r.script_name) || '')).filter(Boolean));
    const drop = (Array.isArray(removeNames) ? removeNames : []).map(String).filter((n) => n && !keep.has(n));
    const cleaned = removeRegexesByName(regexes, drop);
    const res = upsertRegexesInList(cleaned.list, incoming, idFor);
    return { list: res.list, created: res.created, updated: res.updated, removed: cleaned.removed, droppedNames: drop };
}

// §8 for the regex lane: which of the names this pack wants are ALREADY on the card without the registry
// recording them as ours? Those are the CARD's own regexes, and a pack never silently overwrites one —
// same rule the engine entry and the `Scheme` script already follow, for the same reason: the user wrote
// it, we did not, and an overwrite is unrecoverable from inside ST.
//
// `ownedNames` is what the registry recorded, so a REPAIR or UPGRADE of the same pack is not a conflict:
// it is us meeting our own previous write.
//
// Takes NAMES on every side, not regex objects. Every caller already holds names — the card's come from
// listRegexNames, the pack's from its own `script_name`s, ours from the registry — so accepting objects
// here would make one of the three convert, and the one that forgot would silently compare an empty list
// and wave every collision through. (It did, until a test caught it.)
export function conflictingRegexNames(existingNames, wantedNames, ownedNames) {
    const present = new Set((Array.isArray(existingNames) ? existingNames : []).map(String).filter(Boolean));
    const ours = new Set((Array.isArray(ownedNames) ? ownedNames : []).map(String));
    return (Array.isArray(wantedNames) ? wantedNames : [])
        .map(String)
        .filter((name) => present.has(name) && !ours.has(name));
}

// Uninstall exactness for the regex lane — what the registry RECORDED vs what is actually on the card,
// compared before deleting so both sides of a mismatch can be named. Deliberately NOT reusing
// uninstallExactness from card-artifact-store.js: that one compares lorebook COMMENTS found by a needle
// sweep, and there is no needle here — a regex carries no prefix we own, so the recorded list is the only
// handle. Same shape as its return value so the two reports read alike.
export function regexUninstallExactness(recordedNames, presentNames) {
    const recorded = (Array.isArray(recordedNames) ? recordedNames : []).map(String);
    const present = new Set((Array.isArray(presentNames) ? presentNames : []).map(String));
    const onlyInRecord = recorded.filter((n) => !present.has(n));
    return { agree: onlyInRecord.length === 0, onlyInRecord, onlyInSweep: [] };
}

// Export's read-by-name sibling of the check above: each RECORDED regex back off the card as pack data,
// and every recorded name the card no longer has. `id` is dropped because it is this installation's
// identity, never pack data. Export refuses on a missing name, so the caller gets both lists.
export function exportRecordedRegexRows(regexes, recordedNames) {
    const rows = [];
    const missing = [];
    for (const name of (Array.isArray(recordedNames) ? recordedNames : [])) {
        const hit = findRegexByName(regexes, name);
        if (!hit) { missing.push(String(name)); continue; }
        const { id: _id, ...row } = hit;
        rows.push(row);
    }
    return { rows, missing };
}

// ── the pack's shape → SillyTavern's own shape (§11, 2026-08-24) ─────────────────────────────────────
// Pack files declare regexes in TavernHelper's vocabulary (`script_name`, `source`, `destination`), which
// is the shape normalizeTavernRegex above produces. SillyTavern stores something different on the card:
// `scriptName`, a `placement` array of numeric slots, and INVERTED `disabled`. Writing a card through
// SillyTavern's own API — which is the only workflow guaranteed to keep working — means converting here.
//
// This mirrors TavernHelper's `from_tavern_regex` deliberately and is checked against it, because the two
// have to agree: a card written by us and a card written by its editor must be the same card. Placement
// slots are SillyTavern's `regex_placement` enum (USER_INPUT 1 · AI_OUTPUT 2 · SLASH_COMMAND 3 ·
// WORLD_INFO 5 · REASONING 6); the caller passes the live enum so this stays a pure function and cannot
// drift from a hardcoded copy of numbers that belong to the host.
export function toSillyTavernRegex(tavernRegex, placement) {
    const r = tavernRegex || {};
    const src = r.source || {};
    const dst = r.destination || {};
    const p = placement || {};
    const slots = [];
    if (src.user_input) slots.push(p.USER_INPUT);
    if (src.ai_output) slots.push(p.AI_OUTPUT);
    if (src.slash_command) slots.push(p.SLASH_COMMAND);
    if (src.world_info) slots.push(p.WORLD_INFO);
    if (src.reasoning) slots.push(p.REASONING);
    return {
        id: String(r.id || ''),
        scriptName: String(r.script_name || ''),
        disabled: r.enabled === false,               // INVERTED — the one field a careless copy gets wrong
        runOnEdit: r.run_on_edit !== false,
        findRegex: String(r.find_regex || ''),
        trimStrings: Array.isArray(r.trim_strings) ? r.trim_strings.map(String) : [],
        replaceString: String(r.replace_string == null ? '' : r.replace_string),
        placement: slots.filter((s) => s !== undefined),
        substituteRegex: 0,
        minDepth: r.min_depth === undefined ? null : r.min_depth,
        maxDepth: r.max_depth === undefined ? null : r.max_depth,
        markdownOnly: dst.display !== false,
        promptOnly: dst.prompt === true,
    };
}

// Merge a converted list into the card's OWN scoped scripts, by scriptName. Same rules the TavernHelper
// path used and for the same reasons: update keeps the existing `id` and POSITION (list order is apply
// order), create appends, and anything the card owns that we do not name is left exactly where it is.
// `removeNames` drops what a previous pack version installed and this one no longer ships.
export function mergeScopedScripts(current, incoming, removeNames, idFor, { declaredOrder } = {}) {
    // No defensive copy here on purpose: the filter below already returns a NEW array, so `current` is
    // never touched. A slice() would read like a guard while guarding nothing.
    const list = Array.isArray(current) ? current : [];
    const drop = new Set((Array.isArray(removeNames) ? removeNames : []).map(String).filter(Boolean));
    const keep = new Set((Array.isArray(incoming) ? incoming : []).map((r) => String((r && r.scriptName) || '')));
    let removed = 0;
    const out = list.filter((r) => {
        const name = String((r && r.scriptName) || '');
        if (drop.has(name) && !keep.has(name)) { removed++; return false; }
        return true;
    });
    let created = 0;
    let updated = 0;
    for (const item of (Array.isArray(incoming) ? incoming : [])) {
        const name = String((item && item.scriptName) || '');
        if (!name) continue;
        const at = out.findIndex((r) => String((r && r.scriptName) || '') === name);
        if (at < 0) { out.push({ ...item, id: item.id || (idFor ? idFor() : '') }); created++; continue; }
        if (scopedScriptUnchanged(out[at], item, idFor)) continue;
        out[at] = { ...item, id: out[at].id || item.id || (idFor ? idFor() : '') };
        updated++;
    }
    // W9 — a pack that DECLARES its internal order gets it applied: the pack's own rows are placed
    // across the index slots those rows already occupy, in the declared sequence. Foreign rows never
    // move (the pack owns its internal order, not the card's list), which is also why position stays
    // sticky for every pack that declares nothing — the declaration is the opt-in, its absence is
    // not a weaker version of it. `reordered` is its own count because a pure reorder changes no
    // field: without it the caller's unchanged-check would skip the save and the order would never
    // land — and WITH it the operation still terminates, because the write makes declared == card
    // and the next merge counts zero.
    let reordered = 0;
    const wanted = (Array.isArray(declaredOrder) ? declaredOrder : []).map(String).filter(Boolean);
    if (wanted.length) {
        const inDeclared = new Set(wanted);
        const slots = [];
        const rows = new Map();
        out.forEach((r, i) => {
            const name = String((r && r.scriptName) || '');
            if (inDeclared.has(name)) { slots.push(i); rows.set(name, r); }
        });
        // Only names actually present participate — a declared name with no row (possible when the
        // caller passes an order wider than this write) is skipped rather than leaving a hole.
        const present = wanted.filter((n) => rows.has(n));
        present.forEach((name, k) => {
            const slot = slots[k];
            if (String((out[slot] && out[slot].scriptName) || '') !== name) { out[slot] = rows.get(name); reordered++; }
        });
    }
    return { list: out, created, updated, removed, reordered };
}

// Would writing `incoming` over the card's copy change anything? THE rule an update is counted by, and
// the only place it is spelled out — mergeScopedScripts asks it to decide whether to write, and the §11
// adoption check asks it to decide whether a regex the card already carries is one the pack would have
// written anyway. Two callers, one rule, deliberately: an adoption test that compared even slightly
// differently would claim ownership of a regex the user actually wrote, which is the exact overwrite §11
// exists to prevent.
//
// The card's copy keeps its id, because that is what the write does — so a re-apply of the same version
// compares equal and is not a write, which is what lets the caller skip the save AND the chat reload
// behind it. The engine sink byte-compares before restarting the Worker for the same reason.
export function scopedScriptUnchanged(cardScript, incomingScript, idFor) {
    if (!cardScript || !incomingScript) return false;
    const next = { ...incomingScript, id: cardScript.id || incomingScript.id || (idFor ? idFor() : '') };
    return scriptsEqual(cardScript, next);
}

// Of the names `incoming` would write, which are ALREADY on the card byte for byte? The §11 half of
// adoption: a card built outside mvu-helper carries the pack's own regexes with no registry recording
// them, and claiming one whose bytes match writes nothing and loses nothing.
//
// Names absent from the card are NOT returned — there is nothing there to adopt. Both sides are in
// SillyTavern's scoped-script shape, because that is the shape the write compares in.
export function unchangedScopedNames(current, incoming) {
    const list = Array.isArray(current) ? current : [];
    const out = [];
    for (const item of (Array.isArray(incoming) ? incoming : [])) {
        const name = String((item && item.scriptName) || '');
        if (!name) continue;
        const card = list.find((r) => String((r && r.scriptName) || '') === name);
        if (card && scopedScriptUnchanged(card, item)) out.push(name);
    }
    return out;
}

// Two scripts are the same when every field reads the same, key order aside — the shape is plain JSON
// (SillyTavern's own scoped-script record), so a canonical stringify is an exact comparison.
export function scriptsEqual(a, b) {
    return canonical(a) === canonical(b);
}
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

// Which of the names we asked for are NOT on the card. The whole verification reduces to this, and it is
// pure so it can be tested without a host — the L6 rule: a decision that lives only inside an I/O function
// is a decision no test can reach.
export function missingScriptNames(wantedNames, namesOnCard) {
    const have = new Set((Array.isArray(namesOnCard) ? namesOnCard : []).map(String));
    return (Array.isArray(wantedNames) ? wantedNames : []).map(String).filter((n) => n && !have.has(n));
}

// The mirror of missingScriptNames, for the other direction: which of the names we asked to REMOVE are
// STILL on the card. An install is wrong when a name is absent; an uninstall is wrong when one is present.
// Both directions need checking for the same reason — a removal that quietly failed leaves the card
// running a regex from a pack version that no longer exists, and nothing else would ever say so.
export function presentScriptNames(unwantedNames, namesOnCard) {
    const have = new Set((Array.isArray(namesOnCard) ? namesOnCard : []).map(String));
    return (Array.isArray(unwantedNames) ? unwantedNames : []).map(String).filter((n) => n && have.has(n));
}

// ── WHICH DIRECTION IS "WRONG"? ─────────────────────────────────────────────────────────────────────
// The install and the uninstall verify the card with the SAME routine and differ only in what counts as a
// defect, so that difference is data — and it lives out here, in the pure half, because a decision inside
// the host-coupled writer is a decision no test can open (L6). Getting these two backwards would be
// invisible: an uninstall would "verify" by demanding the names it just deleted still be present, repair
// them back onto the card, and report success for putting back exactly what it was asked to remove.
export const VERIFY_INSTALL = {
    offendersOn: missingScriptNames,
    lost: (n) => n + ' regex(es) did NOT reach the card',
    stuck: (n) => 'the card STILL lacks ' + n + ' regex(es) after re-asserting',
    fixed: (n) => 'the lost write was repaired — all ' + n + ' regex(es) are on the card',
};
export const VERIFY_REMOVAL = {
    offendersOn: presentScriptNames,
    lost: (n) => n + ' regex(es) were NOT removed from the card',
    stuck: (n) => 'the card STILL carries ' + n + ' regex(es) we removed, after re-asserting',
    fixed: (n) => 'the lost removal was repaired — all ' + n + ' regex(es) are off the card',
};
