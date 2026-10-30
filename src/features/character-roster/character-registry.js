// character-roster/character-registry.js — the character registry's store: each character's look, kept in the chat's
// state at stat_data.$mvuhelper.character_registry (plans/character-registry-in-state.md). Its pure half is
// character-registry-core.js; the entry text it hands out is parsed by dna-core.js.
//
// Callers see entries, { key, content }, the content in `[Body]` / `[Clothes:<outfit>]` text, through the functions
// below. Which store sits behind them is this file's business alone: the harvest, the draw and the reply cast call the
// same functions with the same arguments and decide exactly as before.
//
// THE CURRENT REGISTRY is the newest stored state's registry, with the newest reply's journal applied: every reader
// reads it, so a redraw of an old message reads it too.
//
// THE REPLY'S JOURNAL. A change made while a reply is the chat's newest — the harvest, a name-only mint at draw time,
// the POST capture, a Roster-tab edit — is appended to that reply's journal (its message and swipe), and:
//   • written at once into the reply's stored state, through the save door, when MVU has saved that state;
//   • written into every copy of the reply's state that is saved later, by characterRegistryJournalTask, an
//     own-state task run on MVU's save and on a turn engine's staged copy (own-state.js).
// The narrate capture and MVU's parse both run on MESSAGE_RECEIVED, in either order, and a turn engine saves its own
// copy after MVU's: the journal reaches each copy whichever comes first, and a copy that already holds a change is
// left as it is. A regenerate or a new reply starts a new journal, so a change never reaches another swipe.
//
// A ROSTER-TAB EDIT is also written into every state a new generation can seed from (shared/generation-floor.js), so
// regenerating or swiping the newest reply keeps it; it is refused while a reply is being generated, because the reply
// in flight would overwrite it.

import { createModuleLog } from '../../sillytavern/log.js';
import { chatContext, chatMessages } from '../../sillytavern/chat-context.js';
import { rewriteOwnStatPart } from '../../sillytavern/mvu-bridge.js';
import { ownStatPart, setOwnStatPart, storedStatDataOf, stateBefore, MVUHELPER_STAT_ROOT } from '../../sillytavern/mvu-bridge-core.js';
import { latestAiMessageId, swipeOf } from '../../shared/latest-reply.js';
import { tailMessagesCarryingVariables } from '../../shared/generation-floor.js';
import { createSerialQueue } from '../../shared/serial-queue.js';
import { isGenerationInFlight } from '../logic-engine/index.js';
import { readCardSeed, SEED_FINGERPRINTS_PART, differsFromSeedPrints } from '../card-sync/index.js';
import { listOutfitVariants, listAliases, pickCharEntry, appendAliases, appendClothesVariant, chooseLook, replyRecordOf, wornOutfitOn } from './dna-core.js';
import {
    CHARACTER_REGISTRY_PART, registryIn, entriesOfRegistry, recordFromContent, setChange, deleteChange, applyRegistryChanges,
    registryPartAfter, describeChange, newJournal, isJournalOf, recordProblems,
} from './character-registry-core.js';

const log = createModuleLog('character-roster');

export { listOutfitVariants, listAliases };

const SAVE_WRITER = 'character-registry';

let journal = null;   // the newest reply's changes: { message, swipe, changes }
const reportedProblemChats = new Set();
const unsavedWarnedChats = new Set();

function currentChat() {
    return chatMessages('character-roster');
}

function currentChatId() {
    const context = chatContext('character-roster');
    return String((context && context.chatId) || '');
}

// The journal when it belongs to the chat's newest reply on the swipe it shows; null otherwise.
function journalOfNewestReply(chat) {
    const mid = latestAiMessageId(chat);
    return mid >= 0 && isJournalOf(journal, chat[mid], swipeOf(chat, mid)) ? journal : null;
}

// The registry of one stored state.
const registryOfState = (statData) => registryIn(ownStatPart(statData, CHARACTER_REGISTRY_PART));

// THE CURRENT REGISTRY (header). A record whose shape is wrong is named once per chat; it is still read.
function currentRegistry() {
    const chat = currentChat();
    const newest = stateBefore(chat, chat.length);
    const base = newest ? registryOfState(newest.statData) : {};
    const own = journalOfNewestReply(chat);
    const registry = own ? applyRegistryChanges(base, own.changes) : base;
    reportShapeProblems(registry);
    return registry;
}

function reportShapeProblems(registry) {
    const chatId = currentChatId();
    if (reportedProblemChats.has(chatId)) return;
    const problems = Object.entries(registry).flatMap(([key, record]) => recordProblems(key, record));
    if (!problems.length) return;
    reportedProblemChats.add(chatId);
    log.warn(`the character registry in this chat's state has records of the wrong shape — they are read as far as they go: ${problems.join('; ')}`);
}

