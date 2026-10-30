// statbox/statbox-core.js — PURE logic for the StatBox: the per-reply summary of which declared stats
// moved, written into the reply's own text so every reply keeps its own numbers.
//
// The CARD declares everything (its [Initmvuhelper] `statBox` section): the wrapper around the lines,
// where in the reply the box goes, which records and which fields. This file reads that declaration
// and nothing else — it names no state path, no field and no tag of any consumer (L1). A new stat is
// one config row in the card, never a line here.
//
// Four jobs, each a pure function, so every decision is unit-tested (tests/statbox-core.test.js):
//   normalizeStatBoxSection — the card's section → the shape render reads; unknown vocabulary ignored
//   renderStatBox           — baseline stat_data vs current stat_data → the box text ('' = nothing moved)
//   placeStatBox            — put the box into the reply text, or refresh the one already there
//   stripStatBox            — the reply text without any box (for readers that must not see it)
// plus what the host needs around them: which message is the baseline, which declared paths point at
// nothing in real state (a typo the config check cannot see), which of MVU's parses build a box, and the
// two macros a member name may carry (expandIdentityMacros).

import { unknownKeysOf } from '../../shared/unknown-keys.js';
import { getPath } from '../../shared/object-path.js';
import { unwrapTupleValue } from '../../shared/mvu-tuple.js';
import { WRITER_MESSAGE, WRITER_POST } from '../../sillytavern/mvu-bridge-core.js';
import { pageCodeTokenIn } from '../../shared/rendered-region.js';

export const STATBOX_GROUP_KINDS = ['record', 'collection'];
export const STATBOX_RESET_MODES = ['hide', 'value'];
const DEFAULT_RESET_MODE = 'hide';
// When a field prints: `whenMoved` (the default) when its value differs from the baseline's, `whenSet` whenever it
// holds a value in this reply's state. A `whenSet` field is a note the card's own logic writes for one reply and
// clears on the next (what a cap took, why a gain was cut); its label may be left out, so the note prints alone.
export const STATBOX_SHOW_MODES = ['whenMoved', 'whenSet'];
const DEFAULT_SHOW_MODE = 'whenMoved';

