// character-roster/reply-cast-core.js — the reply cast: who is in a reply, and what the roster knows
// about each of them (plans/reply-cast.md). PURE. Tested by tests/reply-cast-core.test.js.
//
// The narrator ends every reply with one cast record per named character present. Those records are
// the ONE source for "who is in this reply"; everything here is computed from them. This file handles
// records (`{ name, attributes }`) only — how a record is written lives in cast-record-format-core.js.

import { writeCastRecord, CAST_RECORD_FORMAT_RULES, NAME_RULES } from './cast-record-format-core.js';
import { pickCharEntry, hasStoredAppearance, listAliases, listOutfitVariants, parseDnaSections, allowsClothesUpdate, RESERVED_OUTFIT_NAMES, OUTFIT_SAME_AS_LAST_PICTURE, OUTFIT_NEW_CLOTHES } from './dna-core.js';
import { mentionsName } from '../../shared/name-mention.js';

// ── ON FILE: the characters the narrator is told have a stored look ───────────────────────────
// The registered characters with a look on file whom the story has named anywhere in this chat, whom the game state
// marks present, or on one of whose names a lorebook entry in this prompt is keyed. The list is mvu-helper's statement
// of what the registry holds, so the narrator never judges who is registered; it reads the list. It does two jobs:
//   • a character on it is never described again (describe once — her <cast> record is the name);
//   • it gives each one's outfit= choices: her outfits on file, and "same-as-last-picture" while the worn-outfit
//     store holds what her last picture showed and the story is with her (named in the recent chat, or present),
//     with what it draws after her name: the outfit on file she wore, or her one-off's clothes. The narrator then
//     compares the story with what is in front of it instead of remembering what her last picture showed.
// It is also the INFORMED set: the characters whose look this prompt showed, which decides whether a later
// narrator registration may replace her clothes (dna-core mayStoryReplaceClothes).
//
// `entries`       [{ key, names: [key, …aliases], variants: [outfit…], hasLook }] for every registered
//                 character; `hasLook` is true when anything of her look is stored (hasStoredAppearance).
// `namedKeys`     registry keys the story has named anywhere in this chat (namedKeysOf, message by message).
// `recentKeys`    registry keys named in the recent chat — they alone are offered "same-as-last-picture".
// `presentKeys`   on-screen character keys from the game state; [] on a card with no presence field.
// `activatedKeys` registry keys a lorebook entry activated for this prompt is keyed on (activatedKeysOf); [] when
//                 no activated entry is keyed on a registered name.
// `uncastKeys`    registry keys that never take a cast record — the user's own character's entry. It is
//                 never listed, however often its key appears in the chat (state paths name it every turn); his
//                 outfits are printed ON FILE on a line of his own instead (userOutfitsOnFile), which casts nobody.
// `lastPictures`  [{ key, outfit, clothes }] what the worn-outfit store holds, in the state the reply starts from
//                 (dna-core lastPictureOutfitsIn): `lastPictureWear` carries what "same-as-last-picture" draws for a
//                 recent or present character (lastPictureWearOf).
//
// SCOPED BY THE WHOLE CHAT, because a list scoped any shorter leaves out exactly the characters the narrator still
// remembers: one the story brings back after a gap is off the list, so the narrator either copies an outfit= earlier
// replies show or describes her clothes anew, and her stored outfits are never drawn. The size stays small: lines
// carry outfit NAMES, and replyCastInstruction prints the characters who share one set of outfits on one line.
// THE LOREBOOK COVERS THE REPLY THAT BRINGS HER IN. The prompt is built before the reply is written, so the chat has
// not named a character on the reply she first appears in. If an entry keyed on her name is in the prompt, whatever
// loaded it (a key the scan matched, a constant entry, a card forcing in the character its next scene brings), the
// narrator is about to play her, so she is listed and her first picture is drawn in an outfit on file. A character
// first named in this reply with no such entry is off the list, and "newclothes" is then the plain truth. A loaded
// entry is no sign the story was with her lately, so it offers no "same-as-last-picture". Presence and the lorebook
// ADD to the list and never gate it, so a card with neither still gets it.
//
// An entry with nothing stored (a name-only placeholder) is left out: she still needs describing. One with
// a stored body and no outfit — she was shown undressed when she was registered — is listed with that said, so
// she is never described again: her clothes come from "newclothes" and her record when they first appear, and
// those are kept as her first clothes (D29).
export function onFileCast({ entries, namedKeys, recentKeys, presentKeys, activatedKeys, uncastKeys, lastPictures } = {}) {
    const folded = (list) => new Set((Array.isArray(list) ? list : []).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean));
    const named = folded(namedKeys);
    const recent = folded(recentKeys);
    const present = folded(presentKeys);
    const activated = folded(activatedKeys);
    const uncast = folded(uncastKeys);
    const namesOf = (e) => (Array.isArray(e.names) ? e.names : [e.key]).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
    const keyOf = (e) => String(e.key || '').trim().toLowerCase();
    return (Array.isArray(entries) ? entries : [])
        .filter((e) => e && ((Array.isArray(e.variants) && e.variants.length) || e.hasLook === true))
        .filter((e) => !uncast.has(keyOf(e)))
        .filter((e) => named.has(keyOf(e)) || activated.has(keyOf(e)) || namesOf(e).some((n) => present.has(n)))
        .map((e) => {
            const withHer = recent.has(keyOf(e)) || namesOf(e).some((n) => present.has(n));
            const variants = Array.isArray(e.variants) ? e.variants.slice() : [];
            return {
                key: String(e.key || ''),
                variants,
                lastPictureWear: withHer ? lastPictureWearOf(findByKey(lastPictures, e.key), variants) : '',
            };
        });
}