// ── entry listing ─────────────────────────────────────────────────────────────
// Every character on file → [{ key, content }], sorted by key.
export async function listCharEntries() {
    return entriesOfRegistry(currentRegistry());
}

// ── key resolution (the ONE place a name becomes an entry) ───────────────────
// Every consumer — draw-time appearance, outfit-variant append, harvest's already-registered check — resolves through
// here, so an alias declared once is honoured everywhere. Which entry wins is pickCharEntry's rule (dna-core.js):
// exact key over any alias. Two entries claiming one alias is logged, never silent: picking one quietly would draw a
// character with someone else's body on some turns and not others. The listing is sorted by key, so the pick is
// stable between calls.
export async function resolveCharEntry(key) {
    const want = String(key || '').trim();
    if (!want) return null;
    const { entry, viaAlias, claimants } = pickCharEntry(await listCharEntries(), want);
    if (!entry) return null;
    if (!viaAlias) return entry;
    if (claimants.length > 1) {
        log.child('dna').warn(`"${want}" is registered as an alias on ${claimants.length} entries `
            + `(${claimants.map((e) => `"${e.key}"`).join(', ')}) — using "${entry.key}". `
            + 'Two characters cannot share an alias; remove it from all but one in the Roster tab.');
    }
    log.child('dna').domain('roster', 'verbose', `"${want}" resolved through an alias to "${entry.key}"`);
    return entry;
}

// ── the look read (called per generation) ───────────────────────────────────
// One drawn person's look for this picture — dna-core chooseLook decides: her stored look, else the look her <cast>
// record in the same reply gives her, else none. `replyRecords` are that reply's cast records (readCastRecords);
// `worn` is the worn-outfit store as this picture sees it (nextWornOutfit), which "same-as-last-picture" and a slip are
// drawn from (wornOutfitOn); `shownFor`, on a regen only, gives her entry's key → what the store saved with the
// picture's reply holds for her, or null (D39). Alias-aware through resolveCharEntry, for the entry, the record and
// the store. Returns { source, key, body, clothes, clothesSource, wornEntry, bust }; `key` is the entry's key when she
// has one, `source` / `clothesSource` / `wornEntry` say where her body / her clothes came from (chooseLook). Every
// warning chooseLook raises is logged here. A person with no look at all is the CALLER's to report, because only it
// knows what the picture does without one.
export async function readCharLook(charKey, outfit, { replyRecords = [], worn = null, shownFor = null } = {}) {
    const name = String(charKey || '').trim();
    if (!name) return { source: 'none', key: '', body: '', clothes: '', clothesSource: '', wornEntry: null, bust: null };
    const entry = await resolveCharEntry(name);
    const key = entry ? entry.key : name;
    const shown = typeof shownFor === 'function' ? shownFor(key) : null;
    const look = chooseLook({ name, entry, record: replyRecordOf(replyRecords, name, entry), outfit, carried: wornOutfitOn(worn, key), shown });
    for (const w of look.warnings) log.warn('dna:', w);
    return { source: look.source, key, body: look.body, clothes: look.clothes, clothesSource: look.clothesSource, wornEntry: look.wornEntry, bust: look.bust };
}

// ── writing ───────────────────────────────────────────────────────────────────
// Is a Roster-tab edit allowed now? Not while a reply is being generated: the reply in flight would overwrite it.
export function isRegistryEditable() {
    return !isGenerationInFlight();
}

// One write at a time: each reads a state and saves it back (shared/serial-queue.js).
const serialized = createSerialQueue();

// Apply `changes` to the registry of message `messageId`'s stored state and save it through the save door; changes
// that leave it as it is save nothing. False when that message holds no state or MVU is unavailable (logged where it
// happens).
function writeIntoStoredState(messageId, changes) {
    return rewriteOwnStatPart(messageId, CHARACTER_REGISTRY_PART, (part) => registryPartAfter(part, changes), { writer: SAVE_WRITER });
}