// Everything this section understands, listed so the import can NAME what it does not.
const KNOWN_SECTION_FIELDS = ['open', 'close', 'placeBefore', 'groups'];
const KNOWN_GROUP_FIELDS = ['path', 'kind', 'nameField', 'fields'];
const KNOWN_FIELD_FIELDS = ['path', 'label', 'resetWith', 'onReset', 'show'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// ── normalize: the card's section → what render reads ────────────────────────
// A card may carry vocabulary this mvu-helper does not know — a typo, or a key from a newer version.
// The rule: an ignored piece acts as if the card never wrote it, UNLESS that would print a wrong
// number, in which case the field or group that owns it is ignored instead. Nothing throws, and no
// other section of [Initmvuhelper] is touched.
//
// Everything ignored lands in the import's shared `report` — unknown KEYS in report.unknown (via
// unknownKeysOf, like every other section), every refused VALUE in report.blocked with a `why` naming
// what was dropped — and card-config.js prints both. No warn code lives here.
//
// Returns the normalized section, or null (absent, or nothing usable left: the box stays idle).
export function normalizeStatBoxSection(raw, report) {
    if (raw === undefined) return null;
    const blocked = (path, why) => report.blocked.push({ path, why });
    if (!isPlainObject(raw)) {
        blocked('statBox', 'expected an object — the section was ignored');
        return null;
    }
    report.unknown.push(...unknownKeysOf(raw, KNOWN_SECTION_FIELDS, 'statBox'));

    let usable = true;
    if (!nonEmptyString(raw.open)) { blocked('statBox.open', 'must be a non-empty string (the text before the lines) — the section was ignored'); usable = false; }
    if (!nonEmptyString(raw.close)) { blocked('statBox.close', 'must be a non-empty string (the text after the lines) — the section was ignored'); usable = false; }

    const placeBefore = [];
    if (!Array.isArray(raw.placeBefore)) {
        blocked('statBox.placeBefore', 'must be a list of the reply\'s closing tags to place the box before — the section was ignored');
        usable = false;
    } else {
        raw.placeBefore.forEach((anchor, i) => {
            if (nonEmptyString(anchor)) placeBefore.push(anchor);
            else blocked(`statBox.placeBefore[${i}]`, 'must be a non-empty string — that entry was ignored');
        });
        if (!placeBefore.length && raw.placeBefore.length) {
            blocked('statBox.placeBefore', 'no usable entry left — the section was ignored');
            usable = false;
        } else if (!placeBefore.length) {
            blocked('statBox.placeBefore', 'is empty, so the box has nowhere to go — the section was ignored');
            usable = false;
        }
    }

    const groups = [];
    if (!Array.isArray(raw.groups)) {
        blocked('statBox.groups', 'must be a list of groups — the section was ignored');
        usable = false;
    } else {
        raw.groups.forEach((g, i) => {
            const group = normalizeGroup(g, i, report);
            if (group) groups.push(group);
        });
        if (!groups.length) {
            blocked('statBox.groups', 'no usable group left — the section was ignored');
            usable = false;
        }
    }

    if (!usable) return null;
    return { open: raw.open, close: raw.close, placeBefore, groups };
}

function groupLabel(g, i) {
    const path = isPlainObject(g) && nonEmptyString(g.path) ? ` "${g.path.trim()}"` : '';
    return `statBox.groups[${i}]${path}`;
}

function normalizeGroup(g, i, report) {
    const label = groupLabel(g, i);
    const blocked = (path, why) => report.blocked.push({ path, why });
    if (!isPlainObject(g)) { blocked(label, 'expected an object — the group was ignored'); return null; }
    report.unknown.push(...unknownKeysOf(g, KNOWN_GROUP_FIELDS, label));

    let usable = true;
    if (!nonEmptyString(g.path)) { blocked(`${label}.path`, 'must be a non-empty stat_data dot-path — the group was ignored'); usable = false; }
    if (g.kind === undefined) {
        blocked(`${label}.kind`, `is missing (${STATBOX_GROUP_KINDS.join(' or ')}) — the group was ignored`);
        usable = false;
    } else if (!STATBOX_GROUP_KINDS.includes(g.kind)) {
        blocked(`${label}.kind`, `${JSON.stringify(g.kind)} is not a kind this mvu-helper knows (${STATBOX_GROUP_KINDS.join(', ')}) — the group was ignored`);
        usable = false;
    }
    let nameField = '';
    if (g.nameField !== undefined) {
        if (typeof g.nameField === 'string') nameField = g.nameField.trim();
        else blocked(`${label}.nameField`, 'must be a string — ignored, so the line is named by its key');
    }

    // Fields that stand on their own first; then resetWith, which must name one of THEM. A field whose
    // reset sibling is gone is dropped — keeping it without its reset rule would print a bogus delta on
    // every reset — and that can remove another field's sibling, so repeat until nothing changes.
    let fields = [];
    if (!Array.isArray(g.fields)) {
        blocked(`${label}.fields`, 'must be a list of fields — the group was ignored');
        usable = false;
    } else {
        g.fields.forEach((f, j) => {
            const field = normalizeField(f, `${label}.fields[${j}]`, report);
            if (field) fields.push(field);
        });
        let dropped = true;
        while (dropped) {
            dropped = false;
            const paths = new Set(fields.map((f) => f.path));
            fields = fields.filter((f) => {
                if (!f.resetWith || paths.has(f.resetWith)) return true;
                blocked(`${label}.fields "${f.path}".resetWith`, `"${f.resetWith}" is not a field in this group's list — the field was ignored (without its reset rule it would print a wrong change on every reset)`);
                dropped = true;
                return false;
            });
        }
        if (!fields.length) {
            blocked(`${label}.fields`, 'no usable field left — the group was ignored');
            usable = false;
        }
    }

    if (!usable) return null;
    return { path: g.path.trim(), kind: g.kind, nameField, fields };
}

function normalizeField(f, label, report) {
    const blocked = (path, why) => report.blocked.push({ path, why });
    if (!isPlainObject(f)) { blocked(label, 'expected an object — the field was ignored'); return null; }
    const named = nonEmptyString(f.path) ? `${label.replace(/\[\d+\]$/, '')} "${f.path.trim()}"` : label;
    report.unknown.push(...unknownKeysOf(f, KNOWN_FIELD_FIELDS, named));
    if (!nonEmptyString(f.path)) { blocked(`${named}.path`, 'must be a non-empty dot-path under the member — the field was ignored'); return null; }
    let show = DEFAULT_SHOW_MODE;
    if (f.show !== undefined) {
        if (STATBOX_SHOW_MODES.includes(f.show)) show = f.show;
        else blocked(`${named}.show`, `${JSON.stringify(f.show)} is not a mode this mvu-helper knows (${STATBOX_SHOW_MODES.join(', ')}) — ignored, so the field prints when it moves (the default)`);
    }
    const isLabelOptional = show === 'whenSet';
    if (isLabelOptional ? (f.label !== undefined && typeof f.label !== 'string') : !nonEmptyString(f.label)) {
        blocked(`${named}.label`, `must be a${isLabelOptional ? '' : ' non-empty'} string — the field was ignored`);
        return null;
    }
    const out = { path: f.path.trim(), label: typeof f.label === 'string' ? f.label.trim() : '', resetWith: '', onReset: '', show };
    if (f.resetWith !== undefined) {
        if (!nonEmptyString(f.resetWith)) {
            blocked(`${named}.resetWith`, 'must be the path of another field in this group — the field was ignored (without its reset rule it would print a wrong change on every reset)');
            return null;
        }
        out.resetWith = f.resetWith.trim();
    }
    if (f.onReset !== undefined) {
        if (!out.resetWith) blocked(`${named}.onReset`, 'has no effect without resetWith — ignored');
        else if (!STATBOX_RESET_MODES.includes(f.onReset)) blocked(`${named}.onReset`, `${JSON.stringify(f.onReset)} is not a mode this mvu-helper knows (${STATBOX_RESET_MODES.join(', ')}) — ignored, so the field is hidden on a reset (the default)`);
        else out.onReset = f.onReset;
    }
    if (out.resetWith && !out.onReset) out.onReset = DEFAULT_RESET_MODE;
    return out;
}

// ── the card-config section's statBox half (read by features/card-config's registry) ─────
// Every key is card-owned — nothing here describes the user's machine — so the registry takes the normalized
// section whole (card-config wholeCardOwnedSection derives install and merge); this file supplies normalize,
// serialize and the configured check.
export function serializeStatBoxSection(current) {
    if (!isStatBoxConfigured(current)) return undefined;
    return {
        open: current.open,
        close: current.close,
        placeBefore: [...current.placeBefore],
        groups: current.groups.map((g) => ({
            path: g.path,
            kind: g.kind,
            ...(g.nameField ? { nameField: g.nameField } : {}),
            fields: g.fields.map((f) => ({
                path: f.path,
                label: f.label,
                ...(f.resetWith ? { resetWith: f.resetWith, onReset: f.onReset } : {}),
                ...(f.show && f.show !== DEFAULT_SHOW_MODE ? { show: f.show } : {}),
            })),
        })),
    };
}

export function isStatBoxConfigured(v) {
    return isPlainObject(v) && Array.isArray(v.groups) && v.groups.length > 0;
}

// PER-CARD defaults (PROFILE scope) — merged into profileDefaults by index.js. Absent = idle: the card's
// [Initmvuhelper] is the only thing that fills it.
export const statBoxProfileDefaults = { statBox: null };

// The card's declared box, or null while it declares none. Reads only.
export function statBoxSectionOf(p) {
    return isStatBoxConfigured(p.statBox) ? p.statBox : null;
}

// ── render: baseline vs current → the box ─────────────────────────────────────
// `baseline` is the stat_data the player last saw (the previous reply's), `current` this reply's.
// `formatName` turns a member's stored name into display text (the host passes expandIdentityMacros);
// identity when absent.
//
// The box is written into the reply's text, so a line carrying a page-code token (pageCodeTokenIn — a
// TavernHelper render token or ST-Prompt-Template's opener) is left out: its names and values are
// stat_data, which the engine and the model write, and that token would make the page run the reply's
// text. `onRefused({ key, token })` is told of each one.
//
// Per member, per field:
//   · numbers on both sides and changed → `Label cur (+d)` / `Label cur (-d)`
//   · anything else that changed        → `Label prev → cur` (`Label cur` when there was no prev)
//   · its resetWith sibling changed     → no change is printed at all: `hide` leaves the field off,
//     `value` prints `Label cur`. The sibling changed, so its own part is on the line and explains the
//     turn. This compares the sibling and never inspects the value — no sentinel knowledge.
//   · a `whenSet` field holding a value → `Label cur` (`cur` alone with no label), changed or not; nothing
//     when it is empty. Its text is the card's, printed as written.
// A member absent from the baseline is new: `Name: new · Label cur · …`. A member is printed when it
// is new or a field changed, in scene or not. Groups in declared order, members in key order.
//
// No baseline at all → '' (no box). The box says what CHANGED this reply, and with no earlier state
// nothing did: the chat's first message (a greeting resolved when the player finishes character
// creation) would otherwise list the whole roster as `new`.
export function renderStatBox(section, baseline, current, { formatName = (s) => s, onRefused } = {}) {
    if (!isStatBoxConfigured(section) || !isPlainObject(baseline)) return '';
    const lines = [];
    for (const group of section.groups) {
        for (const { key, member, before } of groupMembers(group, baseline, current)) {
            const line = renderMemberLine(group, key, member, before, formatName);
            if (!line) continue;
            const token = pageCodeTokenIn(line);
            if (token) {
                if (typeof onRefused === 'function') onRefused({ key, token });
                continue;
            }
            lines.push(line);
        }
    }
    return lines.length ? `${section.open}\n${lines.join('\n')}\n${section.close}` : '';
}

// The two macros a member name is written with — `{{user}}` (School's player record) and `{{char}}` —
// and only those. A member name is a stat_data key or value, which the engine and the model write, and
// SillyTavern's full macro engine runs the macros that change state (setvar and its kin) as it expands
// them. Matched without regard to case, as SillyTavern matches them.
export function expandIdentityMacros(text, { user = '', char = '' } = {}) {
    return String(text == null ? '' : text)
        .replace(/\{\{user\}\}/gi, () => String(user))
        .replace(/\{\{char\}\}/gi, () => String(char));
}

function groupMembers(group, baseline, current) {
    const now = getPath(current, group.path);
    const was = getPath(baseline, group.path);
    if (group.kind === 'record') {
        if (!isPlainObject(now)) return [];
        const segments = group.path.split('.');
        return [{ key: segments[segments.length - 1], member: now, before: isPlainObject(was) ? was : null }];
    }
    if (!isPlainObject(now)) return [];
    const out = [];
    for (const key of Object.keys(now)) {
        if (!isPlainObject(now[key])) continue;
        const prev = isPlainObject(was) ? was[key] : undefined;
        out.push({ key, member: now[key], before: isPlainObject(prev) ? prev : null });
    }
    return out;
}

function renderMemberLine(group, key, member, before, formatName) {
    const stored = group.nameField ? displayText(readField(member, group.nameField)) : '';
    const name = oneLine(formatName(stored || key)) || key;
    const parts = [];
    if (!before) {
        for (const f of group.fields) {
            const cur = displayText(readField(member, f.path));
            if (cur !== '') parts.push(labelled(f, cur));
        }
        return [`${name}: new`, ...parts].join(' · ');
    }
    for (const f of group.fields) {
        const cur = readField(member, f.path);
        const prev = readField(before, f.path);
        if (f.resetWith && !sameValue(readField(member, f.resetWith), readField(before, f.resetWith))) {
            if (f.onReset === 'value' && displayText(cur) !== '') parts.push(labelled(f, displayText(cur)));
            continue;
        }
        if (f.show === 'whenSet') {
            if (displayText(cur) !== '') parts.push(labelled(f, displayText(cur)));
            continue;
        }
        if (sameValue(cur, prev) || cur === undefined) continue;
        if (isFiniteNumber(cur) && isFiniteNumber(prev)) {
            const d = cur - prev;
            parts.push(`${f.label} ${formatNumber(cur)} (${d > 0 ? '+' : '-'}${formatNumber(Math.abs(d))})`);
        } else if (displayText(prev) === '') {
            parts.push(`${f.label} ${displayText(cur)}`);
        } else {
            parts.push(`${f.label} ${displayText(prev)} → ${displayText(cur)}`);
        }
    }
    return parts.length ? `${name}: ${parts.join(' · ')}` : '';
}

const readField = (member, path) => unwrapTupleValue(getPath(member, path));
const labelled = (f, text) => (f.label ? `${f.label} ${text}` : text);

// ── declared paths that point at nothing ──────────────────────────────────────
// The config check cannot see a misspelled path ("Afection" is a valid path to nothing), and such a
// field simply never prints — the one failure an author has no thread to pull on. Measured against the
// reply's real state instead: a path is reported when it resolves in NONE of its group's members. A field
// missing on SOME members is data (a partly filled roster), not a typo, and an empty collection proves
// nothing either way. Returns [{ path, why }]; the host warns once per path.
export function unresolvedStatBoxPaths(section, current) {
    if (!isStatBoxConfigured(section)) return [];
    const out = [];
    for (const group of section.groups) {
        const root = getPath(current, group.path);
        if (!isPlainObject(root)) {
            out.push({ path: group.path, why: `the group's path is ${root === undefined ? 'not in' : 'not an object in'} this reply's stat_data, so the whole group never prints` });
            continue;
        }
        const members = group.kind === 'record' ? [root] : Object.values(root).filter(isPlainObject);
        if (!members.length) continue;
        const where = group.kind === 'record' ? `"${group.path}"` : `any of the ${members.length} member(s) of "${group.path}"`;
        const missing = (path) => members.every((m) => getPath(m, path) === undefined);
        for (const f of group.fields) {
            if (missing(f.path)) out.push({ path: `${group.path}.${f.path}`, why: `the field is not in ${where}, so "${f.label || f.path}" never prints` });
        }
        if (group.nameField && missing(group.nameField)) {
            out.push({ path: `${group.path}.${group.nameField}`, why: `the nameField is not in ${where}, so every line is named by its key instead` });
        }
    }
    return out;
}
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return false;
}

