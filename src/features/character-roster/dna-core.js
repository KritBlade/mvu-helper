// character-roster/dna-core.js — PURE logic for the character registry's entry text (no ST imports,
// no logger — returns warnings to the caller, repo convention like lore-core.js): the sections an entry holds,
// whose look a picture draws, which clothes the story may save, and what each character wears now (the worn-outfit
// store) with its edits. The store (character-registry.js) hands every caller this text. Tested by
// tests/dna-core.test.js.

import { MVUHELPER_STAT_ROOT } from '../../sillytavern/mvu-bridge-core.js';

// ── DNA section parsing ───────────────────────────────────────────────────────
// Entry content = labelled sections: [Body] · [Clothes] · [Clothes:variant] · [Bust] · [Alias] · [AllowUpdate].
// [Bust] is NOT an image tag — it is a number handed to the /sd backend's bust LoRA (see imagegen
// bust transport). It never reaches the prompt text.
// [Alias] is NOT appearance either — it is the OTHER keys that mean this same character, one per
// line. No prompt can stop a model spelling a name two ways (阿曼德 vs 阿曼德·布劳尔 for one man),
// so the user declares the equivalence once in the roster and every later lookup resolves through
// it. See resolveCharEntry in character-registry.js — this half only parses.
const SECTION_RE = /^\s*\[(Body|Bust|Alias|AllowUpdate|Clothes(?::([A-Za-z0-9_-]+))?)\]\s*$/gim;

export function parseDnaSections(content) {
    const text = String(content || '');
    const result = { body: '', clothes: {}, bust: '', aliases: [], allowUpdate: '' };
    const headers = [];
    let m;
    SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(text)) !== null) {
        headers.push({ label: m[1], variant: m[2] || '', start: m.index, bodyStart: m.index + m[0].length });
    }
    for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        const end = i + 1 < headers.length ? headers[i + 1].start : text.length;
        const chunk = text.slice(h.bodyStart, end).trim();
        if (/^Body$/i.test(h.label)) {
            result.body = chunk;
        } else if (/^Bust$/i.test(h.label)) {
            result.bust = chunk;
        } else if (/^AllowUpdate$/i.test(h.label)) {
            result.allowUpdate = chunk;
        } else if (/^Alias$/i.test(h.label)) {
            // ONE PER LINE, deliberately: a name may legally contain a comma or a middle dot
            // (阿曼德·布劳尔), so splitting on punctuation would shred real keys. Repeated
            // [Alias] sections accumulate rather than overwrite.
            for (const line of chunk.split('\n')) {
                const alias = line.trim();
                if (alias && !result.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) {
                    result.aliases.push(alias);
                }
            }
        } else if (h.variant) {
            result.clothes[h.variant.toLowerCase()] = chunk;
        } else {
            result.clothes.default = chunk;
        }
    }
    return result;
}

// Does this entry actually carry appearance data, or is it only a NAME? PURE.
//
// The distinction exists because a registry entry can now be created two ways: harvested from a
// registration (real [Body]/[Clothes]) or minted mechanically from a <pic char=…> naming someone
// the registry has never heard of (name only). The second kind is a PLACEHOLDER — it exists so the
// name is visible in the Roster tab and reachable by the Merge/alias tool, which needs two entries
// to work at all. It must never be mistaken for established DNA:
//   • harvest FILLS a placeholder instead of skipping it (skipping would mean a name minted once
//     could never acquire real appearance data again),
//   • the draw-time diagnostic keeps warning while it is empty, instead of falling silent the moment
//     an entry with the right key exists.
// Clothes counts, not just body: an entry carrying only [Clothes] was authored by someone.
export function hasStoredAppearance(content) {
    const parsed = parseDnaSections(content);
    if (parsed.body.trim()) return true;
    return Object.values(parsed.clothes).some((c) => String(c || '').trim());
}

// The alternate keys this entry answers to ('' content → []).
export function listAliases(content) {
    return parseDnaSections(content).aliases;
}

// Does `key` name this entry — as its own key, or as one of its aliases? Case-insensitive,
// matching every other key comparison in the registry. PURE: the caller supplies both halves.
export function entryAnswersTo(entryKey, content, key) {
    const want = String(key || '').trim().toLowerCase();
    if (!want) return false;
    if (String(entryKey || '').trim().toLowerCase() === want) return true;
    return listAliases(content).some((a) => a.toLowerCase() === want);
}

// WHICH ENTRY A NAME RESOLVES TO — PURE; the rule behind character-registry.js resolveCharEntry, shared so a lookup
// over an entry list already in hand cannot drift from it. `entries` is [{ key, content }].
// Exact key wins over any alias: renaming records the OLD key as an alias, so a character whose old
// name is another character's current name must still resolve to the CURRENT owner.
// Returns { entry, viaAlias, claimants } — `claimants` lists every entry claiming the name as an alias,
// so the caller can report two entries sharing one (the first one wins; the list order decides).
export function pickCharEntry(entries, key) {
    const want = String(key || '').trim().toLowerCase();
    const none = { entry: null, viaAlias: false, claimants: [] };
    if (!want) return none;
    const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
    const exact = list.find((e) => String(e.key || '').trim().toLowerCase() === want);
    if (exact) return { entry: exact, viaAlias: false, claimants: [] };
    const claimants = list.filter((e) => entryAnswersTo(e.key, e.content, want));
    if (!claimants.length) return none;
    return { entry: claimants[0], viaAlias: true, claimants };
}

// ── [AllowUpdate] — may the STORY overwrite clothes already on file? ───────────────────
// One more non-image field beside [Bust] and [Alias], holding `true` or `false`.
//
// ABSENT MEANS FALSE, which is the behaviour every entry already has, so nothing migrates and there
// is no version field. The GUI writes the section the first time someone enables it and flips the
// value afterwards, which is why nothing here ever has to REMOVE a section.
//
// An unreadable value reads as FALSE and says so. A flag that cannot be parsed must never be the one
// authorising an overwrite of hand-authored DNA.
export function allowsClothesUpdate(content) {
    const raw = parseDnaSections(content).allowUpdate;
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return { allowed: false, warning: '' };          // absent — the default, not a fault
    if (value === 'true') return { allowed: true, warning: '' };
    if (value === 'false') return { allowed: false, warning: '' };
    return { allowed: false, warning: `has an unreadable [AllowUpdate] value ("${String(raw).slice(0, 30)}") — reading it as false` };
}

// MAY THE STORY REPLACE HER CLOTHES THIS TURN? PURE, and the whole decision in one place.
// [AllowUpdate] guards the REGISTRY only (plans/reply-cast.md §1.9): an overwrite there is permanent
// and hits every chat, so it is off unless her entry says true.
//
// Nothing here guesses whether the clothes really changed, because nothing can: "brown blazer, brown
// skirt" against "brown skirt, brown blazer" is one outfit and two strings, and no amount of
// normalising closes that class. That is precisely why the switch exists instead of a comparison.
//   1. [AllowUpdate] is true on HER entry.
//   2. The reply did not draw her in a one-off (`drawnAsOneOff`): outfit="newclothes" is the narrator
//      saying the story CHANGED her clothes, so anything written about her clothes this reply describes
//      the one-off — never a correction of what is on file, which a one-off must not replace.
//   3. What the writer wrote is evidence of a correction. Two ways:
//      • a CHANGE REPORT (`isChangeReport`): the POST registration call is shown her clothes and told to
//        write one of her outfits only when this reply shows it differently (D3) — [AllowUpdate] alone
//        decides;
//      • otherwise (the narrator), the prompt did NOT show the model her clothes. An INFORMED character
//        was shown her outfits ON FILE, so a description the narrator writes for her is a one-off or a
//        paraphrase, never evidence that what is on file is wrong. Only for an UNINFORMED character is
//        the model's description the only one in existence.
// `informedNames` must be the UNION of both prompt blocks. null means the turn was never measured and
// reads as INFORMED: unknown must never authorise overwriting hand-authored DNA.
export function mayStoryReplaceClothes(entryKey, content, informedNames, { isChangeReport = false, drawnAsOneOff = false } = {}) {
    const gate = allowsClothesUpdate(content);
    if (!gate.allowed) return { allowed: false, warning: gate.warning, reason: gate.warning ? 'unreadable [AllowUpdate]' : '[AllowUpdate] is not true' };
    if (drawnAsOneOff) return { allowed: false, warning: '', reason: `this reply drew her in a one-off (outfit="${OUTFIT_NEW_CLOTHES}"), which never replaces clothes on file` };
    if (isChangeReport) return { allowed: true, warning: '', reason: 'allowed, and the registration call reports only a change' };
    const key = String(entryKey || '').trim().toLowerCase();
    const informed = !Array.isArray(informedNames)
        || informedNames.some((n) => String(n || '').trim().toLowerCase() === key);
    if (informed) return { allowed: false, warning: '', reason: 'this prompt SHOWED the model her registered clothes' };
    return { allowed: true, warning: '', reason: 'allowed, and this prompt showed the model no clothes for her' };
}

