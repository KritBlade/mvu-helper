/**
 * MVU Helper — the streetcleaner (streetcleaner/streetcleaner-core.js, plans/executed/streetcleaner.md): the reply clock, and one
 * sweep over mvu-helper's own root in one copy of a reply's state.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { repliesSince, sweepOwnState } from '../src/features/streetcleaner/streetcleaner-core.js';
import { wornOutfitCleaningMission } from '../src/features/character-roster/dna-core.js';

const user = { is_user: true };
const ai = { is_user: false };

describe('repliesSince — the reply clock', () => {
    // [greeting, user, reply, user, reply, user, reply]
    const chat = [ai, user, ai, user, ai, user, ai];

    it('MUTATION TARGET — counts the replies after the stamp, up to and including the reply, never the user\'s messages', () => {
        expect(repliesSince(chat, 2, 6)).toBe(2);
        expect(repliesSince(chat, 0, 6)).toBe(3);
        expect(repliesSince(chat, 2, 4)).toBe(1);
    });

    // Two user messages in a row still make one reply.
    it('counts replies, not messages', () => {
        expect(repliesSince([ai, user, user, ai], 0, 3)).toBe(1);
    });

    it('MUTATION TARGET — a stamp at or past the reply is 0 replies old (a chat cut back, a branch)', () => {
        expect(repliesSince(chat, 6, 6)).toBe(0);
        expect(repliesSince(chat, 9, 6)).toBe(0);
    });

    it('a reply past the chat counts up to its end; junk counts nothing', () => {
        expect(repliesSince(chat, 2, 40)).toBe(2);
        expect(repliesSince(chat, 'x', 6)).toBe(0);
        expect(repliesSince(chat, 2, null)).toBe(0);
        expect(repliesSince(null, 0, 6)).toBe(0);
    });
});

describe('sweepOwnState — every mission sweeps its own part of mvu-helper\'s root', () => {
    const clock = { replyIndex: 10, repliesSince: () => 0 };
    // Drops every key starting with "old".
    const oldOnes = (part) => ({
        name: `${part} cleaner`,
        part,
        sweep: (value) => {
            const kept = {};
            const dropped = [];
            for (const [key, item] of Object.entries(value)) {
                if (key.startsWith('old')) dropped.push({ key, why: 'old' });
                else kept[key] = item;
            }
            return { kept, dropped, warnings: [] };
        },
    });

    it('MUTATION TARGET — writes back what a mission kept, in its own part, and nothing else', () => {
        const state = { World: { Day: 3 }, $mvuhelper: { a: { old1: 1, fresh: 2 }, b: { old2: 3 } } };
        const report = sweepOwnState(state, [oldOnes('a')], clock, () => {});
        expect(state).toEqual({ World: { Day: 3 }, $mvuhelper: { a: { fresh: 2 }, b: { old2: 3 } } });
        expect(report).toEqual([{ part: 'a', dropped: [{ key: 'old1', why: 'old' }], warnings: [] }]);
    });

    it('MUTATION TARGET — a mission that drops nothing leaves its part untouched, and is not reported', () => {
        const part = { fresh: 1 };
        const state = { $mvuhelper: { a: part } };
        expect(sweepOwnState(state, [oldOnes('a')], clock, () => {})).toEqual([]);
        expect(state.$mvuhelper.a).toBe(part);
    });

    it('a mission\'s warnings are reported even when it drops nothing', () => {
        const talker = { name: 't', part: 'a', sweep: (value) => ({ kept: value, dropped: [], warnings: ['say it'] }) };
        expect(sweepOwnState({ $mvuhelper: { a: {} } }, [talker], clock, () => {})).toEqual([{ part: 'a', dropped: [], warnings: ['say it'] }]);
    });

    it('a part the state does not hold is skipped', () => {
        let isSwept = false;
        const watcher = { name: 'w', part: 'missing', sweep: () => { isSwept = true; return { kept: {}, dropped: [], warnings: [] }; } };
        expect(sweepOwnState({ $mvuhelper: {} }, [watcher], clock, () => {})).toEqual([]);
        expect(sweepOwnState({}, [watcher], clock, () => {})).toEqual([]);
        expect(isSwept).toBe(false);
    });

    it('MUTATION TARGET — a mission that throws is handed to onError, its part left as it was, and the others still run', () => {
        const state = { $mvuhelper: { a: { old1: 1 }, b: { old2: 2, keep: 3 } } };
        const errors = [];
        const broken = { name: 'broken', part: 'a', sweep: () => { throw new Error('boom'); } };
        const report = sweepOwnState(state, [broken, oldOnes('b')], clock, (mission, e) => errors.push([mission.name, e.message]));
        expect(errors).toEqual([['broken', 'boom']]);
        expect(state.$mvuhelper).toEqual({ a: { old1: 1 }, b: { keep: 3 } });
        expect(report.map((r) => r.part)).toEqual(['b']);
    });

    // The same copy and the same reply sweep the same way, so MVU's copy and the engine's agree.
    it('sweeps the same state alike twice', () => {
        const make = () => ({ $mvuhelper: { a: { old1: 1, fresh: 2 } } });
        const first = make();
        const second = make();
        sweepOwnState(first, [oldOnes('a')], clock, () => {});
        sweepOwnState(second, [oldOnes('a')], clock, () => {});
        expect(first).toEqual(second);
    });

    it('no missions ⇒ nothing swept', () => {
        expect(sweepOwnState({ $mvuhelper: { a: { old1: 1 } } }, [], clock, () => {})).toEqual([]);
        expect(sweepOwnState({ $mvuhelper: { a: { old1: 1 } } }, null, clock, () => {})).toEqual([]);
    });
});

// The first mission with the real clock (character-roster wornOutfitCleaningMission).
describe('the worn-outfit store swept with the real clock', () => {
    it('MUTATION TARGET — an entry no picture drew for more than 100 replies is dropped; one drawn 100 replies back stays', () => {
        const chat = [ai];
        for (let i = 0; i < 110; i++) chat.push(user, ai);   // reply n is message 2n
        const replyIndex = chat.length - 1;                    // message 220, reply 110
        const state = { $mvuhelper: { worn_outfit: {
            Stale: { outfit: 'newclothes', clothes: 'sundress', last_picture_message: 18 },   // reply 9: 101 replies back
            Fresh: { outfit: 'school-gym', clothes: '', last_picture_message: 20 },           // reply 10: 100 replies back
        } } };
        const report = sweepOwnState(state, [wornOutfitCleaningMission], { replyIndex, repliesSince: (stamp) => repliesSince(chat, stamp, replyIndex) }, () => {});
        expect(Object.keys(state.$mvuhelper.worn_outfit)).toEqual(['Fresh']);
        expect(report).toEqual([{ part: 'worn_outfit', dropped: [{ key: 'Stale', why: 'last picture msg 18, 101 replies ago' }], warnings: [] }]);
    });
});
