// tests/mvu-parse-disposition.test.js — shared/mvu-parse-disposition.js: is an MVU parse the live chat's,
// or MVU replaying old messages? One test per source of the event: every real parse of the live turn must
// pass, every replay must not. The turn runner's call site is gated as source in turn-runner-core.test.js.

import { describe, it, expect } from 'vitest';
import { endedEventDisposition, turnBaseMessageIds, TURN_BASE_COUNT } from '../src/shared/mvu-parse-disposition.js';

describe('endedEventDisposition — is this VARIABLE_UPDATE_ENDED the live turn\'s?', () => {
    // A stored state per message; each is distinct, as RES's own stamps make them in a real chat.
    const state = (n) => ({ World: { Time: '12:' + String(n).padStart(2, '0') }, Intent: { resolvedFor: [`${n}:0`] } });
    const copy = (x) => JSON.parse(JSON.stringify(x));
    const stored = (n) => ({ is_user: n % 2 === 1, swipe_id: 0, variables: [{ stat_data: state(n) }] });
    const bare = (n) => ({ is_user: n % 2 === 1, swipe_id: 0 });
    // Messages 0..last, each holding its own state; `withoutVars` lists the ones that hold none yet.
    const chatOf = (last, withoutVars = []) => Array.from({ length: last + 1 }, (_, n) => (withoutVars.includes(n) ? bare(n) : stored(n)));
    const startOf = (chat, id) => copy(chat[id].variables[chat[id].swipe_id].stat_data);

    it('MUTATION TARGET — narrate\'s reply parse starts from the message before the reply: a turn', () => {
        const chat = chatOf(62, [62]);                           // reply 62 streamed, no state yet; user msg 61 holds one
        const v = endedEventDisposition(startOf(chat, 61), chat);
        expect(v).toMatchObject({ disposition: 'turn', reason: 'matches', matched: 61 });
    });

    it('the reply\'s start is a COPY, never the stored object itself — equality is structural', () => {
        const chat = chatOf(62, [62]);
        expect(startOf(chat, 61)).not.toBe(chat[61].variables[0].stat_data);
        expect(endedEventDisposition(startOf(chat, 61), chat).disposition).toBe('turn');
    });

    it('POST\'s block (and a card script on the latest message) starts from the reply itself: a turn', () => {
        const chat = chatOf(62);
        expect(endedEventDisposition(startOf(chat, 62), chat)).toMatchObject({ disposition: 'turn', matched: 62 });
    });

    it('a user message\'s parse starts from the reply before it: a turn', () => {
        const chat = chatOf(61, [61]);                           // user msg 61 just sent, not written yet
        expect(endedEventDisposition(startOf(chat, 60), chat)).toMatchObject({ disposition: 'turn', matched: 60 });
    });

    it('MVU function-call mode starts from the newest message holding state: a turn', () => {
        const chat = chatOf(62);
        expect(endedEventDisposition(startOf(chat, 62), chat).disposition).toBe('turn');
        const midStream = chatOf(62, [62]);
        expect(endedEventDisposition(startOf(midStream, 61), midStream).disposition).toBe('turn');
    });

    it('MUTATION TARGET — a reply that already holds state still accepts a parse from its base (continue, swipe cache write)', () => {
        const chat = chatOf(62);                                 // 62 holds state, the parse started from 61
        expect(TURN_BASE_COUNT).toBe(2);
        expect(endedEventDisposition(startOf(chat, 61), chat)).toMatchObject({ disposition: 'turn', matched: 61 });
    });

    it('a swipe being generated holds no state on its shown swipe: the base is still found', () => {
        const chat = chatOf(62);
        chat[62] = { is_user: false, swipe_id: 1, variables: [{ stat_data: state(62) }] };   // swipe 1 not written yet
        expect(turnBaseMessageIds(chat)).toEqual([61, 60]);
        expect(endedEventDisposition(startOf(chat, 61), chat).disposition).toBe('turn');
    });

    it('MUTATION TARGET — the replay\'s first step starts from a message ~20 back: foreign', () => {
        const chat = chatOf(62, [62]);
        const v = endedEventDisposition(startOf(chat, 41), chat);
        expect(v).toMatchObject({ disposition: 'foreign', reason: 'no-match', matched: null, compared: [61, 60] });
    });

    it('MUTATION TARGET — the replay\'s later steps carry a rebuilt state no message holds: foreign', () => {
        const chat = chatOf(62, [62]);
        const rebuilt = startOf(chat, 61);
        rebuilt.Intent.resolvedFor = ['40:0'];                   // the replay never ran RES, so its stamp is the snapshot's
        expect(endedEventDisposition(rebuilt, chat).disposition).toBe('foreign');
    });

    it('a replay after the reply landed, or with no generation running, is foreign all the same', () => {
        const chat = chatOf(62);                                 // reply 62 complete and stored
        expect(endedEventDisposition(startOf(chat, 41), chat).disposition).toBe('foreign');
        const rebuilt = startOf(chat, 62);
        rebuilt.World.Time = '09:00';
        expect(endedEventDisposition(rebuilt, chat).disposition).toBe('foreign');
    });

    it('a parse of an older message (another extension) is foreign — it is not this turn', () => {
        const chat = chatOf(62);
        expect(endedEventDisposition(startOf(chat, 58), chat).disposition).toBe('foreign');
    });

    it('MUTATION TARGET — the SHOWN swipe is compared, never another swipe of the same message', () => {
        const chat = chatOf(62, [62]);
        chat[61] = { is_user: true, swipe_id: 1, variables: [{ stat_data: state(99) }, { stat_data: state(61) }] };
        expect(endedEventDisposition(state(99), chat).disposition).toBe('foreign');
        expect(endedEventDisposition(state(61), chat).disposition).toBe('turn');
    });

    it('MUTATION TARGET — an event without its starting state is foreign: the published signature always has one', () => {
        const chat = chatOf(62, [62]);
        for (const missing of [undefined, null, 'x', 0]) {
            expect(endedEventDisposition(missing, chat)).toMatchObject({ disposition: 'foreign', reason: 'no-start-state' });
        }
    });

    it('MUTATION TARGET — a chat where no message holds state yet is initialization: a turn (MVU cannot replay from nothing)', () => {
        const chat = [bare(0)];
        expect(endedEventDisposition(state(0), chat)).toMatchObject({ disposition: 'turn', reason: 'first-state', compared: [] });
    });

    it('junk chat, no throw', () => {
        expect(endedEventDisposition(state(0), null)).toMatchObject({ disposition: 'turn', reason: 'first-state' });
        expect(turnBaseMessageIds(undefined)).toEqual([]);
        expect(turnBaseMessageIds([null, { variables: {} }, { variables: [{}] }])).toEqual([]);
    });
});