// Where one section's BODY lives, so a scalar section can be rewritten without disturbing its
// neighbours. Returns null when the section is absent. PURE.
function sectionBodyBounds(text, label) {
    SECTION_RE.lastIndex = 0;
    const headers = [];
    let m;
    while ((m = SECTION_RE.exec(text)) !== null) headers.push({ label: m[1], start: m.index, bodyStart: m.index + m[0].length });
    for (let i = 0; i < headers.length; i++) {
        if (headers[i].label.toLowerCase() !== label.toLowerCase()) continue;
        return { start: headers[i].bodyStart, end: i + 1 < headers.length ? headers[i + 1].start : text.length };
    }
    return null;
}

// Set the flag — PURE. REPLACES the value in place when the section exists, which is deliberate and is
// NOT a breach of the no-clobber rule: that rule protects AUTHORED DNA from a model re-emission, and
// this is a scalar the user set in the GUI. Every other writer here appends and refuses.
export function setAllowUpdate(content, allowed) {
    const base = String(content || '').trim();
    const value = allowed ? 'true' : 'false';
    const bounds = sectionBodyBounds(base, 'AllowUpdate');
    if (!bounds) return { changed: true, content: [base, '[AllowUpdate]', value].join('\n') };
    if (base.slice(bounds.start, bounds.end).trim().toLowerCase() === value) return { changed: false, content: base };
    return { changed: true, content: spliceSectionBody(base, bounds, value) };
}

// Swap one section BODY for new text, leaving every neighbour byte-identical. PURE.
function spliceSectionBody(text, bounds, body) {
    const head = text.slice(0, bounds.start).replace(/[ \t\r\n]+$/, '');
    const tail = text.slice(bounds.end).replace(/^[ \t\r\n]+/, '');
    return (tail ? [head, body, tail] : [head, body]).join('\n');
}

// Replace the clothes of ONE outfit — PURE, and the only writer here that overwrites appearance.
// `variant` '' or 'default' targets [Clothes]; anything else targets [Clothes:<variant>]. A section
// that does not exist is NOT created: this path exists to correct clothes already on file, and
// adding a new variant is appendClothesVariant's job with its own no-clobber rule.
// [Body] is never touched by this or any other part of the update path.
export function replaceClothesInContent(content, variant, clothesText) {
    const base = String(content || '').trim();
    const text = String(clothesText || '').trim();
    const v = String(variant || '').trim().toLowerCase();
    if (!text) return { changed: false, content: base, reason: 'empty clothes' };
    const label = (!v || v === 'default') ? 'Clothes' : `Clothes:${v}`;
    const bounds = sectionBodyBounds(base, label);
    if (!bounds) return { changed: false, content: base, reason: `no [${label}] section to replace` };
    if (base.slice(bounds.start, bounds.end).trim() === text) return { changed: false, content: base, reason: 'identical' };
    return { changed: true, content: spliceSectionBody(base, bounds, text) };
}

// Do two names differ ONLY by a trailing name part — "Nanami" against "Nanami Kujou"? PURE.
//
// THE SHAPE THAT SPLITS ONE CHARACTER ACROSS TWO ENTRIES. Both contracts tell the model to spell a
// name the way the story spells it, and prose shortens names freely, so one reply can register
// "Nanami Kujou" and draw `<pic char="Nanami">`. Neither resolves to the other,
// nothing links them, and which spelling wins FLIPS between replies (measured 2026-09-19: one
// generation used the short form in both tags, the next registered long and drew short and the
// character vanished from her own "2girls" render).
//
// SPACED NAMES ONLY, deliberately. A CJK full name is written unspaced (来栖遥香) so it has no first
// token, and a prefix test over two-character kanji given names would fire on ordinary unrelated
// pairs. That case is left for its own decision rather than folded in silently here.
// Case-insensitive, matching every other key comparison in this file.
export function namesNearMiss(a, b) {
    const x = String(a || '').trim().toLowerCase();
    const y = String(b || '').trim().toLowerCase();
    if (!x || !y || x === y) return false;
    const firstToken = (s) => (s.includes(' ') ? s.slice(0, s.indexOf(' ')) : '');
    return firstToken(x) === y || firstToken(y) === x;
}

// WHICH pairs are a split — PURE, so the decision is testable even though the caller is not.
//
// `name` is what a registration just stored. `drawnNames` are the char=/char2= of every <pic> in
// the SAME reply; `entries` is the registry as [{ key, content }]. Returns [{ other, where }], the
// pairs worth reporting, with `where` naming which arm found it so the message can say so.
// The caller still has to rule out a pair an [Alias] already links — that needs a lookup, and this
// file does no I/O.
export function findNameSplits(name, { drawnNames = [], entries = [] } = {}) {
    const found = [];
    const seen = new Set();
    const push = (other, where) => {
        const lc = String(other || '').trim().toLowerCase();
        if (!lc || seen.has(lc)) return;
        seen.add(lc);
        found.push({ other, where });
    };
    for (const drawn of (Array.isArray(drawnNames) ? drawnNames : [])) {
        if (namesNearMiss(name, drawn)) push(drawn, 'drawn by a <pic> in this same reply');
    }
    for (const entry of (Array.isArray(entries) ? entries : [])) {
        if (!entry) continue;
        // HER OWN ENTRY IS NEVER A SPLIT. Every School heroine is keyed by her given name and carries
        // her full name as an [Alias], so "Mitsuki" is a near-miss of her own "Mitsuki Tachibana" and
        // the registry arm would report all 21 of them against themselves. An entry that already
        // ANSWERS TO this name is the same character by definition — that is what an alias means.
        // (Found by running this against the live registry, not by a fixture.)
        if (entryAnswersTo(entry.key, entry.content, name)) continue;
        const viaKey = namesNearMiss(name, entry.key);
        const viaAlias = listAliases(entry.content).some((a) => namesNearMiss(name, a));
        if (viaKey || viaAlias) push(entry.key, 'already a registry entry');
    }
    return found;
}

// NAMES NO REGISTRATION CARRIES — PURE. `names` are the names to check — the char=/char2= of every <pic> in one
// reply, or the newcomers the registration call was asked to register — and `registeredNames` the names its
// registrations carry. Returns the names, as written and once each, that no registration carries
// (case-insensitive, like every key comparison here). A name a registration spells differently is left out:
// findNameSplits reports that pair, and one cause gets one line.
export function namesWithoutRegistration(names, registeredNames) {
    const registered = (Array.isArray(registeredNames) ? registeredNames : []).map((n) => String(n || '').trim()).filter(Boolean);
    const registeredLc = new Set(registered.map((n) => n.toLowerCase()));
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(names) ? names : [])) {
        const name = String(raw || '').trim();
        const lc = name.toLowerCase();
        if (!name || seen.has(lc)) continue;
        seen.add(lc);
        if (registeredLc.has(lc)) continue;
        if (registered.some((r) => namesNearMiss(r, name))) continue;
        out.push(name);
    }
    return out;
}

