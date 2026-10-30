// tests/mvu-bridge-core.test.js — the write-attribution stack (the bookkeeper door's pure half), plus
// source gates on the save door in the host-coupled mvu-bridge.js, which a unit test cannot open, and on the
// engine hand-offs that must leave MVU's transient key behind.
//
// The contract under test is the pair of DEFAULTS, because they carry the design's whole safety
// argument: an un-initiated parse must read as 'message' (the model's own block), and an UNLABELED
// trip through the door must read as 'host' — never 'message', because a host lane mislabeled as
// the model is a false accusation no runtime check can retract.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    currentWriter, withWriter, WRITER_MESSAGE, WRITER_UNLABELED, MVU_STATE_SAVED_EVENT,
    writeJudgeOf, refusedByPhrase, ZOD_DISABLE_SENTINEL, JUDGE_ZOD, JUDGE_MVU_DERIVED, JUDGE_UNKNOWN, storedStatDataOf, stateBefore,
    MVUHELPER_STAT_ROOT, ownStatPart, setOwnStatPart, MVU_TRANSIENT_KEY, withoutMvuTransientKey,
} from '../src/sillytavern/mvu-bridge-core.js';

// mvu-helper's own root inside stat_data: one part per feature, and nothing else in the state is touched.
describe('ownStatPart / setOwnStatPart — one part of mvu-helper\'s root in a state', () => {
    it('MUTATION TARGET — the root is "$mvuhelper"', () => {
        expect(MVUHELPER_STAT_ROOT).toBe('$mvuhelper');
    });

    it('MUTATION TARGET — setting a part creates the root and leaves the rest of the state, and every other part, as it was', () => {
        const state = { World: { Date: '2026-04-12' } };
        setOwnStatPart(state, 'worn_outfit', { Mitsuki: { outfit: 'school-gym', clothes: '', last_picture_message: 4 } });
        expect(state).toEqual({ World: { Date: '2026-04-12' }, $mvuhelper: { worn_outfit: { Mitsuki: { outfit: 'school-gym', clothes: '', last_picture_message: 4 } } } });
        const other = { tracker: { a: 1 } };
        const withOther = { $mvuhelper: other };
        setOwnStatPart(withOther, 'worn_outfit', {});
        expect(withOther.$mvuhelper).toBe(other);
        expect(withOther.$mvuhelper).toEqual({ tracker: { a: 1 }, worn_outfit: {} });
    });

    it('a root that is not an object is replaced by one; a state that is not an object is left alone', () => {
        const state = { $mvuhelper: 'x' };
        setOwnStatPart(state, 'worn_outfit', {});
        expect(state.$mvuhelper).toEqual({ worn_outfit: {} });
        expect(() => setOwnStatPart(null, 'worn_outfit', {})).not.toThrow();
    });

    it('MUTATION TARGET — reading a part reads it in place; nothing there ⇒ undefined', () => {
        const part = { Mitsuki: { outfit: 'school-gym' } };
        expect(ownStatPart({ $mvuhelper: { worn_outfit: part } }, 'worn_outfit')).toBe(part);
        expect(ownStatPart({ $mvuhelper: {} }, 'worn_outfit')).toBeUndefined();
        expect(ownStatPart({ $mvuhelper: { constructor: 1 } }, 'toString')).toBeUndefined();
        expect(ownStatPart({}, 'worn_outfit')).toBeUndefined();
        expect(ownStatPart(null, 'worn_outfit')).toBeUndefined();
    });
});

// The state a message stores, read where MVU keeps it: one variables object per swipe.
describe('storedStatDataOf — the state a message stores for the swipe it shows', () => {
    const state = (n) => ({ stat_data: { World: { Day: n } } });

    it('MUTATION TARGET — the SHOWN swipe\'s stat_data, read in place', () => {
        const message = { swipe_id: 1, variables: [state(1), state(2)] };
        expect(storedStatDataOf(message)).toBe(message.variables[1].stat_data);
        expect(storedStatDataOf({ variables: [state(5)] })).toEqual({ World: { Day: 5 } });
    });

    it('a message holding no state for that swipe ⇒ null', () => {
        expect(storedStatDataOf({ swipe_id: 2, variables: [state(1)] })).toBeNull();
        expect(storedStatDataOf({ mes: 'streaming…' })).toBeNull();
        expect(storedStatDataOf({ variables: [{ stat_data: 'x' }] })).toBeNull();
        expect(storedStatDataOf(null)).toBeNull();
    });
});

// The state a reply starts from: the newest message before it whose shown swipe holds one.
describe('stateBefore — the stored state a reply at an index starts from', () => {
    const held = (n) => ({ variables: [{ stat_data: { World: { Day: n } } }] });
    const streaming = { mes: 'streaming…' };

    it('MUTATION TARGET — the newest message BEFORE the index that holds a state, never the message at it', () => {
        const chat = [held(1), held(2), held(3)];
        expect(stateBefore(chat, 2)).toEqual({ index: 1, statData: { World: { Day: 2 } } });
        expect(stateBefore(chat, 3)).toEqual({ index: 2, statData: { World: { Day: 3 } } });
    });

    it('MUTATION TARGET — a message holding no state is passed over', () => {
        expect(stateBefore([held(1), streaming, streaming], 3)).toEqual({ index: 0, statData: { World: { Day: 1 } } });
    });

    it('an index past the chat reads from its end; nothing before it ⇒ null', () => {
        expect(stateBefore([held(1)], 9)).toEqual({ index: 0, statData: { World: { Day: 1 } } });
        expect(stateBefore([held(1)], 0)).toBeNull();
        expect(stateBefore([streaming], 1)).toBeNull();
        expect(stateBefore(null, 3)).toBeNull();
    });
});

