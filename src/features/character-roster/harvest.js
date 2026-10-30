// character-roster/harvest.js — Route B: character looks registered from the story (plans/reply-cast.md §4).
// Pure decisions live in dna-core.js and reply-cast-core.js; this half writes through the registry's store
// (character-registry.js) and logs.
//
// The registration call — the narrator, or a POST call it was routed to — writes cast records; a record
// carrying body=/clothes= is a registration (dna-core registrationFromCastRecord). This module reads
// the records out of that call's output, stores each registration as a character registry entry, and never
// rewrites a record: records stay in the text as written. The one thing it hands back for the caller to
// remove from a LIVE message is stray markup (closers the format never asks for).
//
// It reads a snapshot and awaits the store's writes, and by then another pass may have written the same
// message (live 2026-08-29: the image splice), so it never returns a rewritten text — the caller
// removes stray markup from the message as it is NOW, by exact string. For a POST call the records
// live in that call's output, not in the message, so there is nothing to remove.
//
// IDEMPOTENT BY CONSTRUCTION. Records are never stripped, so a continue reads the same records again:
// a registered name is skipped, an existing outfit is kept, and an overwrite with the same clothes is
// a no-op (replaceClothesInContent reports 'identical').
//
// WHAT THE PICTURE DREW (D40). A record's clothes for someone a picture of this reply drew in a one-off are replaced by
// the clothes that picture drew, whoever wrote the record: on the POST route the narrator's record dresses the
// picture and the POST call writes its own record in its own words, and only the picture's are what she was seen in.
//
// WHAT IT KEPT. Every clothes it writes into a record from the reply's records is listed as kept, and the worn-outfit
// store then holds that outfit by name wherever it copied the same clothes as a one-off (D37,
// worn-outfit-edits.js nameKeptOutfitsInWornStore): a picture drawn before the harvest saw no outfit on file. With the
// drawn clothes saved, that is the store's copy of her picture.

import { upsertCharDna, upsertOutfitVariant, resolveCharEntry, listCharEntries } from './character-registry.js';
import { nameKeptOutfitsInWornStore } from './worn-outfit-edits.js';
import { readCastRecords } from './cast-record-format-core.js';
import { isUncastName } from './reply-cast-core.js';
import { uncastNamesFor } from './reply-cast-prompt.js';
import { registrationFromCastRecord, registrationToEntryContent, registrationClothesTarget, hasStoredAppearance, hasClothesOnFile, hasBodyOnly, pickCharEntry, findNameSplits, namesWithoutRegistration, mayStoryReplaceClothes, replaceClothesInContent, entryAnswersTo, parseDnaSections, listAliases, drawnClothesFor } from './dna-core.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('character-roster');

// One outfit the harvest saved from a reply's records (WHAT IT KEPT): her entry's key, every name the worn-outfit store
// may hold her under — the key, her aliases, the name the record wrote — and the outfit with its clothes.
function keptOutfit(entry, writtenName, outfit, clothes) {
    return { key: entry.key, names: [entry.key, ...listAliases(entry.content), writtenName], outfit, clothes };
}

// FIRST CLOTHES (D29). A character with only her [Body] on file keeps the clothes a record gives her — an outfit, a
// clothes correction or a one-off alike: under its outfit= when that is a static <place or role>-<outfit> name, else
// as her [Clothes] (registrationClothesTarget). Nothing on file is replaced, so no clothes gate applies.
// Returns what was stored, for the summary line, or ''; what it stored joins `kept`.
async function keepFirstClothes(entry, parsed, kept) {
    const target = registrationClothesTarget(parsed.clothes, parsed.outfit, { hasClothesOnFile: false });
    if (target.notice) log.child('harvest').warn(`"${entry.key}" ${target.notice}.`);
    if (!target.variant) {
        if (target.refusal) log.child('harvest').warn(`"${entry.key}" clothes NOT saved — ${target.refusal}.`);
        return '';
    }
    if (await upsertOutfitVariant(entry.key, target.variant, target.clothes) !== 'stored') return '';
    kept.push(keptOutfit(entry, parsed.name, target.variant, target.clothes));
    const label = target.variant === 'default' ? 'Clothes' : `Clothes:${target.variant}`;
    return `${entry.key}:[${label}] (her first clothes)`;
}