// Append alias(es) to an entry's content — PURE. Skips ones already present (including the
// entry's OWN key, which would be a self-reference the resolver would never reach) and returns
// { changed:false } when nothing new was added, mirroring appendClothesVariant.
export function appendAliases(content, entryKey, aliases) {
    const base = String(content || '').trim();
    const ownLc = String(entryKey || '').trim().toLowerCase();
    const known = new Set(listAliases(base).map((a) => a.toLowerCase()));
    const added = [];
    for (const raw of (Array.isArray(aliases) ? aliases : [aliases])) {
        const alias = String(raw || '').trim();
        const lc = alias.toLowerCase();
        if (!alias || lc === ownLc || known.has(lc)) continue;
        known.add(lc);
        added.push(alias);
    }
    if (!added.length) return { changed: false, content: base, added: [] };
    return { changed: true, content: `${base}\n[Alias]\n${added.join('\n')}`, added };
}

// The [Bust] multiplier for one entry — the strength handed to the backend's bust LoRA,
// which SCALES whatever cup size the appearance text already asserts (verified 2026-08-01: the
// same "C cup" prompt at strength 1 vs 5 renders modest vs enormous).
// PURE: returns { value, warnings[] } — `null` value means "this entry declares no bust", which
// the caller reads as "send the neutral default", never as an error. A present-but-unparseable
// section IS surfaced, because a typo silently falling back would be indistinguishable from a
// deliberate omission.
export function parseBustMultiplier(key, content) {
    const warnings = [];
    const raw = parseDnaSections(content).bust;
    if (!raw) return { value: null, warnings };
    const value = Number(raw.split(/\s+/)[0]);
    if (!Number.isFinite(value) || value < 0) {
        warnings.push(`"${key}" has an unreadable [Bust] value ("${raw.slice(0, 30)}") — using the default multiplier`);
        return { value: null, warnings };
    }
    return { value, warnings };
}

// Variant names for the roster badges ('default' first when present).
export function listOutfitVariants(content) {
    const sections = parseDnaSections(content);
    const names = [];
    if (sections.clothes.default) names.push('default');
    for (const k of Object.keys(sections.clothes)) if (k !== 'default') names.push(k);
    return names;
}

// ── outfit= vocabulary ────────────────────────────────────────────────
// Every <pic> slot names what that person wears in the shot, picked from a list: a choice on her ON FILE line (her
// outfits on file, and "same-as-last-picture" while the worn-outfit store holds what she wore), "newclothes" or
// "undressed".
// `newclothes` says the story put her in clothes that are none of her outfits on file: a one-off, written as
// clothes= on her <cast> record that reply. It is NEVER a claim that she has nothing on file: the narrator cannot see
// the registry. The worn-outfit store keeps it (nextWornOutfit) until a picture names other clothes for her. The
// registry keeps it only as a character's first clothes — her [Clothes] when she has none on file
// (registrationClothesTarget).
export const OUTFIT_NEW_CLOTHES = 'newclothes';
// `same-as-last-picture` says she wears what her last picture showed: an outfit she has on file, or a one-off. Her ON
// FILE line offers it while the worn-outfit store holds either for her, with what it draws after her name, so the
// narrator reads what she wears instead of remembering it, and a one-off is described once and picked after that. The
// main character takes it in mainchar= the same way. The value names the relation, never a kind of clothes, and its
// unit is her last picture, because that is what the store holds.
export const OUTFIT_SAME_AS_LAST_PICTURE = 'same-as-last-picture';
// `undressed` says the shot shows her without her clothes: none are attached, and the composition says what is
// bared. A state of the shot, never a change of clothes: the worn-outfit store keeps what she wore. Never "none" —
// models read "none" as nobody or no outfit.
export const OUTFIT_UNDRESSED = 'undressed';

// What a slot that selects no clothes said — the start of its warning. PURE.
function slipOf(want) {
    if (!want) return 'was drawn with no outfit= (every picture names one)';
    if (want === OUTFIT_NEW_CLOTHES) return `said "${OUTFIT_NEW_CLOTHES}" but her <cast> record carries no clothes=`;
    if (want === OUTFIT_SAME_AS_LAST_PICTURE) return `said "${OUTFIT_SAME_AS_LAST_PICTURE}"`;
    if (want === 'default') return 'said "default", which she does not have';
    return `has no [Clothes:${want}] on file`;
}

// The clothes one outfit= value selects — PURE, and the one decision every reader shares.
// `replyClothes` / `replyOutfit` are the clothes= and outfit= of her <cast> record in the same reply
// ('' when the reply gives her none); `carried` is what the worn-outfit store holds for her as of this picture
// (wornOutfitOn: { outfit, clothes, lastPictureMessage }; null when it holds nothing); `shown` is, on a regen, her entry
// in the store saved with the picture's reply (shownForRegen; null on a first draw and whenever it does not apply).
//   "undressed"             no clothes: the shot shows her without them.
//   `shown`                 what the reply saved for her: an outfit she has on file, or her one-off. An outfit she
//                           no longer has falls through to the rules below.
//   an outfit on file       that outfit — "default" included, when she has one.
//   "newclothes"            this reply's clothes=.
//   "same-as-last-picture"  what the store holds for her: the outfit on file she wore, or her one-off.
//   a name not on file, defined by her record this reply (the same outfit= key, with clothes=) ⇒ the record's
//                           clothes.
//   anything else is a SLIP — outfit= left out, a name she does not have ("none" among them), a "default" she does
//                           not have, a "newclothes" with no clothes=, a "same-as-last-picture" while the store
//                           holds nothing she can be drawn in: she is drawn in what the store holds for her, else
//                           with no clothes described, and the warning names the slip.
// This reply's own record never answers a slip: a picture drawn mid-stream, before the records exist, must come out
// the same as one drawn after them.
// Returns { clothes, clothesSource, wornEntry, warning }: `clothesSource` is where the clothes came from — 'stored'
// (the outfit the slot named), 'reply' (her record this reply), 'carried' (the store as the picture sees it), 'saved'
// (the store saved with the reply, `shown`), or '' when she wears nothing described; `wornEntry` is the store entry
// carried or saved clothes came from, { outfit, lastPictureMessage } with outfit '' for a one-off, else null.
// `warning` is the caller's to log. hasOwnProperty, not a bare index: sections.clothes is a plain object, so
// outfit="constructor" would otherwise return a function off the prototype and stringify it.
export function selectClothesForOutfit(sections, outfit, { replyClothes = '', replyOutfit = '', carried = null, shown = null } = {}) {
    const want = String(outfit || '').trim().toLowerCase();
    const all = (sections && sections.clothes) || {};
    const onFile = (name) => !!name && Object.prototype.hasOwnProperty.call(all, name) && !!all[name];
    const fromReply = String(replyClothes || '').trim();
    const result = (clothes, source, warning = '', wornEntry = null) => ({ clothes, clothesSource: clothes ? source : '', wornEntry, warning });
    const entryOf = (held, name) => ({ outfit: name, lastPictureMessage: held.lastPictureMessage ?? null });
    if (want === OUTFIT_UNDRESSED) return result('', '');
    if (shown) {
        const shownOutfit = String(shown.outfit || '').trim().toLowerCase();
        const shownClothes = String(shown.clothes || '').trim();
        if (onFile(shownOutfit)) return result(all[shownOutfit], 'saved', '', entryOf(shown, shownOutfit));
        if (shownOutfit === OUTFIT_NEW_CLOTHES && shownClothes) return result(shownClothes, 'saved', '', entryOf(shown, ''));
    }
    if (want === OUTFIT_NEW_CLOTHES && fromReply) return result(fromReply, 'reply');
    if (onFile(want)) return result(all[want], 'stored');
    const carriedOutfit = carried ? String(carried.outfit || '').trim().toLowerCase() : '';
    const carriedClothes = carried ? String(carried.clothes || '').trim() : '';
    const wearsOneOff = carriedOutfit === OUTFIT_NEW_CLOTHES && !!carriedClothes;
    const from = (name) => entryOf(carried, name);
    if (want === OUTFIT_SAME_AS_LAST_PICTURE && onFile(carriedOutfit)) return result(all[carriedOutfit], 'carried', '', from(carriedOutfit));
    if (want === OUTFIT_SAME_AS_LAST_PICTURE && wearsOneOff) return result(carriedClothes, 'carried', '', from(''));
    if (want && want !== OUTFIT_NEW_CLOTHES && want !== OUTFIT_SAME_AS_LAST_PICTURE && fromReply
        && String(replyOutfit || '').trim().toLowerCase() === want) return result(fromReply, 'reply');
    const slip = slipOf(want);
    const sectionLabel = (name) => (name === 'default' ? '[Clothes]' : `[Clothes:${name}]`);
    if (onFile(carriedOutfit)) return result(all[carriedOutfit], 'carried', `${slip} — drawn in what she last wore (${sectionLabel(carriedOutfit)})`, from(carriedOutfit));
    if (wearsOneOff) return result(carriedClothes, 'carried', `${slip} — drawn in what she last wore (her one-off)`, from(''));
    return result('', '', `${slip}, and nothing is stored for her — drawn with no clothes described`);
}

