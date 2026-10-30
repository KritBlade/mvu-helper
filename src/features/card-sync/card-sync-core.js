// card-sync/card-sync-core.js — PURE, host-free logic for the card→save data sync.
//
// THE PROBLEM IT SOLVES: MVU reads a book's `[InitVar]` ONCE per chat (it records the book in
// `initialized_lorebooks` and never re-reads it), so a running game never sees data added in a later
// version — new event trigger rows, new quest definitions, new characters. This lane re-applies the
// card's OWN `[InitVar]` on every chat load, so a content creator authors exactly what every MVU card
// carries and nothing mvu-helper-specific.
//
// PAYLOAD:  { "version": "M.m.r", "seed": { <the parsed [InitVar] tree> }, "force": { "<dotted.path>": <value> },
//             "forceFromInitVar": ["<dotted.path>"] }
//
// THREE HALVES, each with its own rule (plans/character-registry-in-state.md §4 names them):
//   seed    — the `[InitVar]` tree, create-only at EVERY depth (mergeInitSubtree): a key is written only
//     when ABSENT, so player edits and live state always survive, and missing containers are created on
//     the way (that IS the upgrade case). UNGATED — it runs on EVERY chat load, which is safe because
//     create-only is idempotent: a save that already has everything takes ZERO writes. Its job is DATA,
//     not shape: Zod backfills every declared key from its own `.prefault(...)`, but cannot supply the rows
//     inside a `z.record` container.
//   re-seed — under mvu-helper's own root only (reseedOwnRoot): a value the card seeded and the chat never
//     changed takes the card's newer value, tracked by the fingerprints of what the seed last wrote, kept in
//     the state itself. A game root changes in play, so it stays create-only. Ungated, every load.
//   force   — overwrites a value that is already PRESENT and wrong, from two lists the card's pack supplies.
//     WATERMARK-GATED, because overwriting a player's save must happen once per version, never per load; each
//     list keeps its own watermark (applyDataSync says why). For DEFINITION-class paths only. Supplied by whoever
//     owns the card registry, registered rather than imported (P5) — this file must not know that a pack feature
//     exists.
//       force            — a FLAT map of absolute dotted path → value, written unconditionally, wholesale.
//       forceFromInitVar — dotted paths that take the card's own [InitVar] value, so the card carries one copy.
//         A table (a plain object) goes row by row: each row the card carries replaces the save's row of that
//         key when the two differ beyond the empty fields a schema fills in, and a row the card does not carry is
//         never deleted, because another developer's event pack may have installed it. Any other value is
//         replaced whole. It runs before the literal map, so a value written there wins on a shared path.
//   version — gates the force lists ONLY; the caller supplies and stamps the watermarks (sillytavern/chat-metadata.js).
//
// `$meta` extensibility declarations are inert on any card with a Zod schema: mvu_zod overwrites MVU's
// schema with MVU's own disable sentinel, so MVU's derived schema gates nothing.
//
// Everything here is a plain function with no ST/globals (unit-tested in tests/card-sync-core.test.js);
// its imports are the ownerless primitives in shared/ and mvu-helper's own root name. The I/O glue (lorebook
// fetch, MVU blob read/write, hooks) lives in card-sync/card-sync.js and delegates to these.
import { compareVersions } from '../../shared/version-compare.js';
import { ensurePath, deepClone, isPrototypeKey } from '../../shared/object-path.js';
import { mergeInitSubtree } from '../../shared/create-only-merge.js';
import { deepEqual } from '../../shared/deep-equal.js';
import { hash36 } from '../../shared/string-hash.js';
import { MVUHELPER_STAT_ROOT } from '../../sillytavern/mvu-bridge-core.js';

// The needle of `[MVU_Update_Data]`, an entry older installs wrote as a copy of `[InitVar]`. Nothing reads one;
// the sync names a stale one as ignored rather than let it look load-bearing.
export const RETIRED_UPDATE_ENTRY_MATCH = '[mvu_update_data]';