// Read + store every registration in `text`.
// `drawnPics` = ONE ENTRY PER <pic> tag in the same reply, each the cast of that pic
//   (`[char]` or `[char, char2]`); empty = the reply drew nothing.
// `informedNames` = the characters the narrator's prompt showed registered clothes for (narrator only).
// `isChangeReport` = the writer is the POST registration call, which is shown her clothes and writes
//   them only on a change (D3): [AllowUpdate] alone decides an overwrite.
// `oneOffNames` = the names this reply's <pic> tags draw with outfit="newclothes": the story changed
//   their clothes, so nothing written about them this reply replaces clothes on file.
// `drawnOneOffs` = what those pictures drew each of them in ([{ key, clothes }], dna-core drawnOneOffClothesOf): a
//   record's clothes for one of them become these (WHAT THE PICTURE DREW).
// `askedNewcomers` = the names the POST registration call was asked to register this reply (reply-cast-core
//   classifyReplyCast's newcomers; [] on the narrate route, whose contract lets a passer-by go undescribed).
//
// A registration with no <pic> is EXPECTED — a character can be registered on the turn they debut,
// before anything draws them — and prints at verbose, not warn: a warning that fires on correct
// behaviour is one we learn to ignore. The opposite case is the costly one: a drawn name with nothing
// on file is composed without an appearance on every image until some reply registers it, so that
// one warns. So does a newcomer the POST call was asked to register and left without one: its answer
// may be empty when nobody needed anything, so an empty answer warns only through this check.
// Returns { stored: [names] }.
export async function harvestCastRegistrations(text, { drawnPics = [], informedNames = null, isChangeReport = false, oneOffNames = [], drawnOneOffs = [], askedNewcomers = [] } = {}) {
    const { records, invalid } = readCastRecords(text);
    // "2 pic(s): Mitsuki · Mitsuki+Mana" — the COUNT comes from the array length and each pic's
    // cast is joined with '+', so a two-hander can never be misread as two separate pics.
    const pics = Array.isArray(drawnPics) ? drawnPics : [];
    const picsLabel = pics.length
        ? `${pics.length} pic(s): ${pics.map((cast) => (Array.isArray(cast) ? cast : [cast]).join('+')).join(' · ')}`
        : 'no pics drawn';
    for (const bad of invalid) log.child('harvest').warn(`unreadable cast record (kept in text) — ${bad.error}:`, bad.raw.slice(0, 200));
    const drawnLc = new Set(pics.flatMap((cast) => (Array.isArray(cast) ? cast : [cast])).map((c) => String(c).toLowerCase()));
    // AS-WRITTEN drawn names. drawnLc is lowercased for comparison only, and a message built from it
    // tells the reader their card writes "mitsuki" when it writes "Mitsuki".
    const drawnNames = [...new Set(pics.flatMap((cast) => (Array.isArray(cast) ? cast : [cast]))
        .map((c) => String(c || '').trim()).filter(Boolean))];
    // A drawn name no registration carries costs nothing when the registry already holds an appearance
    // for it. With nothing on file, every image of them is composed without one until a reply registers them.
    // A newcomer the POST call was asked to register is checked the same way, unless drawn: a drawn one is
    // the first line's, so one name gets one warning.
    const reportUnregistered = async (registeredNames) => {
        const isOnFile = async (name) => {
            const entry = await resolveCharEntry(name);
            return !!entry && hasStoredAppearance(entry.content);
        };
        for (const name of namesWithoutRegistration(drawnNames, registeredNames)) {
            if (await isOnFile(name)) continue;
            log.child('harvest').warn(`"${name}" is drawn this reply but no cast record registers them (no body=), and the registry holds no appearance for them — every image of them is composed without one until a reply registers them. The call carrying the registration contract skipped them.`);
        }
        for (const name of namesWithoutRegistration(askedNewcomers, [...registeredNames, ...drawnNames])) {
            if (await isOnFile(name)) continue;
            log.child('harvest').warn(`"${name}" is in this reply and the POST call was asked to register them, but no cast record registers them (no body=) — the registry holds no appearance for them, and the next reply that shows them asks again.`);
        }
    };
    // ONE registry read for the whole pass: it names the user's own character (uncastNamesFor) and feeds the
    // one-off check and the name-split check below. An empty list on failure leaves the persona name alone to
    // recognise them by, drops every one-off as not stored and costs the split check, never the registration.
    let known = [];
    if (records.length) {
        try { known = await listCharEntries(); }
        catch (e) { log.child('harvest').warn('could not read the registry — the user\'s own character is recognised by the persona name alone and the name-split check is skipped (registering anyway):', e); }
    }
    const uncastNames = uncastNamesFor(known);
    const kept = [];   // WHAT IT KEPT (header)
    const registrations = [];
    let presenceOnly = 0;
    // A one-off outfit of a character with clothes on file is a valid record that is never stored: later pictures
    // carry it from the chat itself (the worn-outfit store). One for a character with only her [Body] on file goes on
    // to the loop below, as her first clothes.
    let oneOffs = 0;
    // THE USER'S OWN CHARACTER takes no record: <reply_cast> prints the names they go by. A record under one of
    // them registers nothing — as a newcomer it would store them as a second character, and as a match it would
    // add outfits to their entry.
    const uncastWritten = [];
    // WHAT THE PICTURE DREW (header): the record with the clothes her picture drew this reply, when one drew her in a
    // one-off; each replacement is named in the log.
    const redrawn = [];
    const asDrawn = (parsed) => {
        if (!parsed.clothes) return parsed;
        const drawn = drawnClothesFor(drawnOneOffs, pickCharEntry(known, parsed.name).entry, parsed.name);
        if (!drawn || drawn === parsed.clothes) return parsed;
        redrawn.push(`"${parsed.name}"${parsed.outfit ? ` [${parsed.outfit}]` : ''} "${drawn}" (the record wrote "${parsed.clothes}")`);
        return { ...parsed, clothes: drawn };
    };
    for (const record of records) {
        if (isUncastName(record.name, uncastNames)) { uncastWritten.push(record.name); continue; }
        const parsed = registrationFromCastRecord(record);
        if (!parsed.ok) {
            log.child('harvest').warn(`cast record for "${parsed.name}" NOT registered (kept in text) — ${parsed.error}:`, record.raw.slice(0, 200));
            continue;
        }
        if (parsed.kind === 'presence') { presenceOnly++; continue; }
        if (parsed.kind === 'oneoff' && !hasBodyOnly(pickCharEntry(known, parsed.name).entry?.content)) { oneOffs++; continue; }
        registrations.push({ parsed: asDrawn(parsed), raw: record.raw });
    }
    if (uncastWritten.length) {
        log.child('harvest').warn(`${uncastWritten.length} cast record(s) for the user's own character ignored (${uncastWritten.join(', ')}) — <reply_cast> lists these names as taking no record, and the writer wrote one anyway.`);
    }
    if (redrawn.length) {
        log.child('harvest').domain('roster', 'verbose', `${redrawn.length} record(s) take the clothes their picture drew this reply: ${redrawn.join('; ')}`);
    }
    if (!registrations.length) {
        log.child('harvest').domain('roster', 'verbose', `no registration in output (${records.length} cast record(s), ${presenceOnly} presence-only, ${oneOffs} one-off outfit(s), ${uncastWritten.length} for the user's own character, ignored) — nothing to register (${picsLabel}).`);
        await reportUnregistered([]);
        return { stored: [] };
    }
    log.child('harvest').domain('roster', 'verbose', `${registrations.length} registration(s) among ${records.length} cast record(s) (${oneOffs} one-off outfit(s), not stored; ${uncastWritten.length} for the user's own character, ignored), parsing (${picsLabel})`);

    const splitWarned = new Set();

    // ONE CHARACTER UNDER TWO KEYS. Both contracts tell the model to spell a name the way the STORY
    // spells it, and prose shortens names freely — so one reply registers "Nanami Kujou" and draws
    // `<pic char="Nanami">`. Neither resolves to the other and nothing links them: the drawn tag finds
    // no entry and renders composition-only, and the registration becomes a SECOND entry with a second
    // face. Measured live 2026-09-19 across three generations; the spelling that wins FLIPS between
    // replies, so neither side is the stable one.
    // TWO ARMS, because the damage arrives two ways:
    //   • WITHIN this reply — the <pic> and the registration disagree with each other. This is the one
    //     that cost a whole character: the registry was EMPTY that turn, so comparing against the
    //     registry had nothing to compare to.
    //   • ACROSS replies — the other spelling is already an entry, and the two drift apart.
    // SURFACED, NEVER REPAIRED (L7 corollary): auto-aliasing would hide a contract problem inside the
    // module that merely noticed it. The alias IS the fix, and the message says so — verified live.
    const reportNameSplits = async (name) => {
        for (const { other, where } of findNameSplits(name, { drawnNames, entries: known })) {
            const pair = [name.toLowerCase(), other.toLowerCase()].sort().join('|');
            if (splitWarned.has(pair)) continue;
            splitWarned.add(pair);
            // An [Alias] may already link them, which is the whole remedy — say nothing then.
            const [mine, theirs] = await Promise.all([resolveCharEntry(name), resolveCharEntry(other)]);
            if (mine && theirs && mine.key.toLowerCase() === theirs.key.toLowerCase()) continue;
            const longer = name.length >= other.length ? name : other;
            const shorter = longer === name ? other : name;
            log.child('harvest').warn(`"${name}" and "${other}" look like ONE character under TWO keys `
                + `("${other}" is ${where}). Neither name resolves to the other, so they become separate `
                + `entries with separate appearances, and which one a <pic> renders depends on the spelling `
                + `that tag happened to use. Fix: add "${shorter}" as an [Alias] on the "${longer}" entry in `
                + `the Roster tab — then both spellings resolve to her.`);
        }
    };
    // ── the ONLY path that overwrites clothes already on file ────────────────────────
    // The decision is mayStoryReplaceClothes (dna-core): [AllowUpdate] true on HER entry, and the
    // writer's record is evidence of a change — a POST change report, or a narrator that was not shown
    // her clothes. `informedNames === null` means the turn was never measured, and that reads as
    // INFORMED: unknown must never authorise an overwrite.
    // [Body] is never written by this path — replaceClothesInContent touches clothes sections only.
    const maybeUpdateClothes = async (entry, variant, clothesText) => {
        const drawnAsOneOff = (Array.isArray(oneOffNames) ? oneOffNames : []).some((n) => entryAnswersTo(entry.key, entry.content, n));
        const gate = mayStoryReplaceClothes(entry.key, entry.content, informedNames, { isChangeReport, drawnAsOneOff });
        if (gate.warning) log.child('harvest').warn(`"${entry.key}" ${gate.warning}`);
        if (!gate.allowed) {
            log.child('harvest').domain('roster', 'verbose', `"${entry.key}" clothes NOT updated — ${gate.reason}.`);
            return false;
        }
        const label = (!variant || variant === 'default') ? 'Clothes' : `Clothes:${variant}`;
        const res = replaceClothesInContent(entry.content, variant, clothesText);
        if (!res.changed) {
            log.child('harvest').domain('roster', 'verbose', `"${entry.key}" [${label}] not updated — ${res.reason}.`);
            return false;
        }
        if (!await upsertCharDna(entry.key, res.content)) return false;   // write failed (warned in character-registry.js)
        kept.push(keptOutfit(entry, entry.key, variant || 'default', clothesText));
        log.child('harvest').lifecycle(`"${entry.key}" [${label}] UPDATED from the story — ${gate.reason}. Her [Body] is untouched.`);
        return true;
    };
    // A registration's saved clothes for a character already on file. "default", or a static outfit she
    // already has, goes through the clothes gate; a static outfit she lacks is added. Returns what was
    // stored, for the summary line, or '' when nothing was.
    const saveRegisteredClothes = async (entry, variant, clothesText, writtenName) => {
        const label = variant === 'default' ? 'Clothes' : `Clothes:${variant}`;
        const isOnFile = Object.prototype.hasOwnProperty.call(parseDnaSections(entry.content).clothes, variant);
        if (variant === 'default' || isOnFile) {
            return await maybeUpdateClothes(entry, variant === 'default' ? '' : variant, clothesText) ? `${entry.key}:[${label}] (updated)` : '';
        }
        if (await upsertOutfitVariant(entry.key, variant, clothesText) !== 'stored') return '';
        kept.push(keptOutfit(entry, writtenName, variant, clothesText));
        return `${entry.key}:[${label}]`;
    };

    const stored = [];
    const registeredNames = [];
    // An outfit or clothes record for a character who holds clothes already, or who has no look on file.
    // OUTFIT → append a [Clothes:<variant>] to the EXISTING character entry, or correct one on file. A NEW name must
    // be static (newOutfitNameProblem): the narrator is shown only names, so a bare "swimsuit" saved once would dress
    // every later swimsuit in this one.
    // CLOTHES → correct her default clothes. Only a registered character has clothes to correct; a newcomer needs
    // body= to be registered at all.
    const saveRecordClothes = async (owner, parsed) => {
        if (parsed.kind === 'outfit') {
            const isOnFile = !!owner && Object.prototype.hasOwnProperty.call(parseDnaSections(owner.content).clothes, parsed.outfit);
            if (!isOnFile && parsed.nameProblem) {
                log.child('harvest').warn(`"${parsed.name}" outfit NOT saved — ${parsed.nameProblem}.`);
                return;
            }
            const r = await upsertOutfitVariant(parsed.name, parsed.outfit, parsed.clothes);
            if (r === 'stored') {
                stored.push(`${parsed.name}:[Clothes:${parsed.outfit}]`);
                if (owner) kept.push(keptOutfit(owner, parsed.name, parsed.outfit, parsed.clothes));
            }
            // Already on file under that name. upsertOutfitVariant refuses to clobber it, which is
            // right by default; the clothes gate is the one case where the story may replace it.
            if (r !== 'exists') return;
            if (owner && await maybeUpdateClothes(owner, parsed.outfit, parsed.clothes)) {
                stored.push(`${owner.key}:[Clothes:${parsed.outfit}] (updated)`);
            } else {
                log.child('harvest').lifecycle(`"${parsed.name}" [Clothes:${parsed.outfit}] already on file — NOT overwritten (edit it in the Roster tab to replace)`);
            }
            return;
        }
        if (!owner || !hasStoredAppearance(owner.content)) {
            log.child('harvest').warn(`"${parsed.name}" has clothes= but no body= and nothing on file — NOT registered (a new character needs body=).`);
            return;
        }
        if (await maybeUpdateClothes(owner, '', parsed.clothes)) stored.push(`${owner.key}:[Clothes] (updated)`);
    };

    for (const { parsed } of registrations) {
        if (parsed.kind !== 'char') {
            const owner = await resolveCharEntry(parsed.name);
            // FIRST CLOTHES → a character with only her [Body] on file keeps them, whatever the record's kind.
            if (owner && hasBodyOnly(owner.content)) {
                const first = await keepFirstClothes(owner, parsed, kept);
                if (first) stored.push(first);
                continue;
            }
            // A one-off reaches the loop only for a character who held her [Body] only as the reply began; an
            // earlier record in this reply has given her clothes since, and those are her first.
            if (parsed.kind === 'oneoff') {
                log.child('harvest').domain('roster', 'verbose', `"${parsed.name}" one-off not stored — an earlier record in this reply gave her her first clothes.`);
                continue;
            }
            await saveRecordClothes(owner, parsed);
            continue;
        }
        // CHAR → register her. Her clothes go where registrationClothesTarget puts them, by what her entry holds
        // already: a newcomer's first clothes are always kept; clothes it refused are named.
        registeredNames.push(parsed.name);
        // Print the AS-WRITTEN names, not drawnLc — that set is lowercased for comparison only.
        if (drawnLc.size && !drawnLc.has(parsed.name.toLowerCase())) {
            log.child('harvest').domain('roster', 'verbose', `"${parsed.name}" registered without being drawn this reply (${picsLabel}) — expected: the contract registers named characters present, not only drawn ones.`);
        }
        await reportNameSplits(parsed.name);
        // Never clobber an existing entry: a re-registration of a known key is a slip — keep the
        // established DNA stable. Alias-aware (resolveCharEntry): once 阿曼德 is an alias of
        // 阿曼德·布劳尔, a registration under EITHER spelling is recognised as already registered.
        const existing = await resolveCharEntry(parsed.name);
        const holdsClothes = !!existing && hasClothesOnFile(existing.content);
        const target = registrationClothesTarget(parsed.clothes, parsed.outfit, { hasClothesOnFile: holdsClothes });
        if (existing && hasStoredAppearance(existing.content)) {
            // Her [Body] is never rewritten here. With only her [Body] on file she keeps these clothes as her first;
            // with clothes on file, a new static outfit is added and one already on file changes only through the
            // clothes gate.
            const via = existing.key.toLowerCase() === parsed.name.toLowerCase() ? '' : ` as "${existing.key}" (matched by alias)`;
            if (holdsClothes && target.refusal) log.child('harvest').warn(`"${parsed.name}" clothes NOT saved — ${target.refusal}.`);
            const updated = !holdsClothes
                ? await keepFirstClothes(existing, parsed, kept)
                : (target.variant ? await saveRegisteredClothes(existing, target.variant, target.clothes, parsed.name) : '');
            if (updated) stored.push(updated);
            else log.child('harvest').lifecycle(`"${parsed.name}" already registered${via} — entry NOT overwritten (use roster Re-harvest to replace)`);
            continue;
        }
        if (target.notice) log.child('harvest').warn(`"${parsed.name}" ${target.notice}.`);
        if (target.refusal) log.child('harvest').warn(`"${parsed.name}" registered with the body only — ${target.refusal}.`);
        const savedAs = target.variant ? `[${target.variant === 'default' ? 'Clothes' : `Clothes:${target.variant}`}]` : '(body only)';
        const content = registrationToEntryContent({ body: parsed.body, clothes: target.clothes, variant: target.variant });
        const key = existing ? existing.key : parsed.name;
        if (existing) {
            // A NAME-ONLY placeholder, minted at draw time because a <pic> named someone the registry
            // did not know. It is a stand-in for exactly this registration, so FILL it — skipping would
            // mean a character drawn before she was ever described could never acquire appearance data.
            if (!await upsertCharDna(existing.key, content)) continue;
            stored.push(`${existing.key} ${savedAs}`);
            log.child('harvest').lifecycle(`filled the name-only placeholder for "${existing.key}" with harvested appearance.`);
        } else {
            if (!await upsertCharDna(parsed.name, content)) continue;   // write failed (warned in character-registry.js)
            stored.push(`${parsed.name} ${savedAs}`);
        }
        if (target.variant) kept.push(keptOutfit({ key, content }, parsed.name, target.variant, target.clothes));
    }
    // picsLabel rides along so the line says what was DRAWN as well as what was REGISTERED — they are
    // independent counts, and "3 registered" alone implies nothing about how many images this reply produced.
    if (stored.length) log.child('harvest').lifecycle(`stored ${stored.length} in the registry (new, "(updated)" or "(her first clothes)"): ${stored.join(', ')} (${picsLabel})`);
    await nameKeptOutfitsInWornStore(kept);
    await reportUnregistered(registeredNames);
    return { stored };
}