// ── one drawn person's look ───────────────────────────────────────────────────
// Does a name written in a picture or a record mean her — the name she is drawn under now, or any name her
// registry entry answers to? PURE. `entry` is her resolved entry or null.
function namesHer(written, name, entry) {
    const w = String(written || '').trim();
    if (!w) return false;
    if (w.toLowerCase() === String(name || '').trim().toLowerCase()) return true;
    return !!entry && entryAnswersTo(entry.key, entry.content, w);
}

// Her <cast> record in one reply, PURE: every record whose name is hers (namesHer) merged, the first non-empty
// value of each attribute winning. The narrator is asked for one record per character, so the merge only
// matters when it wrote two. Returns { name, attributes } or null when the reply carries none for her.
export function replyRecordOf(records, name, entry = null) {
    if (!String(name || '').trim()) return null;
    const mine = (Array.isArray(records) ? records : []).filter((record) => namesHer(record && record.name, name, entry));
    if (!mine.length) return null;
    const attributes = {};
    for (const record of mine) {
        for (const [key, value] of Object.entries(record.attributes || {})) {
            if (!String(attributes[key] || '').trim() && String(value || '').trim()) attributes[key] = value;
        }
    }
    return { name: mine[0].name, attributes };
}

// ── what each character wears now: the worn-outfit store ─────────────────────
// The store is one entry per character, keyed by her registry entry's key (the name as written when she has
// none), so a character called by an alias never splits in two: { [key]: { outfit, clothes, last_picture_message } }.
//   outfit                an outfit she has on file, or "newclothes": a one-off
//   clothes               the one-off's garments; '' for an outfit on file
//   last_picture_message  the message index of the reply whose picture last drew her, which the streetcleaner ages
//                         her entry by (wornOutfitCleaningMission)
// Every reply's state holds the store as that reply leaves it: the state before the reply, carried through
// nextWornOutfit with the reply's own pictures (wornReportsOf). The host keeps it in the card's state, as the
// WORN_OUTFIT_PART part of mvu-helper's own root.
export const WORN_OUTFIT_PART = 'worn_outfit';
export const LAST_PICTURE_MESSAGE = 'last_picture_message';
const isPlainRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isSameKey = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isMessageIndex = (value) => Number.isInteger(value) && value >= 0;
const withStamp = (entry, stamp) => (isMessageIndex(stamp) ? { ...entry, [LAST_PICTURE_MESSAGE]: stamp } : entry);
// The key the store holds her under: `key` itself, else the one equal to it without regard to case.
const heldKeyOf = (worn, key) => (Object.prototype.hasOwnProperty.call(worn, key) ? key : Object.keys(worn).find((k) => isSameKey(k, key)));

// What one reply's pictures say about each person they draw, in text order — PURE. `people` are its <pic> people
// ([{ name, outfit }], imagegen drawnPeopleOf), `records` its <cast> records, `entries` the registry as a list
// ([{ key, content }]). Every person drawn gives one report, read off the clothes her picture is drawn in — the
// decision her look takes (selectClothesForOutfit), so the store keeps what the picture showed:
//   an outfit she has on file ("default" included)                        → { key, outfit, clothes: '' }
//   her record's clothes= in this reply (a one-off, or a newcomer's look)  → { key, outfit: "newclothes", clothes }
//   anything else — "undressed", "same-as-last-picture", a slip: she is drawn in what the store holds, or in no
//   clothes, so what she wears does not change                             → { key, outfit: '', clothes: '' }
export function wornReportsOf(people, records, entries) {
    const reports = [];
    for (const person of Array.isArray(people) ? people : []) {
        const name = String((person && person.name) || '').trim();
        if (!name) continue;
        const outfit = String(person.outfit || '').trim().toLowerCase();
        const { entry } = pickCharEntry(entries, name);
        const key = entry ? entry.key : name;
        const attributes = (replyRecordOf(records, name, entry) || {}).attributes || {};
        const replyClothes = String(attributes.clothes || '').trim();
        if (entry && hasStoredAppearance(entry.content)) {
            const picked = selectClothesForOutfit(parseDnaSections(entry.content), outfit, { replyClothes, replyOutfit: String(attributes.outfit || '') });
            if (picked.clothesSource === 'stored') reports.push({ key, outfit, clothes: '' });
            else if (picked.clothesSource === 'reply') reports.push({ key, outfit: OUTFIT_NEW_CLOTHES, clothes: picked.clothes });
            else reports.push({ key, outfit: '', clothes: '' });
            continue;
        }
        // A look from her record, or none (chooseLook): the record's clothes=, unless the shot undresses her.
        if (outfit !== OUTFIT_UNDRESSED && replyClothes) reports.push({ key, outfit: OUTFIT_NEW_CLOTHES, clothes: replyClothes });
        else reports.push({ key, outfit: '', clothes: '' });
    }
    return reports;
}

// The clothes each character's pictures in one reply drew as a one-off — PURE: for every key `reports` (wornReportsOf)
// draws in "newclothes", the clothes of her last such report. [{ key, clothes }], each key once.
export function drawnOneOffClothesOf(reports) {
    const byKey = new Map();
    for (const report of Array.isArray(reports) ? reports : []) {
        const key = String((report && report.key) || '').trim();
        const clothes = String((report && report.clothes) || '').trim();
        if (!key || report.outfit !== OUTFIT_NEW_CLOTHES || !clothes) continue;
        byKey.set(key.toLowerCase(), { key, clothes });
    }
    return [...byKey.values()];
}

// What a picture of hers drew her in as a one-off this reply (drawnOneOffClothesOf's list) — PURE: matched by her
// entry's key or an alias when she has an entry, and by the name a record wrote her under, without regard to case.
// '' when no picture of hers did.
export function drawnClothesFor(drawn, entry, name) {
    const written = String(name || '').trim();
    const found = (Array.isArray(drawn) ? drawn : [])
        .find((d) => (!!entry && entryAnswersTo(entry.key, entry.content, d.key)) || (!!written && isSameKey(d.key, written)));
    return found ? found.clothes : '';
}

