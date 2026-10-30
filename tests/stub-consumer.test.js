/**
 * MVU Helper — THE NEGATIVE TEST: run the platform against a consumer that is not School v4
 * (plans/platform-genre-blindness.md §5, acceptance item 3).
 *
 * This is the only acceptance item that can fail while the grep gate and School's own suite are both
 * green. Everything below drives real platform code with tests/stub-consumer-card.mjs — a salvage
 * hauler that shares no vocabulary with School — and asserts two things of every result:
 *   1. it is CORRECT for this card (its channels, its roots, its collection), and
 *   2. it contains none of School's vocabulary.
 *
 * (2) matters as much as (1). A platform that has silently re-learned one genre usually still produces
 * something for the other — it just produces the wrong thing, plausibly, in a way that reads as a bug
 * in the new card's own repo.
 */

import { describe, it, expect } from 'vitest';
import {
    STUB_STAT_DATA, STUB_CARD_CONFIG, STUB_ENGINE_DECLARED, STUB_PRESENCE_FIELD, SCHOOL_VOCABULARY,
} from './stub-consumer-card.mjs';
import { pendingIntentSummary } from '../src/features/logic-engine/turn-runner-core.js';
import { readEventContract } from '../src/features/logic-engine/logic-engine-core.js';
import { applyDataSync } from '../src/features/card-sync/card-sync-core.js';
import { normalizeCardConfig, installCardConfigSections, isFreshProfile } from '../src/features/card-config/card-config-core.js';
import { findCharacterCollection, allCharKeys, presentCharKeys } from '../src/features/character-roster/roster-scan-core.js';
import { sceneRosterText } from '../src/features/imagegen/prompt-assembly-core.js';
import { DEFAULT_PROMPT, SCENE_ROSTER_PROMPT, narrateRegistrationContract, readerRegistrationContract } from '../src/features/imagegen/default-template.js';
import { NAME_RULES } from '../src/features/character-roster/cast-record-format-core.js';
import { classifyReplyCast, onFileCast, namedKeysOf, replyCastInstruction } from '../src/features/character-roster/reply-cast-core.js';

// The registration contracts, for this card's own people: one registered captain who may change
// clothes, one registered pilot who may not, and one newcomer.
const STUB_ROSTER = [
    { key: 'Captain Vey', content: '[Body]\nb\n[Clothes]\ngrey coveralls\n[Clothes:flightsuit]\norange flightsuit\n[Alias]\nVey\n[AllowUpdate]\ntrue' },
    { key: 'Pilot Oro', content: '[Body]\nb\n[Clothes]\nleather jacket' },
];
const NARRATE_CONTRACT = narrateRegistrationContract({ isStoring: true });
const READER_FULL = readerRegistrationContract(classifyReplyCast(['Vey', 'Pilot Oro', 'Wren Hollis'], STUB_ROSTER));
const READER_SHORT = readerRegistrationContract(classifyReplyCast(['Pilot Oro'], STUB_ROSTER));
const READER_EMPTY = readerRegistrationContract(classifyReplyCast([], STUB_ROSTER));

const clone = (o) => JSON.parse(JSON.stringify(o));
const mentionsSchool = (text) => SCHOOL_VOCABULARY.filter((w) => String(text).includes(w));

describe('negative test — the RES pending line describes THIS card', () => {
    it('lists the card\'s own three channels and invents nothing', () => {
        const line = pendingIntentSummary(STUB_STAT_DATA.Intent);
        expect(line).toBe('salvage=-  dock=-  eventFire=-');
        expect(mentionsSchool(line)).toEqual([]);
    });

    it('a turn firing ONLY a channel School never had is visible in the log', () => {
        // The failure the log-sanity rule exists to prevent: an enumerating log that omits the one
        // channel that fired reads as "nothing pending", which is a lie about the turn.
        const intent = clone(STUB_STAT_DATA.Intent);
        intent.salvage = ['Derelict-7:hull', 'Salvage intent'];
        expect(pendingIntentSummary(intent)).toContain('salvage=Derelict-7:hull');
    });
});