// The item of `list` for one registry key, matched without regard to case, or null: the store's entry in
// lastPictureOutfitsIn's list, or a character's entry as onFileCast takes them.
function findByKey(list, key) {
    const want = String(key || '').trim().toLowerCase();
    if (!want) return null;
    return (Array.isArray(list) ? list : []).find((p) => p && String(p.key || '').trim().toLowerCase() === want) || null;
}

// What "same-as-last-picture" draws for one character, as printed after her name — PURE: her one-off's clothes, or
// the name of the outfit on file she wore. '' when nothing she can be drawn in is held: no entry, a one-off with no
// clothes, or an outfit name her entry no longer has (`variants`, her outfits on file), which would draw a slip.
// Printed on one line, so any run of whitespace in the stored text is one space.
export function lastPictureWearOf(held, variants) {
    if (!held) return '';
    const outfit = String(held.outfit || '').trim().toLowerCase();
    if (outfit === OUTFIT_NEW_CLOTHES) return String(held.clothes || '').replace(/\s+/g, ' ').trim();
    const name = (Array.isArray(variants) ? variants : []).find((v) => String(v || '').trim().toLowerCase() === outfit);
    return name ? String(name) : '';
}

// The user's own character's entries in `entries` (as onFileCast takes them), one per uncast key that has one, in key order.
function uncastEntriesOf(entries, uncastKeys) {
    return (Array.isArray(uncastKeys) ? uncastKeys : []).map((key) => findByKey(entries, key)).filter(Boolean);
}

// What "same-as-last-picture" draws for the user's own character in mainchar= — PURE, lastPictureWearOf for the first
// uncast key whose entry the store holds something for. He takes no record, so onFileCast never lists him, yet
// mainchar= names what he wears in every picture of him, so his offer is printed on its own line. Offered whenever the
// store holds it: the story is always with him. `entries` as onFileCast takes them.
export function userLastPictureWear({ entries, uncastKeys, lastPictures } = {}) {
    for (const entry of uncastEntriesOf(entries, uncastKeys)) {
        const wear = lastPictureWearOf(findByKey(lastPictures, entry.key), entry.variants);
        if (wear) return wear;
    }
    return '';
}

// The user's own character's outfits on file — PURE, the variants of the first uncast key whose entry has any; [] when
// none has. replyCastInstruction prints them ON FILE on a line of his own, for mainchar=: with his worn outfit printed
// alone under a heading that says the list is all that is on file, a narrator read that one outfit as all he has
// (D32). Printed text only: onFileCast still never lists him, so he takes no record and is never in the informed set.
// `entries` as onFileCast takes them.
export function userOutfitsOnFile({ entries, uncastKeys } = {}) {
    const entry = uncastEntriesOf(entries, uncastKeys).find((e) => Array.isArray(e.variants) && e.variants.length);
    return entry ? entry.variants.slice() : [];
}

// Which registered characters a text names — PURE. `entries` as onFileCast takes them; returns their keys, in
// entry order. The host runs it once per chat message and keeps the answer, so the whole chat is never rescanned.
// A NAME IN LATIN LETTERS MATCHES AS A WHOLE WORD (mentionsName): no Latin letter or digit may touch either end of
// it, so "Mana" is not inside "manager", nor "Sui" inside "suit", while "Mitsuki" between two Chinese characters
// still counts. A name in any other script ("柚月") matches wherever it appears, because those scripts put no space
// between words. Names are written the way the story writes them, in its own script; case is ignored.
export function namedKeysOf(entries, text) {
    const haystack = String(text || '');
    if (!haystack) return [];
    return (Array.isArray(entries) ? entries : [])
        .filter((e) => e && (Array.isArray(e.names) ? e.names : [e.key]).some((n) => {
            const name = String(n || '').trim();
            return !!name && mentionsName(haystack, name);
        }))
        .map((e) => String(e.key || ''));
}