// The store after one reply — PURE. `previous` is the store the reply starts from (the state before it), `reports`
// the reply's own (wornReportsOf), in text order, and `replyIndex` the reply's message index. An entry no report
// touches is carried as it was. A report with an outfit replaces her entry, the last one winning; every report
// stamps her entry with `replyIndex`, the message of her last picture. A report without an outfit never creates an
// entry: she wears what the store holds, and with nothing held there is nothing to stamp.
export function nextWornOutfit(previous, { reports = [], replyIndex = null } = {}) {
    const next = {};
    for (const [key, worn] of Object.entries(isPlainRecord(previous) ? previous : {})) {
        if (key === '__proto__' || !isPlainRecord(worn)) continue;
        const outfit = String(worn.outfit || '').trim().toLowerCase();
        if (!outfit) continue;
        next[key] = withStamp({ outfit, clothes: String(worn.clothes || '').trim() }, worn[LAST_PICTURE_MESSAGE]);
    }
    for (const report of Array.isArray(reports) ? reports : []) {
        const key = String((report && report.key) || '').trim();
        if (!key || key === '__proto__') continue;
        const outfit = String(report.outfit || '').trim().toLowerCase();
        if (!outfit) {
            const held = heldKeyOf(next, key);
            if (held !== undefined) next[held] = withStamp(next[held], replyIndex);
            continue;
        }
        for (const held of Object.keys(next)) if (held !== key && isSameKey(held, key)) delete next[held];
        next[key] = withStamp({ outfit, clothes: String(report.clothes || '').trim() }, replyIndex);
    }
    return next;
}

// What the store holds for her — PURE: her entry in `worn`, the store as the picture sees it (nextWornOutfit from the
// state before its reply, with the reply's pictures ahead of it), matched by her entry's key without regard to case,
// as every registry key is. { outfit, clothes, lastPictureMessage } (lastPictureMessage null when the entry carries
// no stamp), or null when the store holds nothing for her.
export function wornOutfitOn(worn, key) {
    const want = String(key || '').trim();
    if (!want || !isPlainRecord(worn)) return null;
    const held = heldKeyOf(worn, want);
    const entry = held !== undefined ? worn[held] : null;
    if (!isPlainRecord(entry)) return null;
    const outfit = String(entry.outfit || '').trim().toLowerCase();
    if (!outfit) return null;
    const stamp = entry[LAST_PICTURE_MESSAGE];
    return { outfit, clothes: String(entry.clothes || '').trim(), lastPictureMessage: isMessageIndex(stamp) ? stamp : null };
}

// What each character's last picture showed, as the store holds it — PURE: [{ key, outfit, clothes }], one per entry
// that can be drawn again: an outfit she has on file by name (clothes ''), or "newclothes" with her one-off's clothes.
// These are the characters "same-as-last-picture" is offered for, the main character among them (reply-cast-core
// lastPictureWearOf says what each one's offer draws).
export function lastPictureOutfitsIn(worn) {
    if (!isPlainRecord(worn)) return [];
    return Object.keys(worn)
        .map((key) => ({ key, held: wornOutfitOn(worn, key) }))
        .filter(({ held }) => !!held && (held.outfit !== OUTFIT_NEW_CLOTHES || !!held.clothes))
        .map(({ key, held }) => ({ key, outfit: held.outfit, clothes: held.outfit === OUTFIT_NEW_CLOTHES ? held.clothes : '' }));
}

// ── edits of the worn-outfit store (plans/reply-cast.md §11) ─────────────────
// An edit changes one character's entry from outside a reply's pictures. Three kinds:
//   wornOutfitSet         "Wearing now" (D38): she wears an outfit on file, by name, or one-off clothes. Her entry keeps
//                         its stamp; an entry made where she had none, or had one with no stamp, takes `newStamp`.
//   wornOutfitCleared     "Wearing now" (D38), nothing recorded: her entry is removed.
//   wornOutfitKeptByName  the harvest saved clothes from the reply into her record (D37): her entry, while it is the
//                         one-off holding exactly those clothes, becomes that outfit by name, its stamp kept. `names` are
//                         every name the store may hold her under — her entry's key, her aliases, the name the record
//                         wrote — because a picture drawn before she was registered keyed her by the name it drew.
// Applying an edit the store already holds changes nothing, so one reply's edits can be applied to every copy of its
// state, whichever copy already has some of them.
export const wornOutfitSet = (key, outfit, clothes, newStamp) => ({ op: 'set', key, outfit, clothes, newStamp });
export const wornOutfitCleared = (key) => ({ op: 'clear', key });
export const wornOutfitKeptByName = (names, outfit, clothes) => ({ op: 'kept', names, outfit, clothes });

// Clothes as one line: the store prints them on one line, and the harvest's copy and the picture's may differ in spacing.
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// The store with `edits` applied in order — PURE; `worn` itself is not touched.
export function applyWornOutfitEdits(worn, edits) {
    const next = { ...(isPlainRecord(worn) ? worn : {}) };
    for (const edit of Array.isArray(edits) ? edits : []) {
        if (!isPlainRecord(edit)) continue;
        if (edit.op === 'kept') {
            nameKeptOutfit(next, edit);
            continue;
        }
        const key = String(edit.key || '').trim();
        if (!key || key === '__proto__') continue;
        const held = heldKeyOf(next, key);
        if (edit.op === 'clear') {
            if (held !== undefined) delete next[held];
            continue;
        }
        if (edit.op !== 'set') continue;
        const outfit = String(edit.outfit || '').trim().toLowerCase();
        const clothes = outfit === OUTFIT_NEW_CLOTHES ? oneLine(edit.clothes) : '';
        if (!outfit || (outfit === OUTFIT_NEW_CLOTHES && !clothes)) continue;
        const heldStamp = held !== undefined && isPlainRecord(next[held]) ? next[held][LAST_PICTURE_MESSAGE] : undefined;
        next[held !== undefined ? held : key] = withStamp({ outfit, clothes }, isMessageIndex(heldStamp) ? heldStamp : edit.newStamp);
    }
    return next;
}

// The keys of `worn` a kept outfit's `names` hold her under, in the store's order.
function keysNamedBy(worn, edit) {
    const names = (Array.isArray(edit.names) ? edit.names : []).map((name) => String(name || '').trim()).filter(Boolean);
    return Object.keys(worn).filter((key) => key !== '__proto__' && names.some((name) => isSameKey(name, key)));
}

const isOneOffEntry = (entry) => isPlainRecord(entry) && String(entry.outfit || '').trim().toLowerCase() === OUTFIT_NEW_CLOTHES;

// wornOutfitKeptByName applied to `worn` in place (applyWornOutfitEdits hands it its own copy).
function nameKeptOutfit(worn, edit) {
    const outfit = String(edit.outfit || '').trim().toLowerCase();
    const clothes = oneLine(edit.clothes);
    if (!outfit || outfit === OUTFIT_NEW_CLOTHES || !clothes) return;
    for (const key of keysNamedBy(worn, edit)) {
        const entry = worn[key];
        if (!isOneOffEntry(entry) || oneLine(entry.clothes) !== clothes) continue;
        worn[key] = withStamp({ outfit, clothes: '' }, entry[LAST_PICTURE_MESSAGE]);
    }
}

// What a kept outfit (wornOutfitKeptByName) finds in `worn`, for the harvest's log — PURE. { finding, held }:
//   'held'           her entry is the one-off holding exactly its clothes, which the edit holds by the outfit's name
//   'other-clothes'  her entry is a one-off with other clothes (`held`), which the edit leaves a one-off
//   'outfit'         her entry names an outfit (`held`), which the edit leaves
//   'none'           the store holds nothing for her
export function keptOutfitFinding(worn, edit) {
    const store = isPlainRecord(worn) ? worn : {};
    const kept = isPlainRecord(edit) ? edit : {};
    const entries = keysNamedBy(store, kept).map((key) => store[key]).filter((entry) => isPlainRecord(entry) && String(entry.outfit || '').trim());
    if (!entries.length) return { finding: 'none', held: '' };
    const clothes = oneLine(kept.clothes);
    if (entries.some((entry) => isOneOffEntry(entry) && oneLine(entry.clothes) === clothes)) return { finding: 'held', held: clothes };
    const [first] = entries;
    return isOneOffEntry(first)
        ? { finding: 'other-clothes', held: oneLine(first.clothes) }
        : { finding: 'outfit', held: String(first.outfit).trim().toLowerCase() };
}