// The fields mvu-helper stamps a save's taken versions under, inside its OWN chat-metadata namespace
// (sillytavern/chat-metadata.js) — never inside a consumer's state tree, whose roots are not the platform's to
// create. One per force list (applyDataSync says why they are apart).
export const WATERMARK_FIELD = 'dataSyncVer';                                // string "M.m.r" — the literal force map
export const FORCE_FROM_INITVAR_WATERMARK_FIELD = 'forceFromInitVarVer';     // string "M.m.r" — the forceFromInitVar paths

// ── the not-ready retry (§12a.1 — the hole phase GE closes) ──────────────────

// THE DEFECT THIS EXISTS FOR, found by reading during the GE diagnosis: a sync can stand down with a
// RETRYABLE verdict ("lorebook not ready", "MVU not ready") and, mid-session, have NOTHING re-run it.
// The bounded retry lived only in index.js's initial-load kick, which fires once at extension init —
// so a chat that lost the race after that point simply played without its pack rows, silently.
// §4a's rule is that a rebuild which quietly does not run is indistinguishable from state that was
// never card-level at all, so every not-ready verdict must schedule its own next attempt.
//
// ⚠ "no stat_data" is NOT one of them, and treating it as one is a bug this file already shipped once
// (live, 2026-08-15): MVU's own initializer is bound to GENERATION_STARTED / MESSAGE_SENT, NOT to
// CHAT_CHANGED — so a brand-new chat has no variables at all until the first turn, by MVU's design.
// Retrying that for 15 s and then warning "this chat is running WITHOUT its card payload" fires on
// EVERY new chat and is false: nothing is missing, the state does not exist yet, and the
// mag_variable_initialized hook syncs the moment it does. A waiting-for-an-event verdict must stand
// down quietly; only a RACE is worth retrying.
//
// THE BUDGET IS MEASURED, NOT GUESSED. The kick's old 10 × 1500 ms ≈ 15 s was a coin flip on this
// install: V29 clocked the TavernHelper script API taking 14 358 ms to attach, and `window.Mvu` (an
// iframe-exposed global) lands AFTER it — live 2026-08-15, a reload + card open burned all ten
// attempts on "MVU not ready" and then warned, with MVU up seconds later. 20 × 1500 ms ≈ 30 s clears
// the measurement with margin. Overshooting is free: the loop exits the moment a real verdict lands,
// and (since the retry runs in the background) a long budget delays nothing.
export const SYNC_RETRY_MAX_ATTEMPTS = 20;
export const SYNC_RETRY_DELAY_MS = 1500;

// A RACE, and only a race: some host surface (ST, TavernHelper, MVU) is not attached YET, and the very
// same call will succeed a moment later. These are the reasons card-sync.js produces for that state.
const RETRYABLE_SKIP_RE = /MVU not ready|lorebook not ready|chat changed mid-sync/;
export function isRetryableSkip(result) {
    return Boolean(result && result.skipped && RETRYABLE_SKIP_RE.test(result.reason || ''));
}

// WAITING FOR AN EVENT, not losing a race. A chat that has never been played has NO MVU variables and
// will not grow any until the first turn, because MVU's initializer hooks GENERATION_STARTED /
// MESSAGE_SENT. Retrying cannot help and the give-up warning would be false. Logged, never retried.
// It never overlaps the race above: a reason that matched both would make the retry chain's behaviour
// depend on check ORDER, which is exactly the kind of silent coupling that produced the bug above.
const AWAITING_MVU_INIT_RE = /no stat_data/;
export function isAwaitingMvuInit(result) {
    return Boolean(result && result.skipped && AWAITING_MVU_INIT_RE.test(result.reason || ''));
}