// THE REPLY'S OWN RECORDS ON THE POST ROUTE (D29). There the harvest reads the POST call's output, while the
// narrator's records stay in the reply — a picture's one-off among them (`outfit="newclothes" clothes=…`) — and the
// POST call is told to write nothing for a character already registered. So a character with only her [Body] on
// file keeps her first clothes from the reply's records, by the harvest's own rule (keepFirstClothes). Nothing else
// in the reply is read: on that route registering a newcomer, and every outfit of a character with clothes on file,
// is the POST call's job. The user's own character takes no record (uncastNamesFor).
// Returns { stored: [what was stored, for the log] }.
export async function keepFirstClothesFromReply(replyText) {
    const { records } = readCastRecords(replyText);
    if (!records.length) return { stored: [] };
    let known = [];
    try { known = await listCharEntries(); }
    catch (e) {
        log.child('harvest').warn('could not read the registry — no first clothes kept from the reply\'s records this turn:', e);
        return { stored: [] };
    }
    const uncastNames = uncastNamesFor(known);
    const stored = [];
    const kept = [];   // WHAT IT KEPT (header)
    for (const record of records) {
        if (isUncastName(record.name, uncastNames)) continue;
        const parsed = registrationFromCastRecord(record);
        if (!parsed.ok || parsed.kind === 'presence' || parsed.kind === 'char') continue;
        const owner = await resolveCharEntry(parsed.name);
        if (!owner || !hasBodyOnly(owner.content)) continue;
        const first = await keepFirstClothes(owner, parsed, kept);
        if (first) stored.push(first);
    }
    if (stored.length) log.child('harvest').lifecycle(`stored ${stored.length} first clothes from the reply's own records (the POST call writes none for a registered character): ${stored.join(', ')}`);
    await nameKeptOutfitsInWornStore(kept);
    return { stored };
}