// Record `changes` and write them where they belong (header). Returns true once they are on file — in the journal,
// and in every stored state that should hold them.
async function commitChanges(changes, { isUserEdit = false } = {}) {
    if (!changes.length) return true;
    if (isUserEdit && !isRegistryEditable()) {
        log.child('registry').warn('a reply is being generated — the Roster-tab edit was not saved; try again when the reply has finished');
        return false;
    }
    return serialized(async () => {
        const chat = currentChat();
        const mid = latestAiMessageId(chat);
        if (mid >= 0) {
            const message = chat[mid];
            const swipe = swipeOf(chat, mid);
            if (!isJournalOf(journal, message, swipe)) journal = newJournal(message, swipe);
            journal.changes.push(...changes);
        }
        const targets = [];
        if (mid >= 0 && storedStatDataOf(chat[mid])) targets.push(mid);
        if (isUserEdit) {
            for (const index of tailMessagesCarryingVariables(chat, 2)) {
                if (storedStatDataOf(chat[index]) && !targets.includes(index)) targets.push(index);
            }
        }
        if (!targets.length) {
            warnNothingSaved(mid);
            return mid >= 0;
        }
        let isWritten = true;
        for (const index of targets) {
            // The chat can move on while a save is awaited; a state that is no longer the one this change was for is left alone.
            if (currentChat() !== chat) { log.child('registry').warn('the chat changed while the registry was being saved — the rest was not written'); return false; }
            try {
                if (!(await writeIntoStoredState(index, changes))) isWritten = false;
            } catch (e) {
                log.child('registry').error(`saving the character registry into msg ${index}'s state failed:`, e);
                isWritten = false;
            }
        }
        return isWritten;
    });
}

// No message holds MVU state yet: the change rides the reply's journal into the state MVU saves for it, and is lost if
// MVU never saves one. Named once per chat.
function warnNothingSaved(mid) {
    const chatId = currentChatId();
    if (unsavedWarnedChats.has(chatId)) return;
    unsavedWarnedChats.add(chatId);
    log.child('registry').warn(mid >= 0
        ? `no message in this chat holds MVU state yet — the character registry change is kept for msg ${mid} until MVU saves its state`
        : 'no reply and no MVU state in this chat yet — the character registry change was not kept');
}

// Upsert one character's entry text (the harvest and the Roster tab's edits land here). Returns { created } once it is
// on file, null when it could not be written (logged). `isUserEdit` marks a Roster-tab edit (header).
export async function upsertCharDna(key, content, { isUserEdit = false } = {}) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) { log.child('dna.upsertCharDna').warn('empty key — skipped'); return null; }
    const registry = currentRegistry();
    const created = !Object.prototype.hasOwnProperty.call(registry, cleanKey);
    const record = recordFromContent(String(content || '').trim(), registry[cleanKey]);
    if (!(await commitChanges([setChange(cleanKey, record)], { isUserEdit }))) {
        log.child('dna.upsertCharDna').warn(`write failed for "${cleanKey}"`);
        return null;
    }
    log.child('dna').domain('roster', 'verbose', `${created ? 'created' : 'updated'} entry for "${cleanKey}"`);
    return { created };
}

// A <pic> names someone the registry has never heard of. mvu-helper is already holding that name, so it mints a
// NAME-ONLY entry: the name then shows in the Roster tab, where Merge — which needs both entries to exist — can turn it
// into an alias of the entry it duplicates, and every later <pic> under that spelling resolves through the alias. The
// entry is deliberately empty: only the story knows what she looks like, and hasStoredAppearance() keeps a name-only
// entry from passing for a look.
export async function registerPlaceholderCharDna(key) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return { ok: false, reason: 'empty key' };
    const existing = await resolveCharEntry(cleanKey);
    if (existing) return { ok: false, reason: 'already resolves', key: existing.key };
    const res = await upsertCharDna(cleanKey, '');
    if (!res) return { ok: false, reason: 'write failed' };
    log.child('dna').lifecycle(`minted a name-only entry for "${cleanKey}" — it was drawn but not registered. `
        + 'Give it appearance text in the Roster tab, or Merge it onto the entry it duplicates to make it an alias.');
    return { ok: true, key: cleanKey };
}

// Delete one character by key. True once it is gone from the registry.
export async function deleteCharDna(key, { isUserEdit = false } = {}) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return false;
    if (!Object.prototype.hasOwnProperty.call(currentRegistry(), cleanKey)) {
        log.child('dna.deleteCharDna').warn(`no entry keyed "${cleanKey}" — nothing deleted`);
        return false;
    }
    if (!(await commitChanges([deleteChange(cleanKey)], { isUserEdit }))) return false;
    log.child('dna').lifecycle(`deleted entry for "${cleanKey}"`);
    return true;
}