// The primary keys of the lorebook entries SillyTavern activated for one prompt — PURE. `activatedEntries` is the list
// WORLD_INFO_ACTIVATED carries; each entry's `key` holds its primary keys. Secondary keys are left out: they narrow
// when an entry fires and never say who it is about. Trimmed, empty ones dropped.
export function lorebookKeysOf(activatedEntries) {
    return (Array.isArray(activatedEntries) ? activatedEntries : [])
        .flatMap((entry) => (entry && Array.isArray(entry.key) ? entry.key : []))
        .map((key) => String(key == null ? '' : key).trim())
        .filter(Boolean);
}

// Which registered characters a lorebook entry in this prompt is keyed on — PURE. `entries` as onFileCast takes them;
// `lorebookKeys` the primary keys of the entries activated for this prompt (lorebookKeysOf). A character counts when
// one of her names, her registry key or an alias, EQUALS one of those keys, case ignored. Never a substring: an entry
// keyed "Event_Body_Haruka" is not Haruka's, and one keyed "manager" is not Mana's. Only names are compared, never
// what an entry is or holds, so an entry keyed on a registered name counts whatever it is about, and a key written as
// a regex ("/Sora|空/") equals no name. A card whose lorebook keys a character under a spelling her entry does not
// carry needs that spelling as her alias. Returns their registry keys, in entry order.
export function activatedKeysOf(entries, lorebookKeys) {
    const keys = new Set((Array.isArray(lorebookKeys) ? lorebookKeys : []).map((key) => String(key == null ? '' : key).trim().toLowerCase()).filter(Boolean));
    if (!keys.size) return [];
    return (Array.isArray(entries) ? entries : [])
        .filter((e) => e && (Array.isArray(e.names) ? e.names : [e.key]).some((n) => keys.has(String(n || '').trim().toLowerCase())))
        .map((e) => String(e.key || ''));
}

// ── the user's own character: the names that never take a record ─────────────────────────────
// The story may call the user's character something other than the persona name (a card's protagonist, a
// nickname), and working out which name means the user is a judgement a model can get wrong: a record under
// the protagonist's story name asks the registration call to describe them, and they are stored as a new
// character. So the block prints these names (replyCastInstruction), and a record under one of them is
// nobody in the cast (classifyReplyCast) and registers nothing (harvest).
// `entries`     the registry as [{ key, content }].
// `uncastKeys`  registry keys that never take a cast record (requestReplyCast).
// `personaName` the user's persona name.
// Returns the persona name, then each uncast key with its entry's aliases, each once (case-insensitive) as first
// written. A key with no entry is listed all the same: it is a name the user's character goes by.
export function uncastNamesOf({ entries, uncastKeys, personaName } = {}) {
    const out = [];
    const seen = new Set();
    const add = (raw) => {
        const name = String(raw || '').trim();
        const folded = name.toLowerCase();
        if (!name || seen.has(folded)) return;
        seen.add(folded);
        out.push(name);
    };
    add(personaName);
    for (const key of (Array.isArray(uncastKeys) ? uncastKeys : [])) {
        const { entry } = pickCharEntry(entries, key);
        if (!entry) { add(key); continue; }
        add(entry.key);
        for (const alias of listAliases(entry.content)) add(alias);
    }
    return out;
}

/** Is `name` one of `uncastNames` (uncastNamesOf)? Trimmed and case-insensitive, like every name comparison here. */
export function isUncastName(name, uncastNames) {
    const want = String(name || '').trim().toLowerCase();
    return !!want && (Array.isArray(uncastNames) ? uncastNames : []).some((n) => String(n || '').trim().toLowerCase() === want);
}

// A character listed with no outfit says so: "newclothes" and "undressed" are all a picture of her can say.
export const NO_OUTFIT_ON_FILE = 'no outfit on file — "newclothes" or "undressed"';
// Everyone the list leaves out: a character the story has not named before and no lorebook entry in this prompt is
// keyed on, one with no look stored, or one named under a spelling her entry does not carry. A model that recognises
// her from the lore would still pick an outfit= it remembers, and a value she does not have draws her with no
// clothes, so the list says it is all that is on file.
export const NOT_LISTED_HAS_NO_OUTFIT = 'Anyone this reply names who is not on this list has no outfit on file, however often the story has met them before — this list is all that is on file: a picture of them is "newclothes" or "undressed".';

