// character-roster/character-registry-core.js — PURE half of the character registry's store (no ST imports, no
// logger: problems come back to the caller). Tested by tests/character-registry-core.test.js.
//
// The registry lives in the chat's state, at stat_data.$mvuhelper.character_registry: a map from a character's key
// to one record, { body, bust, aliases, clothes: { default, <outfit>… }, allow_update }, plus any field a later
// feature adds. Every reader and writer above the store works on ENTRY TEXT instead — the `[Body]` / `[Bust]` /
// `[Clothes]` / `[Clothes:<outfit>]` / `[Alias]` / `[AllowUpdate]` sections dna-core.js parses — so the look
// choice, the clothes gates and the harvest decide exactly as they did on lorebook entries. This file turns a
// record into entry text and back, applies entry-level changes to a registry, and checks a record's shape.

import { parseDnaSections, RESERVED_OUTFIT_NAMES } from './dna-core.js';

export const CHARACTER_REGISTRY_PART = 'character_registry';

// The record fields entry text carries. Any other field is a later feature's and rides along untouched.
const ENTRY_TEXT_FIELDS = ['body', 'bust', 'aliases', 'clothes', 'allow_update'];
const OUTFIT_NAME = /^[A-Za-z0-9_-]+$/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A record as entry text, sections in the order the card build writes them. An empty field writes no section,
// so a name-only record ({}) is empty text, which dna-core reads as "no stored appearance".
export function contentFromRecord(record) {
    const r = isPlainObject(record) ? record : {};
    const lines = [];
    const section = (header, body) => {
        lines.push(header);
        if (body !== '') lines.push(body);
    };
    if (typeof r.body === 'string' && r.body.trim()) section('[Body]', r.body.trim());
    if (r.bust !== undefined && r.bust !== null && String(r.bust).trim()) section('[Bust]', String(r.bust).trim());
    if (isPlainObject(r.clothes)) {
        const outfits = Object.keys(r.clothes);
        const ordered = outfits.includes('default') ? ['default', ...outfits.filter((name) => name !== 'default')] : outfits;
        for (const name of ordered) {
            const clothes = typeof r.clothes[name] === 'string' ? r.clothes[name].trim() : '';
            section(name === 'default' ? '[Clothes]' : `[Clothes:${name}]`, clothes);
        }
    }
    if (Array.isArray(r.aliases)) {
        const aliases = r.aliases.map((alias) => String(alias || '').trim()).filter(Boolean);
        if (aliases.length) section('[Alias]', aliases.join('\n'));
    }
    if (typeof r.allow_update === 'boolean') section('[AllowUpdate]', r.allow_update ? 'true' : 'false');
    else if (typeof r.allow_update === 'string' && r.allow_update.trim()) section('[AllowUpdate]', r.allow_update.trim());
    return lines.join('\n');
}

// The fields of a record that entry text does not carry — a later feature's — copied into a new record.
function fieldsBeyondEntryText(record) {
    const kept = {};
    if (!isPlainObject(record)) return kept;
    for (const [field, value] of Object.entries(record)) {
        if (!ENTRY_TEXT_FIELDS.includes(field)) kept[field] = value;
    }
    return kept;
}

// Entry text back into a record. The fields entry text carries come from the text; every other field of
// `previous` (the record this text replaces) is kept. A value dna-core would warn about stays as written — an
// unreadable [AllowUpdate] stays text, so dna-core still reads it as false and says so.
export function recordFromContent(content, previous = null) {
    const parsed = parseDnaSections(content);
    const record = fieldsBeyondEntryText(previous);
    if (parsed.body) record.body = parsed.body;
    if (parsed.bust) record.bust = NUMBER_TEXT.test(parsed.bust) ? Number(parsed.bust) : parsed.bust;
    if (Object.keys(parsed.clothes).length) record.clothes = { ...parsed.clothes };
    if (parsed.aliases.length) record.aliases = [...parsed.aliases];
    const allowUpdate = String(parsed.allowUpdate || '').trim();
    if (allowUpdate) record.allow_update = allowUpdate === 'true' ? true : allowUpdate === 'false' ? false : allowUpdate;
    return record;
}

// The registry part of a state, read in place; {} when the state holds none or holds something else.
export function registryIn(part) {
    return isPlainObject(part) ? part : {};
}