describe('negative test — the data sync stamps nothing into this card\'s tree', () => {
    it('a full apply adds only what the payload asked for; no root is manufactured', () => {
        const statData = clone(STUB_STAT_DATA);
        const rootsBefore = Object.keys(statData);
        const report = applyDataSync(statData, {
            version: '1.0.0',
            seed: { Salvage: { jobs: { derelict_7: { cat: 'TRG', when: 'Docked' } } } },
            force: {},
        }, undefined);

        expect(report.applied).toBe(true);
        expect(statData.Salvage.jobs.derelict_7.cat).toBe('TRG');
        expect(Object.keys(statData)).toEqual(rootsBefore);          // no new top-level root
        expect(mentionsSchool(JSON.stringify(statData))).toEqual([]);
        expect(JSON.stringify(statData)).not.toContain('1.0.0');     // the watermark went to the caller
    });

    it('the version gate works with a watermark the platform stores outside stat_data', () => {
        const statData = clone(STUB_STAT_DATA);
        const payload = { version: '1.0.0', data: {}, force: {} };
        expect(applyDataSync(statData, payload, '1.0.0').skipped).toBe(true);
        expect(applyDataSync(statData, payload, '0.9.0').applied).toBe(true);
    });
});

describe('negative test — the card declares its own imagegen paths', () => {
    it('normalize accepts the two path fields and reports nothing unknown or blocked', () => {
        const cfg = normalizeCardConfig(STUB_CARD_CONFIG);
        expect(cfg.imagegen).toEqual(STUB_CARD_CONFIG.imagegen);
        expect(cfg.unknown).toEqual([]);
        expect(cfg.blocked).toEqual([]);
    });

    it('install seeds THIS card\'s paths into a profile carrying the shipped blank defaults', () => {
        // The shipped defaults: blank, so nothing points into anybody's schema until a card says so.
        const profile = { imagegen: { intimacyLatchPath: '', maincharRegistryKey: '', maxCharactersPerImage: 3 } };
        expect(isFreshProfile(profile)).toBe(true);

        const next = installCardConfigSections(profile, normalizeCardConfig(STUB_CARD_CONFIG));
        expect(next.imagegen.intimacyLatchPath).toBe('Flags.Docked');
        expect(next.imagegen.maincharRegistryKey).toBe('Vasquez');
        expect(next.imagegen.maxCharactersPerImage).toBe(3);             // untouched feature default survives
        expect(mentionsSchool(JSON.stringify(next))).toEqual([]);
    });
});

describe('negative test — the engine declares its event-pack paths and they are honoured', () => {
    it('reads THIS card\'s roots, not a default set', () => {
        const c = readEventContract(STUB_ENGINE_DECLARED);
        expect(c.paths).toEqual({ ok: true, triggerRoot: 'Salvage.jobs', armedPath: 'Flags.JobArmed' });
        expect(c.format).toBe('1.2');
        expect(c.scopes).toEqual({ ok: true, scopes: ['once', 'always'] });
        expect(c.writes).toEqual({ ok: true, writes: [{ path: 'Salvage.manifest' }] });
    });

    it('a malformed declaration explains the SHAPE without naming another card\'s schema', () => {
        const half = readEventContract({ ...STUB_ENGINE_DECLARED, eventPack: { ...STUB_ENGINE_DECLARED.eventPack, armedPath: null } });
        expect(half.paths.ok).toBe(false);
        expect(mentionsSchool(half.paths.reason)).toEqual([]);
    });

    it('and so does "no engine at all" — the state a stub card is in until one is hosted', () => {
        for (const nothing of [null, { version: 'v3.1', name: 'Salvage', type: 'Salvage', eventPack: null }]) {
            const c = readEventContract(nothing);
            expect(c.paths.ok).toBe(false);
            expect(mentionsSchool(c.paths.reason)).toEqual([]);
        }
    });
});

describe('negative test — the roster resolves this card\'s collection', () => {
    it('finds Crew by SHAPE, using the card\'s own presence field', () => {
        expect(findCharacterCollection(STUB_STAT_DATA, '', STUB_PRESENCE_FIELD)).toBe('Crew');
        expect(allCharKeys(STUB_STAT_DATA, '', STUB_PRESENCE_FIELD)).toEqual(['Vasquez', 'Okonkwo']);
        expect(presentCharKeys(STUB_STAT_DATA, '', STUB_PRESENCE_FIELD)).toEqual(['Vasquez']);
    });

    it('the DEFAULT presence field finds no collection here — and says so instead of guessing', () => {
        // A card using its own field name gets nothing rather than a wrong collection. That is the
        // correct degradation: the user sets the presence field, and the log tells them to.
        expect(findCharacterCollection(STUB_STAT_DATA, '', 'Is_present')).toBe(null);
    });
});