// Should this verdict be tried again, and when? PURE so the decision is reachable (L6) — the caller
// owns the clock and the awaits.
//   retryable   — isRetryableSkip(result): a NOT-READY stand-down, never a real verdict
//   attempt     — how many attempts have already run (1 after the first)
//   superseded  — a newer chain started (chat switched): this one must stop, silently. The new chat's
//                 own sync is now the authority, and a stale chain retrying against it is how a
//                 payload lands in the wrong save.
// Returns { retry, delayMs, giveUp } — giveUp marks the ONE transition worth a warning, so a chain
// that succeeds or is superseded never cries wolf.
export function planSyncRetry({ retryable, attempt, superseded = false, maxAttempts = SYNC_RETRY_MAX_ATTEMPTS, delayMs = SYNC_RETRY_DELAY_MS } = {}) {
    if (superseded) return { retry: false, delayMs: 0, giveUp: false };
    if (!retryable) return { retry: false, delayMs: 0, giveUp: false };
    if (attempt >= maxAttempts) return { retry: false, delayMs: 0, giveUp: true };
    return { retry: true, delayMs, giveUp: false };
}

// ── payload parsing ──────────────────────────────────────────────────────────

// Assemble what the apply half takes, from the TWO sources that now feed it. Pure, so the assembly
// rules stay reachable after the parsing itself left this file.
//
// WHY THERE IS NO PARSER HERE ANY MORE. The seed used to be JSON we parsed out of our own entry; it is
// now the card's `[InitVar]`, and that is MVU's format, not ours — JSON5 (comments, trailing commas),
// an optional `<initvar>…</initvar>` wrapper OR a ``` fence, `{{macro}}` substitution, and MERGE across
// several entries. Re-implementing that is how a platform drifts from the format it claims to support,
// so the host half asks MVU to parse its own format (`Mvu.reloadInitVar` against a throwaway object)
// and hands the result in here. Measured: that call reads books only, leaves the live chat untouched,
// and returns the merged tree.
//
//   seed             — the parsed `[InitVar]` tree. Ungated, create-only at every depth.
//   force            — the pack's `state.force`, and
//   forceFromInitVar — the pack's `state.forceFromInitVar`, both supplied by whoever owns the card registry
//                      (registered, not imported: card-sync must not know a pack feature exists — P5).
//   version          — gates both force lists ONLY. Absent ⇒ '0', which no real version can fail to outrank,
//                      so a card with no force lane simply never forces and never stamps.
export function buildSyncPayload({ seed = null, force = null, forceFromInitVar = null, version = '' } = {}) {
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    return {
        version: String(version == null ? '' : version).trim() || '0',
        seed: obj(seed),
        force: obj(force),
        forceFromInitVar: Array.isArray(forceFromInitVar) ? forceFromInitVar.map(String) : [],
    };
}

// ── the re-seed (mvu-helper's own root) ──────────────────────────────────────
//
// A value the card seeded under mvu-helper's root (the character registry …) that the chat never changed takes
// the card's newer value; one the chat changed is kept. A leaf is any value that is not a plain object: a string,
// a number, an array such as a character's aliases. What the seed last wrote at each leaf is remembered as a
// fingerprint, in a mirror of the seeded tree kept in the state at `$mvuhelper.seed_fingerprints`, so a swipe or a
// rewind restores the fingerprints with the values they describe, and a key holding a dot cannot blur a path.
// Each pass, per seeded leaf:
//   equal to the seed                       → the seed's fingerprint is recorded (MVU's own seeding wrote it, or a
//                                             Reset to the card's look put it back)
//   equal to its fingerprint, seed differs  → untouched by the chat: the seed's value replaces it, and its print
//   anything else                           → changed in this chat: kept, with the fingerprint it had
//   a fingerprint whose leaf the seed no longer carries is dropped.
export const SEED_FINGERPRINTS_PART = 'seed_fingerprints';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fingerprintOf = (value) => hash36(JSON.stringify(value));

// Every leaf under `node`, as { path: [segments], value }.
function leavesOf(node, path = [], out = []) {
    for (const key of Object.keys(node)) {
        if (isPrototypeKey(key)) continue;
        const value = node[key];
        if (isPlainObject(value)) leavesOf(value, [...path, key], out);
        else out.push({ path: [...path, key], value });
    }
    return out;
}

// { value } at `path` inside `node`, walking plain objects only; null when the path does not reach a value.
function valueAt(node, path) {
    let here = node;
    for (const key of path) {
        if (!isPlainObject(here) || !Object.prototype.hasOwnProperty.call(here, key)) return null;
        here = here[key];
    }
    return { value: here };
}

