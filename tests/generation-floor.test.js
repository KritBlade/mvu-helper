import { describe, it, expect } from 'vitest';
import { tailMessagesCarryingVariables, generationStartingState } from '../src/shared/generation-floor.js';

describe('tailMessagesCarryingVariables (the before-generation drawer floors)', () => {
    // MUTATION TARGET — which messages a new generation can seed its variables from: newest first, only
    // messages that CARRY variables, capped at two. Walk the list forward instead of backward and the order
    // test fails; drop the variables check and the gap test fails; drop the cap and the cap test fails.
    const m = (hasVars) => (hasVars ? { variables: { 0: {} } } : {});
    it('returns the last two variable-carrying ids, newest first', () => {
        expect(tailMessagesCarryingVariables([m(true), m(true), m(true), m(true)])).toEqual([3, 2]);
    });
    it('skips messages without variables — the delete-then-send gap', () => {
        expect(tailMessagesCarryingVariables([m(true), m(false), m(true), m(false)])).toEqual([2, 0]);
    });
    it('caps at the requested count and survives short or absent chats', () => {
        expect(tailMessagesCarryingVariables([m(true)])).toEqual([0]);
        expect(tailMessagesCarryingVariables([], 2)).toEqual([]);
        expect(tailMessagesCarryingVariables(null)).toEqual([]);
        expect(tailMessagesCarryingVariables([m(true), m(true), m(true)], 3)).toEqual([2, 1, 0]);
    });
});

// The state a generation's reply starts from — what the roster's ON FILE list reads the worn-outfit store from.
describe('generationStartingState — the stored state a generation starts from', () => {
    const held = (n) => ({ variables: [{ stat_data: { Day: n } }] });
    // [greeting, user, reply, user]: a send, a continue and a regenerate (its reply already removed) start from the
    // newest state; a swipe of the last reply is the case below.
    const chat = [held(0), held(1), held(2), held(3)];

    it('MUTATION TARGET — a swipe starts from the state before the message it replaces, never the take it replaces', () => {
        expect(generationStartingState(chat, 'swipe')).toEqual({ index: 2, statData: { Day: 2 } });
    });

    it('MUTATION TARGET — every other generation starts from the newest state the chat holds', () => {
        for (const type of ['normal', 'regenerate', 'continue', 'quiet', 'impersonate', '', undefined]) {
            expect(generationStartingState(chat, type), String(type)).toEqual({ index: 3, statData: { Day: 3 } });
        }
    });

    it('an empty or absent chat starts from nothing', () => {
        expect(generationStartingState([], 'swipe')).toBeNull();
        expect(generationStartingState(null, 'normal')).toBeNull();
    });
});

// ── rule 7 · the plugin's own schema ─────────────────────────────────────────
//
// The decision exists because the two failures it sits between are opposite mistakes:
//   • NOT writing it on a bare card = a plugin that installs perfectly and then writes nothing for the
//     life of that card (MVU's derived schema freezes the empty drawer). Silent, and unfixable later
//     without a reinstall.
//   • writing it over a GameLogic Pack's schema = discarding every path the game declares, on a card
//     where the plugin's copy would have added nothing at all (rule 7 already opens the root there).
// So each case below is one of those two being avoided, not a preference.