// ── §3.5: genre-NEUTRAL content must not inherit a consumer field's gate ─────────────────────
//
// The class this guards is not "the platform names School's vocabulary" — it is "the platform hides
// something universal behind a block that only exists when a consumer field exists". No grep can see
// it (§5.1). The chain below is driven end to end through platform code: this card's stat_data → the
// roster scan with the PUBLISHED default presence field (which finds nothing here, because the card
// names its field `onDeck`) → an empty present list → the ON FILE list. That is precisely the
// third-party card the fix exists for.
describe('negative test — a presence-less card still gets its ON FILE list and naming rules', () => {
    const CREW_DNA = [
        { key: 'Vasquez', names: ['Vasquez'], variants: ['eva', 'offshift'] },
        { key: 'Okonkwo', names: ['Okonkwo', 'Oko'], variants: ['hazmat'] },
    ];

    it('the presence scan finds nobody — the precondition this whole case rests on', () => {
        expect(presentCharKeys(STUB_STAT_DATA, '', 'Is_present')).toEqual([]);
    });

    it('THE REGRESSION GUARD: no presence ⇒ still an ON FILE list naming this card\'s own outfits', () => {
        const onFile = onFileCast({
            entries: CREW_DNA,
            namedKeys: namedKeysOf(CREW_DNA, 'Vasquez sealed the hatch behind her.'),
            presentKeys: presentCharKeys(STUB_STAT_DATA, '', 'Is_present'),   // [] — no presence field
        });
        // Gating the list behind `if (presentKeys.length)` empties this.
        const text = replyCastInstruction(onFile);
        expect(text).toContain('- Vasquez: eva, offshift');
        expect(mentionsSchool(text)).toEqual([]);
    });

    it('it is the ON FILE list, not a presence claim — it never asserts who is on screen', () => {
        const text = replyCastInstruction(onFileCast({ entries: CREW_DNA, namedKeys: namedKeysOf(CREW_DNA, 'Okonkwo checked the seals.') }));
        expect(text).not.toContain('<scene_roster>');
        expect(text).not.toContain('On-screen now');
        expect(text).toContain('- Okonkwo: hazmat');   // matched via its own alias-bearing name set
    });

    it('WITH a presence field the card DOES declare, the scene anchor comes back — gate intact', () => {
        const text = sceneRosterText(presentCharKeys(STUB_STAT_DATA, '', STUB_PRESENCE_FIELD));
        expect(text).toContain('<scene_roster>');
        expect(text).toContain('- Vasquez');
        expect(mentionsSchool(text)).toEqual([]);
    });

    it('the char= naming rules ship in <reply_cast>, which is never gated on presence', () => {
        // They must not be reachable ONLY through the presence block: a presence-less card would never be
        // told them — which is how a romanized, title-welded key gets minted for a CJK-named character.
        expect(replyCastInstruction([], [], [])).toContain(NAME_RULES);
        expect(NAME_RULES).toContain('NEVER translated, romanized, transliterated');
        expect(DEFAULT_PROMPT).toContain('written as Names in <reply_cast> says');
        expect(sceneRosterText([])).toBe('');
    });

    // A consumer whose state keys are romanized but whose prose is CJK satisfies "copy the key" and "copy
    // the story's script" one at a time, so char= flips between spellings. The roster block must defer.
    it('the scene roster never presents its keys as a char= spelling to copy', () => {
        expect(SCENE_ROSTER_PROMPT).not.toContain('their EXACT name as written');
        expect(SCENE_ROSTER_PROMPT).toContain('REGISTRY KEY');
        expect(SCENE_ROSTER_PROMPT).toMatch(/NEVER a spelling to copy into char=/i);
    });

    // A list read as the whole cast leaves a named newcomer undrawn and without a record. MUTATION TARGET: drop
    // the sentence and the list reads as everyone who may be drawn.
    it('MUTATION TARGET — the scene roster is the game\'s tracked characters, never a limit on who can be drawn', () => {
        expect(SCENE_ROSTER_PROMPT).toMatch(/not a limit on who can be drawn: anyone the story names in this scene may be drawn, listed or not, and gets their record/);
    });

    it('the roster defers to the story-script rule INSTEAD of competing with it', () => {
        expect(SCENE_ROSTER_PROMPT).toMatch(/char= follows Names in <reply_cast>, including for everyone on this list/i);
        expect(SCENE_ROSTER_PROMPT).toMatch(/write the STORY's name, never the key/i);
    });

    // Describe once: the narrator reads the ON FILE list and judges nothing. Neither <scene_roster> nor
    // its own earlier replies are evidence of what is stored — naming them closes the inference a model
    // otherwise makes from a list of keys that looks like a registry.
    it('rules out everything but the ON FILE list as evidence, by name', () => {
        expect(NARRATE_CONTRACT).toMatch(/ON FILE IS THE ONLY EVIDENCE/);
        expect(NARRATE_CONTRACT).toMatch(/No other text shown to you is — not <scene_roster>, not your own earlier replies/);
        expect(NARRATE_CONTRACT).toMatch(/Listed ⇒ the name only\. Not listed ⇒ describe them, however familiar they feel/);
    });

    it('names omission — not duplication — as the only costly failure', () => {
        expect(NARRATE_CONTRACT).toMatch(/Describing someone already stored costs only tokens/);
        expect(NARRATE_CONTRACT).toMatch(/leaving out someone who is NOT ON FILE is the ONLY failure with a cost/);
    });

    // Live 2026-09-24: a POST call given the narrator's wording read "every character this reply DRAWS"
    // as its own output. The registry draws nothing — said of the registry alone, because a picture task may
    // ride the same call. MUTATION TARGET: hand the POST call the narrator's opening.
    it('a call reading the reply is never told it drew anything', () => {
        for (const contract of [READER_FULL, READER_SHORT, READER_EMPTY]) {
            expect(contract).toMatch(/You did not write the reply you are given, and the registry draws nothing: it keeps looks\./);
            expect(contract).not.toMatch(/this reply DRAWS/);
            expect(contract).not.toMatch(/you drew|drew her|you draw nothing/i);
        }
    });

    // A record written inside a POST call's JSON block breaks that block's parse. No slot is claimed: the
    // capture reads the records wherever they stand, and the call may carry other duties.
    it('the reading call puts its records on lines of their own, outside every other block, and claims no slot', () => {
        expect(READER_FULL).toMatch(/a cast record on a line of its own, outside any other block: the extension reads the records wherever they stand in your answer, beside anything else this prompt asks you to write\./);
        expect(READER_FULL).not.toMatch(/at the END|after every other block/);
    });

    // The waste the reply cast exists to end (plans/reply-cast.md): 5 of 6 registrations on one turn were
    // for characters already on file, because the call could not see the registry. It now can.
    it('the reading call is told who is registered and asked for newcomers only', () => {
        expect(READER_FULL).toMatch(/REGISTER these characters[^\n]*: Wren Hollis/);
        expect(READER_FULL).toMatch(/REGISTER these characters — one record each, with body=, clothes= and outfit= as this reply shows them \(Outfit, below\)/);
        expect(READER_FULL).toMatch(/ALREADY REGISTERED — the registry needs nothing for them, except a record for a static outfit \(Outfit, below\)/);
        expect(READER_FULL).toContain('- Captain Vey / Vey — outfits: default, flightsuit');
    });

    // D4. MUTATION TARGET: always send the body rules and a turn with nobody new pays for the full text.
    it('a turn with nobody new gets the short rules — no body rules at all', () => {
        expect(READER_FULL).toMatch(/PIN EVERY SLOT/);
        expect(READER_SHORT).not.toMatch(/PIN EVERY SLOT/);
        expect(READER_SHORT.length).toBeLessThan(READER_FULL.length / 2);
        expect(READER_EMPTY).toMatch(/Nobody in this reply needs anything from the registry: write no registry record this reply\./);
    });

    it('clothes on file are shown only for a character the story may correct', () => {
        expect(READER_FULL).toContain('clothes on file (may be corrected) — default: grey coveralls');
        expect(READER_SHORT).not.toContain('clothes on file');
    });

    // A correction is one of her outfits shown differently; clothes that are none of her outfits are a
    // change, which the Outfit rules decide — never an overwrite of what is on file.
    it('MUTATION TARGET — a correction is one of her outfits shown differently, never different clothes', () => {
        expect(READER_FULL).toMatch(/if this reply shows one of those outfits with different garments or colours, write it as the reply shows it/);
        expect(READER_FULL).toMatch(/Clothes that are none of their outfits follow the Outfit rules\./);
        expect(READER_FULL).not.toMatch(/something different from every outfit on file/);
    });

    it('how to write a registration is one rule set, whichever call carries it', () => {
        const nameRules = (contract) => contract.slice(contract.indexOf('NAMED MEANS NAMED'), contract.indexOf('Registering a character'));
        expect(nameRules(NARRATE_CONTRACT).length).toBeGreaterThan(200);
        expect(nameRules(READER_FULL)).toBe(nameRules(NARRATE_CONTRACT));
    });

    it('no contract spells a closer or the retired tag', () => {
        for (const contract of [NARRATE_CONTRACT, READER_FULL, READER_SHORT, READER_EMPTY]) {
            expect(contract).not.toMatch(/<\/cast/);
            expect(contract).not.toMatch(/<charImage/);
        }
    });

    it('none of the new wording names a consumer', () => {
        expect(mentionsSchool(SCENE_ROSTER_PROMPT)).toEqual([]);
        for (const contract of [NARRATE_CONTRACT, READER_FULL, READER_SHORT, READER_EMPTY]) {
            expect(mentionsSchool(contract)).toEqual([]);
        }
    });
});