function writeAt(node, path, value) {
    let here = node;
    for (const key of path.slice(0, -1)) {
        if (!isPlainObject(here[key])) here[key] = {};
        here = here[key];
    }
    here[path[path.length - 1]] = value;
}

// Re-seed `statData`'s mvu-helper root from `seed` IN PLACE (run after the create-only seed, which has already
// written every absent leaf). Returns { replaced: [dotted paths], changed }.
export function reseedOwnRoot(statData, seed) {
    const report = { replaced: [], changed: false };
    const ownRoot = isPlainObject(statData) ? statData[MVUHELPER_STAT_ROOT] : null;
    if (!isPlainObject(ownRoot)) return report;
    const seedRoot = isPlainObject(seed) && isPlainObject(seed[MVUHELPER_STAT_ROOT]) ? seed[MVUHELPER_STAT_ROOT] : {};
    const previous = isPlainObject(ownRoot[SEED_FINGERPRINTS_PART]) ? ownRoot[SEED_FINGERPRINTS_PART] : {};
    const next = {};
    for (const { path, value } of leavesOf(seedRoot)) {
        if (path[0] === SEED_FINGERPRINTS_PART) continue;
        const here = valueAt(ownRoot, path);
        if (!here) continue;   // a value that is not an object stands where the seed has a container: never destroyed
        const seedPrint = fingerprintOf(value);
        const herePrint = fingerprintOf(here.value);
        const recorded = valueAt(previous, path);
        const recordedPrint = recorded && typeof recorded.value === 'string' ? recorded.value : null;
        if (herePrint === seedPrint) {
            writeAt(next, path, seedPrint);
        } else if (recordedPrint !== null && herePrint === recordedPrint) {
            writeAt(ownRoot, path, deepClone(value));
            writeAt(next, path, seedPrint);
            report.replaced.push([MVUHELPER_STAT_ROOT, ...path].join('.'));
        } else if (recordedPrint !== null) {
            writeAt(next, path, recordedPrint);
        }
    }
    if (report.replaced.length || !deepEqual(previous, next)) {
        ownRoot[SEED_FINGERPRINTS_PART] = next;
        report.changed = true;
    }
    return report;
}

// Does `value` — one seeded subtree of the chat's state, a character's record — differ from what the seed last wrote
// there, per its fingerprint mirror `prints`? A leaf with no print, or a print with no leaf, is a difference too.
// false when nothing was seeded there (`prints` absent).
export function differsFromSeedPrints(value, prints) {
    if (!isPlainObject(prints)) return false;
    const printLeaves = leavesOf(prints);
    const valueLeaves = isPlainObject(value) ? leavesOf(value) : [];
    if (valueLeaves.length !== printLeaves.length) return true;
    return printLeaves.some(({ path, value: print }) => {
        const here = valueAt(value, path);
        return !here || fingerprintOf(here.value) !== print;
    });
}

// After a force wrote `value` at `path` (dotted, or its segments, from the root of stat_data): every leaf it wrote under
// mvu-helper's root takes the forced value's fingerprint, so the next re-seed sees it as the card's and not as the chat's.
function recordForcedFingerprints(statData, path, value) {
    const segments = Array.isArray(path) ? path : String(path).split('.').filter(Boolean);
    if (segments[0] !== MVUHELPER_STAT_ROOT || segments.length < 2 || segments[1] === SEED_FINGERPRINTS_PART) return;
    const ownRoot = statData[MVUHELPER_STAT_ROOT];
    if (!isPlainObject(ownRoot)) return;
    if (!isPlainObject(ownRoot[SEED_FINGERPRINTS_PART])) ownRoot[SEED_FINGERPRINTS_PART] = {};
    const base = segments.slice(1);
    const leaves = isPlainObject(value) ? leavesOf(value) : [{ path: [], value }];
    for (const leaf of leaves) writeAt(ownRoot[SEED_FINGERPRINTS_PART], [...base, ...leaf.path], fingerprintOf(leaf.value));
}