// The messages a "Wearing now" edit is written into (D38) — PURE: every message holding a saved state from her last
// picture's message on, and every message a new generation can start from. `stateIndices` are the messages holding a
// saved state; `lastPictureMessage` is her entry's stamp in the newest state (null when the store holds nothing for
// her); `generationFloors` are the messages a new generation can start from (shared/generation-floor.js). Ascending,
// each once.
export function wornOutfitEditTargets({ stateIndices = [], lastPictureMessage = null, generationFloors = [] } = {}) {
    const targets = new Set((Array.isArray(generationFloors) ? generationFloors : []).filter(isMessageIndex));
    if (isMessageIndex(lastPictureMessage)) {
        for (const index of Array.isArray(stateIndices) ? stateIndices : []) {
            if (isMessageIndex(index) && index >= lastPictureMessage) targets.add(index);
        }
    }
    return [...targets].sort((a, b) => a - b);
}

// What a regen draws her in from the store saved with her picture's reply (D39) — PURE: her entry in `saved` when it is
// stamped with that reply (`replyIndex`) and the picture is her last in the reply (`isLastPicture`); null otherwise,
// and the picture follows the rule a first draw does.
export function shownForRegen(saved, key, { replyIndex = null, isLastPicture = false } = {}) {
    if (!isLastPicture || !isMessageIndex(replyIndex)) return null;
    const held = wornOutfitOn(saved, key);
    return held && held.lastPictureMessage === replyIndex ? held : null;
}

// Does "Wearing now" say what her entry already holds? PURE. `value` is { outfit, clothes } or null (nothing recorded);
// `held` is what wornOutfitOn returns.
export function isSameWear(value, held) {
    if (!value || !held) return !value && !held;
    const outfit = String(value.outfit || '').trim().toLowerCase();
    if (outfit !== String(held.outfit || '').trim().toLowerCase()) return false;
    return outfit !== OUTFIT_NEW_CLOTHES || oneLine(value.clothes) === oneLine(held.clothes);
}

// The editor's "Wearing now" line read back (D38) — PURE. `fields` = { wearing, oneOffClothes }: `wearing` is an outfit
// name, "newclothes" for one-off clothes, or '' for nothing recorded; `outfits` are her outfit names as the same dialog
// saves them; `held` is her entry as wornOutfitOn returns it. Returns { value, problems, isChanged }: `value` is
// { outfit, clothes } (clothes '' for an outfit on file) or null; a line that says what she holds is unchanged and never
// checked, so an entry naming an outfit she has since lost stays as it is until the line is changed.
export function wearingNowFromEditorFields(fields, outfits, held = null) {
    const wearing = String((fields && fields.wearing) || '').trim().toLowerCase();
    const typed = !wearing ? null : { outfit: wearing, clothes: wearing === OUTFIT_NEW_CLOTHES ? oneLine(fields.oneOffClothes) : '' };
    if (isSameWear(typed, held)) return { value: typed, problems: [], isChanged: false };
    if (!typed) return { value: null, problems: [], isChanged: true };
    if (typed.outfit === OUTFIT_NEW_CLOTHES) {
        return typed.clothes
            ? { value: typed, problems: [], isChanged: true }
            : { value: null, problems: ['Wearing now: write the one-off clothes in the box, or pick an outfit.'], isChanged: true };
    }
    const names = (Array.isArray(outfits) ? outfits : []).map((name) => String(name || '').trim().toLowerCase());
    if (!names.includes(typed.outfit)) {
        return { value: null, problems: [`Wearing now: "${typed.outfit}" is not one of this character's outfits — pick one on file, or one-off clothes.`], isChanged: true };
    }
    return { value: typed, problems: [], isChanged: true };
}

// The outfits "Wearing now" offers — PURE. `outfitNames` are the names the editor's pairs hold right now (Add outfit, ×
// and typing change them), each listed once, trimmed and lowercased as Save writes them. The outfit `held` names is
// listed too when she no longer has it, so the line still shows what is held. "Nothing recorded" and one-off clothes are
// the line's own choices, not listed here.
export function wearingNowChoices(outfitNames, held = null) {
    const choices = [];
    for (const raw of Array.isArray(outfitNames) ? outfitNames : []) {
        const name = String(raw || '').trim().toLowerCase();
        if (name && !choices.includes(name)) choices.push(name);
    }
    const heldOutfit = held ? String(held.outfit || '').trim().toLowerCase() : '';
    if (heldOutfit && heldOutfit !== OUTFIT_NEW_CLOTHES && !choices.includes(heldOutfit)) choices.push(heldOutfit);
    return choices;
}

// What "Wearing now" shows after its choices change — PURE. The pick stays while it is still offered; an outfit that
// left the list (removed with ×, or renamed) gives way to what `held` says she wears, or to nothing recorded.
export function wearingNowSelection(current, choices, held = null) {
    const pick = String(current || '');
    if (!pick || pick === OUTFIT_NEW_CLOTHES || (Array.isArray(choices) && choices.includes(pick))) return pick;
    return held ? String(held.outfit || '').trim().toLowerCase() : '';
}

// How many replies an entry is kept after her last picture. Without a story day nothing else removes an entry, so the
// store would keep everyone ever drawn in the chat (plans/reply-cast.md R11).
export const WORN_OUTFIT_KEEP_REPLIES = 100;

// The streetcleaner's mission over the worn-outfit store (plans/executed/streetcleaner.md §6) — PURE. An entry stays while her
// last picture is no more than WORN_OUTFIT_KEEP_REPLIES replies back (`clock.repliesSince`, the streetcleaner's reply
// clock); an older one is dropped, and so is one with no stamp, which says why once per chat: the card's schema strips
// the field, or the chat was played before every picture stamped what it drew. A dropped entry takes
// "same-as-last-picture" off her ON FILE line, so her next picture names an outfit on file or describes her clothes
// again. Only removes: what it keeps is kept as it was.
export const wornOutfitCleaningMission = {
    name: 'worn-outfit store',
    part: WORN_OUTFIT_PART,
    sweep(worn, clock) {
        const kept = {};
        const dropped = [];
        let isAnyUnstamped = false;
        for (const [key, entry] of Object.entries(isPlainRecord(worn) ? worn : {})) {
            if (key === '__proto__') continue;
            const stamp = isPlainRecord(entry) ? entry[LAST_PICTURE_MESSAGE] : undefined;
            if (!isMessageIndex(stamp)) {
                isAnyUnstamped = true;
                dropped.push({ key, why: 'no stamp' });
                continue;
            }
            const age = clock.repliesSince(stamp);
            if (age > WORN_OUTFIT_KEEP_REPLIES) {
                dropped.push({ key, why: `last picture msg ${stamp}, ${age} replies ago` });
                continue;
            }
            kept[key] = entry;
        }
        const warnings = isAnyUnstamped
            ? [`${WORN_OUTFIT_PART} entries arrive without ${LAST_PICTURE_MESSAGE}, and they are dropped — the card's Zod schema `
                + `strips the field (declare ${MVUHELPER_STAT_ROOT} open: z.record(z.string(), z.any())), or the chat was played `
                + 'before every picture stamped what it drew']
            : [];
        return { kept, dropped, warnings };
    },
};