// Every record as an entry, { key, content }, sorted by key — the shape every caller of the store reads, sorted so a
// lookup that picks among several claimants picks the same one each time.
export function entriesOfRegistry(registry) {
    return Object.entries(registryIn(registry))
        .filter(([key, record]) => key.trim() && isPlainObject(record))
        .map(([key, record]) => ({ key, content: contentFromRecord(record) }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

// ── entry-level changes ────────────────────────────────────────────────────────
// A change sets one key's whole record, or deletes one key. Applying a change a registry already holds changes
// nothing, which is what lets one reply's changes be written into every copy of its state, whichever copy already
// has some of them.
export const setChange = (key, record) => ({ op: 'set', key, record: structuredClone(record) });
export const deleteChange = (key) => ({ op: 'delete', key });

// A new registry with `changes` applied in order; `registry` itself is not touched.
export function applyRegistryChanges(registry, changes) {
    const next = { ...registryIn(registry) };
    for (const change of Array.isArray(changes) ? changes : []) {
        if (!change || typeof change.key !== 'string') continue;
        if (change.op === 'set') next[change.key] = structuredClone(change.record);
        else if (change.op === 'delete') delete next[change.key];
    }
    return next;
}

// A state's registry part with `changes` applied — the part itself when they leave the registry as it reads, so a state
// that holds no registry is never handed an empty one, and a copy that already holds the changes is left as it is.
export function registryPartAfter(part, changes) {
    const before = registryIn(part);
    const after = applyRegistryChanges(before, changes);
    return JSON.stringify(after) === JSON.stringify(before) ? part : after;
}

// What one change does, for a log line: "set Airi", "delete Kenji".
export const describeChange = (change) => `${change.op} ${change.key}`;

// ── a reply's journal ──────────────────────────────────────────────────────────
// The changes made to the registry while one reply, on one swipe, is the chat's newest. `message` is that message
// object, so a regenerate (a new swipe) or a new reply never matches an old journal.
export function newJournal(message, swipe) {
    return { message, swipe, changes: [] };
}

export function isJournalOf(journal, message, swipe) {
    return Boolean(journal && message && journal.message === message && journal.swipe === swipe);
}

// ── the shape check ────────────────────────────────────────────────────────────
// What is wrong with one record, as sentences naming the field; [] when nothing is. A seed written by hand is where a
// wrong shape comes from: the store still turns it into entry text, and dna-core reads what it can.
export function recordProblems(key, record) {
    const name = `"${key}"`;
    if (!isPlainObject(record)) return [`${name} is not a record (an object of body, bust, aliases, clothes, allow_update)`];
    const problems = [];
    if (record.body !== undefined && typeof record.body !== 'string') problems.push(`${name}.body is not text`);
    if (record.bust !== undefined && typeof record.bust !== 'number' && !(typeof record.bust === 'string' && NUMBER_TEXT.test(record.bust.trim()))) {
        problems.push(`${name}.bust is not a number`);
    }
    if (record.aliases !== undefined && (!Array.isArray(record.aliases) || record.aliases.some((alias) => typeof alias !== 'string'))) {
        problems.push(`${name}.aliases is not a list of names`);
    }
    if (record.clothes !== undefined) {
        if (!isPlainObject(record.clothes)) problems.push(`${name}.clothes is not a map of outfit name to clothes text`);
        else {
            for (const [outfit, clothes] of Object.entries(record.clothes)) {
                if (!OUTFIT_NAME.test(outfit)) problems.push(`${name}.clothes has an outfit named "${outfit}" — letters, digits, - and _ only`);
                if (typeof clothes !== 'string') problems.push(`${name}.clothes.${outfit} is not text`);
            }
        }
    }
    if (record.allow_update !== undefined && typeof record.allow_update !== 'boolean') problems.push(`${name}.allow_update is not true or false`);
    return problems;
}

// ── the Roster tab's editor ────────────────────────────────────────────────────
// A record as the editor's fields: { body, bust, aliasesText (one name per line), allowUpdate, outfits: [{ name,
// clothes }] }, one pair per outfit on file, the default outfit first. Add outfit and × change the pairs in the dialog.
export function editorFieldsFromRecord(record) {
    const r = isPlainObject(record) ? record : {};
    const clothes = isPlainObject(r.clothes) ? r.clothes : {};
    const names = Object.keys(clothes);
    const ordered = names.includes('default') ? ['default', ...names.filter((name) => name !== 'default')] : names;
    return {
        body: typeof r.body === 'string' ? r.body : '',
        bust: r.bust !== undefined && r.bust !== null ? String(r.bust) : '',
        aliasesText: Array.isArray(r.aliases) ? r.aliases.join('\n') : '',
        allowUpdate: r.allow_update === true,
        outfits: ordered.map((name) => ({ name, clothes: String(clothes[name] || '') })),
    };
}

// The editor's fields as a record, the default outfit named 'default'. A blank field writes nothing; the record's
// outfits are the pairs the dialog holds, so a pair removed with × is an outfit removed. A pair left empty is skipped;
// a named one with no clothes is a problem. The fields of `previous` the editor does not show are kept. Returns
// { record, problems }: a problem is a sentence naming the field, and a record with problems is not saved.
export function recordFromEditorFields(fields, previous = null) {
    const f = isPlainObject(fields) ? fields : {};
    const problems = [];
    const record = fieldsBeyondEntryText(previous);
    const body = String(f.body || '').trim();
    if (body) record.body = body;
    const bust = String(f.bust || '').trim();
    if (bust) {
        if (NUMBER_TEXT.test(bust)) record.bust = Number(bust);
        else problems.push(`Bust is a number, such as 1.2 — "${bust}" is not one.`);
    }
    const aliases = [];
    for (const line of String(f.aliasesText || '').split(/\r?\n/)) {
        const alias = line.trim();
        if (alias && !aliases.some((known) => known.toLowerCase() === alias.toLowerCase())) aliases.push(alias);
    }
    if (aliases.length) record.aliases = aliases;
    const clothes = {};
    for (const outfit of Array.isArray(f.outfits) ? f.outfits : []) {
        const name = String((outfit && outfit.name) || '').trim().toLowerCase();
        const text = String((outfit && outfit.clothes) || '').trim();
        if (!name && !text) continue;
        if (!text) { problems.push(`The outfit "${name}" has no clothes: write them, or remove the outfit with ×.`); continue; }
        if (!name) { problems.push('An outfit needs a name before its clothes can be saved.'); continue; }
        if (!OUTFIT_NAME.test(name)) { problems.push(`The outfit name "${name}" may hold letters, digits, - and _ only.`); continue; }
        if (name !== 'default' && RESERVED_OUTFIT_NAMES.includes(name)) { problems.push(`"${name}" is a word the pictures use, not an outfit name.`); continue; }
        if (Object.prototype.hasOwnProperty.call(clothes, name)) { problems.push(`Two outfits are named "${name}".`); continue; }
        clothes[name] = text;
    }
    if (Object.keys(clothes).length) record.clothes = clothes;
    if (f.allowUpdate === true) record.allow_update = true;
    else if (isPlainObject(previous) && previous.allow_update !== undefined) record.allow_update = false;
    return { record, problems };
}