// The seed with mvu-helper's bookkeeping taken out: a card cannot seed the fingerprints the re-seed keeps.
// Returns { seed, refused: [paths] }; the seed given is not touched.
function withoutReservedPaths(seed) {
    const ownRoot = isPlainObject(seed) ? seed[MVUHELPER_STAT_ROOT] : null;
    if (!isPlainObject(ownRoot) || !Object.prototype.hasOwnProperty.call(ownRoot, SEED_FINGERPRINTS_PART)) return { seed, refused: [] };
    const rest = { ...ownRoot };
    delete rest[SEED_FINGERPRINTS_PART];
    return {
        seed: { ...seed, [MVUHELPER_STAT_ROOT]: rest },
        refused: [MVUHELPER_STAT_ROOT + '.' + SEED_FINGERPRINTS_PART + " (mvu-helper's own bookkeeping, never seeded)"],
    };
}

// ── the apply ────────────────────────────────────────────────────────────────

// '', null, an empty list, or an object whose every field is itself empty — what a schema's defaults fill in.
const isEmptyValue = (value) => value === '' || value === null || value === undefined
    || (Array.isArray(value) && !value.length) || (isPlainObject(value) && Object.values(value).every(isEmptyValue));

// Does the chat's `saved` value already hold the card's `value`? The same, give or take an empty field: a card's schema
// fills each field a row leaves out with its default (Zod `.prefault('')`), so a row the chat holds can carry a
// `check: ""` the card's row never wrote, and it is still the card's row. Recursive through objects and arrays; a field
// only one side holds counts as the same when it is empty (isEmptyValue). Any other difference is a difference — a
// non-empty field the card dropped included.
function matchesCardValue(saved, value) {
    if (saved === undefined && isEmptyValue(value)) return true;
    if (isPlainObject(value)) {
        if (!isPlainObject(saved)) return false;
        return Object.keys(value).every((key) => matchesCardValue(saved[key], value[key]))
            && Object.keys(saved).every((key) => Object.prototype.hasOwnProperty.call(value, key) || isEmptyValue(saved[key]));
    }
    if (Array.isArray(value)) {
        return Array.isArray(saved) && saved.length === value.length && value.every((item, i) => matchesCardValue(saved[i], item));
    }
    return deepEqual(saved, value);
}

// One forceFromInitVar path: the card's `value` written at `segments` (container = the object holding its last
// segment). A table (both sides plain objects) goes row by row: a row the card carries replaces the save's row of
// that key unless it already matches (matchesCardValue), and a row only the save holds stays. Anything else is
// replaced whole unless it matches. Returns the report entry:
//   { path, isTable, cardRows, replaced: [row keys, or the path for a whole value], keptRows }
function forceCardValue(statData, segments, container, value) {
    const key = segments[segments.length - 1];
    const path = segments.join('.');
    const here = container[key];
    if (isPlainObject(value) && isPlainObject(here)) {
        const rows = Object.keys(value).filter((row) => !isPrototypeKey(row));
        const replaced = [];
        for (const row of rows) {
            if (matchesCardValue(here[row], value[row])) continue;
            here[row] = deepClone(value[row]);
            recordForcedFingerprints(statData, [...segments, row], value[row]);
            replaced.push(row);
        }
        const keptRows = Object.keys(here).filter((row) => !Object.prototype.hasOwnProperty.call(value, row)).length;
        return { path, isTable: true, cardRows: rows.length, replaced, keptRows };
    }
    if (matchesCardValue(here, value)) return { path, isTable: false, cardRows: 1, replaced: [], keptRows: 0 };
    container[key] = deepClone(value);
    recordForcedFingerprints(statData, segments, value);
    return { path, isTable: false, cardRows: 1, replaced: [path], keptRows: 0 };
}

