// card-config-whole-section — the ownership rules of a section the card owns whole (statBox, leadText): derived
// once, so the two sections can never disagree on them. The feature's own normalize/serialize are tested beside
// the feature (statbox-core, turn-runner-core).
import { describe, it, expect } from 'vitest';
import { wholeCardOwnedSection } from '../src/features/card-config/card-config-whole-section.js';
import { CARD_CONFIG_SECTIONS } from '../src/features/card-config/card-config-sections.js';

const section = wholeCardOwnedSection({
    key: 'leadText',
    normalize: (raw) => raw,
    serialize: (current) => current,
    isConfigured: (v) => !!v && Array.isArray(v.storyEnvelope) && v.storyEnvelope.length > 0,
});
const GAME = { storyEnvelope: ['<gametxt>'] };
const GALGAME = { storyEnvelope: ['<maintext>'] };

describe('wholeCardOwnedSection — a section the card owns whole', () => {
    it('install takes what the card carries; a card without it leaves the profile\'s, and an unset one is null', () => {
        expect(section.install(null, GAME)).toBe(GAME);
        expect(section.install(GALGAME, undefined)).toBe(GALGAME);
        expect(section.install(undefined, null)).toBe(null);
    });
    it('MUTATION TARGET — merge takes the card whole and says whether it changed; a card without it leaves the profile alone', () => {
        expect(section.merge(null, GAME)).toEqual({ merged: GAME, summary: { refreshed: true } });
        expect(section.merge(GAME, { storyEnvelope: ['<gametxt>'] }).summary.refreshed).toBe(false);
        expect(section.merge(GALGAME, null)).toEqual({ merged: GALGAME, summary: { refreshed: false } });
        expect(section.describe({ refreshed: true })).toBe('leadText: refreshed from the card');
        expect(section.describe({ refreshed: false })).toBe('');
    });
    it('the whole section is one card-owned field: carried when configured, cleared to null when the card drops it', () => {
        expect(section.carriedCardOwnedFields(GAME)).toEqual(['leadText']);
        expect(section.carriedCardOwnedFields(null)).toEqual([]);
        expect(section.clearCardOwnedField(GAME, 'leadText')).toBe(null);
    });
    it('the registry builds statBox and leadText with it', () => {
        for (const key of ['statBox', 'leadText']) {
            const entry = CARD_CONFIG_SECTIONS.find((s) => s.key === key);
            expect(entry).toBeTruthy();
            expect(entry.describe({ refreshed: true })).toBe(`${key}: refreshed from the card`);
            expect(entry.clearCardOwnedField({}, key)).toBe(null);
        }
    });
});