// Outfit-variant harvest: append a clothes section to an EXISTING character's entry — [Clothes] for "default",
// [Clothes:<variant>] for any other name (appendClothesVariant). Never clobbers a present variant: it returns 'exists'
// WITHOUT logging a verdict, because the caller decides what happens next (the harvest's clothes gate may still
// replace it). Returns 'stored' | 'exists' | 'no-char' | 'failed'.
export async function upsertOutfitVariant(key, variant, clothesText) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) { log.child('dna.upsertOutfitVariant').warn('empty key — skipped'); return 'failed'; }
    const entry = await resolveCharEntry(cleanKey);
    if (!entry) {
        log.child('dna.upsertOutfitVariant').warn(`no entry for "${cleanKey}" — an outfit needs a registered character (register her first, then the outfit)`);
        return 'no-char';
    }
    const res = appendClothesVariant(entry.content, variant, clothesText);
    if (!res.changed) return 'exists';
    if (!(await commitChanges([setChange(entry.key, recordFromContent(res.content, currentRegistry()[entry.key]))]))) {
        log.child('dna.upsertOutfitVariant').warn(`write failed for "${cleanKey}"`);
        return 'failed';
    }
    log.child('dna').domain('roster', 'verbose', `registered outfit ${String(variant).trim().toLowerCase() === 'default' ? '[Clothes]' : `[Clothes:${variant}]`} for "${cleanKey}"`);
    return 'stored';
}

// ── what the card seeds ───────────────────────────────────────────────────────
// A character the card's [InitVar] seeds carries fingerprints in the state (card-sync's re-seed): it follows the card
// while the chat leaves it alone, and comes back from the card when deleted. Its key is the card's: renamed or merged
// away, the seeded key would come back on the next load and win over the alias.
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The fingerprints the re-seed recorded for one character in the newest stored state; null when the card seeds none.
function seedPrintsOf(key) {
    const chat = currentChat();
    const newest = stateBefore(chat, chat.length);
    const prints = newest ? ownStatPart(newest.statData, SEED_FINGERPRINTS_PART) : undefined;
    const registryPrints = isPlainObject(prints) ? prints[CHARACTER_REGISTRY_PART] : undefined;
    const own = isPlainObject(registryPrints) ? registryPrints[key] : undefined;
    return isPlainObject(own) ? own : null;
}

// Does the card seed this character, and has this chat changed it from the card's record?
export function seedStatusOf(key) {
    const cleanKey = String(key || '').trim();
    const prints = seedPrintsOf(cleanKey);
    if (!prints) return { isSeeded: false, isChanged: false };
    return { isSeeded: true, isChanged: differsFromSeedPrints(currentRegistry()[cleanKey], prints) };
}

// The outfits the card seeds for this character: removed in this chat, one comes back from the card on the next load
// (card-sync's seed writes every absent key, at every depth).
export function seededOutfitsOf(key) {
    const prints = seedPrintsOf(String(key || '').trim());
    return prints && isPlainObject(prints.clothes) ? Object.keys(prints.clothes) : [];
}

const seededKeyRefusal = (key) => `the card seeds "${key}": renamed or merged away, it would come back from the card on the next `
    + 'load. Add the other spelling to its aliases instead (Edit)';

// "Reset to the card's look": the card's own record for this character, read from its [InitVar] now, replaces what the
// chat holds — a Roster-tab edit (header). The next re-seed records its fingerprints, so later card changes reach it
// again. Returns { ok, reason? }.
export async function resetCharToSeed(key) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return { ok: false, reason: 'empty key' };
    const seed = await readCardSeed();
    const seededRoot = seed && isPlainObject(seed[MVUHELPER_STAT_ROOT]) ? seed[MVUHELPER_STAT_ROOT] : null;
    const seededRegistry = seededRoot && isPlainObject(seededRoot[CHARACTER_REGISTRY_PART]) ? seededRoot[CHARACTER_REGISTRY_PART] : null;
    const record = seededRegistry ? seededRegistry[cleanKey] : undefined;
    if (!isPlainObject(record)) {
        return { ok: false, reason: seed ? "the card's [InitVar] does not seed this character" : "the card's [InitVar] could not be read (see console)" };
    }
    if (!(await commitChanges([setChange(cleanKey, record)], { isUserEdit: true }))) return { ok: false, reason: 'the registry could not be saved (see console)' };
    log.child('dna').lifecycle(`"${cleanKey}" reset to the card's look`);
    return { ok: true };
}