describe('write attribution — currentWriter / withWriter', () => {
    it('an empty stack answers \'message\' — the parse nobody initiated is the model\'s own block', () => {
        expect(currentWriter()).toBe(WRITER_MESSAGE);
        expect(WRITER_MESSAGE).toBe('message');
    });

    it('the label holds exactly for the duration of the callback', async () => {
        let inside = '';
        await withWriter('post', async () => { inside = currentWriter(); });
        expect(inside).toBe('post');
        expect(currentWriter()).toBe(WRITER_MESSAGE);            // popped on the way out
    });

    it('holds across an await — the ENDED handler fires INSIDE the parse, one microtask later', async () => {
        let afterAwait = '';
        await withWriter('plugin:lane-probe', async () => {
            await Promise.resolve();
            afterAwait = currentWriter();
        });
        expect(afterAwait).toBe('plugin:lane-probe');
    });

    it('NESTS — the plugin relay parses inside POST\'s ENDED handler, and the inner writer wins', async () => {
        const seen = [];
        await withWriter('post', async () => {
            seen.push(currentWriter());
            await withWriter('plugin:lane-probe', async () => { seen.push(currentWriter()); });
            seen.push(currentWriter());                          // POST's frame is still open
        });
        expect(seen).toEqual(['post', 'plugin:lane-probe', 'post']);
    });

    it('a THROW unwinds the label — a failed parse must not stamp its name on every later one', async () => {
        await expect(withWriter('pre-sim', async () => { throw new Error('parse died'); }))
            .rejects.toThrow('parse died');
        expect(currentWriter()).toBe(WRITER_MESSAGE);
    });

    it('an OMITTED label degrades to \'host\', never to \'message\' — vague beats false', async () => {
        let inside = '';
        await withWriter(undefined, async () => { inside = currentWriter(); });
        expect(inside).toBe(WRITER_UNLABELED);
        expect(WRITER_UNLABELED).not.toBe(WRITER_MESSAGE);
    });

    it('returns the callback\'s value — the bridge\'s applied-data return rides through unchanged', async () => {
        expect(await withWriter('post', async () => ({ stat_data: { ok: 1 } }))).toEqual({ stat_data: { ok: 1 } });
    });
});

// Parses OVERLAP (live 2026-08-29): POST's parse settles while the relay's — started by the ENDED handler
// POST's own emit reached — is still open. A frame leaves by identity, never by position.
describe('write attribution — overlapping frames', () => {
    it('MUTATION TARGET — the outer frame returning first does not take the inner label with it', async () => {
        let releaseOuter; const outerGate = new Promise((r) => { releaseOuter = r; });
        let releaseInner; const innerGate = new Promise((r) => { releaseInner = r; });
        const outer = withWriter('post', () => outerGate);
        const inner = withWriter('plugin:lane-probe', () => innerGate);
        expect(currentWriter()).toBe('plugin:lane-probe');
        releaseOuter(); await outer;                       // POST settles first — the relay is still parsing
        expect(currentWriter()).toBe('plugin:lane-probe');
        releaseInner(); await inner;
        expect(currentWriter()).toBe(WRITER_MESSAGE);
    });
});

// ── who judged a refused write ───────────────────────────────────────────────
//
// The contract: name MVU's derived schema when THAT is the judge, because the two failures need
// opposite responses — a Zod refusal is fixed by declaring a path, an MVU-derived refusal cannot be
// fixed by any declaration at all. The blob shape is the only evidence available at the warn site,
// and mvu_zod's sentinel is what distinguishes them.
describe('write judge — writeJudgeOf / refusedByPhrase', () => {
    // The real thing, as MVU stores it on a card with no Zod (live capture 2026-09-04).
    const derivedBlob = {
        display_data: {}, delta_data: {},
        stat_data: { GameLogicPlugin: { standalone_probe: {} } },
        schema: {
            type: 'object',
            properties: { GameLogicPlugin: { type: 'object', properties: {}, extensible: false } },
            extensible: false, recursiveExtensible: false,
        },
    };
    const zodBlob = { stat_data: {}, schema: ZOD_DISABLE_SENTINEL };

    it('a derived schema object is MVU judging, not Zod', () => {
        expect(writeJudgeOf(derivedBlob)).toBe(JUDGE_MVU_DERIVED);
        expect(refusedByPhrase(derivedBlob)).toContain('NO Zod schema is running');
    });

    it('the sentinel mvu_zod stamps is Zod judging', () => {
        expect(writeJudgeOf(zodBlob)).toBe(JUDGE_ZOD);
        expect(refusedByPhrase(zodBlob)).toContain("Zod schema refused");
        expect(refusedByPhrase(zodBlob)).not.toContain('NO Zod schema is running');
    });

    it('an empty derived schema STILL reads as MVU — the frozen-from-nothing card is the whole point', () => {
        // properties:{} is what messages 0-1 of the live card carried. If this answered 'unknown' the
        // warning would go vague on exactly the card that needs the clearest answer.
        expect(writeJudgeOf({ schema: { type: 'object', properties: {}, extensible: false } })).toBe(JUDGE_MVU_DERIVED);
    });

    it('no schema, or a sentinel that has changed, refuses to name anyone', () => {
        for (const blob of [{}, null, undefined, { schema: null }, { schema: 'some other marker' }]) {
            expect(writeJudgeOf(blob)).toBe(JUDGE_UNKNOWN);
        }
        expect(refusedByPhrase({})).toContain('cannot be named');
    });
});

