// event-pack/event-pack-core.js — PURE, dependency-free logic for community [MVU_Event_Pack] entries.
//
// THE PROBLEM IT SOLVES (plans/event-pack-plan.md): a community event = ONE lorebook entry carrying
// both halves — a hidden <mvueventpack> JSON block (trigger rows) and self-gated prose bodies. This
// module parses those entries, validates a pack (syntax / structure / safety ONLY — never game
// logic, §4), and merges pack rows into the dedicated root `stat_data.EventPack`:
//   EventPack.triggers  — EVERY event row (official base + community overlay; the engine reads this)
//   EventPack.installed — community-pack registry: { <packId>: { ver, keys: [] } }
//
// SAFETY MODEL (§5): pack content is UNTRUSTED. No free-form target — this module writes ONLY under
// the EventPack root. Keys must carry the pack's own `slug(creator)_slug(event)_` prefix, and a pack
// may never claim a key it doesn't own (collision fence). fx is data the engine interprets, not code.
//
// Everything here is a plain function with no ST/globals (unit-tested in tests/event-pack-core.test.js).
// Dotted-path + version helpers are REUSED from data-sync-core.js (one implementation). The I/O glue
// (lorebook fetch, registry scan, persist) lands in card-sync/card-sync.js (plan P2).

import { compareVersions, isVersionString } from '../../shared/version-compare.js';
import { getPath, ensurePath, deepClone } from '../../shared/object-path.js';
import { deepEqual } from '../../shared/deep-equal.js';
// The registry TEXT format (a '#' header line above pretty JSON) is artifact machinery, shared with the
// pack lane since phase GE (§12a). What a valid registry CONTAINS is still decided here.
import { parseRegistryJson, buildRegistryText, deriveArtifactLed } from '../../shared/card-artifact-store.js';
// §4.7 token-shape lint. VENDORED from the engine's parseToken — see when-dsl-grammar.js for why the
// grammar may not be edited here, and which test enforces that.
import { isTokenShapeOk, parseToken } from './when-dsl-grammar.js';

export const PACK_ENTRY_MATCH = '[mvu_event_pack]';   // comment substring, case-insensitive.
// NOTE: the tab's registry entry '[MVU_Event_Pack_Registry]' does NOT match — no ']' after "pack".

// The tab-owned cross-chat registry entry (§5.5): a data carrier (enabled:false) in the STANDALONE
// worldbook holding { "<packId>": { "ver": "M.m" } }. It is what tells TAB-INSTALLED packs from
// hand-pasted ones across chats (stat_data is per-chat; the lorebook is shared under the card).
// Only the P3 tab creates/updates it — the scanner READS it; no registry entry ⇒ pack scan inert.
export const REGISTRY_COMMENT = '[MVU_Event_Pack_Registry]';
export const REGISTRY_ENTRY_MATCH = REGISTRY_COMMENT.toLowerCase();

// The Intent channel a pack body emits to COMMIT its event — FORMAT-level, not genre-level (P9 §5a.6,
// "B1"). A body with no emit means applyEventFire never runs, so no fired record is written and the
// event re-fires forever; the self-contained pack tier chains on exactly that record, so a missing emit
// breaks the schema-free tier hardest. It sits here beside the other format protocol strings rather
// than being spelled inline: a genre wanting event packs must expose an Intent channel by this name,
// exactly as the format already fixes the `=== '@key'` gate and the `<mvueventpack>` wrapper.
// ⚠ NOT vendored from the engine: eventpack.cjs never sees this string (it is handed an already-split
// `fireStr`; globalLogic's `I.eventFire` is what reads the channel), so there is nothing to vendor FROM
// and a second copy would MANUFACTURE drift. The real-bundle test asserts School actually reads it.
export const FIRE_INTENT = 'eventFire';

// The pack-format level THIS scanner implements (§3.1a). 1.0 is the whole grammar — `!` negation,
// contains(), has(), wildcard paths, whenAny — and fx.writes; 1.1 adds fx.reward, a row's own bounded
// payout; 1.2 lets a keyed reward name its member by a selector (`<path>.*.<field>`). It is only the
// FLOOR — the binding gate is the CARD's engine level, because mvu-helper updates independently of a
// card that shipped with an older engine.
export const SUPPORTED_FORMAT = '1.2';

// Size caps (§4.5 — stat_data snapshot-bloat guard):
export const MAX_ROWS_PER_PACK = 20;                  // one series, up to 20 steps/beats
export const MAX_ROW_JSON_BYTES = 4096;               // per trigger row
export const MAX_ENTRY_BYTES = 65536;                 // whole entry content (64 KB)

// §4.8 P4b — the scanner's paths are REQUIRED OPTS, supplied by the caller from what the card's
// LOADED engine declares (`readEventContract().paths`). They used to be a hardcoded stub here, which
// made this module a THIRD independent spelling of two facts the engine's adapter already owns — and
// a disagreement would not throw, it would merge pack rows into a table the engine never reads: pack
// "installed", its row green, events that can never fire.
//
// NO DEFAULT, by decision (2026-08-05): a missing path THROWS here rather than falling back. The pure
// core cannot reach the loaded engine, so it cannot source them itself, and inventing them is exactly
// the silent divergence being closed. Every impure caller (the sync pass, the floor seed, the tab)
// reads the declared contract and stands down loudly when it is absent, so this throw is a
// programming-error backstop — not the user-facing refusal, which happens earlier and with an
// actionable message.
function requirePaths(opts) {
    const cfg = opts || {};
    for (const field of ['triggerRoot', 'armedPath']) {
        if (typeof cfg[field] !== 'string' || !cfg[field]) {
            throw new Error(`event-pack: opts.${field} is REQUIRED (P4b) — read it from the loaded engine via readEventContract().paths`);
        }
    }
    // The library keeps its own stores BESIDE the trigger table (siblingRootOf), so a root with no dot
    // has no sibling: the install record would land on stat_data itself. readEventContract refuses that
    // shape before any caller gets here; this is the same backstop as the throw above.
    if (!siblingRootOf(cfg.triggerRoot, 'installed')) {
        throw new Error(`event-pack: opts.triggerRoot must be a dotted path (got ${JSON.stringify(cfg.triggerRoot)}) — the library keeps its own stores beside it`);
    }
    return cfg;
}

// ── SAME-ROUND BODY DELIVERY (P8 §6.6 actor-3) ───────────────────────────────
// Pull the DO/FIRE prose body gated by `=== '@<key>'` out of a body-carrying lorebook entry, so the
// PRE→narrate seam can inject it the SAME reply an input-signalled event goes ripe — instead of the
// 1-reply EventArmed lag. Source-BLIND by construction: official bodies (event_schedule.txt) and
// community bodies (a [MVU_Event_Pack] entry's prose half) use the IDENTICAL flat `=== '@<key>'`
// gate (format §5), so ONE extractor serves both.
//
// We EXTRACT (strip the gate) rather than render-with-EventArmed-override: ST-Prompt-Template's
// prepareContext hands back the LIVE variable store, so a setvar to fake EventArmed PERSISTS to the
// message — a state write, the exact thing §6.6 forbids for PRE. Stripping the gate sidesteps it:
// the inner prose carries no EventArmed dependency, so the caller renders it against the REAL
// (unmutated) context. Flat gates only (no nested EJS block per §5), so the FIRST standalone close
// tag after the gate-open closes it. PURE — no I/O, no globals.

const EJS_OPEN_RE = '<%[-_]?';    // <% · <%- · <%_   (ST-Prompt-Template trim + non-trim opens)
const EJS_CLOSE_RE = '[-_]?%>';   // %> · -%> · _%>

// Extract the inner prose of the `=== '@<key>'`-gated body from one entry's content (gate wrapper
// stripped, trimmed). '' when this content carries no gated body for the key. The closing quote
// after the key guards prefix collisions (`@leila_1` never matches inside `@leila_10`'s gate).
export function extractArmedBody(content, key) {
    const src = String(content == null ? '' : content);
    const trimmedKey = String(key == null ? '' : key).trim();
    if (!src || !trimmedKey) return '';
    const esc = trimmedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // the gate-open EJS tag: `if (... === '@<key>') {` — match on the `=== '@<key>'` marker + the block open.
    const gateOpen = new RegExp(EJS_OPEN_RE + "[^%]*===\\s*['\"]@" + esc + "['\"][^%]*\\{\\s*" + EJS_CLOSE_RE);
    const open = gateOpen.exec(src);
    if (!open) return '';
    const rest = src.slice(open.index + open[0].length);
    // FIRST standalone close tag `<%_ } _%>` closes the flat gate (a `}` inside another EJS tag won't match).
    const close = new RegExp(EJS_OPEN_RE + '\\s*\\}\\s*' + EJS_CLOSE_RE).exec(rest);
    return (close ? rest.slice(0, close.index) : rest).trim();
}

// Find the first ENABLED lorebook entry carrying a gated body for `key`; return { body, entry } or
// null. Skips disabled entries to match the live render gate (a disabled body entry renders nothing).
export function findArmedBody(entries, key) {
    for (const entry of (Array.isArray(entries) ? entries : [])) {
        if (entry && entry.enabled === false) continue;
        const body = extractArmedBody(entry && entry.content, key);
        if (body) return { body, entry };
    }
    return null;
}

// ── identity (§3.1) ──────────────────────────────────────────────────────────