// Write each forceFromInitVar path into `statData`, as forceCardValue writes it; a path the card's [InitVar] does not
// reach is named in `report.blocked`, never guessed at.
function forceFromInitVar(statData, seed, paths, report) {
    for (const path of paths) {
        const segments = String(path).split('.').filter(Boolean);
        if (!segments.length) { report.blocked.push('(empty path)'); continue; }
        if (segments.some(isPrototypeKey)) { report.blocked.push(path + ' (prototype key, never a stat_data key)'); continue; }
        const card = valueAt(seed, segments);
        if (!card) { report.blocked.push(path + " (the card's [InitVar] carries nothing there)"); continue; }
        const container = segments.length > 1 ? ensurePath(statData, segments.slice(0, -1).join('.')) : statData;
        if (!container || typeof container !== 'object') { report.blocked.push(path + ' (non-object in the way)'); continue; }
        report.forcedFromInitVar.push(forceCardValue(statData, segments, container, card.value));
    }
}

// Write the literal force map into `statData`. `ensurePath` builds the parent chain and returns the container; the
// last segment is the key written. A path with no parent chain ("Day") writes at the root. A prototype key anywhere
// is refused up front: ensurePath guards the parent chain, but the LAST segment is assigned here, and
// `container.__proto__ = value` re-parents the container itself.
function forceMap(statData, force, report) {
    for (const path of Object.keys(force)) {
        const segments = String(path).split('.').filter(Boolean);
        if (!segments.length) { report.blocked.push('(empty path)'); continue; }
        if (segments.some(isPrototypeKey)) { report.blocked.push(path + ' (prototype key, never a stat_data key)'); continue; }
        const key = segments.pop();
        const container = segments.length ? ensurePath(statData, segments.join('.')) : statData;
        if (!container || typeof container !== 'object') { report.blocked.push(path + ' (non-object in the way)'); continue; }
        container[key] = deepClone(force[path]);
        recordForcedFingerprints(statData, path, force[path]);
        report.forced.push(path);
    }
}

const emptyReport = (version) => ({
    applied: false, skipped: false, reason: '', version,
    added: [], reseeded: [], didFingerprintsMove: false, blocked: [],
    forced: [], isForceSkipped: false, shouldStamp: false,
    forcedFromInitVar: [], forceFromInitVarSkipReason: '', shouldStampForceFromInitVar: false,
});

// Apply `payload` to `statData` IN PLACE. Each force list is gated on its own watermark — the version this save last
// took for it ('' / missing ⇒ none): `watermark` for the literal map, `forceFromInitVarWatermark` for the paths taken
// from [InitVar]. They are kept apart because an mvu-helper that predates forceFromInitVar still takes the version for
// the map: a shared watermark would mark the push done there, and no later load would ever run it. Returns a report:
//   { applied, skipped, reason, version, added:[paths], reseeded:[paths], didFingerprintsMove, blocked:[paths],
//     forced:[paths], isForceSkipped, shouldStamp,
//     forcedFromInitVar:[forceCardValue entries], forceFromInitVarSkipReason, shouldStampForceFromInitVar }
// applied=false + skipped=true when nothing ran (the every-load fast path: string compares, zero writes). blocked =
// targets refused, never destroyed. The forceFromInitVar paths run before the map, so a value the map writes wins on a
// shared path when both run in one load.
//
// THE CALLER STAMPS (watermarkStamps). shouldStamp / shouldStampForceFromInitVar say which watermark may advance to
// `report.version`: each list's own, and only when that list RAN for this version — even when it changed nothing,
// because the version WAS processed. `applied` cannot say it: the seed runs every load, so `applied` is true on a load
// where both force lists were skipped, and stamping on it would mark a version done that never ran. This function does
// not know, and must not know, WHERE the watermarks live: storage is the host glue's business (card-sync.js), never
// the consumer's own state tree.
export function applyDataSync(statData, payload, watermark, forceFromInitVarWatermark = '') {
    const report = emptyReport(payload.version);
    if (!statData || typeof statData !== 'object') { report.skipped = true; report.reason = 'no stat_data'; return report; }

    // SEED — ungated, every load, create-only at every depth. Reuses the same merge the pack's `init`
    // used, so folding the two lanes changed the SHAPE of the payload and not the semantics of seeding.
    const { seed, refused } = withoutReservedPaths(payload.seed || {});
    report.blocked.push(...refused);
    const seeded = mergeInitSubtree(statData, seed);
    report.added = seeded.written || [];

    // RE-SEED — ungated, every load, mvu-helper's own root only: what the chat never changed follows the card.
    const reseed = reseedOwnRoot(statData, seed);
    report.reseeded = reseed.replaced;
    report.didFingerprintsMove = reseed.changed;

    // FORCE — watermark-gated, because this is the half that overwrites a player's save. A list with nothing in it
    // has nothing to take, so it never stamps.
    const paths = payload.forceFromInitVar || [];
    const pushed = String(forceFromInitVarWatermark || '0');
    if (paths.length && compareVersions(payload.version, pushed) > 0) {
        forceFromInitVar(statData, seed, paths, report);
        report.shouldStampForceFromInitVar = true;
    } else if (paths.length) {
        report.forceFromInitVarSkipReason = 'version ' + payload.version + ' <= pushed ' + pushed;
    }
    const seen = String(watermark || '0');
    if (compareVersions(payload.version, seen) > 0) {
        forceMap(statData, payload.force || {}, report);
        report.shouldStamp = true;
    } else {
        report.isForceSkipped = true;
        report.reason = 'force map skipped: version ' + payload.version + ' <= watermark ' + seen;
    }

    report.applied = report.added.length > 0 || reseed.changed || report.shouldStamp || report.shouldStampForceFromInitVar;
    report.skipped = !report.applied;
    return report;
}