// THE ON FILE LINES, GROUPED. Characters whose outfits on file are the same set share one line — a cast in one
// school uniform set is one line, however many girls wear it — so the list costs a line per DISTINCT set, not per
// character. Regrouped from `onFile` on every prompt: an outfit added to one girl moves her to a line of her own.
// The set is compared in any order and printed in the order of its first member; lines, and the names on them,
// keep `onFile`'s order.
function onFileGroupLines(onFile) {
    const groups = new Map();
    for (const e of onFile) {
        const variants = Array.isArray(e.variants) ? e.variants : [];
        const id = variants.map((v) => String(v).toLowerCase()).sort().join('\n');
        if (!groups.has(id)) groups.set(id, { choices: variants.length ? variants.join(', ') : NO_OUTFIT_ON_FILE, names: [] });
        groups.get(id).names.push(e.key);
    }
    return [...groups.values()].map((g) => `- ${g.names.join(', ')}: ${g.choices}`);
}

// The name the user's own character goes by on his ON FILE line and his "same-as-last-picture" line: the literal macro
// the image contract writes for him, with the attribute that takes the value.
export const USER_MAINCHAR_LABEL = '{{user}} (mainchar=)';

// HIS ON FILE LINE says what it is, because the heading above it speaks of outfit= choices and of characters who take
// records: his choices go in mainchar=, and listing him never makes him castable.
const USER_ON_FILE_NOTE = `The ${USER_MAINCHAR_LABEL} line is the user's own character: its choices go in mainchar=, and he never takes a record.`;

// "SAME-AS-LAST-PICTURE" IS PER CHARACTER, so it goes on lines of its own after the groups, each with what it draws —
// an outfit's name or a one-off's clothes — and the user's own character last, when the store holds what he wore.
// [] when nobody is offered it.
function sameAsLastPictureLines(onFile, userWear) {
    const lines = onFile.filter((e) => e.lastPictureWear).map((e) => `- ${e.key}: ${e.lastPictureWear}`);
    if (userWear) lines.push(`- ${USER_MAINCHAR_LABEL}: ${userWear}`);
    return lines.length
        ? [`"${OUTFIT_SAME_AS_LAST_PICTURE}" is also a choice for these, and draws what they wore in their last picture — the outfit or clothes after their name:`, ...lines]
        : [];
}

// The ON FILE list: who has a stored look, the outfit= choices each line offers, and "same-as-last-picture" where the
// store offers it. Inside <reply_cast> for the narrator, and the same list for a POST call that writes the pictures
// (reply-cast-prompt onFileListForPictureCall). `onFile`, `userWear` and `userOutfits` as for replyCastInstruction.
export function onFileListText(onFile = [], userWear = '', userOutfits = []) {
    const listed = (Array.isArray(onFile) ? onFile : []).filter(Boolean);
    const userChoices = (Array.isArray(userOutfits) ? userOutfits : []).map((o) => String(o || '').trim()).filter(Boolean);
    const groupLines = [...onFileGroupLines(listed), ...(userChoices.length ? [`- ${USER_MAINCHAR_LABEL}: ${userChoices.join(', ')}`] : [])];
    const sameAsLines = sameAsLastPictureLines(listed, String(userWear || '').trim());
    return groupLines.length
        ? `ON FILE — characters whose look is stored. Each line names one or more of them, then the outfit= choices a picture of any of them picks from.${userChoices.length ? ` ${USER_ON_FILE_NOTE}` : ''} Never write body= for them; their stored look is used:\n${[...groupLines, ...sameAsLines].join('\n')}\n${NOT_LISTED_HAS_NO_OUTFIT}`
        : `ON FILE — nobody the story has named has a stored look. ${NOT_LISTED_HAS_NO_OUTFIT}${sameAsLines.length ? `\n${sameAsLines.join('\n')}` : ''}`;
}