// ── rename / merge (the drift repair pair) ───────────────────────────────────
// RENAME — the look is right, the key is wrong: a key captured in the wrong script ("Amand" for a character the story
// calls 阿曼德·布劳尔) keeps its body and clothes; the old key becomes an alias, so a reply already in flight under the
// old spelling still resolves. Returns { ok, reason? }.
export async function renameCharDna(oldKey, newKey, { isUserEdit = false } = {}) {
    const from = String(oldKey || '').trim();
    const to = String(newKey || '').trim();
    if (!from || !to) return { ok: false, reason: 'empty key' };
    if (from === to) return { ok: false, reason: 'the new key is identical to the current one' };
    const registry = currentRegistry();
    const entries = entriesOfRegistry(registry);
    const entry = entries.find((e) => e.key.toLowerCase() === from.toLowerCase());
    if (!entry) return { ok: false, reason: `no entry keyed "${from}"` };
    if (seedPrintsOf(entry.key)) return { ok: false, reason: seededKeyRefusal(entry.key) };
    // Only a DIFFERENT entry already owning the target key is a conflict — a pure case change ("amand" → "Amand")
    // resolves to this same entry and is a legitimate rename.
    const clash = entries.find((e) => e.key.toLowerCase() === to.toLowerCase() && e.key !== entry.key);
    if (clash) return { ok: false, reason: `"${to}" is already registered — use Merge instead of Rename` };
    const aliased = appendAliases(entry.content, to, from);
    const changes = [deleteChange(entry.key), setChange(to, recordFromContent(aliased.content, registry[entry.key]))];
    if (!(await commitChanges(changes, { isUserEdit }))) return { ok: false, reason: 'the registry could not be saved (see console)' };
    log.child('dna').lifecycle(`renamed "${from}" → "${to}" (look kept; "${from}" now resolves as an alias)`);
    return { ok: true };
}

// MERGE — two entries, one character. The TARGET keeps its look; the source's key and the source's own aliases are
// recorded on the target, and the source is deleted, in one change set. The source's appearance text is DISCARDED,
// which is why every caller must confirm first. Returns { ok, reason?, aliases: [] }.
export async function mergeCharDna(sourceKey, targetKey, { isUserEdit = false } = {}) {
    const from = String(sourceKey || '').trim();
    const to = String(targetKey || '').trim();
    if (!from || !to) return { ok: false, reason: 'empty key', aliases: [] };
    if (from.toLowerCase() === to.toLowerCase()) return { ok: false, reason: 'cannot merge an entry into itself', aliases: [] };
    const registry = currentRegistry();
    const entries = entriesOfRegistry(registry);
    const source = entries.find((e) => e.key.toLowerCase() === from.toLowerCase());
    const target = entries.find((e) => e.key.toLowerCase() === to.toLowerCase());
    if (!source) return { ok: false, reason: `no entry keyed "${from}"`, aliases: [] };
    if (!target) return { ok: false, reason: `no entry keyed "${to}"`, aliases: [] };
    if (seedPrintsOf(source.key)) return { ok: false, reason: seededKeyRefusal(source.key), aliases: [] };
    // The source's OWN aliases come along — otherwise a second merge would strand the names a first merge had already
    // resolved, and they would start creating fresh entries again.
    const carried = [from, ...listAliases(source.content)];
    const aliased = appendAliases(target.content, target.key, carried);
    const changes = [deleteChange(source.key)];
    if (aliased.changed) changes.unshift(setChange(target.key, recordFromContent(aliased.content, registry[target.key])));
    if (!(await commitChanges(changes, { isUserEdit }))) return { ok: false, reason: 'the registry could not be saved (see console)', aliases: [] };
    log.child('dna').lifecycle(`merged "${from}" into "${to}" — ${aliased.added.length} alias(es) now resolve to "${to}": ${aliased.added.join(', ') || '(none new)'}`);
    return { ok: true, aliases: aliased.added };
}

// ── the journal into each saved copy ─────────────────────────────────────────
// An own-state task (own-state registerOwnStateTask, src/index.js): writes the reply's journal into the copy of its
// state being saved — MVU's save, and a turn engine's staged copy.
export const characterRegistryJournalTask = {
    name: 'character registry',
    run(statData, { mid, copyLabel }) {
        const chat = currentChat();
        if (!isJournalOf(journal, chat[mid], swipeOf(chat, mid)) || !journal.changes.length) return;
        const before = ownStatPart(statData, CHARACTER_REGISTRY_PART);
        const after = registryPartAfter(before, journal.changes);
        if (after === before) return;
        setOwnStatPart(statData, CHARACTER_REGISTRY_PART, after);
        log.domain('roster', 'verbose', `msg ${mid} (${copyLabel}): ${CHARACTER_REGISTRY_PART}: ${journal.changes.length} change(s) from this reply — `
            + journal.changes.map(describeChange).join(', '));
    },
};

// A chat change ends every journal and every once-per-chat note.
export function resetCharacterRegistryForChat() {
    journal = null;
}