// The watermarks a sync is gated on, read from mvu-helper's chat record: { force, forceFromInitVar }, '' each when the
// chat has taken none.
export function watermarksOf(record) {
    const fields = record && typeof record === 'object' ? record : {};
    return { force: String(fields[WATERMARK_FIELD] || ''), forceFromInitVar: String(fields[FORCE_FROM_INITVAR_WATERMARK_FIELD] || '') };
}

// The chat-record fields the caller writes once a sync's writes have landed: each force list's watermark advances to
// the version it RAN for. {} when neither ran.
export function watermarkStamps(report) {
    const stamps = {};
    if (report && report.shouldStamp) stamps[WATERMARK_FIELD] = report.version;
    if (report && report.shouldStampForceFromInitVar) stamps[FORCE_FROM_INITVAR_WATERMARK_FIELD] = report.version;
    return stamps;
}

// One sync over the states a new generation can seed from, newest first ({ id, statData } each; card-sync.js reads
// them from shared/generation-floor.js). The payload goes into every one: written into the newest alone, a regenerate
// or swipe of the newest reply would start over from the state before it, which never had it. `watermarks` is
// { force, forceFromInitVar }, the version this chat last took for each force list. `runPasses(statData)`, the
// registered sync passes, runs on the newest only — each pass keeps its own states before a generation. Mutates each
// statData; returns [{ id, report, isChanged }] in the same order. `payload` null = the card has no [InitVar].
export function syncFloorStates(floors, payload, watermarks, runPasses) {
    const { force = '', forceFromInitVar: pushed = '' } = watermarks || {};
    return (Array.isArray(floors) ? floors : []).map(({ id, statData }, index) => {
        const report = payload ? applyDataSync(statData, payload, force, pushed)
            : { ...emptyReport(''), skipped: true, reason: 'no [InitVar] entry' };
        report.eventPacks = index === 0 ? runPasses(statData) : { changed: false, reports: [] };
        return { id, report, isChanged: report.applied || report.eventPacks.changed };
    });
}

// What one sync did to this chat's state, as the sentence Re-import from card shows; '' when it changed nothing a
// player would notice (fingerprints alone, or a skipped run). Counts, never paths: the console line has the paths.
export function seedPassSummary(report) {
    if (!report || !report.applied) return '';
    const parts = [];
    const replaced = (report.forcedFromInitVar || []).reduce((count, entry) => count + entry.replaced.length, 0);
    if (report.added && report.added.length) parts.push(`${report.added.length} added`);
    if (report.reseeded && report.reseeded.length) parts.push(`${report.reseeded.length} updated`);
    if (replaced) parts.push(`${replaced} replaced`);
    if (report.forced && report.forced.length) parts.push(`${report.forced.length} forced`);
    return parts.length ? `Re-seeded this chat from the card: ${parts.join(', ')}` : '';
}
