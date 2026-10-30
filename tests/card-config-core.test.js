/**
 * MVU Helper — card-config pure-core tests (features/card-config/)
 *
 * The [Initmvuhelper] carry: a card ships its own mvu-helper setup in a lorebook entry, the extension
 * installs it on the card's first load and re-imports it whenever it changes, and the Main tab exports
 * it back. What travels and who owns each field is declared ONCE in the section registry — these tests
 * pin that decision, because it is the expensive one to get wrong: a card that ships somebody's
 * connection UUID is out in the world, and a field that silently changes category on re-import changes
 * behaviour behind the user's back.
 *
 * The I/O half (lorebook read/write, the profile) is card-config.js, which imports the ST host and
 * cannot load under vitest — everything decided here is pure, the whole import included (planCardImport).
 *
 * Run:  npm test   (or:  npx vitest run --reporter=verbose)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
    parseInitmvuhelper,
    normalizeCardConfig,
    serializeCardConfig,
    installCardConfigSections,
    mergeCardConfigSections,
    decideCardImport,
    isFreshProfile,
    cardConfigFingerprint,
    carriedCardOwnedFields,
    lastImportOf,
    planCardImport,
    CONFIG_SCHEMA_VERSION,
} from '../src/features/card-config/card-config-core.js';
import { CARD_CONFIG_SECTIONS, KNOWN_TOP_LEVEL, RESERVED_CONFIG_KEYS } from '../src/features/card-config/card-config-sections.js';
import { flatSection } from '../src/features/card-config/card-config-flat-section.js';
import { mergeExtraLlmCallsSection } from '../src/features/small-llm/extra-llm-calls-core.js';
import { imagegenProfileDefaults } from '../src/features/imagegen/imagegen-profile-core.js';

describe('parseInitmvuhelper + normalizeCardConfig ([Initmvuhelper] card config import)', () => {
    const CFG = {
        extraLlmCalls: {
            enabled: true, parallel: false, timeoutSec: 90,
            groups: [{ tag: 'llmshare', members: ['PRE', 'POST'] }],
            calls: [
                { name: 'PRE', phase: 'pre', maxTokens: 200, temperature: 0, profileId: 'SHOULD_BE_DROPPED' },
                { name: 'POST', phase: 'post', inputRegex: '<gametxt>([\\s\\S]*?)</gametxt>' },
            ],
        },
    };

    it('parses a bare JSON body', () => {
        const cfg = parseInitmvuhelper(JSON.stringify(CFG));
        expect(cfg.extraLlmCalls.enabled).toBe(true);
        expect(cfg.extraLlmCalls.parallel).toBe(false);
        expect(cfg.extraLlmCalls.timeoutSec).toBe(90);
        expect(cfg.extraLlmCalls.calls.map((c) => c.name)).toEqual(['PRE', 'POST']);
    });

    it('strips a <initmvuhelper> wrapper (like MVU strips <initvar>)', () => {
        const cfg = parseInitmvuhelper('<initmvuhelper>\n' + JSON.stringify(CFG) + '\n</initmvuhelper>');
        expect(cfg.extraLlmCalls.calls).toHaveLength(2);
    });

    it('strips a ``` code fence', () => {
        const cfg = parseInitmvuhelper('```json\n' + JSON.stringify(CFG) + '\n```');
        expect(cfg.extraLlmCalls.calls).toHaveLength(2);
    });

    it('FORCES every profileId to empty (card cannot carry a local connection UUID)', () => {
        const cfg = parseInitmvuhelper(JSON.stringify(CFG));
        expect(cfg.extraLlmCalls.calls.every((c) => c.profileId === '')).toBe(true);
    });

    it('normalizes each call to the full profile shape with deterministic ids', () => {
        const cfg = normalizeCardConfig(CFG);
        expect(cfg.extraLlmCalls.calls[0]).toEqual({
            id: 'call_pre', name: 'PRE', profileId: '', phase: 'pre',
            maxTokens: 200, temperature: 0, inputRegex: '', outputRegex: '', enabled: true,
        });
        expect(cfg.extraLlmCalls.calls[1].id).toBe('call_post');
        expect(cfg.extraLlmCalls.calls[1].inputRegex).toBe('<gametxt>([\\s\\S]*?)</gametxt>');
        expect(cfg.extraLlmCalls.calls[1].phase).toBe('post');
    });

    it('applies sane defaults for a minimal/partial config', () => {
        const cfg = normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'x' }] } });
        expect(cfg.extraLlmCalls).toMatchObject({ enabled: true, parallel: true, timeoutSec: 60, groups: [] });
        expect(cfg.extraLlmCalls.calls[0]).toMatchObject({ phase: 'pre', enabled: true, maxTokens: '', temperature: '', profileId: '' });
    });

    // A retired field must be dropped LOUDLY. The author who set `preset` is the only person who can
    // fix it, and a drop with no log leaves them nothing to search for.
    it('REPORTS a retired per-call field instead of dropping it silently', () => {
        const cfg = normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE', preset: 'myPreset' }] } });
        expect(cfg.extraLlmCalls.calls[0]).not.toHaveProperty('preset');   // still dropped from the shape
        expect(cfg.retired).toEqual([
            { call: 'PRE', field: 'preset', why: expect.stringContaining('connection profile') },
        ]);
    });

    // A retired SECTION field is reported by path, never as unknown: "check for a typo" would send the
    // author hunting for a spelling mistake in a field that was spelled right and simply retired.
    it('REPORTS a retired imagegen field by path and imports nothing from it', () => {
        const cfg = normalizeCardConfig({ imagegen: { forceImageTypePath: 'Preferences.ForceImageType', maincharRegistryKey: 'Hero' } });
        expect(cfg.imagegen).toEqual({ maincharRegistryKey: 'Hero' });
        expect(cfg.retired).toEqual([
            { path: 'imagegen.forceImageTypePath', why: expect.stringContaining('Image type') },
        ]);
        expect(cfg.unknown).toEqual([]);
    });

    // Every picture names what each person wears, so neither a story date nor a default outfit has anything to do:
    // a card that still declares them is told to remove them, and nothing of them is imported or exported.
    it('MUTATION TARGET — the story date path and the default outfits are retired: reported, never imported or exported', () => {
        const cfg = normalizeCardConfig({ imagegen: { storyDatePath: 'World.Date', defaultOutfits: 'school-uniform, goddess-outfit', maincharRegistryKey: 'Hero' } });
        expect(cfg.imagegen).toEqual({ maincharRegistryKey: 'Hero' });
        expect(cfg.unknown).toEqual([]);
        expect(cfg.retired).toEqual([
            { path: 'imagegen.storyDatePath', why: expect.stringContaining('remove it from the card') },
            { path: 'imagegen.defaultOutfits', why: expect.stringContaining('remove it from the card') },
        ]);
        expect(JSON.parse(serializeCardConfig({ imagegen: { storyDatePath: 'World.Date', defaultOutfits: 'x', maincharRegistryKey: 'Hero' } })).imagegen).toEqual({ maincharRegistryKey: 'Hero' });
        const { merged } = mergeCardConfigSections({ imagegen: { maincharRegistryKey: 'Old' } }, cfg);
        expect(merged.imagegen).not.toHaveProperty('storyDatePath');
    });

    it('reports nothing when no retired field is present, and names an unnamed call by index', () => {
        expect(normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE' }] } }).retired).toEqual([]);
        expect(normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE', preset: '' }] } }).retired).toEqual([]);   // empty ⇒ author set nothing
        expect(normalizeCardConfig({ extraLlmCalls: { calls: [{ preset: 'x' }] } }).retired[0].call).toBe('#0');
    });

    it('tolerates junk (non-object, missing arrays) without throwing', () => {
        expect(normalizeCardConfig(null).extraLlmCalls.calls).toEqual([]);
        expect(normalizeCardConfig({ extraLlmCalls: 5 }).extraLlmCalls.groups).toEqual([]);
        expect(normalizeCardConfig({ extraLlmCalls: { calls: 'nope' } }).extraLlmCalls.calls).toEqual([]);
    });

    it('throws on malformed JSON (caller logs + skips)', () => {
        expect(() => parseInitmvuhelper('{ not json ]')).toThrow();
    });

    it('reads the declared schema version; missing/invalid/<1 → 1 (earliest)', () => {
        expect(normalizeCardConfig({ version: 2 }).version).toBe(2);                 // future card, read as-is
        expect(normalizeCardConfig({}).version).toBe(1);                             // missing → 1
        expect(normalizeCardConfig({ version: 'x' }).version).toBe(1);               // junk → 1
        expect(normalizeCardConfig({ version: 0 }).version).toBe(1);                 // <1 → 1
    });
});

describe('decideCardImport — install a fresh profile, re-import a changed config, otherwise nothing', () => {
    const loaded = { hasEntry: true, isFresh: false, importedFingerprint: 'f1', cardFingerprint: 'f1' };

    it("MUTATION TARGET — ST's lobby (no card open) → skip-no-card, whatever else holds", () => {
        expect(decideCardImport({ ...loaded, isCardOpen: false })).toBe('skip-no-card');
        expect(decideCardImport({ ...loaded, isCardOpen: false, force: true, isEmbeddedSnapshot: true })).toBe('skip-no-card');
        expect(planCardImport(null, null, { isCardOpen: false })).toMatchObject({ decision: 'skip-no-card', values: {} });
    });
    it('no [Initmvuhelper] entry → skip-none, for a chat load and for the button', () => {
        expect(decideCardImport({ ...loaded, hasEntry: false })).toBe('skip-none');
        expect(decideCardImport({ ...loaded, hasEntry: false, force: true })).toBe('skip-none');
    });
    it('a fresh profile installs, from a chat load or from the button', () => {
        expect(decideCardImport({ ...loaded, isFresh: true, importedFingerprint: undefined })).toBe('install');
        expect(decideCardImport({ ...loaded, isFresh: true, importedFingerprint: undefined, force: true })).toBe('install');
    });
    it('MUTATION TARGET — the config this profile last imported → unchanged: an ordinary chat load touches nothing', () => {
        expect(decideCardImport(loaded)).toBe('unchanged');
    });
    it('MUTATION TARGET — a changed config re-imports with no button press', () => {
        expect(decideCardImport({ ...loaded, cardFingerprint: 'f2' })).toBe('reimport');
    });
    it('a profile saved before fingerprints existed re-imports once', () => {
        expect(decideCardImport({ ...loaded, importedFingerprint: undefined })).toBe('reimport');
    });
    it('the button re-imports an unchanged config', () => {
        expect(decideCardImport({ ...loaded, force: true })).toBe('reimport');
    });

    // The embedded book is the card as it was imported; a pack upgrade rewrites only the standalone one.
    it('MUTATION TARGET — a chat load that read only the embedded snapshot never re-imports', () => {
        expect(decideCardImport({ ...loaded, cardFingerprint: 'old', isEmbeddedSnapshot: true })).toBe('skip-snapshot');
        expect(decideCardImport({ ...loaded, isEmbeddedSnapshot: true })).toBe('skip-snapshot');          // same print: inconclusive too
        expect(decideCardImport({ ...loaded, hasEntry: false, isEmbeddedSnapshot: true })).toBe('skip-snapshot');
    });
    it('the snapshot may install a fresh profile, and the button may use it', () => {
        expect(decideCardImport({ ...loaded, isFresh: true, importedFingerprint: undefined, isEmbeddedSnapshot: true })).toBe('install');
        expect(decideCardImport({ ...loaded, cardFingerprint: 'old', isEmbeddedSnapshot: true, force: true })).toBe('reimport');
    });
});

// A stat box any section test can use. Module level: the fingerprint and import-flow tests below need it.
const STAT_BOX = {
    open: '<box>', close: '</box>', placeBefore: ['</story>', '</gametxt>'],
    groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }] }],
};

describe('isFreshProfile + install — a profile this card has never imported into', () => {
    // A profile as getProfile builds it for a card nobody has opened yet: blank card-owned fields, and
    // every preference filled by its feature default.
    const shippedDefaults = () => ({
        extraLlmCalls: { enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [] },
        imagegen: {
            promptTemplate: '', promptRegex: '', promptPosition: '', promptDepth: '', intimacyLatchPath: '', maincharRegistryKey: '',
            insertType: 'disabled', charimgVia: '', sdPromptPrefixPresetId: 'default', maxCharactersPerImage: 3,
            maxImagesPerReply: 1, defaultImageType: 'landscape', stripPicTag: true, hBlockAlwaysOn: false,
        },
        roster: { route: 'harvest', charCollection: '', presenceField: '' },
        logicEngine: { enabled: true },
        statBox: null,
        leadText: null,
    });

    it('an untouched profile is fresh', () => {
        expect(isFreshProfile({})).toBe(true);
    });
    it('MUTATION TARGET — the shipped defaults leave a profile fresh: a filled preference never says "set up"', () => {
        expect(isFreshProfile(shippedDefaults())).toBe(true);
    });
    it('calls, a card-owned path or a stat box make a profile not fresh', () => {
        expect(isFreshProfile({ ...shippedDefaults(), extraLlmCalls: { calls: [{ id: 'c1', name: 'PRE' }] } })).toBe(false);
        const withPath = shippedDefaults();
        withPath.imagegen.maincharRegistryKey = 'Hero';
        expect(isFreshProfile(withPath)).toBe(false);
        expect(isFreshProfile({ ...shippedDefaults(), statBox: normalizeCardConfig({ statBox: STAT_BOX }).statBox })).toBe(false);
    });
    it('MUTATION TARGET — a stored fingerprint is never fresh, whatever the sections hold', () => {
        expect(isFreshProfile({ ...shippedDefaults(), importedConfigFingerprint: 'f1' })).toBe(false);
    });
    it('install seeds every section the card carries — preferences included — over the feature defaults', () => {
        const cfg = normalizeCardConfig({
            extraLlmCalls: { enabled: false, calls: [{ name: 'PRE' }] },
            imagegen: { maincharRegistryKey: 'Hero', insertType: 'inline', maxImagesPerReply: 2 },
            roster: { route: 'predefined' },
            logicEngine: { enabled: false },
        });
        const next = installCardConfigSections(shippedDefaults(), cfg);
        expect(Object.keys(next)).toEqual(CARD_CONFIG_SECTIONS.map((s) => s.key));
        expect(next.extraLlmCalls).toMatchObject({ enabled: false, calls: [{ name: 'PRE' }] });
        expect(next.imagegen).toMatchObject({ maincharRegistryKey: 'Hero', insertType: 'inline', maxImagesPerReply: 2, maxCharactersPerImage: 3 });
        expect(next.roster).toEqual({ route: 'predefined', charCollection: '', presenceField: '' });
        expect(next.logicEngine).toEqual({ enabled: false });
        expect(next.statBox).toBe(null);                                 // the card carries no box: stays idle
        expect(next.leadText).toBe(null);                                // nor a story block: no lead text
    });
});

describe('serializeCardConfig (Export button → [Initmvuhelper] body) + round-trip', () => {
    const profile = {
        extraLlmCalls: {
            enabled: true, parallel: false, timeoutSec: 90,
            groups: [{ id: 'grp_x', tag: 'llmshare', members: ['PRE', 'POST'] }],
            calls: [
                { id: 'call_pre', name: 'PRE', profileId: 'LOCAL-UUID-DROP-ME', phase: 'pre', maxTokens: 200, temperature: 0, inputRegex: '', enabled: true },
                { id: 'call_post', name: 'POST', profileId: 'ANOTHER-UUID', phase: 'post', maxTokens: '', temperature: '', inputRegex: '<gametxt>([\\s\\S]*?)</gametxt>', enabled: true },
            ],
        },
    };

    it('stamps the current schema version', () => {
        const json = JSON.parse(serializeCardConfig(profile));
        expect(json.version).toBe(CONFIG_SCHEMA_VERSION);
    });

    it('drops local id + profileId and omits unset optional fields', () => {
        const json = JSON.parse(serializeCardConfig(profile));
        expect(json.extraLlmCalls.calls[0]).not.toHaveProperty('profileId');
        expect(json.extraLlmCalls.calls[0]).not.toHaveProperty('id');
        expect(json.extraLlmCalls.calls[0]).toEqual({ name: 'PRE', phase: 'pre', enabled: true, maxTokens: 200, temperature: 0 }); // no inputRegex (unset)
        expect(json.extraLlmCalls.calls[1]).toEqual({ name: 'POST', phase: 'post', enabled: true, inputRegex: '<gametxt>([\\s\\S]*?)</gametxt>' });
        expect(json.extraLlmCalls.groups[0]).toEqual({ tag: 'llmshare', members: ['PRE', 'POST'] }); // group id dropped too
    });

    it('round-trips: serialize → parse → normalize == normalize(original) (id regenerated, profileId empty)', () => {
        const exported = serializeCardConfig(profile);
        const reimported = parseInitmvuhelper(exported);
        const direct = normalizeCardConfig({ extraLlmCalls: profile.extraLlmCalls });
        // the canonical form of the original is what import would have produced from it directly —
        // except `version`: the raw profile carries none (normalize defaults it to 1) while the
        // export stamps the CURRENT schema version.
        expect(reimported).toEqual({ ...direct, version: CONFIG_SCHEMA_VERSION, blocked: [] });
        expect(reimported.extraLlmCalls.calls.every((c) => c.profileId === '')).toBe(true);
        expect(reimported.extraLlmCalls.calls.map((c) => c.id)).toEqual(['call_pre', 'call_post']);
        // …and the ONE thing that must differ between the two paths: the raw profile still holds the
        // user's connection UUIDs, so normalizing it directly REPORTS them as unimportable, while the
        // exported card never carried them at all. That asymmetry is the never-travels rule working.
        expect(direct.blocked.map((b) => b.path)).toEqual(['call "PRE".profileId', 'call "POST".profileId']);
    });
});

// ownedRoot is retired (user 2026-10-17): a call reads state with EJS in its own entries, and the field
// never limited where a patch may write. A card still carrying it must be told, and a profile that saved
// it must lose it on the next re-import — the same two duties every retired field has.
describe('ownedRoot is retired', () => {
    it('import REPORTS a set ownedRoot as retired, never as unknown, and drops it from the shape', () => {
        const cfg = normalizeCardConfig({ extraLlmCalls: { calls: [
            { name: 'PRE', phase: 'pre', ownedRoot: '/Intent/check' },
            { name: 'POST', phase: 'post', ownedRoot: '' },
        ] } });
        expect(cfg.extraLlmCalls.calls[0]).not.toHaveProperty('ownedRoot');
        expect(cfg.extraLlmCalls.calls[1]).not.toHaveProperty('ownedRoot');
        expect(cfg.retired).toEqual([{ call: 'PRE', field: 'ownedRoot', why: expect.stringContaining('getvar') }]);   // '' ⇒ the author set nothing
        expect(cfg.unknown).toEqual([]);
    });
    it('export never writes it, even from a profile that still holds one', () => {
        const profile = { extraLlmCalls: { enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [
            { id: 'c1', name: 'weather', profileId: 'UUID', phase: 'pre', ownedRoot: '/World_Weather', enabled: true },
        ] } };
        const json = JSON.parse(serializeCardConfig(profile));
        expect(json.version).toBe(CONFIG_SCHEMA_VERSION);
        expect(json.extraLlmCalls.calls[0]).not.toHaveProperty('ownedRoot');
    });
    it('a re-import DELETES it from every saved call, and names only the calls where it held a value', () => {
        const cur = { enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [
            { id: 'call_pre', name: 'PRE', profileId: 'U', phase: 'pre', inputRegex: '', outputRegex: '', ownedRoot: '/Intent/check', enabled: true },
            { id: 'call_post', name: 'POST', profileId: 'U', phase: 'post', inputRegex: '', outputRegex: '', ownedRoot: '', enabled: true },
            { id: 'call_mine', name: 'Mine', profileId: 'U', phase: 'pre', ownedRoot: '/TownSim', enabled: true },   // hand-added
        ] };
        const inc = normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE', phase: 'pre' }, { name: 'POST', phase: 'post' }] } }).extraLlmCalls;
        const { merged, summary } = mergeExtraLlmCallsSection(cur, inc);
        for (const c of merged.calls) expect(c).not.toHaveProperty('ownedRoot');
        expect(summary.deleted).toEqual(['PRE (ownedRoot)', 'Mine (ownedRoot)']);   // POST held '' — nothing to name
        expect(summary.updated).toEqual([]);                                          // deleting a dead key is no refresh
        expect(summary.kept).toEqual(['Mine']);
        expect(merged.calls.map((c) => c.profileId)).toEqual(['U', 'U', 'U']);
    });
    it('a re-import with no retired key reports nothing deleted and returns the call untouched', () => {
        const call = { id: 'call_pre', name: 'PRE', profileId: 'U', phase: 'pre', maxTokens: '', temperature: '', inputRegex: '', outputRegex: '', enabled: true };
        const inc = normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE', phase: 'pre' }] } }).extraLlmCalls;
        const { merged, summary } = mergeExtraLlmCallsSection({ enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [call] }, inc);
        expect(summary.deleted).toEqual([]);
        expect(merged.calls[0]).toEqual(call);
    });
});

// ── mergeExtraLlmCallsSection — the "Re-import from card" button ────────────
// The button used to REPLACE `extraLlmCalls` wholesale. Since `calls` is ONE array in ONE per-card
// settings object, getting a deleted call back also destroyed every other call's connection and any
// hand-added call. These tests pin WHO OWNS WHAT, which is the whole decision.
describe('mergeExtraLlmCallsSection (the force re-import)', () => {
    const card = () => ({
        enabled: true, parallel: true, timeoutSec: 60,
        groups: [{ id: 'grp_llmshare', tag: 'llmshare', members: ['PRE', 'POST'] }],
        calls: [
            { id: 'call_pre', name: 'PRE', profileId: '', phase: 'pre', maxTokens: 200, temperature: 0, inputRegex: '', outputRegex: 'CARD', enabled: true },
            { id: 'call_post', name: 'POST', profileId: '', phase: 'post', maxTokens: '', temperature: '', inputRegex: 'CARD-IN', outputRegex: '', enabled: true },
        ],
    });

    // The card seeds the top-level switches on an install (a fresh profile) only. A profile holding no
    // calls can still be the user's: they deleted every call, or set the switches before the card had any.
    it('a profile with no calls gets every card call ADDED and keeps its own switches', () => {
        const { merged, summary } = mergeExtraLlmCallsSection({ enabled: false, parallel: false, timeoutSec: 90, calls: [], groups: [] }, card());
        expect(summary.added).toEqual(['PRE', 'POST']);
        expect(summary.groupsAdded).toEqual(['llmshare']);
        expect(merged.calls).toEqual(card().calls);
        expect(merged).toMatchObject({ enabled: false, parallel: false, timeoutSec: 90 });
    });

    it('RESTORES a deleted call without touching the survivors — the reported bug', () => {
        const current = {
            enabled: true, parallel: false, timeoutSec: 90,
            groups: [{ id: 'grp_llmshare', tag: 'llmshare', members: ['PRE', 'POST'] }],
            calls: [{ id: 'call_post', name: 'POST', profileId: 'MY-UUID', phase: 'post', maxTokens: '', temperature: '', inputRegex: 'CARD-IN', outputRegex: '', enabled: true }],
        };
        const { merged, summary } = mergeExtraLlmCallsSection(current, card());
        expect(summary.added).toEqual(['PRE']);
        expect(merged.calls.map((c) => c.name)).toEqual(['POST', 'PRE']);      // survivors keep their position
        expect(merged.calls.find((c) => c.name === 'POST').profileId).toBe('MY-UUID');   // ← the whole point
    });

    it('NEVER clears a connection — the card cannot carry one, so refreshing it would only destroy it', () => {
        const current = { ...card(), calls: card().calls.map((c) => ({ ...c, profileId: 'MY-UUID' })) };
        const { merged } = mergeExtraLlmCallsSection(current, card());
        expect(merged.calls.every((c) => c.profileId === 'MY-UUID')).toBe(true);
    });

    it('KEEPS a hand-added call the card knows nothing about', () => {
        const current = { ...card(), calls: [...card().calls, { id: 'call_x', name: 'kjl', profileId: '', phase: 'pre', enabled: false }] };
        const { merged, summary } = mergeExtraLlmCallsSection(current, card());
        expect(summary.kept).toEqual(['kjl']);
        expect(merged.calls.map((c) => c.name)).toContain('kjl');
    });

    it('REFRESHES card-owned fields on an existing call (an author can ship a corrected regex)', () => {
        const current = { ...card(), calls: card().calls.map((c) => ({ ...c, outputRegex: 'MINE', profileId: 'MY-UUID' })) };
        const { merged, summary } = mergeExtraLlmCallsSection(current, card());
        expect(merged.calls[0].outputRegex).toBe('CARD');                       // card wins on shape
        expect(merged.calls[0].profileId).toBe('MY-UUID');                      // user wins on connection
        expect(summary.updated.join(' ')).toContain('outputRegex');             // and it SAYS what it changed
    });

    it('does NOT re-enable a call the user deliberately disabled — enabled is a switch, not shape', () => {
        const current = { ...card(), calls: card().calls.map((c) => ({ ...c, enabled: false })) };
        const { merged } = mergeExtraLlmCallsSection(current, card());
        expect(merged.calls.every((c) => c.enabled === false)).toBe(true);
    });

    it('preserves top-level tuning (parallel / timeoutSec) rather than resetting it to the card', () => {
        const current = { ...card(), parallel: false, timeoutSec: 120 };
        const { merged } = mergeExtraLlmCallsSection(current, card());
        expect(merged.parallel).toBe(false);
        expect(merged.timeoutSec).toBe(120);
    });

    it('restores a deleted GROUP and refreshes members, keeping hand-added groups', () => {
        const current = { ...card(), groups: [{ id: 'grp_mine', tag: 'mine', members: ['PRE'] }] };
        const { merged, summary } = mergeExtraLlmCallsSection(current, card());
        expect(summary.groupsAdded).toEqual(['llmshare']);
        expect(merged.groups.map((g) => g.tag)).toEqual(['mine', 'llmshare']);
        const drifted = { ...card(), groups: [{ id: 'grp_llmshare', tag: 'llmshare', members: ['PRE'] }] };
        const r2 = mergeExtraLlmCallsSection(drifted, card());
        expect(r2.summary.groupsUpdated).toEqual(['llmshare']);
        expect(r2.merged.groups[0].members).toEqual(['PRE', 'POST']);
    });

    it('matches on NAME case-insensitively — "pre" and "PRE" are one call, not two', () => {
        const current = { ...card(), calls: [{ id: 'c', name: 'pre', profileId: 'U', phase: 'pre', enabled: true }] };
        const { merged, summary } = mergeExtraLlmCallsSection(current, card());
        expect(summary.added).toEqual(['POST']);                                // PRE matched, not duplicated
        expect(merged.calls.filter((c) => /^pre$/i.test(c.name))).toHaveLength(1);
    });

    it('an idempotent second merge reports NOTHING changed (a no-op must not look like work)', () => {
        const { merged } = mergeExtraLlmCallsSection(card(), card());
        const { summary } = mergeExtraLlmCallsSection(merged, card());
        expect(summary).toMatchObject({ added: [], updated: [], groupsAdded: [], groupsUpdated: [] });
    });

    it('degrades on junk instead of throwing', () => {
        expect(() => mergeExtraLlmCallsSection(null, null)).not.toThrow();
        expect(() => mergeExtraLlmCallsSection({ calls: 'nope' }, { calls: 5 })).not.toThrow();
    });
});

// ── unknown-setting reporting ────────────────────────────────────────────────
// Same reasoning as the retired-field report: the card AUTHOR is the only person who can fix what a
// card carries, and a setting dropped in silence gives them nothing to search for. Two causes, two
// different fixes — a typo (fix the card) vs a section from a newer mvu-helper (update the extension)
// — which is why `version` is reported alongside.
describe('normalizeCardConfig — reports settings it cannot import', () => {
    it('names an unknown TOP-LEVEL section (a future tab, or a typo)', () => {
        const cfg = normalizeCardConfig({ version: 1, extraLlmCalls: { calls: [] }, npc: { foo: 1 } });
        expect(cfg.unknown.map((u) => u.path)).toEqual(['npc']);
    });

    it('names an unknown field INSIDE a known section, on the call and the group', () => {
        const cfg = normalizeCardConfig({
            extraLlmCalls: {
                wat: 1,
                calls: [{ name: 'PRE', nonsense: true }],
                groups: [{ tag: 'llmshare', members: ['PRE'], bogus: 'x' }],
            },
        });
        expect(cfg.unknown.map((u) => u.path)).toEqual(
            expect.arrayContaining(['extraLlmCalls.wat', 'call "PRE".nonsense', 'group "llmshare".bogus']),
        );
    });

    it('does NOT double-report a RETIRED field — it already gets a better message', () => {
        const cfg = normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE', preset: 'x' }] } });
        expect(cfg.retired.map((r) => r.field)).toEqual(['preset']);
        expect(cfg.unknown.map((u) => u.path)).toEqual([]);      // reported ONCE, as retired
    });

    it('a clean card reports nothing (a quiet import must stay quiet)', () => {
        const cfg = normalizeCardConfig({
            version: 1,
            extraLlmCalls: {
                enabled: true, parallel: true, timeoutSec: 60,
                groups: [{ tag: 'llmshare', members: ['PRE', 'POST'] }],
                calls: [{ name: 'PRE', phase: 'pre', enabled: true, outputRegex: '^x$' }],
            },
        });
        expect(cfg.unknown).toEqual([]);
        expect(cfg.retired).toEqual([]);
    });

    it('the SHIPPED card shape imports with nothing unrecognised', () => {
        // Guards the real Schoolv4 initmvuhelper.txt shape against a rename in either direction.
        const cfg = normalizeCardConfig({
            version: 1,
            extraLlmCalls: {
                enabled: true, parallel: true, timeoutSec: 60,
                groups: [{ tag: 'llmshare', members: ['POST', 'PRE'] }],
                calls: [
                    { name: 'PRE', phase: 'pre', enabled: true, outputRegex: String.raw`^\s*\{[\s\S]*\}\s*$` },
                    { name: 'POST', phase: 'post', enabled: true, inputRegex: String.raw`<(?:gametxt|maintext)>([\s\S]*?)</(?:gametxt|maintext)>` },
                ],
            },
        });
        expect(cfg.unknown).toEqual([]);
        expect(cfg.version).toBe(1);
    });

    it('degrades on junk without throwing', () => {
        expect(() => normalizeCardConfig({ extraLlmCalls: { calls: [null, 5] } })).not.toThrow();
        expect(normalizeCardConfig(null).unknown).toEqual([]);
    });
});

// ── the SECTION REGISTRY — the format's permanent guarantees ─────────────────
// These pin the promises made pre-ship (plans/executed/card-config-sections-plan.md §6.1). A migration is only
// ever forced by a FORMAT change; a new section is not one. What could break that is a section key
// colliding with the meta channel, or a key list drifting from the registry — so both are pinned here
// rather than left to review.
describe('CARD_CONFIG_SECTIONS (the registry contract)', () => {
    it('every section declares every operation — a partial handler would fail at a random pass', () => {
        for (const s of CARD_CONFIG_SECTIONS) {
            expect(typeof s.key).toBe('string');
            for (const op of ['normalize', 'serialize', 'install', 'merge', 'describe', 'isConfigured', 'carriedCardOwnedFields', 'clearCardOwnedField']) {
                expect(typeof s[op], `${s.key}.${op}`).toBe('function');
            }
        }
    });

    it('no section key collides with a RESERVED or RESULT-META key (§6.1 #3)', () => {
        // The keys normalizeCardConfig's result reserves for its report: a section key equal to one would
        // overwrite the report a caller reads. Pinned here rather than by a runtime throw, which at module
        // load would take the whole extension down for a mistake only a developer can make.
        const resultMetaKeys = ['version', 'retired', 'unknown', 'blocked'];
        const sectionKeys = CARD_CONFIG_SECTIONS.map((s) => s.key);
        expect(Object.keys(normalizeCardConfig({})).filter((k) => !sectionKeys.includes(k)).sort()).toEqual([...resultMetaKeys].sort());
        for (const s of CARD_CONFIG_SECTIONS) {
            expect(RESERVED_CONFIG_KEYS, `section "${s.key}" is a reserved key`).not.toContain(s.key);
            expect(resultMetaKeys, `section "${s.key}" would overwrite the import report`).not.toContain(s.key);
        }
    });

    it('section keys are unique, and KNOWN_TOP_LEVEL is derived from them (never hand-listed)', () => {
        const keys = CARD_CONFIG_SECTIONS.map((s) => s.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(KNOWN_TOP_LEVEL).toEqual([...RESERVED_CONFIG_KEYS, ...keys]);
    });

    it('a card carrying ONLY a future section still imports — the no-migration guarantee', () => {
        // An OLD extension meeting a NEW card: the unknown key is named, and every known section still
        // lands at its default. Nothing throws, nothing is half-written.
        const cfg = normalizeCardConfig({ version: 1, npc: { mood: 'sly' } });
        expect(cfg.unknown.map((u) => u.path)).toEqual(['npc']);
        expect(cfg.extraLlmCalls.calls).toEqual([]);
        expect(cfg).not.toHaveProperty('npc');
    });
});

// ── the GENERIC FLAT HANDLER — built for imagegen / roster / logicEngine (phase 2) ───────────
// Exercised against a synthetic descriptor rather than a real section, because the contract IS the
// generic part: a section is nothing but its three field lists, and every operation must read them the
// same way. A field that is card-owned on import and user-owned on merge is the bug this prevents.
describe('flatSection (the generic handler for a flat card-config section)', () => {
    const section = () => flatSection({
        key: 'demo',
        cardOwned: { route: 'string', maxPerReply: 'number', stripPicTag: 'boolean' },
        cardSeeded: { insertType: 'string' },
        neverTravels: ['presetId'],
    });

    const report = () => ({ retired: [], unknown: [], blocked: [] });

    it('normalize takes the declared fields and coerces them to the declared type', () => {
        const r = report();
        expect(section().normalize({ route: 'harvest', maxPerReply: '2', stripPicTag: true, insertType: 'draw' }, r))
            .toEqual({ route: 'harvest', maxPerReply: 2, stripPicTag: true, insertType: 'draw' });
        expect(r.blocked).toEqual([]);
    });

    it('an ABSENT field is never written — absent ⇒ the feature default, not a default we invent', () => {
        expect(section().normalize({ route: 'harvest' }, report())).toEqual({ route: 'harvest' });
    });

    it('BLOCKS a never-travels field instead of importing it, and says why', () => {
        const r = report();
        const out = section().normalize({ route: 'harvest', presetId: 'MY-LOCAL-PRESET' }, r);
        expect(out).not.toHaveProperty('presetId');
        expect(r.blocked).toEqual([{ path: 'demo.presetId', why: expect.stringContaining('local machine') }]);
        expect(r.unknown).toEqual([]);              // it is understood, not unrecognised — different fix
    });

    it('BLOCKS a wrong-typed value rather than writing a string where a number belongs', () => {
        const r = report();
        const out = section().normalize({ maxPerReply: 'two', stripPicTag: 'yes' }, r);
        expect(out).toEqual({});
        expect(r.blocked.map((b) => b.path)).toEqual(['demo.maxPerReply', 'demo.stripPicTag']);
    });

    it('serialize emits card-owned + card-seeded and can NEVER emit a never-travels field', () => {
        const json = section().serialize({ route: 'harvest', maxPerReply: 2, insertType: 'draw', presetId: 'LEAK' });
        expect(json).toEqual({ route: 'harvest', maxPerReply: 2, insertType: 'draw' });
        expect(json).not.toHaveProperty('presetId');
    });

    it('install SEEDS the switches — a card may ship "on by default"', () => {
        const merged = section().install({ insertType: 'disabled', presetId: 'MINE' }, { route: 'harvest', insertType: 'draw' });
        expect(merged).toEqual({ insertType: 'draw', presetId: 'MINE', route: 'harvest' });
    });

    it('merge REFRESHES card-owned but PRESERVES a switch the user changed — the whole category split', () => {
        const cur = { route: 'predefined', maxPerReply: 9, insertType: 'disabled', presetId: 'MINE' };
        const { merged, summary } = section().merge(cur, { route: 'harvest', maxPerReply: 2, insertType: 'draw' });
        expect(merged.route).toBe('harvest');                    // card wins on shape
        expect(merged.maxPerReply).toBe(2);
        expect(merged.insertType).toBe('disabled');              // user wins on behaviour
        expect(merged.presetId).toBe('MINE');                    // never touched
        expect(summary.refreshed).toEqual(['route', 'maxPerReply']);
    });

    it('an idempotent merge reports NOTHING refreshed (a no-op must not look like work)', () => {
        const same = { route: 'harvest', maxPerReply: 2, insertType: 'draw' };
        const { summary } = section().merge(same, same);
        expect(summary.refreshed).toEqual([]);
        expect(section().describe(summary)).toBe('');
        expect(section().describe({ refreshed: ['route'] })).toBe('demo: refreshed route');
    });

    it('MUTATION TARGET — only a CARD-OWNED field says the section is set up; a filled preference never does', () => {
        expect(section().isConfigured({ insertType: 'draw', presetId: 'MINE' })).toBe(false);
        expect(section().isConfigured({ route: '' })).toBe(false);              // blank is the shipped default
        expect(section().isConfigured({ maxPerReply: 0 })).toBe(true);          // 0 is a value, not an absence
    });

    it('names the card-owned fields a config carries, as profile paths', () => {
        expect(section().carriedCardOwnedFields({ route: 'harvest', insertType: 'draw' })).toEqual(['demo.route']);
        expect(section().carriedCardOwnedFields(undefined)).toEqual([]);
    });

    it('clearing a dropped field removes it, so the feature default fills it back in', () => {
        expect(section().clearCardOwnedField({ route: 'harvest', insertType: 'draw' }, 'demo.route')).toEqual({ insertType: 'draw' });
    });

    it('MUTATION TARGET — merge deletes the retired names a profile still holds, and nothing else', () => {
        const withRetired = flatSection({ key: 'demo', cardOwned: { route: 'string' }, cardSeeded: { insertType: 'string' }, retired: { oldName: 'renamed route' } });
        const { merged, summary } = withRetired.merge({ route: 'a', insertType: 'draw', oldName: 'x', localOnly: 1 }, {});
        expect(merged).toEqual({ route: 'a', insertType: 'draw', localOnly: 1 });
        expect(summary.deleted).toEqual(['oldName']);
        expect(withRetired.describe(summary)).toBe('demo: deleted oldName (no longer used)');
    });

    it('degrades on junk instead of throwing', () => {
        expect(() => section().normalize(null, report())).not.toThrow();
        expect(() => section().merge(null, null)).not.toThrow();
        expect(section().serialize(undefined)).toEqual({});
        expect(section().clearCardOwnedField(null, 'demo.route')).toEqual({});
    });
});

// ── the WHOLE-CONFIG passes over the registry ────────────────────────────────
describe('installCardConfigSections + mergeCardConfigSections (registry-driven apply)', () => {
    const cfg = () => normalizeCardConfig({
        extraLlmCalls: { calls: [{ name: 'PRE', phase: 'pre', outputRegex: 'CARD' }] },
    });

    it('install writes every section, keyed by the PROFILE key (one vocabulary, §6.1 #4)', () => {
        const next = installCardConfigSections({}, cfg());
        expect(Object.keys(next)).toEqual(CARD_CONFIG_SECTIONS.map((s) => s.key));
        expect(next.extraLlmCalls.calls.map((c) => c.name)).toEqual(['PRE']);
    });

    it('merge routes each section through ITS handler and keeps the user connection', () => {
        const profile = { extraLlmCalls: {
            enabled: true, parallel: true, timeoutSec: 60, groups: [],
            calls: [{ id: 'call_pre', name: 'PRE', profileId: 'MY-UUID', phase: 'pre', outputRegex: 'MINE', enabled: true }],
        } };
        const { merged, summaries, lines } = mergeCardConfigSections(profile, cfg());
        expect(merged.extraLlmCalls.calls[0].profileId).toBe('MY-UUID');
        expect(merged.extraLlmCalls.calls[0].outputRegex).toBe('CARD');
        expect(summaries.extraLlmCalls.updated.join(' ')).toContain('outputRegex');
        expect(lines).toEqual([]);          // extraLlmCalls reports itself in full — no generic line
    });

    it('degrades on junk instead of throwing', () => {
        expect(() => installCardConfigSections(null, null)).not.toThrow();
        expect(() => mergeCardConfigSections(null, null)).not.toThrow();
    });
});

// ── the PHANTOM refresh — found live 2026-08-05 ──────────────────────────────
// A profile written before a field existed has no such KEY. The card normalizes it to that field's
// empty default, so the naive comparison (undefined !== '') called it a change and every re-import
// announced "refreshed POST (ownedRoot)" — that field, since retired — while nothing about the call
// differed. The key still has to be written — the profile shape must converge — but the REPORT has to
// stay honest. Any card-owned field with an empty default can be the absent one; outputRegex stands in.
describe('mergeExtraLlmCallsSection — an absent field filled with the card default is not a refresh', () => {
    const cardCall = (over = {}) => ({
        id: 'call_post', name: 'POST', profileId: '', phase: 'post', maxTokens: '', temperature: '',
        inputRegex: 'CARD-IN', outputRegex: '', enabled: true, ...over,
    });
    const card = (over = {}) => ({ enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [cardCall(over)] });

    // The live case: a profile predating a field has no such key at all.
    const legacyProfile = () => {
        const c = cardCall();
        delete c.outputRegex;
        return { enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [{ ...c, profileId: 'MY-UUID' }] };
    };

    it('reports NOTHING and still WRITES the key, so the shape converges', () => {
        const { merged, summary } = mergeExtraLlmCallsSection(legacyProfile(), card());
        expect(summary.updated).toEqual([]);                       // ← the phantom, gone
        expect(merged.calls[0].outputRegex).toBe('');              // ← but the key exists now
        expect('outputRegex' in merged.calls[0]).toBe(true);
        expect(merged.calls[0].profileId).toBe('MY-UUID');
    });

    it('a SECOND merge is identical — the first one already converged the shape', () => {
        const { merged } = mergeExtraLlmCallsSection(legacyProfile(), card());
        expect(mergeExtraLlmCallsSection(merged, card()).summary.updated).toEqual([]);
    });

    it('still REPORTS an absent field the card fills with a REAL value — that IS a refresh', () => {
        const { merged, summary } = mergeExtraLlmCallsSection(legacyProfile(), card({ outputRegex: '^\\s*\\{' }));
        expect(summary.updated.join(' ')).toContain('outputRegex');
        expect(merged.calls[0].outputRegex).toBe('^\\s*\\{');
    });

    it('still REPORTS the card CLEARING a field the user had set — absent and empty are different', () => {
        const cur = { enabled: true, parallel: true, timeoutSec: 60, groups: [], calls: [cardCall({ outputRegex: 'MINE' })] };
        const { merged, summary } = mergeExtraLlmCallsSection(cur, card());
        expect(summary.updated.join(' ')).toContain('outputRegex');
        expect(merged.calls[0].outputRegex).toBe('');
    });
});

describe('the statBox section through the whole-config passes', () => {
    const statBox = {
        open: '<box>', close: '</box>', placeBefore: ['</story>'],
        groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Level', onReset: 'value' }] }],
    };

    it('import → export → import is lossless and reports nothing', () => {
        const first = normalizeCardConfig({ version: 1, statBox });
        expect(first.unknown).toEqual([]);
        expect(first.blocked).toEqual([]);
        const again = normalizeCardConfig(JSON.parse(serializeCardConfig({ statBox: first.statBox })));
        expect(again.statBox).toEqual(first.statBox);
    });
    it('bad vocabulary in statBox never costs another section anything', () => {
        const cfg = normalizeCardConfig({
            version: 1,
            imagegen: { maincharRegistryKey: 'Hero' },
            statBox: { ...statBox, theme: 'dark', groups: [{ path: 'Party', kind: 'tree', fields: [{ path: 'Level', label: 'Level' }] }, ...statBox.groups] },
        });
        expect(cfg.imagegen).toEqual({ maincharRegistryKey: 'Hero' });
        expect(cfg.statBox.groups.map((g) => g.path)).toEqual(['Hero']);
        expect(cfg.unknown.map((u) => u.path)).toEqual(['statBox.theme']);
        expect(cfg.blocked.map((b) => b.path)).toEqual(['statBox.groups[0] "Party".kind']);
    });
    it('a card without the section imports as idle (null), and re-import leaves a configured box alone', () => {
        expect(normalizeCardConfig({ version: 1 }).statBox).toBe(null);
        const configured = normalizeCardConfig({ version: 1, statBox }).statBox;
        const { merged } = mergeCardConfigSections({ statBox: configured }, normalizeCardConfig({ version: 1 }));
        expect(merged.statBox).toEqual(configured);
    });
    it('a re-import that changed the box says so', () => {
        const old = normalizeCardConfig({ version: 1, statBox }).statBox;
        const next = normalizeCardConfig({ version: 1, statBox: { ...statBox, open: '<panel>' } });
        expect(mergeCardConfigSections({ statBox: old }, next).lines).toContain('statBox: refreshed from the card');
    });
});

describe('the leadText section through the whole-config passes', () => {
    const leadText = { storyEnvelope: ['<gametxt>', '<maintext>'] };

    it('import → export → import is lossless and reports nothing', () => {
        const first = normalizeCardConfig({ version: 1, leadText });
        expect(first.unknown).toEqual([]);
        expect(first.blocked).toEqual([]);
        expect(first.leadText).toEqual(leadText);
        expect(normalizeCardConfig(JSON.parse(serializeCardConfig({ leadText: first.leadText }))).leadText).toEqual(leadText);
    });
    it('a bad tag costs its own entry only, never another section', () => {
        const cfg = normalizeCardConfig({ version: 1, imagegen: { maincharRegistryKey: 'Hero' }, leadText: { storyEnvelope: ['gametxt', '<maintext>'] } });
        expect(cfg.imagegen).toEqual({ maincharRegistryKey: 'Hero' });
        expect(cfg.leadText).toEqual({ storyEnvelope: ['<maintext>'] });
        expect(cfg.blocked.map((b) => b.path)).toEqual(['leadText.storyEnvelope[0]']);
    });
    it('MUTATION TARGET — a card that drops the section clears it: its last import carried it, this one does not', () => {
        const carried = normalizeCardConfig({ version: 1, leadText });
        const profile = { leadText: carried.leadText, ...lastImportOf(carried) };
        expect(profile.importedCardOwnedFields).toContain('leadText');
        const { merged, lines } = mergeCardConfigSections(profile, normalizeCardConfig({ version: 1 }));
        expect(merged.leadText).toBe(null);
        expect(lines).toContain('cleared leadText to the built-in default (the card no longer carries it)');
    });
});

// ── the fingerprint — what counts as the card's config changing ───────────────
describe('cardConfigFingerprint — what counts as the card config changing', () => {
    const entry = (json, comment) => `${comment}\n<initmvuhelper>\n${json}\n</initmvuhelper>`;
    const body = { version: 1, imagegen: { intimacyLatchPath: 'Flags.Intimate', maincharRegistryKey: 'Hero' }, statBox: STAT_BOX };

    it('the same config under other comments, whitespace or key order has the same fingerprint', () => {
        const reordered = { statBox: STAT_BOX, version: 1, imagegen: { maincharRegistryKey: 'Hero', intimacyLatchPath: 'Flags.Intimate' } };
        const a = cardConfigFingerprint(parseInitmvuhelper(entry(JSON.stringify(body), '# notes')));
        const b = cardConfigFingerprint(parseInitmvuhelper(entry(JSON.stringify(reordered, null, 4), '# other notes\n# rewritten')));
        expect(b).toBe(a);
    });

    it('MUTATION TARGET — a changed value changes it (the staging stat box: a third placeBefore anchor)', () => {
        const a = cardConfigFingerprint(normalizeCardConfig(body));
        const b = cardConfigFingerprint(normalizeCardConfig({ ...body, statBox: { ...STAT_BOX, placeBefore: [...STAT_BOX.placeBefore, '<combat_log>'] } }));
        expect(b).not.toBe(a);
    });

    it('the import report never counts: a setting this mvu-helper ignores changes nothing the profile holds', () => {
        const a = cardConfigFingerprint(normalizeCardConfig(body));
        const b = cardConfigFingerprint(normalizeCardConfig({ ...body, imagegen: { ...body.imagegen, notASetting: 1 } }));
        expect(b).toBe(a);
    });
});

// ── the whole import, as a chat load and the button run it (P2) ────────────────
// One chat load: what card-config.js importCardConfig writes into the profile from planCardImport.
function chatLoad(profile, cardJson, options) {
    const plan = planCardImport(profile, cardJson ? normalizeCardConfig(cardJson) : null, options);
    Object.assign(profile, plan.values);
    return plan;
}

describe('planCardImport — a card upgrade reaches an install that already has the card', () => {
    const card = (over = {}) => ({
        version: 1,
        extraLlmCalls: { calls: [{ name: 'PRE', phase: 'pre', outputRegex: 'CARD' }] },
        imagegen: { intimacyLatchPath: 'Flags.Intimate', insertType: 'inline' },
        statBox: STAT_BOX,
        ...over,
    });

    it('the first load installs and stores the fingerprint; loading the same card again does nothing', () => {
        const profile = {};
        expect(chatLoad(profile, card()).decision).toBe('install');
        expect(profile.importedConfigFingerprint).toBe(cardConfigFingerprint(normalizeCardConfig(card())));
        const again = chatLoad(profile, card());
        expect(again.decision).toBe('unchanged');
        expect(again.values).toEqual({});
    });

    it('MUTATION TARGET — a changed statBox.placeBefore replaces the saved one with no button press (staging msg 304)', () => {
        const profile = {};
        chatLoad(profile, card());
        const fixed = card({ statBox: { ...STAT_BOX, placeBefore: [...STAT_BOX.placeBefore, '<combat_log>'] } });
        const plan = chatLoad(profile, fixed);
        expect(plan.decision).toBe('reimport');
        expect(profile.statBox.placeBefore).toEqual(['</story>', '</gametxt>', '<combat_log>']);
        expect(plan.lines).toContain('statBox: refreshed from the card');
    });

    it("MUTATION TARGET — a user's edit to a card-owned field stands until the config changes, then the card's value replaces it", () => {
        const profile = {};
        chatLoad(profile, card());
        profile.imagegen.intimacyLatchPath = 'Mine.Flag';                       // edited in the panel
        chatLoad(profile, card());
        expect(profile.imagegen.intimacyLatchPath).toBe('Mine.Flag');
        chatLoad(profile, card({ statBox: { ...STAT_BOX, open: '<panel>' } }));  // the card changed something else
        expect(profile.imagegen.intimacyLatchPath).toBe('Flags.Intimate');
    });

    it('MUTATION TARGET — a preference is seeded on install and never overridden after', () => {
        const profile = {};
        chatLoad(profile, card());
        expect(profile.imagegen.insertType).toBe('inline');
        profile.imagegen.insertType = 'disabled';
        chatLoad(profile, card({ imagegen: { intimacyLatchPath: 'Flags.Intimate', insertType: 'replace' } }));
        expect(profile.imagegen.insertType).toBe('disabled');
    });

    it('a profile saved before fingerprints existed re-imports once, keeping its connections and preferences', () => {
        const profile = {
            extraLlmCalls: { enabled: false, parallel: true, timeoutSec: 60, groups: [], calls: [{ id: 'call_pre', name: 'PRE', profileId: 'MY-UUID', phase: 'pre', outputRegex: 'OLD', enabled: true }] },
            imagegen: { intimacyLatchPath: 'Old.Path', insertType: 'disabled' },
            statBox: normalizeCardConfig({ statBox: { ...STAT_BOX, placeBefore: ['</story>'] } }).statBox,
        };
        expect(chatLoad(profile, card()).decision).toBe('reimport');
        expect(profile.extraLlmCalls.calls[0]).toMatchObject({ profileId: 'MY-UUID', outputRegex: 'CARD' });
        expect(profile.extraLlmCalls.enabled).toBe(false);
        expect(profile.imagegen).toEqual({ intimacyLatchPath: 'Flags.Intimate', insertType: 'disabled' });
        expect(profile.statBox.placeBefore).toEqual(STAT_BOX.placeBefore);
        expect(chatLoad(profile, card()).decision).toBe('unchanged');
    });

    it('a deleted call stays deleted on ordinary loads and returns when the config changes, with the new one', () => {
        const profile = {};
        chatLoad(profile, card());
        profile.extraLlmCalls.calls = [];                                       // the user deleted PRE
        chatLoad(profile, card());
        expect(profile.extraLlmCalls.calls).toEqual([]);
        const upgraded = card({ extraLlmCalls: { calls: [{ name: 'PRE', phase: 'pre', outputRegex: 'CARD' }, { name: 'POST', phase: 'post' }] } });
        expect(chatLoad(profile, upgraded).summaries.extraLlmCalls.added).toEqual(['PRE', 'POST']);
    });

    it("an author's own export does not re-import itself", () => {
        const profile = {};
        chatLoad(profile, card());
        profile.imagegen.intimacyLatchPath = 'Edited.Path';                     // the author edits, then exports
        const exported = serializeCardConfig(profile);
        Object.assign(profile, lastImportOf(parseInitmvuhelper(exported)));       // what exportCardConfig stores
        expect(chatLoad(profile, JSON.parse(exported)).decision).toBe('unchanged');
        expect(profile.imagegen.intimacyLatchPath).toBe('Edited.Path');
    });

    it('Reset installs: a deleted record is fresh, so the button seeds the preferences again', () => {
        const profile = {};
        expect(chatLoad(profile, card(), { force: true }).decision).toBe('install');
        expect(profile.imagegen.insertType).toBe('inline');
    });

    it('no entry: nothing is written', () => {
        const plan = planCardImport({ imagegen: { maincharRegistryKey: 'Hero' } }, null);
        expect(plan.decision).toBe('skip-none');
        expect(plan.values).toEqual({});
    });

    it('MUTATION TARGET — a page load that reads the stale embedded snapshot leaves the upgraded config in place', () => {
        const profile = {};
        chatLoad(profile, card());                                                // the card as imported
        const upgraded = card({ statBox: { ...STAT_BOX, placeBefore: [...STAT_BOX.placeBefore, '<combat_log>'] } });
        chatLoad(profile, upgraded);                                              // the pack upgrade, read from the standalone book
        const snapshotRead = planCardImport(profile, normalizeCardConfig(card()), { isEmbeddedSnapshot: true });
        expect(snapshotRead.decision).toBe('skip-snapshot');
        expect(snapshotRead.values).toEqual({});
        expect(profile.statBox.placeBefore).toContain('<combat_log>');
    });
});

// ── a card-owned field the card drops (P9) ──────────────────────────────────
describe('a card-owned field the card drops goes back to its built-in default', () => {
    it('MUTATION TARGET — a dropped promptTemplate is cleared, so the built-in contract returns', () => {
        const profile = {};
        chatLoad(profile, { version: 1, imagegen: { promptTemplate: 'CARD TEMPLATE', maincharRegistryKey: 'Hero' } });
        expect(profile.imagegen.promptTemplate).toBe('CARD TEMPLATE');
        expect(profile.importedCardOwnedFields).toEqual(['imagegen.maincharRegistryKey', 'imagegen.promptTemplate']);
        const plan = chatLoad(profile, { version: 1, imagegen: { maincharRegistryKey: 'Hero' } });
        expect('promptTemplate' in profile.imagegen).toBe(false);      // the feature default ('' = DEFAULT_PROMPT) fills it back in
        expect(profile.importedCardOwnedFields).toEqual(['imagegen.maincharRegistryKey']);
        expect(plan.lines.join(' ')).toContain('cleared imagegen.promptTemplate');
    });

    it('MUTATION TARGET — a dropped statBox stops the box', () => {
        const profile = {};
        chatLoad(profile, { version: 1, statBox: STAT_BOX, imagegen: { maincharRegistryKey: 'Hero' } });
        chatLoad(profile, { version: 1, imagegen: { maincharRegistryKey: 'Hero' } });
        expect(profile.statBox).toBe(null);
    });

    it("a field the card never carried keeps the user's value", () => {
        const profile = {};
        chatLoad(profile, { version: 1, imagegen: { maincharRegistryKey: 'Hero' } });
        profile.imagegen.promptTemplate = 'MY TEMPLATE';
        chatLoad(profile, { version: 1, imagegen: { maincharRegistryKey: 'Hero2' } });
        expect(profile.imagegen).toEqual({ maincharRegistryKey: 'Hero2', promptTemplate: 'MY TEMPLATE' });
    });

    it('the card-owned list is what the config carries — every call field is a value, so calls add nothing', () => {
        expect(carriedCardOwnedFields(normalizeCardConfig({ extraLlmCalls: { calls: [{ name: 'PRE' }] }, statBox: STAT_BOX }))).toEqual(['statBox']);
    });
});

// ── retired names in a saved profile (P5) ───────────────────────────────────
describe('a re-import deletes the profile keys no code reads', () => {
    it('MUTATION TARGET — every retired key is gone after a re-import, and nothing else is', () => {
        const profile = {
            imagegen: {
                maincharRegistryKey: 'Hero', insertType: 'inline', maxCharactersPerImage: 3,
                maleRegistryKey: 'Hero', maxGirlsPerImage: 2, teachNarrator: true, forceImageTypePath: 'X', storyDatePath: 'Y', defaultOutfits: {},
            },
            roster: { route: 'harvest', presenceField: '', keepHarvestBlocks: false },
            logicEngine: { enabled: false, resolverHost: 'mvu-helper' },
        };
        const { merged, lines } = mergeCardConfigSections(profile, normalizeCardConfig({ version: 1 }));
        expect(merged.imagegen).toEqual({ maincharRegistryKey: 'Hero', insertType: 'inline', maxCharactersPerImage: 3 });
        expect(merged.roster).toEqual({ route: 'harvest', presenceField: '' });
        expect(merged.logicEngine).toEqual({ enabled: false });
        expect(lines).toContain('roster: deleted keepHarvestBlocks (no longer used)');
        expect(lines).toContain('logicEngine: deleted resolverHost (no longer used)');
    });

    it('a card carrying a retired name is told to remove it, and nothing is imported from it', () => {
        const cfg = normalizeCardConfig({ imagegen: { maleRegistryKey: 'Hero' }, roster: { keepHarvestBlocks: true }, logicEngine: { resolverHost: 'card' } });
        expect(cfg.retired.map((r) => r.path)).toEqual(['imagegen.maleRegistryKey', 'roster.keepHarvestBlocks', 'logicEngine.resolverHost']);
        expect(cfg.imagegen).toEqual({});
        expect(cfg.roster).toEqual({});
        expect(cfg.logicEngine).toEqual({});
    });
});

// A card-owned default holding a value would make every profile look set up, and a card opened for the first time would
// re-import instead of installing — its preferences would never be seeded.
describe("imagegen's template, as the card-config feature needs it", () => {
    it('MUTATION TARGET — every card-owned imagegen field ships blank', () => {
        const owned = CARD_CONFIG_SECTIONS.find((s) => s.key === 'imagegen').cardOwned;
        expect(owned.length).toBeGreaterThan(0);
        for (const field of owned) expect(imagegenProfileDefaults.imagegen[field], `${field}'s default`).toBe('');
    });
});

// ── SOURCE GATES — the host-coupled halves this feature depends on ─────────────
// image-gen.js imports the ST host and cannot load here, so what it must hold is read as source.
describe('SOURCE GATE — imagegen as the card-config feature needs it', () => {
    const imageGenSrc = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8');

    // The <pic> contract is per card: a reader of the old global copy would send a stale contract.
    it('MUTATION TARGET — nothing in src reads the global promptInjection except the code that deletes it', () => {
        const files = [];
        const walk = (dir) => {
            for (const name of readdirSync(dir)) {
                const path = `${dir}/${name}`;
                if (statSync(path).isDirectory()) walk(path);
                else if (path.endsWith('.js')) files.push(path);
            }
        };
        walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
        const readers = files.filter((f) => readFileSync(f, 'utf8').includes('promptInjection'));
        expect(readers.map((f) => f.slice(f.indexOf('/src/') + 1))).toEqual(['src/features/imagegen/image-gen.js']);
        const deleter = imageGenSrc.slice(imageGenSrc.indexOf('// `promptInjection` at the settings root'), imageGenSrc.indexOf('export function deleteGlobalPromptInjection'));
        const body = imageGenSrc.slice(imageGenSrc.indexOf('export function deleteGlobalPromptInjection'));
        const outside = imageGenSrc.replace(deleter, '').replace(body.slice(0, body.search(/\n\}\r?\n/) + 2), '');
        expect(outside).not.toContain('promptInjection');
        expect(imageGenSrc).toContain('rules: expandPromptMacros(narratorPictureRules({ template: prof.promptTemplate,');
        expect(imageGenSrc).toContain('const str = getImagegenProfile().promptRegex || DEFAULT_REGEX;');
    });
});