// Where one person's look comes from — PURE, the first source that exists:
//   stored  her registry entry carries an appearance (a name-only placeholder does not);
//   reply   her <cast> record in the same reply carries body=;
//   none    neither: she is drawn from the scene alone, and the caller says so.
// `entry` is her resolved registry entry or null; `record` her replyRecordOf result or null.
export function lookSourceOf({ entry = null, record = null } = {}) {
    if (entry && hasStoredAppearance(entry.content)) return 'stored';
    if (record && String(((record.attributes || {}).body) || '').trim()) return 'reply';
    return 'none';
}

// lookSourceOf for a NAME, against the registry as a list ([{ key, content }]) and this reply's records.
export function lookSourceFor(name, entries, records) {
    const { entry } = pickCharEntry(entries, name);
    return lookSourceOf({ entry, record: replyRecordOf(records, name, entry) });
}

// Can one person's look in `outfit` be built BEFORE the reply's <cast> records exist? PURE. '' when it can;
// otherwise why it needs the reply — the caller then waits for the finished reply instead of drawing
// mid-stream. `entries` is the registry as a list ([{ key, content }]); `earlierSlots` are the slots of this
// reply's <pic> tags ahead of this one ([{ key, outfit }]). "same-as-last-picture" and a slip are drawn from the
// worn-outfit store (selectClothesForOutfit): the earlier replies are written already, but an earlier picture in
// THIS reply that drew her in "newclothes", or in a name her record may define, takes its clothes from this reply's
// records, which come after the story.
export function lookWaitsForReply({ name = '', outfit = '', entries = [], earlierSlots = [] } = {}) {
    const { entry } = pickCharEntry(entries, name);
    if (lookSourceOf({ entry }) !== 'stored') return 'has no stored look (unregistered, or a name-only placeholder awaiting a look or a merge)';
    const want = String(outfit || '').trim().toLowerCase();
    if (want === OUTFIT_UNDRESSED) return '';
    if (want === OUTFIT_NEW_CLOTHES) return `wears "${OUTFIT_NEW_CLOTHES}", whose clothes come from this reply's <cast> record`;
    const clothes = parseDnaSections(entry.content).clothes;
    const onFile = (o) => !!o && Object.prototype.hasOwnProperty.call(clothes, o) && !!clothes[o];
    if (onFile(want)) return '';
    if (want && !RESERVED_OUTFIT_NAMES.includes(want)) return `has no [Clothes:${want}] on file yet`;
    const dependsOnThisReply = (Array.isArray(earlierSlots) ? earlierSlots : []).some((slot) => {
        if (!slot || !namesHer(slot.key, name, entry)) return false;
        const earlier = String(slot.outfit || '').trim().toLowerCase();
        return earlier === OUTFIT_NEW_CLOTHES || (!!earlier && !RESERVED_OUTFIT_NAMES.includes(earlier) && !onFile(earlier));
    });
    return dependsOnThisReply ? "was drawn earlier in this reply in clothes this reply's <cast> records define" : '';
}

// Does a picture of `name` wait for a registration that runs AFTER the reply (a POST call storing looks)? PURE.
// Yes until a look of hers is STORED. A look in this reply's own record does not end the wait: the registration's
// look is the one kept, and drawing first from the reply's would make her first picture disagree with every later
// one. When the wait ends her look is chosen as always (chooseLook): the stored one, else the reply's record when
// nothing was stored. A reserved outfit word never waits — no registration is coming for it.
// `entries` is the registry as a list ([{ key, content }]).
export function lookWaitsForRegistration(name, entries) {
    const key = String(name || '').trim();
    if (!key || RESERVED_OUTFIT_NAMES.includes(key.toLowerCase())) return false;
    const { entry } = pickCharEntry(entries, key);
    return lookSourceOf({ entry }) !== 'stored';
}

// What one person in a picture looks like — PURE, from the source lookSourceOf picks. `carried` is what the
// worn-outfit store holds for her as of this picture (wornOutfitOn), which "same-as-last-picture" and a slip are
// drawn in, and `shown` what the store saved with the picture's reply holds for her on a regen (selectClothesForOutfit).
// Returns { source, body, clothes, clothesSource, wornEntry, bust, warnings }. `source` is where her look (her
// body) came from; `clothesSource` is where her clothes came from, which can differ — a stored look wearing this
// reply's one-off is 'stored' with clothes from the 'reply', and one wearing what the store holds has them 'carried'
// or 'saved' ('' = no clothes described; `wornEntry` as selectClothesForOutfit). `bust` is her [Bust] value, null when
// she declares none — a look from the reply never does.
export function chooseLook({ name = '', entry = null, record = null, outfit = '', carried = null, shown = null } = {}) {
    const warnings = [];
    const attributes = (record && record.attributes) || {};
    const read = (key) => String(attributes[key] == null ? '' : attributes[key]).trim();
    const source = lookSourceOf({ entry, record });
    if (source === 'stored') {
        const sections = parseDnaSections(entry.content);
        const { clothes, clothesSource, wornEntry, warning } = selectClothesForOutfit(sections, outfit, { replyClothes: read('clothes'), replyOutfit: read('outfit'), carried, shown });
        if (warning) warnings.push(`"${name}" ${warning}`);
        if (!sections.body) warnings.push(`"${name}" has clothes on file but no [Body] — drawn with her clothes only`);
        const bust = parseBustMultiplier(name, entry.content);
        warnings.push(...bust.warnings);
        return { source: 'stored', body: sections.body, clothes, clothesSource, wornEntry, bust: bust.value, warnings };
    }
    if (source === 'reply') {
        // A look from this reply's record: on a regen her one-off as the reply saved it, else its clothes=, else what the
        // store holds for her. She has no outfit on file, so a saved outfit name draws nothing here.
        const undressed = String(outfit || '').trim().toLowerCase() === OUTFIT_UNDRESSED;
        const saved = !undressed && shown && String(shown.outfit || '').trim().toLowerCase() === OUTFIT_NEW_CLOTHES ? String(shown.clothes || '').trim() : '';
        if (saved) return { source, body: read('body'), clothes: saved, clothesSource: 'saved', wornEntry: { outfit: '', lastPictureMessage: shown.lastPictureMessage ?? null }, bust: null, warnings };
        const own = undressed ? '' : read('clothes');
        const earlier = !undressed && !own && carried ? String(carried.clothes || '').trim() : '';
        const wornEntry = earlier ? { outfit: '', lastPictureMessage: carried.lastPictureMessage ?? null } : null;
        return { source, body: read('body'), clothes: own || earlier, clothesSource: own ? 'reply' : (earlier ? 'carried' : ''), wornEntry, bust: null, warnings };
    }
    return { source, body: '', clothes: '', clothesSource: '', wornEntry: null, bust: null, warnings };
}

// Words that never name an outfit or a character: the outfit= values, and "none", which models write for nobody
// (char="none"). An entry or an outfit under one of them could never be matched.
export const RESERVED_OUTFIT_NAMES = ['default', OUTFIT_UNDRESSED, OUTFIT_NEW_CLOTHES, OUTFIT_SAME_AS_LAST_PICTURE, 'none'];

// Append a clothes section to existing entry content — PURE: [Clothes] for "default", [Clothes:<variant>] for any
// other name. Never clobbers: an already-present variant returns { changed:false } (the roster
// Edit button is the explicit replace path, mirroring the char-entry no-clobber rule).
export function appendClothesVariant(content, variant, clothesText) {
    const base = String(content || '').trim();
    const v = String(variant || '').trim().toLowerCase();
    const text = String(clothesText || '').trim();
    if (!v || !text) return { changed: false, content: base, reason: 'empty variant/clothes' };
    const label = v === 'default' ? 'Clothes' : `Clothes:${v}`;
    const existing = parseDnaSections(base);
    if (Object.prototype.hasOwnProperty.call(existing.clothes, v)) {
        return { changed: false, content: base, reason: `[${label}] already registered` };
    }
    return { changed: true, content: `${base}\n[${label}]\n${text}` };
}