// Floating-point residue (0.1 + 0.2) must not reach the player; stats past two decimals are not a thing.
function formatNumber(n) {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// Only scalars and lists are shown; an object value is not a stat and prints nothing.
function displayText(v) {
    if (v === undefined || v === null) return '';
    if (isFiniteNumber(v)) return formatNumber(v);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return oneLine(String(v));
    if (Array.isArray(v)) return oneLine(v.map(displayText).filter(Boolean).join(', '));
    return '';
}

// ── place / strip ─────────────────────────────────────────────────────────────
// A box in the text is `open` … the first `close` after it. The card chose both strings, so that pair
// IS the box's identity — the same pair the card's own prompt regex removes.
function findBoxRegions(text, open, close) {
    const regions = [];
    let from = 0;
    for (;;) {
        const start = text.indexOf(open, from);
        if (start < 0) break;
        const closeAt = text.indexOf(close, start + open.length);
        if (closeAt < 0) break;                                   // an unclosed open is not a box
        regions.push({ start, end: closeAt + close.length });
        from = closeAt + close.length;
    }
    return regions;
}

// Remove regions (last first, so earlier offsets stay valid), each with the newline placeBox put after it.
function removeRegions(text, regions) {
    let out = text;
    for (let i = regions.length - 1; i >= 0; i--) {
        const { start } = regions[i];
        let { end } = regions[i];
        if (out[end] === '\n') end += 1;
        out = out.slice(0, start) + out.slice(end);
    }
    return out;
}

// Put `rendered` into `text`. A box already there is refreshed IN PLACE (the first one; any extra is
// removed) — so the call is idempotent, and a later writer updating an earlier writer's box needs no
// record of what that writer wrote. No box yet → insert before the first `placeBefore` anchor found, in
// the card's declared order, at that anchor's LAST occurrence: a closing tag's real place is the last
// one, and an earlier one is the tag quoted (reasoning that leaked into the reply quotes the envelope's
// tags). `rendered` '' removes the box.
//
// No anchor → the text is returned untouched with hit 'no-anchor' and the CALLER says so. The box is
// never put anywhere else: outside the story envelope the GUI never shows it, which would be a silent
// miss dressed as a success.
//
// Built with slice and concatenation, never String.replace: the box carries member names from state,
// and a replacement STRING would expand `$&` and friends inside them.
export function placeStatBox(text, section, rendered) {
    const src = String(text == null ? '' : text);
    if (!isStatBoxConfigured(section)) return { text: src, hit: 'unchanged' };
    const regions = findBoxRegions(src, section.open, section.close);
    if (regions.length) {
        const [first, ...rest] = regions;
        if (!rendered) return { text: removeRegions(src, regions), hit: 'removed' };
        const withoutRest = removeRegions(src, rest);
        const next = withoutRest.slice(0, first.start) + rendered + withoutRest.slice(first.end);
        return { text: next, hit: next === src ? 'unchanged' : 'replaced' };
    }
    if (!rendered) return { text: src, hit: 'unchanged' };
    const anchor = section.placeBefore.find((a) => src.includes(a));
    if (!anchor) return { text: src, hit: 'no-anchor' };
    const at = src.lastIndexOf(anchor);
    return { text: src.slice(0, at) + rendered + '\n' + src.slice(at), hit: 'inserted' };
}

// The text without any box — for readers that must not see numbers they did not compute (POST's input
// and history) or names that are not mentions (the roster's mention scan for <reply_cast>).
export function stripStatBox(text, section) {
    const src = String(text == null ? '' : text);
    if (!isStatBoxConfigured(section)) return src;
    const regions = findBoxRegions(src, section.open, section.close);
    return regions.length ? removeRegions(src, regions) : src;
}

// ── which of MVU's parses build the box ───────────────────────────────────────
// MVU fires its update event after every parse. A box is built from a parse that read a reply's own
// <UpdateVariable> (writer 'message') or POST's record (writer 'post'); every other writer parses its own
// patch (a PRE apply, a plugin relay, a menu action), never a reply's state.
export function isStatBoxParseWriter(writer) {
    return writer === WRITER_MESSAGE || writer === WRITER_POST;
}

// ...and only from a parse of the live chat ('turn', shared/mvu-parse-disposition) when there is a reply
// to put the box in: MVU's floor replay re-reads old messages, and their state belongs in no box on the
// latest reply.
export function shouldBuildStatBoxOnParse({ writer, disposition, mid }) {
    return isStatBoxParseWriter(writer) && disposition === 'turn' && Number.isInteger(mid) && mid >= 0;
}

// ── the box at MVU's parse joins the turn's one write ─────────────────────────
// MVU parses a reply in its own MESSAGE_RECEIVED listener, added when a chat loads, so it runs after the POST
// pass's; on a card with neither an engine nor a POST call nothing else holds the turn's write until then. So the
// box is announced to the reply redraw when the reply arrives, and the announcement settles when SillyTavern
// emits CHARACTER_MESSAGE_RENDERED for that reply, which it does only after every MESSAGE_RECEIVED listener, MVU's
// parse included, has returned. A reply MVU does not parse settles the same way.
export function shouldAwaitBoxAtArrival({ isDeclared, message }) {
    return isDeclared === true && !!message && !message.is_user;
}

// `awaited` is the announced box ({ mid }), or null.
export function isAwaitedBoxRendered(awaited, renderedMessageId) {
    return !!awaited && Number(renderedMessageId) === awaited.mid;
}

// ── the baseline: the state the player last saw ───────────────────────────────
// The nearest assistant message below `mid` that carries stat_data, read at ITS active swipe. A user
// message is skipped even when it carries state: a PRE call can write this turn's changes onto it, and
// those belong in this reply's box. Every swipe and regen of `mid` therefore diffs against the same
// baseline. -1 = none (no box: nothing to compare against).
//
// Not small-llm's findBaseFloorIndex: that one anchors on the LAST user message of the whole chat (the
// floor a generation starts from), which skips an assistant message sitting directly below `mid` when
// two replies follow one user line.
export function statBoxBaselineIndex(chat, mid) {
    if (!Array.isArray(chat)) return -1;
    for (let i = Math.min(mid, chat.length) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && messageStatData(m)) return i;
    }
    return -1;
}

export function messageStatData(message) {
    const vars = message && message.variables;
    if (!vars || typeof vars !== 'object') return null;
    const own = vars[message.swipe_id != null ? message.swipe_id : 0];
    return (own && isPlainObject(own.stat_data)) ? own.stat_data : null;
}