// slug: lowercase, spaces → '_', everything outside [a-z0-9_] dropped.
export function slug(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// Pack ID = slug(creator) + '.' + slug(event) — the EventPack.installed watermark KEY.
export function packId(meta) {
    return slug(meta && meta.creator) + '.' + slug(meta && meta.event);
}

// Trigger-key namespace prefix — every key in the pack must start with this.
export function keyPrefix(meta) {
    return slug(meta && meta.creator) + '_' + slug(meta && meta.event) + '_';
}

// ── parsing (§3) ─────────────────────────────────────────────────────────────

const PACK_BLOCK_RE = /<mvueventpack>\s*([\s\S]*?)\s*<\/mvueventpack>/i;
const PACK_BLOCK_RE_G = /<mvueventpack>\s*([\s\S]*?)\s*<\/mvueventpack>/gi;

// ── MULTI-PACK UPLOAD FILES (spec change, user 2026-08-05) ───────────────────
// An author writing a long chain reaches for ONE file — every beat they can think of, in order — and
// an author writing two heroines does the same. Both are natural, and both used to fail SILENTLY: the
// non-global block regex read only the first pack, and `content.replace(PACK_BLOCK_RE, '')` stripped
// only the first too, so every LATER block's raw JSON survived into `prose` and was injected into the
// prompt as story text. The file looked accepted and quietly shipped garbage to the narrator.
//
// The fix is at PARSE time only. STORAGE IS UNCHANGED: one lorebook entry per pack, one registry
// record per pack, keys still namespaced by `slug(creator)_slug(event)_`. The tab splits an upload
// file into N packs and writes N entries; the runtime scanner still sees exactly one pack per entry.
//
// PROSE ATTRIBUTION — each pack owns the text from the END of its own block to the START of the next.
// That is how an author writes it (block, its gated bodies, next block) and it is the only reading
// that keeps the §4-item-9 body-coverage check meaningful. Giving every pack the whole file's prose was the
// alternative and is worse twice over: it duplicates every body into every entry, against the §4.5
// 64KB entry cap, and it makes "this pack is missing a body" unanswerable.
export function splitUploadFile(text) {
    const src = String(text == null ? '' : text);
    const segments = [];
    let m;
    PACK_BLOCK_RE_G.lastIndex = 0;
    const hits = [];
    while ((m = PACK_BLOCK_RE_G.exec(src)) !== null) hits.push({ json: m[1], start: m.index, end: m.index + m[0].length });
    for (let i = 0; i < hits.length; i++) {
        const proseEnd = (i + 1 < hits.length) ? hits[i + 1].start : src.length;
        // Trim the inert EJS wrapper fragments that sit at a seam: the `<%_ } _%>` closing THIS pack's
        // `if (false)` guard, and the `<%_ if (false) { _%>` opening the NEXT one. Leaving them would
        // put a stray brace in the prose and make the body-coverage check read a phantom body.
        let prose = src.slice(hits[i].end, proseEnd)
            .replace(/^\s*<%[-_]?\s*\}\s*[-_]?%>/, '')
            .replace(/<%[-_]?\s*if\s*\(\s*false\s*\)\s*\{\s*[-_]?%>\s*$/, '');
        segments.push({ json: hits[i].json, prose: prose.trim() });
    }
    return segments;
}

// The canonical single-pack entry body: the JSON hidden behind an `if (false)` guard so it never
// renders, followed by that pack's own gated prose bodies. Matches the shape authors already write and
// the shape parseEventPacks reads back.
export function packEntryContent(json, prose) {
    const body = String(prose || '').trim();
    const head = '<%_ if (false) { _%>\n<mvueventpack>\n' + String(json).trim() + '\n</mvueventpack>\n<%_ } _%>';
    return head + (body ? '\n' + body + '\n' : '\n');
}

// Parse an UPLOAD FILE (the tab's textarea / Load file) into every pack it declares, in order.
// Returns { packs, errors } — `errors` carries the block INDEX so a message can name which one, since
// a file with three packs and one typo must say WHICH. Each pack gets the same shape parseEventPacks
// produces, so validateEventPack and the install path need no special case.
export function parseUploadFile(text) {
    const packs = [], errors = [];
    const segments = splitUploadFile(text);
    if (!segments.length) return { packs, errors: [{ index: 0, error: 'no <mvueventpack> block found' }] };
    segments.forEach((seg, i) => {
        try {
            const obj = JSON.parse(seg.json);
            if (!isPlainObject(obj)) throw new Error(`the <mvueventpack> block must contain a JSON OBJECT ({ "creator": …, "triggers": … }) — got ${describeValue(obj)}`);
            packs.push({
                packId: packId(obj),
                // EXACTLY what the author wrote — `undefined` when omitted (P9 §5a.9). It used to
                // coalesce to '1.0' here, which made an omission indistinguishable from a deliberate
                // "1.0" and so unenforceable. Nothing downstream needs the coalescing: fmtMajor/fmtMinor
                // already read an absent format as 1.0 for the §3.1a gate, and validateEventPack now
                // REFUSES the pack outright, so no absent-format pack reaches an install.
                format: typeof obj.format === 'string' ? obj.format.trim() : undefined,
                builtWith: obj.builtWith,          // receipt, passed through untouched (§5a.9)
                creator: obj.creator,
                event: obj.event,
                version: obj.version,
                triggers: obj.triggers,
                prose: seg.prose,
                // The exact text to write into THIS pack's lorebook entry. Built here, not in the UI,
                // so the split is provable in a unit test: the installer must never write the whole
                // multi-pack file into every entry (each would then carry the others' JSON as prose,
                // which is the leak this whole change exists to close). Canonical shape, so a
                // re-import of an installed entry reads back identically.
                entryContent: packEntryContent(seg.json, seg.prose),
                entrySize: seg.json.length + seg.prose.length,
                comment: '',
                enabled: true,
            });
        } catch (err) {
            errors.push({ index: i, error: String((err && err.message) || err) });
        }
    });
    return { packs, errors };
}

// Two packs in ONE file may share a `series` (a 40-beat arc is naturally one series) but NEVER a
// packId — `decideInstall` compares versions on packId, so a duplicate would read as an UPGRADE of the
// earlier block rather than a second pack, and one would overwrite the other's entry. The author fixes
// it by giving each block its own `event` name (Leila1 / Leila2), which is also what keeps their keys
// apart. Returns [] when clean.
export function duplicatePackIds(packs) {
    const seen = new Map(), dupes = [];
    (packs || []).forEach((p, i) => {
        if (seen.has(p.packId)) dupes.push({ packId: p.packId, first: seen.get(p.packId), second: i });
        else seen.set(p.packId, i);
    });
    return dupes;
}

// Two blocks in ONE file claiming the SAME trigger key. This is NOT the §5 collision fence: that one
// compares a pack against keys already INSTALLED, so its message says "an existing trigger". Here
// neither pack is installed yet, so the message must name the two BLOCKS instead — telling an author
// their brand-new file collides with "an existing trigger" sends them to look at the wrong place.
// Unchecked, both entries would be written and the later pack's row would overwrite the earlier one's
// at merge time: two packs installed, one silently inert.
// Normally unreachable — every key must start `slug(creator)_slug(event)_`, so a shared key implies a
// shared packId — but it becomes reachable the moment a key is malformed, and that combination is
// exactly the one that fails quietly. Returns [] when clean.
export function duplicateTriggerKeys(packs) {
    const seen = new Map(), dupes = [];
    (packs || []).forEach((p, i) => {
        if (!isPlainObject(p && p.triggers)) return;
        for (const key of Object.keys(p.triggers)) {
            if (seen.has(key)) dupes.push({ key, first: seen.get(key), second: i });
            else seen.set(key, i);
        }
    });
    return dupes;
}

// Scan worldbook `entries` ({ comment, content, … }) for pack entries (comment match first, content
// block as the source of truth) and parse each. Malformed JSON in ONE entry must not sink the others:
// per-entry failures are collected in `errors` (caller logs them) while good packs still parse.
// Returns { packs: [pack], errors: [{ comment, error }] } where each pack is:
//   { packId, format, creator, event, version, triggers, prose, entrySize, comment, enabled }
// prose = the entry content OUTSIDE the <mvueventpack> block (the gated bodies — §4 item 9 coverage check).
// enabled mirrors the worldbook entry's flag (absent ⇒ true) — the §5.5 disable-state source of truth.
export function parseEventPacks(entries) {
    const packs = [], errors = [];
    for (const e of entries || []) {
        const comment = String((e && e.comment) || '');
        if (!comment.toLowerCase().includes(PACK_ENTRY_MATCH)) continue;
        const content = String((e && e.content) || '');
        try {
            const m = content.match(PACK_BLOCK_RE);
            if (!m) throw new Error('this entry carries no <mvueventpack>…</mvueventpack> block — the pack JSON must sit inside that wrapper, with the prose bodies after it');
            // The tab writes ONE pack per entry, so more than one block here means the entry was
            // hand-edited. Refuse loudly rather than read the first and inject the rest as prose —
            // that silent leak is exactly why multi-pack files are split at UPLOAD time instead.
            const blockCount = (content.match(PACK_BLOCK_RE_G) || []).length;
            if (blockCount > 1) throw new Error(`entry holds ${blockCount} <mvueventpack> blocks — one pack per entry; re-import the file so the tab can split it`);
            const obj = JSON.parse(m[1]);
            if (!isPlainObject(obj)) throw new Error(`the <mvueventpack> block must contain a JSON OBJECT ({ "creator": …, "triggers": … }) — got ${describeValue(obj)}`);
            packs.push({
                packId: packId(obj),
                format: typeof obj.format === 'string' ? obj.format.trim() : undefined,   // what the author WROTE (P9 §5a.9)
                builtWith: obj.builtWith,          // receipt, passed through untouched (§5a.9)
                creator: obj.creator,
                event: obj.event,
                version: obj.version,
                triggers: obj.triggers,
                prose: content.replace(PACK_BLOCK_RE, ''),
                entrySize: content.length,
                comment,
                enabled: !e || e.enabled !== false,
            });
        } catch (err) {
            // NOT swallowed — surfaced per entry so one bad pack can't sink the rest; caller logs.
            errors.push({ comment, error: String((err && err.message) || err) });
        }
    }
    return { packs, errors };
}

// Parse the registry entry content: bare JSON, or JSON beside '#'-comment header lines (the same
// tolerant shape parseUpdatePayload accepts). Throws on malformed JSON / non-object (caller logs and
// treats the scan as inert — never destructive on a broken registry). Record values are normalized to
// { ver } ({} ⇒ ver '0'); unknown extra fields pass through untouched.
export function parseRegistry(raw) {
    // '{}' for an EMPTY body: this registry is a MAP of installed packs, so empty means "none".
    // (A GameLogic Pack registry holds ONE record and empties to 'null' — see parseRegistryJson.)
    const obj = parseRegistryJson(raw, { whenEmpty: '{}' });
    if (!isPlainObject(obj)) throw new Error(`the registry must be a JSON OBJECT keyed by packId ({ "paulk.beacharc": { "ver": "1.0" } }) — got ${describeValue(obj)}`);
    const out = {};
    for (const id of Object.keys(obj)) {
        const rec = obj[id];
        out[id] = isPlainObject(rec) ? { ...rec, ver: String(rec.ver == null ? '0' : rec.ver) } : { ver: '0' };
    }
    return out;
}

// WHO the engine refusal is actually FOR (2026-08-15). The scan stands down when this card exposes no
// readable event-state paths, and that refusal is right — a pack that cannot be placed must never look
// installed. But it was announcing itself in two situations it had no business in:
//
//   • ZERO packs. Uninstalling the last pack leaves the registry ENTRY behind holding `{}`, and the
//     gate upstream is "does the entry exist", not "is anything installed". So a card that once tried
//     an event pack red-toasted forever about packs it no longer has. The tab itself already gets this
//     right (it renders "no event packs installed" and never reaches the engine check) — the scan did not.
//   • EVERY PASS. The scan runs on CHAT_CHANGED, on mag_variable_initialized and after each
//     install/uninstall, so ONE unchanging fault spoke several times per session. A toast is for a
//     transition; the console line is the record.
//
// Nothing is lost by the silence: with no engine there is nothing to prune either (the per-chat
// installed records hang off the triggerRoot we cannot read), and no engine means nothing can fire.
//
// `refusal` IDENTIFIES the news, it is not the message: the caller folds the installed pack IDs in
// beside the reason, so the same fault on a DIFFERENT card still speaks (this pass never learns which
// card it is running against, and "same words" is not "same situation"). Falsy ⇒ the paths resolved.
// Returns the log level to use (null = say nothing), whether to TOAST, and the latch to store back.
export function planScanRefusalNotice({ packCount = 0, refusal = null, lastAnnounced = null } = {}) {
    // Paths resolved. Clear the latch so a LATER break speaks again instead of being swallowed as a repeat.
    if (!refusal) return { level: null, toast: false, lastAnnounced: null };
    if (!packCount) return { level: 'verbose', toast: false, lastAnnounced: null };
    return { level: 'error', toast: refusal !== lastAnnounced, lastAnnounced: refusal };
}

// ── validation (§4) ──────────────────────────────────────────────────────────

// `check` RETIRED in P9 (§5a.7): it was documented as a "narrate hint" but read by NOTHING — zero hits
// in eventpack.cjs, and globalLogic's `row.check` is the CALENDAR row, a different object. Leaving it in
// this list made it invisible dead weight every pack author would copy forever. It now warns as an
// ordinary unknown field, which is the truth.
const ROW_FIELDS = ['cat', 'series', 'prereq', 'when', 'whenAny', 'fx'];   // whenAny: the OR form (§4b)
const CAT_VALUES = ['TRG', 'TIME'];

// ── fx: the FORMAT's own fields ─────────────────────────────────────────────────────────────
// `summary` is the row's human LABEL (this tab shows it; nothing writes it into the save), `scope` rides
// the done-marker the library writes on a fire, and `writes` is the list of { path, key, set, add, remove }
// the library applies under the rules the card's engine declares (EVENT_PACK_ADAPTER.writes). Nothing else under
// `fx` exists in this format. A write's PATH is checked against the card (unallowedWritePaths), and so is
// whether that path can say WHO made a record at all (unstampedWritePaths); its FIELD NAMES never — they
// are the card's own schema, and the builder that emitted them read that schema. Whether a given write
// lands is a RUNTIME question the engine's owner gate answers, and no install-time check can pre-empt it:
// a pack may name any record key nobody has claimed, so the same key is legal today and taken tomorrow.
// `reward` is the row's own payout, { kind: { field: amount } } — or { kind: { memberKey: { field:
// amount } } } where the card declares that kind KEYED. The KIND is checked against the card
// (unallowedRewardKinds) and so is the keyed-ness (mismatchedRewardShapes); the amount never — the card's
// engine holds it to the ceiling the card declares, and a number this side thinks is too big is a number
// only that engine can judge.
const FX_META = ['summary', 'scope', 'writes', 'reward'];
const WRITE_PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;

// ── the format a pack ACTUALLY needs, derived from what it uses (P9 §5a.9) ───────────────────
// THE HOLE THIS CLOSES: a pack declaring an OLDER format than the constructs it uses validates clean,
// installs on a card of that older level, and the engine cannot parse the token — the event never
// fires. Declared value cross-checked against the derived value, the same pattern as the stamped
// engine header vs the live adapter, pointed at the pack. It also BACKSTOPS the builder's own stamp.
//
// 1.0 is the whole grammar (eventpack_revisit D4: `!` · contains · has · `*` · whenAny · fx.writes are
// all 1.0). A row here names a later construct:
//   { format: '1.1', label: 'newThing()', test: (row, kinds, negs, lhss) => kinds.has('newthing') }
// `kinds` = the parseToken kinds a row uses, `negs` = how many tokens carry `!`, `lhss` = every LHS.
// MvuStatMenuBuilder's own table is the emit-side twin of this one and must carry the same features.
const FEATURE_FORMAT = [
    { format: '1.1', label: 'fx.reward', test: (row) => isPlainObject(row && row.fx) && isPlainObject(row.fx.reward) && Object.keys(row.fx.reward).length > 0 },
    // A keyed reward whose member is a SELECTOR (`<path>.*.<field>`) instead of a name — the row says which
    // field marks the one it means, and the card's engine reads who that is at fire. An engine older than
    // 1.2 sees an illegal member key, refuses it by name and fires the row without the payout, so this is
    // a MINOR bump. Detected by SHAPE (a member key carrying `.*.`), never by a field name.
    { format: '1.2', label: 'fx.reward member selector',
      test: (row) => isPlainObject(row && row.fx) && isPlainObject(row.fx.reward)
                     && Object.values(row.fx.reward).some((v) => isPlainObject(v)
                        && Object.keys(v).some((k) => k.includes('.*.'))) },
];

// The PATHS a pack asks to write — every `writes[].path` across its rows. Genre-blind by construction:
// it collects paths and never looks at a field name.
export function packWritePaths(pack) {
    const paths = new Set();
    for (const key of Object.keys((pack && pack.triggers) || {})) {
        const row = pack.triggers[key];
        if (!isPlainObject(row) || !isPlainObject(row.fx) || !Array.isArray(row.fx.writes)) continue;
        for (const w of row.fx.writes) if (isPlainObject(w) && typeof w.path === 'string') paths.add(w.path);
    }
    return [...paths];
}

// One member's (or one object's) field: amount pairs. An amount is a finite number; 0 is legal and
// pointless, which is a warning rather than a refusal — it installs and does nothing, and the author is
// the only one who can tell whether that was meant.
function checkAmounts(paid, at, errors, warnings) {
    const fields = Object.keys(paid);
    if (!fields.length) { warnings.push(`${at}: pays no field — it rewards nothing`); return; }
    for (const f of fields) {
        // A payout is a NUMBER on an ordinary kind and a STRING on a prose one. This side has no card, so
        // it cannot know which a kind is — both are legal shapes here, and whether THIS card pays prose
        // there is checked at install (mismatchedRewardShapes), where the card's own declaration is in hand.
        if (typeof paid[f] === 'string') {
            if (!paid[f].trim()) warnings.push(`${at}.${f}: a blank pays nothing — the engine drops it`);
            continue;
        }
        if (typeof paid[f] !== 'number' || !Number.isFinite(paid[f])) errors.push(`${at}.${f}: an amount must be a number, or text for a prose reward — got ${describeValue(paid[f])}`);
        else if (paid[f] === 0) warnings.push(`${at}.${f}: an amount of 0 pays nothing — the engine drops it`);
    }
}

// Where a pack's payout SHAPE disagrees with what the card declares that kind to be. A keyed kind pays one
// member of a collection and the row must name them; an unkeyed one pays the path itself and a member key
// is meaningless there. Either way the engine drops the line at fire, so it is caught here instead.
// null/undefined cardRewards ⇒ report nothing, the same rule the write paths follow.
// → [{ key, kind, problem }]
export function mismatchedRewardShapes(pack, cardRewards) {
    if (!Array.isArray(cardRewards)) return [];
    const rows = [];
    for (const key of Object.keys((pack && pack.triggers) || {})) {
        const row = pack.triggers[key];
        if (!isPlainObject(row) || !isPlainObject(row.fx) || !isPlainObject(row.fx.reward)) continue;
        for (const kind of Object.keys(row.fx.reward)) {
            const declared = cardRewards.find((k) => isPlainObject(k) && k.name === kind);
            if (!declared) continue;                      // unallowedRewardKinds' finding, not this one's
            const paid = row.fx.reward[kind];
            if (!isPlainObject(paid)) continue;           // the shape validator's finding
            const named = Object.keys(paid).some((n) => isPlainObject(paid[n]));
            const bare = Object.keys(paid).some((n) => !isPlainObject(paid[n]));
            if (declared.keyed === true && bare) rows.push({ key, kind, problem: `pays ${declared.path} directly, but this card pays one member of it — the row must name who` });
            if (declared.keyed !== true && named) rows.push({ key, kind, problem: `names a member, but this card pays ${declared.path} itself — there is nobody to name` });
            // A prose kind writes TEXT and an ordinary one adds a NUMBER; the engine drops the other, so
            // the wrong type here is the same silent nothing as the wrong nesting.
            const values = [];
            for (const n of Object.keys(paid)) {
                if (isPlainObject(paid[n])) values.push(...Object.values(paid[n]));
                else values.push(paid[n]);
            }
            if (declared.text === true && values.some((v) => typeof v === 'number')) rows.push({ key, kind, problem: 'pays a number, but this card writes TEXT for that kind — a number has nothing to add to a string' });
            if (declared.text !== true && values.some((v) => typeof v === 'string')) rows.push({ key, kind, problem: 'pays text, but this card adds a NUMBER for that kind — there is nothing to write it over' });
        }
    }
    return rows;
}

// The reward KINDS a pack asks for — every `fx.reward` key across its rows. Genre-blind by construction:
// it collects names and never looks at a field or an amount.
export function packRewardKinds(pack) {
    const kinds = new Set();
    for (const key of Object.keys((pack && pack.triggers) || {})) {
        const row = pack.triggers[key];
        if (!isPlainObject(row) || !isPlainObject(row.fx) || !isPlainObject(row.fx.reward)) continue;
        for (const kind of Object.keys(row.fx.reward)) kinds.add(kind);
    }
    return [...kinds];
}

// Which of them THIS card's engine does not pay. `cardRewards` is the declared `rewards` list;
// null/undefined means "unknown" ⇒ report nothing, the same rule the write paths follow. An EMPTY list is
// not unknown — it is a card that pays nothing, and a pack asking for a payout there is named.
export function unallowedRewardKinds(pack, cardRewards) {
    if (!Array.isArray(cardRewards)) return [];
    const declared = cardRewards.map((k) => (isPlainObject(k) ? k.name : k));
    return packRewardKinds(pack).filter((name) => !declared.includes(name));
}

// Which of them THIS card's engine does not allow. `cardWrites` is the declared `writes` list
// (entries with a `path`); null/undefined means "unknown" ⇒ report nothing, because refusing a pack on
// a question we could not ask would be worse than the WRITE REFUSED line the engine logs at fire.
export function unallowedWritePaths(pack, cardWrites) {
    if (!Array.isArray(cardWrites)) return [];
    const allowed = cardWrites.map((e) => (e && typeof e === 'object') ? e.path : e);
    return packWritePaths(pack).filter((p) => !allowed.includes(p));
}

// The keyed writes this card's engine will refuse OUTRIGHT, whatever they name. A record says who made
// it in the field its path declares as `ownerStamp`, and that stamp is the whole of what keeps a community
// pack off a record the game or another pack made (D2) — so a path declaring none refuses every keyed pack
// write on it, fail-closed, and a pack asking for one is broken on this card no matter how it is spelled.
// The ONE exception is a path the engine declares `fillOnly: true`: a shared registry where first capture
// wins for every field, so a pack naming the room the game already calls `School_Cafeteria` can only fill
// blanks and needs no ownership to do it.
// `cardWrites` comes from the engine's own `EVENT_PACK_ADAPTER.writes`; null/undefined means "unknown" ⇒ report
// nothing, the same rule as the paths and scopes. A path the card does not declare AT ALL is
// unallowedWritePaths' finding, not this one's.
// → [{ key, path }] — the row named so the fix is obvious without re-reading the pack.
export function unstampedWritePaths(pack, cardWrites) {
    if (!Array.isArray(cardWrites)) return [];
    const stamped = new Set(cardWrites
        .filter((e) => isPlainObject(e) && (e.fillOnly === true || (typeof e.ownerStamp === 'string' && e.ownerStamp)))
        .map((e) => e.path));
    const declared = new Set(cardWrites.map((e) => (isPlainObject(e) ? e.path : e)));
    const rows = [];
    for (const key of Object.keys((pack && pack.triggers) || {})) {
        const row = pack.triggers[key];
        if (!isPlainObject(row) || !isPlainObject(row.fx) || !Array.isArray(row.fx.writes)) continue;
        for (const w of row.fx.writes) {
            if (!isPlainObject(w) || typeof w.key !== 'string' || !w.key) continue;
            if (!declared.has(w.path) || stamped.has(w.path)) continue;
            rows.push({ key, path: w.path });
        }
    }
    return rows;
}

// The rows naming a scope THIS card's engine never declared. `cardScopes` comes from the engine's own
// `EVENT_PACK_ADAPTER.scopes`; null/undefined means "unknown" ⇒ report nothing, same rule as the write paths
// above. A blank or absent scope is the row deferring to the engine's own default — not a claim to check.
// → [{ key, scope }], the row named so a typo can be found without re-reading the pack.
export function undeclaredScopeRows(pack, cardScopes) {
    if (!Array.isArray(cardScopes)) return [];
    const rows = [];
    for (const key of Object.keys((pack && pack.triggers) || {})) {
        const row = pack.triggers[key];
        if (!isPlainObject(row) || !isPlainObject(row.fx)) continue;
        const scope = row.fx.scope;
        if (typeof scope === 'string' && scope !== '' && !cardScopes.includes(scope)) rows.push({ key, scope });
    }
    return rows;
}

// → { format: 'M.m', reasons: ['contains()', …] }. '1.0' with no reasons when the pack uses only 1.0.
export function requiredFormat(pack) {
    let major = 1, minor = 0;
    const reasons = new Set();
    for (const key of Object.keys((pack && pack.triggers) || {})) {
        const row = pack.triggers[key];
        if (!isPlainObject(row)) continue;
        const kinds = new Set(); const lhss = []; let negs = 0;
        for (const chain of [row.prereq, row.when, ...(Array.isArray(row.whenAny) ? row.whenAny : [])]) {
            for (const tok of String(chain == null ? '' : chain).split('&')) {
                const d = parseToken(tok);
                if (!d) continue;                       // unparseable is the §4.7 lint's problem, not this one
                kinds.add(d.kind);
                if (d.neg) negs++;
                if (typeof d.lhs === 'string') lhss.push(d.lhs);
            }
        }
        for (const f of FEATURE_FORMAT) {
            if (!f.test(row, kinds, negs, lhss)) continue;
            reasons.add(f.label);
            const [fMajor, fMinor] = f.format.split('.').map(Number);
            if (fMajor > major || (fMajor === major && fMinor > minor)) { major = fMajor; minor = fMinor; }
        }
    }
    return { format: `${major}.${minor}`, reasons: [...reasons] };
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Name what a value ACTUALLY is, for a rejection message. The format is deliberately strict, so the
// diagnosis has to be generous in exchange (user, 2026-08-05): "must be an object" leaves an author
// re-reading their own JSON hunting for a difference, while "…got an array" points straight at the
// stray [ ]. Values are quoted/truncated so a huge blob can't flood a toast.
function describeValue(v) {
    if (v === undefined) return 'nothing (the field is absent)';
    if (v === null) return 'null';
    if (Array.isArray(v)) return `an array (${v.length} item${v.length === 1 ? '' : 's'})`;
    if (typeof v === 'string') return `the string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)}`;
    if (typeof v === 'object') return 'an object';
    return `${typeof v} ${JSON.stringify(v)}`;
}

// Validate ONE parsed pack: syntactically well-formed, structurally consumable, and safe — NOT game
// logic (§4 scope: reachability / scalar vocabulary / tier validity all fail safe at runtime).
// `foreignTriggerKeys` = keys already present in EventPack.triggers that this pack does NOT own
// (official base rows + other packs' rows) — the §5 collision fence. Array or Set.
// Returns { ok, errors: [], warnings: [] }; any ERROR ⇒ the pack is skipped entirely, never partial.
export function validateEventPack(pack, foreignTriggerKeys) {
    const errors = [], warnings = [];
    const foreign = foreignTriggerKeys instanceof Set ? foreignTriggerKeys : new Set(foreignTriggerKeys || []);

    // 2. meta
    if (typeof pack.creator !== 'string' || !slug(pack.creator)) errors.push('meta: "creator" must be a non-empty string that survives slugging');
    // "official" is the CARD's word. A pack can never hold the engine's own owner value — that is
    // `Official.Card` and slug() emits lowercase only — so this is not a permission gate; it is a
    // TRUTHFULNESS one. A record stamped `official.card` reads to a player exactly like the game's own,
    // and a pack tab listing "Official" as the creator says something the installer cannot vouch for.
    // Refused rather than warned: a name is free to change before publishing, and a shipped pack
    // claiming the card's authority is not something a later warning can take back.
    if (typeof pack.creator === 'string' && /official/i.test(pack.creator)) {
        errors.push('meta: "creator" may not contain "official" (got ' + JSON.stringify(pack.creator) + ') — that word names the events the CARD itself seeds, and a pack wearing it reads to a player as the game speaking. Pick a creator name that is yours.');
    }
    if (typeof pack.event !== 'string' || !slug(pack.event)) errors.push('meta: "event" must be a non-empty string that survives slugging');
    if (!isVersionString(pack.version)) errors.push('meta: "version" must match M.m or M.m.r (got ' + JSON.stringify(pack.version) + ')');
    // "format" is REQUIRED as of P9 (§5a.9). It used to be optional and silently defaulted to "1.0",
    // which borrowed §3.1a's engine rationale ("an unstamped engine PREDATES the marker, so it is 1.0 by
    // definition") into a case where it does not hold: a pack is written by a person or a tool that could
    // always have declared it, so an absent format is a GUESS, not a deduction — the last silent default
    // in pack parsing. The PARSER no longer coalesces, so an omission arrives here as `undefined` and
    // is caught, instead of reading back as a deliberate "1.0".
    const declared = pack.format;
    if (declared === undefined || declared === '') {
        errors.push(`meta: "format" is REQUIRED — declare the pack-format level this pack needs, e.g. "format": "${SUPPORTED_FORMAT}" (this installer supports up to ${SUPPORTED_FORMAT})`);
    } else if (!/^\d+\.\d+$/.test(String(declared))) {
        errors.push('meta: "format" must be an M.m string (got ' + JSON.stringify(declared) + ')');
    }
    // "builtWith" is a RECEIPT, never a contract (§5a.9): it records WHAT PRODUCED this file so that,
    // after a post-ship bug, the affected packs can be identified — a question neither `format` (what an
    // engine must DO) nor `version` (the pack's own revision) can answer. P3a stamps it automatically.
    // ⚠ It must NEVER gate anything: gating would refuse every hand-authored pack and weld the format to
    // one tool, contradicting the §5.4a split where the two apps share nothing but TEXT. Shape only.
    if (pack.builtWith !== undefined && typeof pack.builtWith !== 'string') {
        warnings.push(`meta: "builtWith" should be a string naming the tool that produced this pack — got ${describeValue(pack.builtWith)}`);
    }
    // NOTE the format COMPAT GATE (major/minor vs the card, §3.1a) is applyEventPacks' concern — only the SHAPE is checked here.
    // …but the DECLARED-vs-USED cross-check IS this function's concern, because it needs the rows.
    // Under-declaring is the dangerous direction and it fails SILENTLY at runtime, so it is an ERROR.
    if (declared && /^\d+\.\d+$/.test(String(declared))) {
        const need = requiredFormat(pack);
        if (compareVersions(need.format, String(declared)) > 0) {
            errors.push(`meta: this pack uses ${need.reasons.join(', ')}, which need format ${need.format}, but it declares "${declared}" — ` +
                `set "format": "${need.format}" (or rewrite those conditions using only ${declared} syntax). ` +
                `Left as-is it would install on a ${declared} card and the events would never fire.`);
        }
    }

    // 5. entry size cap
    if (pack.entrySize > MAX_ENTRY_BYTES) errors.push(`size: entry content ${pack.entrySize} bytes exceeds the ${MAX_ENTRY_BYTES}-byte cap`);

    // 3. triggers + keys
    // Three different mistakes, three different messages — "must be a non-empty object" covered all of
    // them and told an author with `"triggers": []` nothing about the bracket being the problem.
    if (!isPlainObject(pack.triggers)) {
        errors.push(`triggers: must be an OBJECT keyed by trigger key ({ "${keyPrefix(pack)}1": { … } }) — got ${describeValue(pack.triggers)}`);
        return { ok: false, errors, warnings };
    }
    if (!Object.keys(pack.triggers).length) {
        errors.push('triggers: the object is empty — a pack with no trigger rows installs nothing, so add at least one row (or delete the pack)');
        return { ok: false, errors, warnings };
    }
    const keys = Object.keys(pack.triggers);
    const prefix = keyPrefix(pack);
    if (keys.length > MAX_ROWS_PER_PACK) errors.push(`size: ${keys.length} trigger rows exceed the ${MAX_ROWS_PER_PACK}-row cap`);

    const seriesSeen = new Set();
    const seriesRows = new Map();   // series name -> the keys of its rows whose prereq carries no flag: token
    for (const key of keys) {
        // Name the offending CHARACTERS, not just the rule — an author staring at "leila-1" does not
        // always spot that the hyphen is the illegal part, and uppercase is the other common slip.
        if (!/^[a-z0-9_]+$/.test(key)) {
            const illegal = [...new Set(key.split('').filter((c) => !/[a-z0-9_]/.test(c)))].join('');
            errors.push(`key "${key}": not a legal stat_data key — lowercase letters, digits and underscore only (offending character${illegal.length === 1 ? '' : 's'}: ${JSON.stringify(illegal)})`);
        }
        if (!key.startsWith(prefix)) errors.push(`key "${key}": must start with this pack's prefix "${prefix}" (built from creator + event), so rename it "${prefix}${key}" or fix the pack's "creator"/"event" meta`);
        if (foreign.has(key)) errors.push(`key "${key}": collides with a trigger already installed by ANOTHER pack — one key belongs to exactly one pack, so rename this row`);

        const row = pack.triggers[key];
        if (!isPlainObject(row)) { errors.push(`row "${key}": each trigger key must map to a ROW OBJECT ({ "cat": "TRG", "when": … }) — got ${describeValue(row)}`); continue; }
        if (JSON.stringify(row).length > MAX_ROW_JSON_BYTES) errors.push(`row "${key}": exceeds the ${MAX_ROW_JSON_BYTES}-byte row cap`);
        // ONLY real series names (P9 §5a.8 #7a). A series-less row is a ONE-SHOT, not "a series named
        // ''" — counting it made a pack holding one arc PLUS one standalone beat report `spans 2 series
        // (S1, )`, naming a series that does not exist and telling the author to split a pack that was
        // never spanning two arcs. Both rows are structurally valid and the engine runs them fine.
        const seriesName = String(row.series == null ? '' : row.series).trim();
        if (seriesName) {
            seriesSeen.add(seriesName);
            if (!/(^|&)\s*!?flag:/i.test(String(row.prereq == null ? '' : row.prereq))) {
                if (!seriesRows.has(seriesName)) seriesRows.set(seriesName, []);
                seriesRows.get(seriesName).push(key);
            }
        }

        // 6. row fields (warn — catches `preqreq`-style typos that would silently never gate)
        for (const f of Object.keys(row)) if (!ROW_FIELDS.includes(f)) warnings.push(`row "${key}": unknown field "${f}" (engine ignores it)`);
        if (row.cat !== undefined && !CAT_VALUES.includes(row.cat)) warnings.push(`row "${key}": cat "${row.cat}" is not TRG/TIME`);

        // 7. WHEN-DSL grammar shape (prereq + when + whenAny, '&'-split)
        // `whenAny` (§4b) is ONE level of OR-of-ANDs: an array of alternatives, each still a flat
        // AND-chain, so every alternative lints exactly like a `when`.
        const hasWhenAny = row.whenAny !== undefined;
        if (hasWhenAny && row.when !== undefined) {
            // An ERROR, not a warning: with both present the engine evaluates `whenAny` and ignores
            // `when` entirely, so the author's other condition is silently dropped. Guessing which one
            // they meant is exactly the class of bug this validator exists to refuse.
            errors.push(`row "${key}": carries BOTH "when" and "whenAny" — they are alternatives, so pick one (whenAny wins at runtime and "when" would be silently ignored)`);
        }
        if (hasWhenAny && (!Array.isArray(row.whenAny) || row.whenAny.length === 0 || row.whenAny.some((a) => typeof a !== 'string'))) {
            // An EMPTY array would read as "no alternative can hold", i.e. an event that can never fire.
            errors.push(`row "${key}": "whenAny" must be a non-empty array of condition strings`);
        }
        const chains = [];
        if (row.prereq !== undefined) chains.push(['prereq', String(row.prereq)]);
        if (row.when !== undefined) chains.push(['when', String(row.when)]);
        if (Array.isArray(row.whenAny)) {
            row.whenAny.forEach((alt, i) => { if (typeof alt === 'string') chains.push([`whenAny[${i}]`, alt]); });
        }
        for (const [field, chain] of chains) {
            for (const tok of chain.split('&')) {
                if (!isTokenShapeOk(tok)) warnings.push(`row "${key}": ${field} token "${tok.trim()}" matches no known shape (likely a typo; fails safe at runtime)`);
            }
        }

        // 8. fx SHAPE — the FORMAT's own fields (summary · scope · writes) and nothing a genre owns. A write
        // is { path, key?, set?, add?, remove? }: its shape is checked here (ERRORS — a malformed write is
        // refused at fire, so a pack that passed would be one whose rows visibly change nothing), and so is
        // its key's CHARSET, which no card can make legal. WHO may hold that key is the engine's answer at
        // fire, not this function's — the owner gate reads the record that is there now — so the only
        // install-time half is whether the card's path can record ownership at all (unstampedWritePaths),
        // beside the path gate (unallowedWritePaths). FIELD NAMES are the card's own schema and are never
        // inspected.
        if (row.fx !== undefined) {
            if (!isPlainObject(row.fx)) { warnings.push(`row "${key}": fx is not an object (engine ignores it)`); }
            else {
                if (row.fx.summary !== undefined && typeof row.fx.summary !== 'string') {
                    warnings.push(`row "${key}": fx.summary should be a string — got ${describeValue(row.fx.summary)}`);
                }
                if (row.fx.scope !== undefined && typeof row.fx.scope !== 'string') {
                    warnings.push(`row "${key}": fx.scope should be a string — got ${describeValue(row.fx.scope)}`);
                }
                for (const k of Object.keys(row.fx)) {
                    if (!FX_META.includes(k)) warnings.push(`row "${key}": fx.${k} is not a field of format ${SUPPORTED_FORMAT} (${FX_META.join(', ')}) — the engine ignores it; an effect is a fx.writes entry`);
                }
                if (row.fx.reward !== undefined) {
                    if (!isPlainObject(row.fx.reward)) {
                        errors.push(`row "${key}": fx.reward must be an object of kind: { field: amount } (e.g. { "stat": { "Cha": 5 } }) — got ${describeValue(row.fx.reward)}`);
                    } else {
                        for (const kind of Object.keys(row.fx.reward)) {
                            const paid = row.fx.reward[kind];
                            const at = `row "${key}": fx.reward.${kind}`;
                            if (!isPlainObject(paid)) { errors.push(`${at}: must be an object of field: amount pairs — got ${describeValue(paid)}`); continue; }
                            const names = Object.keys(paid);
                            if (!names.length) { warnings.push(`${at}: pays no field — it rewards nothing`); continue; }
                            // The NESTING is read from the value, never from a flag: a number is an amount,
                            // an object is a member of a keyed kind. This side has no card, so it cannot know
                            // which kinds are keyed — and does not need to, to check the shape is one of the two.
                            for (const name of names) {
                                if (isPlainObject(paid[name])) { checkAmounts(paid[name], `${at}.${name}`, errors, warnings); continue; }
                                checkAmounts({ [name]: paid[name] }, at, errors, warnings);
                            }
                        }
                    }
                }
                if (row.fx.writes !== undefined) {
                    if (!Array.isArray(row.fx.writes)) {
                        errors.push(`row "${key}": fx.writes must be an ARRAY of writes ([{ "path": …, "key": …, "set": { … } }]) — got ${describeValue(row.fx.writes)}`);
                    } else {
                        row.fx.writes.forEach((w, i) => {
                            const at = `row "${key}": fx.writes[${i}]`;
                            if (!isPlainObject(w)) { errors.push(`${at}: must be an object { path, key, set } — got ${describeValue(w)}`); return; }
                            if (typeof w.path !== 'string' || !WRITE_PATH.test(w.path)) errors.push(`${at}: "path" must be a dotted stat_data path (e.g. "YourRoot.YourCollection") — got ${describeValue(w.path)}`);
                            if (w.key !== undefined) {
                                if (typeof w.key !== 'string' || !w.key) errors.push(`${at}: "key" must be a non-empty string — got ${describeValue(w.key)}`);
                                else if (/[./]/.test(w.key)) errors.push(`${at}: key "${w.key}" contains "." or "/" — those are MVU's path delimiters and can never be part of a key`);
                            }
                            for (const f of ['set', 'add']) {
                                if (w[f] !== undefined && !isPlainObject(w[f])) errors.push(`${at}: "${f}" must be an object of field: value pairs — got ${describeValue(w[f])}`);
                            }
                            if (w.remove !== undefined && w.remove !== true) errors.push(`${at}: "remove" must be exactly true when present — got ${describeValue(w.remove)}`);
                            if (w.set === undefined && w.add === undefined && w.remove !== true) warnings.push(`${at}: carries no set, add or remove — it writes nothing`);
                        });
                    }
                }
            }
        }

        // 9. BODY COVERAGE — ERROR (▲ user 2026-08-05: "the two halves HAVE to be inside the file and
        // contiguous — this is the only way we know it's a valid event"). A trigger row and its body are
        // two halves of ONE thing, joined by nothing but the key string appearing in both; if they
        // disagree the pack is not half-valid, it is broken:
        //   no gate      ⇒ the event ARMS and renders nothing — a turn that visibly waits forever
        //   no eventFire ⇒ the body plays but never reports, so fx never applies and the row never
        //                  marks done — the same scene replays and the quest log never moves
        // Contiguity comes for free from `pack.prose`: parseUploadFile gives each pack ONLY the text
        // between its own block and the next, so a body under a different pack's block cannot satisfy
        // this. The runtime extractor (findArmedBody) stays source-BLIND on purpose — it serves official
        // bodies too — so the "body lives in another entry" case remains renderable; it is just no longer
        // a shape a PACK may be built in, because the builder emits both halves together by construction.
        if (typeof pack.prose === 'string') {
            if (!pack.prose.includes(`'@${key}'`)) errors.push(`row "${key}": no === '@${key}' gate in this pack's own prose — the body must ship with the row`);
            if (!pack.prose.includes(`${FIRE_INTENT} "${key}`)) {
                errors.push(`row "${key}": no ${FIRE_INTENT} "${key}" emit in this pack's own prose — without it the beat plays but nothing commits: no fx, no fired record, and the event re-fires every turn`);
            }
        }
    }

    // 5b. a chain must ORDER on the engine's own marker. The engine owns both `series` and `flag:`: it
    // marks every fire at <root>.fired.<key> and never deletes that, so `flag:<previous key>` is the ONE
    // gate that stays true. Anything else a chain could read — a record one of its own writes created, a
    // stamp on that record — is state the engine cannot keep: the genre may delete or reset it (School
    // sweeps a completed quest at the day's settle), after which every later beat is closed forever.
    // Only the OPENER may carry no flag; a second flag-less row in one series is a chain ordering on
    // something else. Genre-blind by construction: it inspects the token KIND, never a path.
    for (const [name, rows] of seriesRows) {
        if (rows.length < 2) continue;
        warnings.push(`series "${name}": ${rows.length} rows carry no flag: token in prereq (${rows.join(', ')}) — only the opener may; every later beat must gate on flag:<previous key>, because the engine keeps a fired row closed with its own fired-marker while anything else a chain reads can be deleted underneath it`);
    }
    // 5a. one series per pack
    if (seriesSeen.size > 1) errors.push(`series: pack spans ${seriesSeen.size} series (${[...seriesSeen].join(', ')}) — one series per pack; ship two packs`);

    return { ok: errors.length === 0, errors, warnings };
}

// ── apply (§3.3 upgrade semantics + §3.1a format gate + §5 fence) ────────────

const fmtMajor = (f) => parseInt(String(f || '1.0').split('.')[0], 10) || 0;
const fmtMinor = (f) => parseInt(String(f || '1.0').split('.')[1], 10) || 0;

// THE ONE SHAPE of the armed-event pointer: MVU's [value, label] pair, the way MvuStatMenuBuilder builds
// the variable — ['@<key>', label] while an event is armed, ['', label] when none is. Every body the
// builder writes opens on `getvar('stat_data.<armedPath>[0]') === '@<key>'`, and on any other shape that
// read can never equal the key (on a plain string, `[0]` is its first character, '@'): every event would
// arm and none would reach the narrator, with no error anywhere. So another shape is REPORTED, never
// coerced. Returns '' when the slot is a pair whose value is a string, or when it does not exist yet —
// the engine creates it on its first arm, so an absent slot says nothing about its shape.
export function armedPointerShapeProblem(statData, armedPath) {
    const value = getPath(statData, armedPath);
    if (value === undefined) return '';
    if (Array.isArray(value) && typeof value[0] === 'string') return '';
    const holds = Array.isArray(value) ? `an array whose first item is ${describeValue(value[0])}` : describeValue(value);
    return `stat_data.${armedPath} holds ${holds}, not the MVU [value, label] pair (["@<key>", "label"]) that event packs require — `
        + `every pack body opens on getvar('stat_data.${armedPath}[0]') === '@<key>', which can never be true on that shape`;
}

// Clear the armed-event slot iff it currently holds '@<key>' for one of `keys`.
// Returns the cleared key, or null when the armed value is not one of `keys`. A slot in any other shape
// than the pair is left untouched: armedPointerShapeProblem names it, the sync pass logs that every chat
// load, and an install onto it is refused.
function clearArmedKeyIfOwned(statData, armedPath, keys) {
    const armedVal = getPath(statData, armedPath);
    if (!Array.isArray(armedVal) || typeof armedVal[0] !== 'string' || !armedVal[0].startsWith('@')) return null;
    const armedKey = armedVal[0].slice(1);
    if (!keys.includes(armedKey)) return null;
    armedVal[0] = '';
    return armedKey;
}

// The library keeps its OWN stores beside the trigger table, at <parent-of-triggerRoot>.<name>. The
// derivation mirrors eventpack.cjs's siblingRoot, including '' for a root with no dot (there is no
// sibling then). One spelling here, so the install record and the fired count cannot disagree about
// where the other store is.
const siblingRootOf = (triggerRoot, name) => {
    const root = String(triggerRoot || '');
    return root.includes('.') ? root.replace(/\.[^.]+$/, '.' + name) : '';
};

// The installed registry: <parent-of-triggerRoot>.installed. Exported so the install lane and the tab
// derive it from the same declared triggerRoot rather than spelling the path themselves.
export const installedRootOf = (triggerRoot) => siblingRootOf(triggerRoot, 'installed');

// The library's done-markers: <parent-of-triggerRoot>.fired.<key> = { state, scope, at }. No card
// declares this path; it is platform bookkeeping, never a genre store a player can prune.
export const firedRootOf = (triggerRoot) => siblingRootOf(triggerRoot, 'fired');

// Merge parsed `packs` into `statData` IN PLACE. opts (all optional):
//   cardFormat  — the pack-format level the CARD's baked engine can EXECUTE (§3.1a). P1 defaulted it
//                 to mvu-helper's own SUPPORTED_FORMAT, which answers the wrong question; since P4a
//                 the sync pass reads it from the engine bundle header and passes it here.
//   triggerRoot — dotted path of the trigger table   (REQUIRED, P4b — from the engine header)
//   armedPath   — dotted path of the armed-event key (REQUIRED, P4b — from the engine header)
// Returns { changed, reports } — one report per pack:
//   { packId, version, applied, skipped, incompatible, reason, added: [keys], removed: [keys], errors: [], warnings: [] }
export function applyEventPacks(statData, packs, opts) {
    const cfg = { cardFormat: SUPPORTED_FORMAT, ...requirePaths(opts) };
    const installedRoot = installedRootOf(cfg.triggerRoot);
    const reports = [];
    let changed = false;

    for (const pack of packs || []) {
        const report = { packId: pack.packId || packId(pack), version: pack.version, applied: false, skipped: false, reason: '', added: [], removed: [], errors: [], warnings: [] };
        reports.push(report);

        // §3.1a format compat gate — against the RUNNING CARD's engine level
        const pM = fmtMajor(pack.format), cM = fmtMajor(cfg.cardFormat);
        if (pM > cM) {
            report.skipped = true;
            // FLAGGED, not merely reasoned. `reason` is also set by ordinary quiet no-ops (an
            // already-installed version), so a caller cannot tell a real INCOMPATIBILITY from
            // "nothing to do" without this — and §3.1a says a major mismatch gets a toast. Before
            // P4a the case was unreachable (nothing was ever 2.0) and it reported as a plain
            // 'skipped': no log, no toast, the pack silently never installing. P7 makes it reachable.
            report.incompatible = true;
            report.reason = `pack format ${pack.format} needs a newer engine (card format ${cfg.cardFormat}) — update the card`;
            continue;   // HARD skip: the engine genuinely can't execute it
        }
        if (pM === cM && fmtMinor(pack.format) > fmtMinor(cfg.cardFormat)) {
            report.warnings.push(`pack format ${pack.format} uses newer optional features this card (format ${cfg.cardFormat}) ignores; core events still work`);
        }

        // The WRITE-PATH gate, catch point 2 of 3 (install is 1, the engine's fire-time refusal is 3).
        // Format compatibility does not imply write compatibility: a School pack and a Space card agree on
        // the grammar and disagree completely about where a pack may write. This is the SCAN side, so it
        // WARNS rather than refusing — the pack is already installed and its rows still arm and play; only
        // those writes are refused at fire. It exists for the case import cannot reach: the engine bundle
        // swapped AFTER the pack landed.
        const unallowed = unallowedWritePaths(pack, cfg.cardWrites);
        if (unallowed.length) {
            const allowed = (cfg.cardWrites || []).map((e) => (e && typeof e === 'object') ? e.path : e);
            report.warnings.push(`this card's engine allows no writes into ${unallowed.join(', ')} ` +
                `(it allows: ${allowed.join(', ') || 'none'}) — those writes will be refused when the event fires`);
        }
        // The scope half of the same gate, and a WARNING on both catch points (install is the other):
        // the row still arms, plays and applies its fx — only what the engine makes of a scope it never
        // declared is unknown here, and that is the engine's to decide, not this code's to guess.
        // The OWNERSHIP half of the same gate: a keyed write onto a path that cannot record who made a
        // record. Same catch-point rule as the path — a WARNING here (the pack is installed; the engine
        // refuses the write at fire).
        const unstamped = unstampedWritePaths(pack, cfg.cardWrites);
        if (unstamped.length) {
            report.warnings.push(`${unstamped.map((r) => `row "${r.key}" writes a record into ${r.path}`).join(', ')} — this card's engine declares no ` +
                `ownerStamp on that path and does not share it, so no record there can say who made it and the write is refused when the event fires`);
        }
        const undeclared = undeclaredScopeRows(pack, cfg.cardScopes);
        if (undeclared.length) {
            report.warnings.push(`this card's engine declares no scope named ${undeclared.map((r) => `"${r.scope}" (row ${r.key})`).join(', ')} ` +
                `(it declares: ${(cfg.cardScopes || []).join(', ') || 'none'}) — the engine decides what an undeclared scope means; check the spelling`);
        }

        const installed = ensurePath(statData, installedRoot);
        // Names WHAT is blocking the path, not just that something is: with P4b the root comes from the
        // card engine's header, so "something is in the way at X" is now two possible bugs — a corrupted
        // save, or a stamped path pointing at a field that already holds something else.
        if (!installed) {
            report.skipped = true;
            report.reason = `cannot write the installed-pack record: stat_data.${installedRoot} already holds ${describeValue(getPath(statData, installedRoot))}, not an object — clear that field, or check the triggerRoot this card's engine declares`;
            continue;
        }
        const triggers = ensurePath(statData, cfg.triggerRoot);
        if (!triggers) {
            report.skipped = true;
            report.reason = `cannot write the trigger rows: stat_data.${cfg.triggerRoot} already holds ${describeValue(getPath(statData, cfg.triggerRoot))}, not an object — clear that field, or check the triggerRoot this card's engine declares`;
            continue;
        }

        // §3.3 currency gate — the every-load fast path. Skips iff the save ALREADY agrees with the
        // pack; see decideMerge for why this asks about rows and not about the version number.
        const rec = installed[report.packId];
        const verdict = decideMerge(pack, rec, triggers);
        if (verdict.action === 'current') {
            report.skipped = true;
            report.reason = `v${pack.version} rows are already current`;
            continue;
        }

        // §4 validate + §5 collision fence (foreign = every existing trigger key this pack doesn't own)
        const ownKeys = (rec && Array.isArray(rec.keys)) ? rec.keys : [];
        const foreign = new Set(Object.keys(triggers).filter((k) => !ownKeys.includes(k)));
        const vres = validateEventPack(pack, foreign);
        report.warnings.push(...vres.warnings);
        if (!vres.ok) {
            report.skipped = true;
            report.errors = vres.errors;
            report.reason = vres.errors[0];
            continue;   // any ERROR ⇒ pack skipped entirely, never partially applied
        }

        // §3.3 merge — wholesale replace of this pack's rows (DEFINITION-class; live state untouched)
        const newKeys = Object.keys(pack.triggers);
        for (const k of ownKeys) {
            if (!(k in pack.triggers)) { delete triggers[k]; report.removed.push(k); }
        }
        for (const k of newKeys) { triggers[k] = deepClone(pack.triggers[k]); report.added.push(k); }
        // `keys` is the whole watermark the engine needs: it reads this record to learn which pack owns a
        // firing row, and stamps that pack's id on any record the row creates.
        installed[report.packId] = { ver: pack.version, keys: newKeys };

        // §3.3 upgrade-while-armed: keep the armed key if the new version still has it, clear if dropped
        const dropped = ownKeys.filter((k) => !newKeys.includes(k));
        const cleared = clearArmedKeyIfOwned(statData, cfg.armedPath, dropped);
        if (cleared) report.warnings.push(`armed event "${cleared}" was dropped by v${pack.version} — cleared ${cfg.armedPath}`);

        report.applied = true;
        changed = true;
    }
    return { changed, reports };
}

// ── install-lane helpers (the P3b tab: EJS lint §5, duplicate guard §3.3, registry I/O) ──

// §5 EJS exposure lint — the tab-lane gate that makes installed packs code-free by construction.
// The ONLY '<%' sequences allowed in pack text are the sanctioned patterns:
//   <%_ if (false) { _%>                                              (the JSON-hide wrapper)
//   <%_ if (getvar('stat_data.<armedPath>[0]') === '@key') { _%>      (a flat armed-event gate)
//   <%_ } _%>                                                         (the closer)
// ANY other EJS ⇒ reject the install (returned as errors; caller blocks). Checks the WHOLE pasted
// text (JSON block included). Also rejects a dangling '<%' with no '%>' close.
export function lintPackEjs(text, opts) {
    const cfg = requirePaths(opts);
    const armedEsc = cfg.armedPath.replace(/\./g, '\\.');
    const gate = (index) => new RegExp(`^<%_\\s*if\\s*\\(\\s*getvar\\(\\s*'stat_data\\.${armedEsc}${index}'\\s*\\)\\s*===\\s*'@[a-z0-9_]+'\\s*\\)\\s*\\{\\s*_%>$`);
    const SANCTIONED = [
        /^<%_\s*if\s*\(\s*false\s*\)\s*\{\s*_%>$/,
        // `[0]` is REQUIRED: the armed pointer is MVU's [value, label] pair and the gate reads its value
        // half (armedPointerShapeProblem says why). The fence is pinned to THIS card's armedPath, which
        // stops a pack gating on any other variable, and compares against a literal '@key'.
        gate('\\[0\\]'),
        /^<%_\s*\}\s*_%>$/,
    ];
    // The gate WITHOUT `[0]` is the one an author writes for a plain-string pointer. It compares the
    // whole [value, label] pair to a string, so it can never open: refused with its own answer.
    const PAIR_BLIND_GATE = gate('');
    const errors = [];
    const src = String(text || '');
    const chunks = src.match(/<%[\s\S]*?%>/g) || [];
    // The rejection has to SHOW THE THREE LEGAL FORMS. This is the lint an author trips most often,
    // and "unsanctioned EJS: <the thing they wrote>" tells them only that it was refused — not what
    // they may write instead, and the armed gate's exact spelling (including this card's own armedPath)
    // is not guessable. Strict acceptance is paid for with a diagnosis that carries the answer.
    const allowed = `allowed forms are exactly: \`<%_ if (false) { _%>\` (the JSON-hide wrapper) · ` +
        `\`<%_ if (getvar('stat_data.${cfg.armedPath}[0]') === '@yourkey') { _%>\` (the armed-event gate) · ` +
        `\`<%_ } _%>\` (the closer)`;
    for (const chunk of chunks) {
        const one = chunk.trim();
        if (SANCTIONED.some((re) => re.test(one))) continue;
        if (PAIR_BLIND_GATE.test(one)) {
            errors.push(`EJS not allowed: ${one.slice(0, 120)} — the armed-event pointer is an MVU [value, label] pair, so the gate must read its value at [0]: ` +
                `\`getvar('stat_data.${cfg.armedPath}[0]')\`. Without [0] it compares the whole pair to a string and the body never plays. ${allowed}`);
            continue;
        }
        // A near-miss on the armed gate is the common case, and it deserves its own answer: the author
        // wrote a gate, just not against THIS card's armed path (or with the wrong key shape).
        const looksLikeGate = /getvar\s*\(/.test(one) && /===/.test(one);
        errors.push(looksLikeGate
            ? `EJS not allowed: ${one.slice(0, 120)} — it looks like an armed-event gate, but it must read EXACTLY \`getvar('stat_data.${cfg.armedPath}[0]')\` and compare to a '@key' of lowercase letters/digits/underscore. ${allowed}`
            : `EJS not allowed: ${one.slice(0, 120)} — packs carry DATA and prose, never logic. ${allowed}`);
    }
    const opens = (src.match(/<%/g) || []).length;
    if (opens > chunks.length) {
        errors.push(`dangling '<%' with no closing '%>' — ${opens} opening tag${opens === 1 ? '' : 's'} but only ${chunks.length} complete one${chunks.length === 1 ? '' : 's'}; every '<%' needs a matching '%>'`);
    }
    return { ok: errors.length === 0, errors };
}

// §3.3 install-time duplicate guard (tab): compare the pasted pack against the cross-chat registry.
//   install          — pack ID not registered yet
//   upgrade          — newer version than the registered one
//   reject-same      — same version ("already installed")
//   reject-downgrade — older version (NO downgrade path; recovery = uninstall, then fresh-install)
// Returns { action, installedVer } (installedVer '' when not registered).
export function decideInstall(pack, registry) {
    const rec = registry && registry[pack.packId];
    if (!rec) return { action: 'install', installedVer: '' };
    const c = compareVersions(pack.version, rec.ver);
    if (c > 0) return { action: 'upgrade', installedVer: rec.ver };
    if (c === 0) return { action: 'reject-same', installedVer: rec.ver };
    return { action: 'reject-downgrade', installedVer: rec.ver };
}

// Does this save ALREADY carry, exactly, what the pack declares? Compares the installed record's version
// and every row it claims. `false` on anything it cannot read, so an
// unreadable save merges rather than being declared current on a guess.
//
// Not just the rows: a version bump that changed no trigger still has to rewrite the record, or the
// save keeps reporting the old version while carrying the new pack's rows.
export function packRowsMatch(pack, rec, triggers) {
    if (!rec || !isPlainObject(triggers)) return false;
    if (String(rec.ver || '') !== String(pack.version || '')) return false;
    const ownKeys = Array.isArray(rec.keys) ? rec.keys : [];
    const packKeys = Object.keys(pack.triggers || {});
    if (ownKeys.length !== packKeys.length) return false;
    return packKeys.every((k) => ownKeys.includes(k) && deepEqual(triggers[k], pack.triggers[k]));
}

// The MERGE half's verdict — sibling of decideInstall, and deliberately NOT the same rule.
//
// decideInstall answers a question of POLICY: may this pack replace the installed one? Version is the
// author's identity claim there, so a same-version paste is refused and a downgrade needs an uninstall
// first — the registry is what a player reads to know which version is live, and a silent re-write of
// it makes two saves both "v3.2" with different games inside.
//
// This answers a question of FACT: does the save carry what the card's pack entry says? The entry got
// there under decideInstall's policy, so by the time we are here the only correct move is to make the
// save agree with it — a lower version on the card included.
//
// So it compares ROWS, never the version number. A version is only a PROXY for "are these rows
// current", and the dev loop breaks that proxy on every rebuild that does not move the number: same
// version, different rows. Any gate built on the proxy then needs an exemption handed in for the loop,
// and an exemption cannot tell an already-merged pack from a freshly rebuilt one — so it re-merges on
// every sync afterwards. Comparing the rows asks the real question once, for the loop and for
// everyone else, and needs no exemption from anybody.
// What a sync pass should SAY out loud about its reports — one line per OUTCOME, never one per pack.
// A card may carry a hundred packs and a first sync merges every one of them: a toast each buries the
// screen behind near-identical lines and says nothing the summary does not. At N=1 the per-pack wording
// stays, because there the pack's NAME is the useful part. Nothing is lost either way — the caller logs
// every pack individually regardless, and the summaries point at that log.
//
// Quiet outcomes ('skipped', and the pruning transitions) are deliberately absent: they are ordinary,
// and a toast for them would be the noise this exists to prevent.
export function packSyncToasts(reports) {
    const of = (action) => (reports || []).filter((r) => r && r.action === action);
    const eventsIn = (rows) => rows.reduce((n, r) => n + ((r.added && r.added.length) || 0), 0);
    const batch = (level, rows, one, many) => (rows.length === 0 ? []
        : [{ level, message: rows.length === 1 ? one(rows[0]) : many(rows) }]);
    return [
        ...batch('success', of('merged'),
            // Counted through eventsIn like the plural line, so one malformed report cannot throw here
            // and take the whole sync pass down with it — every other outcome still has to be announced.
            (r) => `Event pack ${r.packId} v${r.version} installed (${eventsIn([r])} event${eventsIn([r]) === 1 ? '' : 's'})`,
            (rows) => `${rows.length} event packs installed (${eventsIn(rows)} events)`),
        ...batch('error', of('error'),
            (r) => `Event pack ${r.packId} skipped: ${r.reason}`,
            (rows) => `${rows.length} event packs skipped (see console).`),
        // §3.1a HARD SKIP. This one MUST be loud: nothing was written and nothing will ever fire, so a
        // quiet skip looks identical to a working install until the player wonders why the event never
        // happens. The fix is the CARD's (update it), not the pack's, so the message names both levels.
        ...batch('warning', of('incompatible'),
            (r) => `Event pack ${r.packId} needs a newer card: ${r.reason}`,
            (rows) => `${rows.length} event packs need a newer card (see console).`),
        ...batch('error', of('malformed'),
            (r) => `Event pack ${r.packId} entry is malformed (see console).`,
            (rows) => `${rows.length} event pack entries are malformed (see console).`),
    ];
}

export function decideMerge(pack, rec, triggers) {
    if (!rec) return { action: 'install', installedVer: '' };
    if (packRowsMatch(pack, rec, triggers)) return { action: 'current', installedVer: rec.ver };
    return { action: compareVersions(pack.version, rec.ver) > 0 ? 'upgrade' : 'refresh', installedVer: rec.ver };
}

// Serialize the registry for its worldbook entry (round-trips through parseRegistry — the '#'
// header line is stripped by its comment tolerance).
export function buildRegistryContent(registry) {
    return buildRegistryText(REGISTRY_COMMENT, 'EventPack', registry);
}

// The §3 comment convention for a pack's worldbook entry — what the tab writes and the
// reconcile scan's malformed-vs-missing check matches on.
export function packEntryComment(id) {
    return '[MVU_Event_Pack] ' + id;
}

// The worldbook entry one installed pack is written as. Its content opens with an @@if on the pack's OWN
// keys, so ST-Prompt-Template drops the entry on every reply none of them is armed: it is never activated,
// rendered or stored in the prompt record, and text outside a body's gate shows only while one of the
// pack's beats is armed. `bodyEntry` is the slot the card's engine declares (readEventContract's bodyEntry
// verdict); null leaves the entry in the host's default slot. MUST be `type:'constant'`, NOT
// `constant:true`: TavernHelper's entry model has no `constant` boolean — a boolean is silently dropped,
// leaving `type:'selective'` + no keys, which ST never injects. PURE — the caller writes it.
export function packEntryWrite(pack, { armedPath, bodyEntry } = {}) {
    if (typeof armedPath !== 'string' || !armedPath) {
        throw new Error('event-pack: armedPath is REQUIRED — read it from the loaded engine via readEventContract().paths');
    }
    const armedKeys = Object.keys((pack && pack.triggers) || {}).map((key) => '@' + key);
    const gate = '@@if ' + JSON.stringify(armedKeys) + ".includes(String(getvar('stat_data." + armedPath + "[0]') || ''))";
    return {
        comment: packEntryComment(pack.packId),
        content: gate + '\n' + pack.entryContent,
        enabled: true,
        type: 'constant',
        keys: [],
        ...(bodyEntry ? { position: bodyEntry.position, depth: bodyEntry.depth, order: bodyEntry.order } : {}),
    };
}

// The pack entry for one id, or null. Matches the comment LOOSELY (substring, case-insensitive)
// rather than comparing two comment strings, so a hand-edited comment does not read as "entry
// missing" — the 2026-08-14 lesson. Lives here, not in the tab, because packInfo answers the same
// question and two copies of "which entry is this pack's" is exactly the drift this module removes.
export function findPackEntry(entries, id) {
    const needle = String(id).toLowerCase();
    return (entries || []).find((e) => {
        const c = String(e.comment || '').toLowerCase();
        return c.includes(PACK_ENTRY_MATCH) && c.includes(needle);
    }) || null;
}

// ── prune + registry-driven scan reconciliation (§5.5) ───────────────────────

// Remove ONE pack's footprint from stat_data: delete the rows its per-chat installed record owns,
// clear the armed slot if it holds one of them, drop the record. The library's done-markers
// (firedRootOf) and every record the pack's fired events wrote (quests and the like) are NEVER
// touched — history survives, so a later re-install won't re-fire done one-shots (§3.1 stable-key property).
// Returns { changed, removed: [keys], clearedArmed: key|null }.
export function pruneEventPack(statData, id, opts) {
    const cfg = requirePaths(opts);
    const out = { changed: false, removed: [], clearedArmed: null };
    const installed = getPath(statData, installedRootOf(cfg.triggerRoot));
    const rec = installed && installed[id];
    if (!rec) return out;                                     // nothing applied to THIS chat → no-op
    const triggers = getPath(statData, cfg.triggerRoot);
    const ownKeys = Array.isArray(rec.keys) ? rec.keys : [];
    for (const k of ownKeys) {
        if (triggers && k in triggers) { delete triggers[k]; out.removed.push(k); }
    }
    out.clearedArmed = clearArmedKeyIfOwned(statData, cfg.armedPath, ownKeys);
    delete installed[id];                                     // dropping the record lets a re-enable re-merge (version gate would otherwise block it)
    out.changed = true;
    return out;
}

// The §5.5 every-chat-load scan, REGISTRY-driven (the entry `enabled` flag is the disable truth):
//   registry record + entry enabled        → merge rows (applyEventPacks §3.3 path)   action merged|skipped|error
//   registry record + entry disabled       → prune rows, drop per-chat record         action disabled
//   registry record + entry MISSING        → auto-disable prune (registry KEPT — it lives in the
//                                            worldbook; this function only touches stat_data)      action missing
//   registry record + entry unparseable    → report the error, NO destructive action (a typo mid-edit
//                                            must not wipe live rows)                              action malformed
//   pack MAJOR format > the card's engine  → HARD skip, nothing written, and it must SPEAK (§3.1a) action incompatible
//   per-chat installed record, NO registry → pack uninstalled from another chat: prune + drop       action uninstalled
//   unregistered [MVU_Event_Pack] entries  → ignored entirely (§5.5 — never scanned, never listed)
// `registry` = parseRegistry() output; `entries` = the standalone worldbook entries.
// Returns { changed, reports: [{ packId, action, ... }] } — merge rows reuse the applyEventPacks report.
// Which installed packs a MERGE-ONLY pass should carry onto a floor. The full reconcile above runs
// both directions — merge what the registry lists, prune what it no longer does — and pruning is a
// chat-load duty: it answers "this pack was uninstalled elsewhere", which cannot become true between
// two replies of one chat. So the before-generation ensure takes only this half, and this function is
// the whole of the choice, kept pure so the narrowing is provable (L6).
//
// Both filters are load-bearing. A pack whose ENTRY IS DISABLED must not be re-merged — the reconcile
// prunes exactly that on chat load, and re-merging it here would put the rows back every turn, a loop
// with the user's own toggle on the other end. A parsed pack the REGISTRY does not list was never
// installed through the tab (hand-pasted, or left over from a removed install), and the registry is
// what "installed" means.
export function installedPacksToEnsure(registry, parsedPacks) {
    const reg = (registry && typeof registry === 'object') ? registry : {};
    return (Array.isArray(parsedPacks) ? parsedPacks : [])
        .filter((p) => p && p.enabled && reg[p.packId] !== undefined);
}

export function reconcileEventPacks(statData, registry, entries, opts) {
    const cfg = { cardFormat: SUPPORTED_FORMAT, ...requirePaths(opts) };
    const parsed = parseEventPacks(entries);
    const byId = new Map(parsed.packs.map((p) => [p.packId, p]));
    const reports = [];
    let changed = false;

    for (const id of Object.keys(registry || {})) {
        const pack = byId.get(id);
        if (pack && pack.enabled) {
            const res = applyEventPacks(statData, [pack], cfg);
            changed = changed || res.changed;
            const r = res.reports[0];
            reports.push({ ...r, action: r.applied ? 'merged' : (r.errors.length ? 'error' : (r.incompatible ? 'incompatible' : 'skipped')) });
            continue;
        }
        if (pack) {                                           // entry present but enabled=false
            const p = pruneEventPack(statData, id, cfg);
            changed = changed || p.changed;
            reports.push({ packId: id, action: 'disabled', removed: p.removed, clearedArmed: p.clearedArmed, changed: p.changed });
            continue;
        }
        // No parsed pack — malformed entry (comment names the pack ID, §3 convention) or hand-deleted.
        const hasEntry = (entries || []).some((e) => String((e && e.comment) || '').toLowerCase().includes(PACK_ENTRY_MATCH)
            && String((e && e.comment) || '').toLowerCase().includes(id));
        if (hasEntry) {
            const err = parsed.errors.find((x) => x.comment.toLowerCase().includes(id));
            reports.push({ packId: id, action: 'malformed', error: (err && err.error) || 'pack entry did not parse', changed: false });
            continue;
        }
        const p = pruneEventPack(statData, id, cfg);
        changed = changed || p.changed;
        reports.push({ packId: id, action: 'missing', removed: p.removed, clearedArmed: p.clearedArmed, changed: p.changed });
    }

    // INVERSE direction — how uninstall PROPAGATES across chats (§5.5)
    const installed = getPath(statData, installedRootOf(cfg.triggerRoot)) || {};
    for (const id of Object.keys(installed)) {
        if (registry && registry[id] !== undefined) continue;
        const p = pruneEventPack(statData, id, cfg);
        changed = changed || p.changed;
        reports.push({ packId: id, action: 'uninstalled', removed: p.removed, clearedArmed: p.clearedArmed, changed: p.changed });
    }

    return { changed, reports };
}

// ── packInfo: ONE read that answers "what is actually installed?" (§diagnostics) ──────────────
//
// WHY THIS EXISTS. Answering that question by hand means reading four stores that can disagree, and
// the obvious place to look is the WRONG one: a card's embedded `data.character_book` is a build-time
// snapshot, and when the character is bound to a standalone world (`data.extensions.world`) ST ignores
// the embedded copy entirely. Both `ctx.characters[…].data.character_book` and
// `POST /api/characters/get` return that embedded snapshot, so the two AGREE with each other while
// both are stale — and the agreement reads as confirmation. That cost a live debugging session on
// 2026-09-09: the standalone world held a pack at v3.0, the embedded book held v2.0, and the tab's
// correct "installed and complete" was reported to the user as a lie.
//
// So this returns the four stores side by side, each labelled with where it came from, plus the
// DISAGREEMENTS between them already computed. Pure: the caller does every read and hands them in.
//
//   entries      — the BOUND STANDALONE worldbook's entries, or null when it could not be read
//   registry     — parsed [MVU_Event_Pack_Registry] ({ id: { ver } }), or null when malformed
//   stored       — listStoredEventPacks() output, or null when the library book could not be read
//   statData     — the current chat's stat_data
//   enginePaths  — { ok, triggerRoot, reason } from the engine's declared EVENT_PACK_ADAPTER
//
// Returns a plain object; `disagreements` is the field to read first.
export function buildPackInfo({ boundWorld = '', entries = null, registry = null, stored = null, statData = null, enginePaths = null } = {}) {
    const paths = enginePaths || { ok: false, reason: 'engine paths not supplied' };
    const triggerRoot = paths.ok ? String(paths.triggerRoot || '') : '';
    const firedRoot = firedRootOf(triggerRoot);
    const installedRoot = installedRootOf(triggerRoot);
    // `{}` — not null — when the root is KNOWN but no row has fired yet: the table is created by the
    // first fire, so its absence is a real zero. null is reserved for "no trigger root at all",
    // where the count is genuinely unknowable and must never print as 0.
    const firedTable = firedRoot ? (getPath(statData || {}, firedRoot) || {}) : null;
    const watermarks = installedRoot ? (getPath(statData || {}, installedRoot) || {}) : {};
    const triggerTable = triggerRoot ? (getPath(statData || {}, triggerRoot) || {}) : {};
    const storedById = new Map((stored || []).map((s) => [s.id, s]));

    const disagreements = [];
    const packs = [];
    for (const id of Object.keys(registry || {})) {
        const entry = findPackEntry(entries, id);
        const parsed = entry ? (parseEventPacks([entry]).packs[0] || null) : null;
        const triggerKeys = parsed && parsed.triggers ? Object.keys(parsed.triggers) : [];
        // A fired row is marked by the shared library in its OWN root, never in a genre store.
        // No trigger root ⇒ the count is UNKNOWN. "0 fired" would be a claim about the save that
        // cannot be made, and a done one-shot reading as never-fired sends someone at the wrong bug.
        const firedKeys = firedTable ? triggerKeys.filter((k) => firedTable[k] && firedTable[k].state) : null;
        const entryVersion = parsed ? String(parsed.version || '') : '';
        const registryVersion = String((registry[id] || {}).ver || '');
        const watermarkVersion = String((watermarks[id] || {}).ver || '');
        const libraryVersion = storedById.has(id) ? String(storedById.get(id).version || '') : '';
        const row = {
            id,
            version: entryVersion || registryVersion,
            entryVersion, registryVersion, watermarkVersion, libraryVersion,
            entryPresent: !!entry,
            entryEnabled: !entry || entry.enabled !== false,
            events: triggerKeys.length,
            triggerKeys,
            rowsInStatData: triggerKeys.filter((k) => triggerTable && triggerTable[k]).length,
            fired: firedKeys ? firedKeys.length : -1,
            firedKeys,
            inLibrary: stored === null ? null : storedById.has(id),
            led: deriveArtifactLed({
                inLibrary: stored === null ? true : storedById.has(id),
                isActive: true,
                isEnabled: !entry || entry.enabled !== false,
                recordedComments: [packEntryComment(id)],
                presentComments: entry ? [packEntryComment(id)] : [],
            }).state,
        };
        packs.push(row);
        // Every version that exists must match the entry's — the entry is the copy that PLAYS.
        const others = [['registry', registryVersion], ['stat_data watermark', watermarkVersion], ['library', libraryVersion]];
        for (const [where, ver] of others) {
            if (ver && entryVersion && ver !== entryVersion) {
                disagreements.push(`${id}: worldbook entry is v${entryVersion} but the ${where} says v${ver}`);
            }
        }
        if (!entry) disagreements.push(`${id}: recorded in the registry but its worldbook entry is MISSING — reinstall or uninstall`);
        else if (triggerKeys.length && row.rowsInStatData === 0) {
            disagreements.push(`${id}: the entry carries ${triggerKeys.length} row(s) but none are in this chat's ${triggerRoot || 'trigger table'} — the sync pass has not run here`);
        }
    }
    for (const s of (stored || [])) {
        if (!Object.prototype.hasOwnProperty.call(registry || {}, s.id) && s.parseError) {
            disagreements.push(`${s.id}: stored in the library but no longer parses — ${s.parseError}`);
        }
    }

    return {
        // WHERE each half was read, so a reader never has to guess — and never re-reads the embedded book.
        source: {
            cardPacksReadFrom: boundWorld
                ? `standalone worldbook "${boundWorld}" (character data.extensions.world)`
                : 'no bound worldbook — nothing on this card is readable',
            boundWorld: String(boundWorld || ''),
            warning: 'The card PNG\'s embedded data.character_book is a build-time snapshot and is NOT read here. '
                + 'When a bound world exists ST ignores it, so any version read from it describes only the last card BUILD.',
        },
        card: {
            worldbookReadable: entries !== null,
            registryState: entries === null ? 'unreadable' : (registry === null ? 'malformed' : 'ok'),
            triggerRoot, firedRoot, installedRoot,
            enginePathsProblem: paths.ok ? '' : String(paths.reason || ''),
            packs,
        },
        library: {
            readable: stored !== null,
            packs: (stored || []).map((s) => ({
                id: s.id, version: s.version, events: s.events,
                parseError: s.parseError || '',
                onThisCard: Object.prototype.hasOwnProperty.call(registry || {}, s.id),
            })),
        },
        chat: {
            statDataPresent: !!statData,
            rowsInTriggerTable: Object.keys(triggerTable || {}).length,
            firedTablePresent: !!(firedRoot && getPath(statData || {}, firedRoot)),
            firedTotal: firedTable ? Object.keys(firedTable).length : -1,   // -1 = no trigger root, so unknowable
            watermarks,
        },
        disagreements,
    };
}