// The narrator's instruction. Every named character present, every reply: the set of names is a
// complete snapshot of the scene (plans/reply-cast.md §1.3), which is why it never asks "who is new".
// The records are read from anywhere in the reply, so they never claim the last slot: a block another
// instruction puts at the very end keeps it.
// `onFile` is onFileCast's result for this prompt.
// `recordAsks` are the attributes the features reading the records ask for on them this prompt, one line
// each (requestReplyCast). They are printed INSIDE this block, ahead of the format rules, so each ask stands
// beside the records it goes on and a record is described in one place.
// `uncastNames` are the names the user's own character goes by (uncastNamesOf), printed so the narrator reads
// them instead of judging which name means the user.
// `userWear` is what "same-as-last-picture" draws for the user's own character in mainchar= (userLastPictureWear),
// '' when the store holds nothing for him.
// `userOutfits` are the user's own character's outfits on file (userOutfitsOnFile), printed ON FILE on a line of his
// own after the groups, never grouped with anyone; [] prints no line for him. He is ON FILE in the text alone: the
// "Never the user's own character" line above still keeps him out of the records.
export function replyCastInstruction(onFile = [], recordAsks = [], uncastNames = [], userWear = '', userOutfits = []) {
    const userNames = (Array.isArray(uncastNames) ? uncastNames : []).map((n) => String(n || '').trim()).filter(Boolean);
    const userLine = userNames.length
        ? `- Never the user's own character, who goes by: ${userNames.join(', ')}. A record under any of these names is ignored.`
        : '- Never the user\'s own character.';
    const onFileText = onFileListText(onFile, userWear, userOutfits);
    const asks = (Array.isArray(recordAsks) ? recordAsks : []).map((a) => String(a || '').trim()).filter(Boolean);
    const asksText = asks.length ? `\nALSO ASKED FOR on a record, when it applies:\n${asks.map((a) => `- ${a}`).join('\n')}` : '';
    return `<reply_cast>
After the story, write one record for EVERY named character present in this reply — speaking, acting or shown on the page. The records never take another block's place: when another instruction puts its own block at the very end of the reply, write them just before that block.
${writeCastRecord({ name: 'the name as the story writes it' })}
${NAME_RULES}
${userLine}
- Every reply, even when nobody is new.
${onFileText}${asksText}
${CAST_RECORD_FORMAT_RULES}
</reply_cast>`;
}

// Who is in the reply: the declared names, then every drawn name the records left out — a drawn
// character is present even when the narrator forgot her record (§2.2). As written, each once
// (case-insensitive, like every key comparison in the roster).
export function replyCastNames(records, drawnNames) {
    const out = [];
    const seen = new Set();
    const add = (raw) => {
        const name = String(raw || '').trim();
        const folded = name.toLowerCase();
        if (!name || seen.has(folded)) return;
        seen.add(folded);
        out.push(name);
    };
    for (const record of (Array.isArray(records) ? records : [])) add(record && record.name);
    for (const name of (Array.isArray(drawnNames) ? drawnNames : [])) add(name);
    return out;
}

// The reply cast against the roster. `entries` is the registry as [{ key, content }].
// Returns:
//   registered — [{ key, names, outfits, allowUpdate, clothes }] one per ENTRY, however many of its
//                spellings the reply used. `names` is the key plus its aliases; `clothes` maps each
//                outfit to its text and is filled only when [AllowUpdate] is true, the one case where
//                the registration call needs to compare what she wears against what is on file.
//   newcomers  — names with no entry, or only a name-only placeholder: nothing on file to draw her from.
//   uncast     — names the user's own character goes by (`uncastNames`, uncastNamesOf), as written: never a
//                member and never a newcomer, so the registration call is never asked about them.
// A reserved outfit word as a name is left out: the registry refuses it anyway.
export function classifyReplyCast(names, entries, uncastNames = []) {
    const registered = [];
    const byKey = new Map();
    const newcomers = [];
    const seenNewcomers = new Set();
    const uncast = [];
    for (const raw of (Array.isArray(names) ? names : [])) {
        const name = String(raw || '').trim();
        if (!name || RESERVED_OUTFIT_NAMES.includes(name.toLowerCase())) continue;
        if (isUncastName(name, uncastNames)) {
            if (!uncast.some((n) => n.toLowerCase() === name.toLowerCase())) uncast.push(name);
            continue;
        }
        const { entry } = pickCharEntry(entries, name);
        if (!entry || !hasStoredAppearance(entry.content)) {
            if (!seenNewcomers.has(name.toLowerCase())) {
                seenNewcomers.add(name.toLowerCase());
                newcomers.push(name);
            }
            continue;
        }
        const keyFolded = entry.key.toLowerCase();
        if (byKey.has(keyFolded)) continue;
        const allowUpdate = allowsClothesUpdate(entry.content).allowed;
        const member = {
            key: entry.key,
            names: [entry.key, ...listAliases(entry.content)],
            outfits: listOutfitVariants(entry.content),
            allowUpdate,
            clothes: allowUpdate ? { ...parseDnaSections(entry.content).clothes } : {},
        };
        byKey.set(keyFolded, member);
        registered.push(member);
    }
    return { registered, newcomers, uncast };
}