// Does this entry hold any clothes — [Clothes] or any [Clothes:<outfit>] with text? PURE. A newcomer has no entry,
// and an entry with only her [Body] holds none: both keep their first clothes (registrationClothesTarget).
export function hasClothesOnFile(content) {
    return Object.values(parseDnaSections(content).clothes).some((c) => String(c || '').trim());
}

// Does this entry hold her [Body] and no clothes? PURE. The next clothes a record gives her are then her first, and
// kept (registrationClothesTarget). A name-only placeholder holds no body: she still needs registering, body first.
export function hasBodyOnly(content) {
    return hasStoredAppearance(content) && !hasClothesOnFile(content);
}

// Compose a new character's entry content from her registration: [Body], plus her clothes under the
// section `variant` names — [Clothes] for "default", [Clothes:<name>] for a static outfit — and no
// clothes section at all when there were none to keep (`variant` '': she was shown undressed, or they were refused).
export function registrationToEntryContent({ body, clothes, variant }) {
    if (!clothes || !variant) return `[Body]\n${body}`;
    return `[Body]\n${body}\n[${variant === 'default' ? 'Clothes' : `Clothes:${variant}`}]\n${clothes}`;
}

// ── which clothes a model may save (plans/reply-cast.md §1.4) ─────────────────────────────────
// A character's FIRST clothes are always saved (D29): with none on file, the clothes a record gives her are kept,
// under a <place or role>-<outfit> name when they are static, else as her [Clothes]. After that only STATIC
// clothes are saved: clothes a place or role fixes, or the story presents as what she always wears, under a
// <place or role>-<outfit> name; anything else is a one-off. The name is all the narrator is ever shown of an
// outfit (the ON FILE list), so a saved name must say which clothes it is: lowercase latin words joined by "-"
// ("cafe-waitress", "police-uniform"). A bare word ("swimsuit", "casual") is refused — every swimsuit would match it.
// A reserved word is refused whatever its shape ("same-as-last-picture" has the shape of a saved name). The rule binds
// what a MODEL writes; an outfit a person adds in the Roster tab is named freely.
const STATIC_OUTFIT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
export function newOutfitNameProblem(outfit) {
    const name = String(outfit || '').trim().toLowerCase();
    if (RESERVED_OUTFIT_NAMES.includes(name)) return `outfit name "${name}" is an outfit= value, never the name of saved clothes`;
    if (STATIC_OUTFIT_NAME.test(name)) return '';
    return `outfit name "${name}" is not a <place or role>-<outfit> name ("cafe-waitress", "police-uniform") — a saved outfit's name must say which clothes it is`;
}

// Where the clothes= on one record are saved, by the outfit= beside them and by whether her entry holds clothes
// already (hasClothesOnFile) — PURE.
//   She holds none (a newcomer, or an entry with only her [Body]): her first clothes are always kept, under outfit=
//   when it is a static name, else as her [Clothes] ("default"). "newclothes" and "default" are the two values that
//   mean [Clothes]; any other outfit= that is no static name (missing, a bare word, a reserved word) keeps them there
//   too, and `notice` names it for the caller's warning — the record broke the outfit rules.
//   She holds some: only "default" or a static name is saved. A one-off ("newclothes") is not, and neither are clothes
//   whose outfit= is missing or no static name (`refusal`).
//   "undressed" beside clothes= contradicts itself: nothing is saved, either way.
// Returns { variant, clothes, refusal, notice }: `variant` 'default' or a static name when the clothes are saved, ''
// when they are not; `refusal` says why clothes a model wrote were NOT saved ('' for a one-off, which is the expected
// way to say "not saved").
export function registrationClothesTarget(clothes, outfit, { hasClothesOnFile = false } = {}) {
    const text = String(clothes || '').trim();
    const want = String(outfit || '').trim().toLowerCase();
    const notSaved = (refusal) => ({ variant: '', clothes: '', refusal, notice: '' });
    const saved = (variant, notice = '') => ({ variant, clothes: text, refusal: '', notice });
    if (!text) return notSaved('');
    if (want === OUTFIT_UNDRESSED) return notSaved(`clothes= with outfit="${OUTFIT_UNDRESSED}" — undressed wears nothing, so nothing is saved`);
    if (want === 'default') return saved('default');
    const isNewClothes = want === OUTFIT_NEW_CLOTHES;
    const problem = want && !isNewClothes ? newOutfitNameProblem(want) : '';
    if (want && !isNewClothes && !problem) return saved(want);
    if (!hasClothesOnFile) {
        if (isNewClothes) return saved('default');
        return saved('default', `${want ? problem : 'clothes= with no outfit='} — kept as her [Clothes], the first clothes she has on file`);
    }
    if (isNewClothes) return notSaved('');
    if (!want) return notSaved('clothes= with no outfit= — not saved (a saved outfit is a <place or role>-<outfit> name; a one-off is "newclothes")');
    return notSaved(`${problem} — clothes not saved`);
}

// ── what one cast record asks of the registry (plans/reply-cast.md §1.4) ──────────────────────
// PURE. A record is `{ name, attributes }` from cast-record-format-core.js; this file never sees how a
// record is written. Every kind carries the record's outfit= (lower-cased) and clothes= as written: where the
// clothes go depends on what her entry holds, which the caller resolves (registrationClothesTarget). The kinds:
//   char      body= present → register her: [Body], plus her first clothes (registrationClothesTarget). body=
//             decides the kind, whatever else the record carries.
//   outfit    no body=; clothes= with a named outfit= → add that outfit (a new name must be static:
//             `nameProblem`), or correct it under [AllowUpdate] when it is already on file.
//   clothes   no body=; clothes= with outfit= absent or "default" → correct her default clothes, under
//             [AllowUpdate].
//   oneoff    no body=; clothes= with outfit="newclothes" → what she wears in this reply's pictures. Stored only
//             as the first clothes of a character with none on file.
//   presence  neither body= nor clothes= → she is in the scene and there is nothing to register.
// A character with only her [Body] on file keeps the clothes of an outfit, clothes or oneoff record as her first
// clothes, the same as a registration (registrationClothesTarget with none on file).
// Returns { ok:true, kind, name, … } or { ok:false, name, error } for a record the registry refuses.
export function registrationFromCastRecord(record) {
    const name = String((record && record.name) || '').trim();
    const attributes = (record && record.attributes) || {};
    const read = (key) => String(attributes[key] == null ? '' : attributes[key]).trim();
    const body = read('body');
    const clothes = read('clothes');
    const outfit = read('outfit').toLowerCase();
    if (!name) return { ok: false, name, error: 'no name' };
    // A reserved outfit word as a name is junk in any reply: an entry keyed with one could never be
    // matched by a real character.
    if (RESERVED_OUTFIT_NAMES.includes(name.toLowerCase())) {
        return { ok: false, name, error: `"${name}" is an outfit= value, never a character name — an entry under it could never be matched` };
    }
    if (body) return { ok: true, kind: 'char', name, body, outfit, clothes };
    if (!clothes) return { ok: true, kind: 'presence', name };
    if (!outfit || outfit === 'default') return { ok: true, kind: 'clothes', name, outfit, clothes };
    if (outfit === OUTFIT_NEW_CLOTHES) return { ok: true, kind: 'oneoff', name, outfit, clothes };
    if (outfit === OUTFIT_UNDRESSED) {
        return { ok: false, name, error: `clothes= with outfit="${OUTFIT_UNDRESSED}" — undressed wears nothing, so there are no clothes to record` };
    }
    return { ok: true, kind: 'outfit', name, outfit, clothes, nameProblem: newOutfitNameProblem(outfit) };
}