// Mvu.replaceMvuData stores a message's state and announces nothing; the save door announces every save.
describe('SOURCE GATE — the save door announces every save, after it lands', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/sillytavern/mvu-bridge.js'), 'utf8');
    const door = src.slice(src.indexOf('export async function saveMessageMvuData'), src.indexOf('function announceStateSaved'));
    const announce = src.slice(src.indexOf('function announceStateSaved'));

    it('MUTATION TARGET — the save is announced once it is stored, and only then', () => {
        expect(door).toMatch(/await Mvu\.replaceMvuData\(data, \{ type: 'message', message_id: messageId \}\);\s*announceStateSaved\(messageId, /);
    });
    it('an unlabeled save is announced as the host\'s, never as the model\'s', () => {
        expect(door).toMatch(/String\(writer \|\| WRITER_UNLABELED\)/);
    });
    it('MUTATION TARGET — the announcement never holds the writer', () => {
        expect(announce).toMatch(/void Promise\.resolve\(eventSource\.emit\(MVU_STATE_SAVED_EVENT, \{ mid, writer \}\)\)/);
        expect(MVU_STATE_SAVED_EVENT).toBe('mvu_helper_state_saved');
    });
});

// MVU's `$internal` is MVU's alone: it sits on stat_data while MVU applies an update and MVU removes it itself. An
// engine is handed the state without it, so the copy an engine returns, which becomes the reply's state, never
// carries it past MVU's removal into a saved state.
describe("withoutMvuTransientKey — the state an engine is handed leaves MVU's transient key behind", () => {
    const live = () => ({ World: { Day: 3 }, $internal: { display_data: { World: { Day: 3 } }, delta_data: {} } });

    it('the key is MVU\'s own spelling', () => expect(MVU_TRANSIENT_KEY).toBe('$internal'));

    it('MUTATION TARGET — the top-level $internal is left out, every other key kept as the same value', () => {
        const state = live();
        const handed = withoutMvuTransientKey(state);
        expect(Object.keys(handed)).toEqual(['World']);
        expect(handed.World).toBe(state.World);
    });

    it("MUTATION TARGET — MVU's own object is left as it is: MVU removes the key itself", () => {
        const state = live();
        withoutMvuTransientKey(state);
        expect(state.$internal).toEqual({ display_data: { World: { Day: 3 } }, delta_data: {} });
    });

    it("a key of that name deeper in a consumer's tree is the consumer's, and stays", () => {
        const state = { Notes: { $internal: 'mine' } };
        expect(withoutMvuTransientKey(state)).toBe(state);
    });

    it('a state without the key, and a non-object, come back as they are', () => {
        const state = { World: { Day: 3 } };
        expect(withoutMvuTransientKey(state)).toBe(state);
        expect(withoutMvuTransientKey(null)).toBeNull();
        expect(withoutMvuTransientKey(undefined)).toBeUndefined();
    });
});

// The hand-offs live in host-coupled files a unit test cannot open: RES1 and RES2 run inside MVU's update, while
// `$internal` is on the state, and a plugin relay can run there too. Each hands the engine the state through
// withoutMvuTransientKey.
describe("SOURCE GATE — every engine hand-off inside MVU's update leaves MVU's transient key behind", () => {
    const read = (file) => readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r/g, '');
    const runner = read('src/features/logic-engine/turn-runner.js');
    const relay = read('src/features/gamelogic-plugin/plugin-relay.js');

    it('MUTATION TARGET — RES1 and RES2 hand the engine the state through withoutMvuTransientKey', () => {
        const calls = [...runner.matchAll(/api\.(resolveTurn|resolvePostRelay)\(([^,]+),/g)];
        expect(calls.map((m) => m[1]).sort()).toEqual(['resolvePostRelay', 'resolveTurn']);
        for (const m of calls) expect(m[2], m[1]).toBe('withoutMvuTransientKey(statData)');
    });

    it("MUTATION TARGET — a plugin relay's snapshot goes through withoutMvuTransientKey", () => {
        expect(relay).toMatch(/snapshot: withoutMvuTransientKey\(statData\),/);
        expect(relay).not.toMatch(/snapshot: statData\b/);
    });
});
