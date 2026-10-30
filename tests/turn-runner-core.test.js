// tests/turn-runner-core.test.js — turn-runner pure logic + the engine behaviour the runner rests on.
// The stateful runner (event listeners, fence, save) imports ST's script.js and is exercised live;
// everything decision-shaped lives in turn-runner-core.js and is proven here, against a REAL
// assembled engine where the behaviour is the engine's. Source gates cover the two host-side
// call sites a unit test cannot open.

import { describe, it, expect } from 'vitest';
import { haveSchoolv4, schoolv4EngineText, schoolv4SeedStatData } from './schoolv4-artifact.mjs';
import { latestAiMessageId, swipeOf } from '../src/shared/latest-reply.js';
import { turnKeyOf, pendingIntentSummary, isTurnResolverActive, postRelayPlan, turnSavePlan, postSilentRelayPlan, noteReplySettled, droppedIntentWrites, createTurnOpsCollector, diffStatOps, planRelayParticipants, applyTextReplacements, placeLeadAndEndText, stripLeadAndEndText, resolverWritesReplyText, normalizeLeadTextSection, serializeLeadTextSection, isLeadTextConfigured, storyEnvelopeOf, REPLY_TAIL_ANCHORS, isStagedBlockStale, TURN_AUDIT_TAG, RELAY_AUDIT_TAG, wrapAuditBlock, auditBodyCarriesTag } from '../src/features/logic-engine/turn-runner-core.js';
import { placeAboveFirstAnchor } from '../src/shared/reply-block-placement.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { executeEngineText } from '../src/features/logic-engine/logic-engine-core.js';

// The ONE skip condition for everything below that needs a real engine (schoolv4-artifact.mjs says
// why it is a helper). Declared up here because a seeded-vocabulary test sits well above the engine
// block and must skip on the same condition rather than throw on a missing file.
const haveV4 = haveSchoolv4();

describe('latestAiMessageId / swipeOf / turnKeyOf — the CALL_INJECT-mirroring turn identity', () => {
    const chat = [
        { is_user: true, swipe_id: 0 },
        { is_user: false, swipe_id: 2 },
        { is_user: true },
        { is_user: false, swipe_id: 1 },   // ← latest AI reply
        { is_user: true },
    ];
    it('finds the latest non-user message, skipping trailing user messages', () => {
        expect(latestAiMessageId(chat)).toBe(3);
    });
    it('empty / all-user / non-array → -1', () => {
        expect(latestAiMessageId([])).toBe(-1);
        expect(latestAiMessageId([{ is_user: true }])).toBe(-1);
        expect(latestAiMessageId(null)).toBe(-1);
    });
    it('swipeOf reads swipe_id, defaulting a missing one to 0', () => {
        expect(swipeOf(chat, 3)).toBe(1);
        expect(swipeOf(chat, 4)).toBe(0);      // no swipe_id field
        expect(swipeOf(chat, 99)).toBe(0);     // out of range
        expect(swipeOf(null, 0)).toBe(0);
    });
    it('turnKeyOf is the "mid:swipe" string both resolvers key on', () => {
        expect(turnKeyOf(3, 1)).toBe('3:1');
    });
});

describe('pendingIntentSummary — the "[RES] fired — pending:" line, enumerated from the CARD', () => {
    // The log-sanity rule is that an ENUMERATING log must list every channel. It used to be satisfied by
    // hardcoding School v4's twenty — which satisfied it for School and broke it for everyone else. What
    // is asserted now is the property itself: whatever channels the card declares are the channels printed.
    it('lists every declared channel, in the card\'s own order, empty ones as "-"', () => {
        const s = pendingIntentSummary({ check: ['', ''], mundane: ['', ''], hact: ['', ''] });
        expect(s).toBe('check=-  mundane=-  hact=-');
    });
    it('GENRE-BLIND: a card with channels School never heard of gets ITS channels, not School\'s', () => {
        const s = pendingIntentSummary({ craft: ['sword', 'lbl'], haggle: ['', ''] });
        expect(s).toBe('craft=sword  haggle=-');
        expect(s).not.toMatch(/check|newClassmate|sceneAdvance/);   // no other genre's vocabulary leaks in
    });
    it('formats by MVU value SHAPE: tuple → [0], record → keys, true → YES', () => {
        const s = pendingIntentSummary({
            check: ['CHARM:Mitsuki:Success:Normal', 'lbl'],
            sceneAdvance: [true, 'lbl'],
            newClassmate: { Aoi: {}, Rin: {} },
            armClassmate: [true, 'lbl'],
            mundane: ['', ''],
            emptyRecord: {},
        });
        expect(s).toContain('check=CHARM:Mitsuki:Success:Normal');
        expect(s).toContain('sceneAdvance=YES');        // the channel's REAL name, not the old `advance=` label
        expect(s).toContain('newClassmate=Aoi,Rin');
        expect(s).toContain('armClassmate=YES');
        expect(s).toContain('mundane=-');
        expect(s).toContain('emptyRecord=-');
    });
    it('a card that declares NO channels says so — never a silent empty line', () => {
        for (const bad of [null, undefined, {}, 'nope']) {
            expect(pendingIntentSummary(bad)).toBe('(this card declares no Intent channels)');
        }
    });
    it.skipIf(!haveV4)('a real card\'s own seed still prints every channel it declares', () => {
        const intent = schoolv4SeedStatData().Intent;
        const s = pendingIntentSummary(intent);
        expect(Object.keys(intent).length).toBeGreaterThan(0);
        for (const channel of Object.keys(intent)) expect(s).toContain(`${channel}=`);
    });
});

// ── against a REAL assembled engine ──────────────────────────────────────────
describe.skipIf(!haveV4)('a REAL engine, as the turn runner drives it', () => {
    const bundle = schoolv4EngineText();
    const seed = schoolv4SeedStatData();

    it('resolveTurn is DETERMINISTIC: two independent loads resolve the same turn identically', () => {
        // No hidden cross-instance state (module-level caches, Date/Math.random reads): the same
        // input must land the same output, or a reload mid-chat would silently change the game.
        // Outlived the shadow gate it was written for — the property is the engine's, not the gate's.
        const engineA = executeEngineText(bundle, {});
        const engineB = executeEngineText(bundle, {});
        const a = structuredClone(seed);
        const b = structuredClone(seed);
        const rA = engineA.resolveTurn(a, { mid: 4, swipe: 0 });
        const rB = engineB.resolveTurn(b, { mid: 4, swipe: 0 });
        expect(rB.applied).toBe(rA.applied);
        expect(b).toEqual(a);
    });

    it('previewNextBlock (v4 R3) matches where RES actually lands — same-day block step', () => {
        const engine = executeEngineText(bundle, {});
        const V = (t) => (Array.isArray(t) ? t[0] : t);
        const sd = structuredClone(seed);
        sd.EngineDerived.Mode = ['SCHOOL', '']; sd.World.Time = ['12:00', '']; sd.World.Date = ['2026-04-08', ''];
        const pv = engine.previewNextBlock(sd);
        expect(pv.dayRoll).toBe(false);
        engine.resolveTurn(sd, { mid: 4, swipe: 0 });        // stamp the turn
        sd.PendingState.BlockDone = [true, 'BlockDone'];
        engine.resolveTurn(sd, { mid: 4, swipe: 0 });        // RES commits the advance
        expect(pv.time).toBe(V(sd.World.Time));              // preview == commit (narrate wrote the same slot RES lands)
    });

    it('previewNextBlock day-roll on the final block previews the next date without mutating', () => {
        const engine = executeEngineText(bundle, {});
        const sd = structuredClone(seed);
        sd.EngineDerived.Mode = ['SCHOOL', '']; sd.World.Time = ['19:00', '']; sd.World.Date = ['2026-04-08', ''];
        const before = JSON.stringify(sd);
        const pv = engine.previewNextBlock(sd);
        expect(pv.dayRoll).toBe(true);
        expect(pv.time).toBe('07:30');
        expect(pv.date).toBe('2026-04-09');
        expect(JSON.stringify(sd)).toBe(before);             // PURE — preview mutated nothing
    });

    it('BlockDone semantics the R3 flag model rests on: resolvedFor bypass + one-shot consume', () => {
        const engine = executeEngineText(bundle, {});
        const sd = structuredClone(seed);
        const V = (t) => (Array.isArray(t) ? t[0] : t);
        engine.resolveTurn(sd, { mid: 4, swipe: 0 });               // the turn resolves normally first
        const dateBefore = V(sd.World.Date);
        sd.PendingState.BlockDone = [true, 'BlockDone'];              // then the GUI click lands
        const r = engine.resolveTurn(sd, { mid: 4, swipe: 0 });     // SAME {mid,swipe} — must still advance
        expect(r.applied).toBe(true);
        expect(V(sd.World.Date)).not.toBe(dateBefore);              // clock advanced (seed sits on a day-roll boundary)
        expect(V(sd.PendingState.BlockDone)).toBe(false);             // one-shot: consumed in the same resolve
        const dateAfter = V(sd.World.Date);
        engine.resolveTurn(sd, { mid: 4, swipe: 0 });               // stray re-fire (e.g. the display-refresh echo)
        expect(V(sd.World.Date)).toBe(dateAfter);                   // no double-advance
    });

    it('a swipe is a different turn: same mid, new swipe re-resolves fresh (resolvedFor keying)', () => {
        const engine = executeEngineText(bundle, {});
        const sd = structuredClone(seed);
        engine.resolveTurn(sd, { mid: 4, swipe: 0 });
        const again = engine.resolveTurn(sd, { mid: 4, swipe: 0 });
        // Same key with nothing new pending → no full re-resolve (idle/no-op path).
        expect(String((again.log || []).join(' '))).not.toMatch(/CHECK|MUNDANE/);
        const swiped = engine.resolveTurn(structuredClone(seed), { mid: 4, swipe: 1 });
        expect(swiped).toBeTruthy();   // fresh input + new swipe resolves without throwing
    });

    it('offers the POST relay — a re-fire runs its game half', () => {
        const engine = executeEngineText(bundle, {});
        expect(postRelayPlan({ isProfileEnabled: true, isRefire: true, writer: 'post', gameStatus: 'loaded', engineApi: engine }).runsGameHalf).toBe(true);
    });

    it('and its relay applies POST-owned records that resolveTurn REFUSES', () => {
        const engine = executeEngineText(bundle, {});
        const V = (t) => (Array.isArray(t) ? t[0] : t);
        const sd = structuredClone(seed);
        const cast = sd.Classmate || {};
        const girl = Object.keys(cast).find((k2) => cast[k2] && cast[k2].ConflictActive !== undefined
            || (cast[k2] && typeof cast[k2] === 'object'));
        if (!girl) return;                          // a seed with no cast proves nothing here
        sd.Intent.relationship[0] = `conflict:${girl}`;
        const refused = engine.resolveTurn(sd, { mid: 4, swipe: 0 });
        expect(String((refused.log || []).join(' '))).toMatch(/POST-owned/);
        expect(V(sd.Classmate[girl].ConflictActive)).not.toBe(true);
        const relayed = engine.resolvePostRelay(sd, { mid: 4, swipe: 0 });
        expect(relayed.applied).toBe(true);
        expect(V(sd.Classmate[girl].ConflictActive)).toBe(true);
    });

});

// POST's RES wait rides on THIS (2026-10-04). It used to ride on the reply's text — an <UpdateVariable> tag
// count — and was wrong both ways: MVU resolves a wrapperless <JSONPatch> too (no wait, stale render), and
// fires its update-ended event on every reply, so an engine-less card waited the full backstop for a
// marker nothing ever stages. Only these two facts decide whether RES1 runs.
describe('isTurnResolverActive — will RES1 run (and stage the marker POST waits for)?', () => {
    const engine = { resolveTurn: () => {} };
    it('yes with the profile on and an engine that exports resolveTurn', () => {
        expect(isTurnResolverActive({ isProfileEnabled: true, engineApi: engine })).toBe(true);
    });
    it('no when the profile has the logic engine off — RES1 returns before resolving anything', () => {
        expect(isTurnResolverActive({ isProfileEnabled: false, engineApi: engine })).toBe(false);
    });
    it('no on a card with no game engine, or one without resolveTurn — nothing stages a marker there', () => {
        expect(isTurnResolverActive({ isProfileEnabled: true, engineApi: null })).toBe(false);
        expect(isTurnResolverActive({ isProfileEnabled: true, engineApi: { resolvePostRelay: () => {} } })).toBe(false);
        expect(isTurnResolverActive({ isProfileEnabled: true, engineApi: { resolveTurn: 'not a function' } })).toBe(false);
    });
    it('only a real true counts as on, and junk input reads as off', () => {
        expect(isTurnResolverActive({ isProfileEnabled: 'yes', engineApi: engine })).toBe(false);
        expect(isTurnResolverActive()).toBe(false);
    });
});

// ── droppedIntentWrites — the tuple-root write MVU refuses (live miss 2026-08-14) ────────────────
// `pending:` prints a refused channel as `-`, which is indistinguishable from "the narrator never
// touched it". These two must not read the same, because one of them means a turn's write was LOST
// after its prose was already shown to the player.
describe('droppedIntentWrites — a /Intent/<ch> op written without its /0', () => {
    const intent = { eventFire: ['', '事件觸發'], mundane: ['', '日常'], check: ['', '社交檢定'] };

    // The verbatim shape of the live miss: seven ops carried /0, the eighth did not.
    const liveReply = `<UpdateVariable><JSONPatch>[
      { "op": "replace", "path": "/Intent/mundane/0", "value": "Mana:Positive" },
      { "op": "replace", "path": "/Classmate/Mana/Thoughts/0", "value": "…" },
      { "op": "replace", "path": "/Intent/eventFire", "value": "test_dsl2_negation" }
    ]</JSONPatch></UpdateVariable>`;

    it('names the channel whose op lost its /0 — and only that one', () => {
        expect(droppedIntentWrites(liveReply, intent)).toEqual(['eventFire']);
    });

    it('a correctly-written op is NOT flagged', () => {
        const ok = '[{ "op": "replace", "path": "/Intent/eventFire/0", "value": "leila_1" }]';
        expect(droppedIntentWrites(ok, intent)).toEqual([]);
    });

    it('does not flag a channel that actually LANDED — the write is only lost if it is still empty', () => {
        const landed = { ...intent, eventFire: ['test_dsl2_negation', '事件觸發'] };
        expect(droppedIntentWrites(liveReply, landed)).toEqual([]);
    });

    it('ignores a path this card does not declare — that is a different bug, not a lost write', () => {
        const bare = { mundane: ['', '日常'] };
        expect(droppedIntentWrites(liveReply, bare)).toEqual([]);
    });

    it('is GENRE-NEUTRAL: the channel list comes from the card, so it works for one that has no eventFire', () => {
        const rpg = { loot: ['', 'Loot'], crew: ['', 'Crew'] };
        const reply = '[{ "op": "replace", "path": "/Intent/loot", "value": "sword" }]';
        expect(droppedIntentWrites(reply, rpg)).toEqual(['loot']);
    });

    it('tolerates whitespace variants and reports each channel once', () => {
        const messy = '[{"op":"replace","path" : "/Intent/eventFire","value":"a"},{"path":"/Intent/eventFire","value":"b"}]';
        expect(droppedIntentWrites(messy, intent)).toEqual(['eventFire']);
    });

    it('degrades on junk rather than throwing — it runs inside the resolve path', () => {
        expect(droppedIntentWrites(null, intent)).toEqual([]);
        expect(droppedIntentWrites(liveReply, null)).toEqual([]);
        expect(droppedIntentWrites(liveReply, {})).toEqual([]);
    });

    // Live false positive 2026-08-15. The `/0` rule belongs to the TUPLE shape, not to the path: a
    // RECORD channel is written on its container path ON PURPOSE, and School's <Classmate_Guide> even
    // forbids the sub-key spelling ("MVU REJECTS adding a new key"). Flagging it told the player a
    // correct reply had lost a write, and pointed them at the one file that was right.
    it('does NOT flag a RECORD channel written on its container path — that spelling is the correct one', () => {
        const withRecord = { ...intent, newClassmate: {} };
        const reply = '[{ "op": "replace", "path": "/Intent/newClassmate", "value": { "Mana": { "key": "Mana" } } }]';
        expect(droppedIntentWrites(reply, withRecord)).toEqual([]);
    });

    it('does not flag a SCALAR channel either — only a [value,"Label"] tuple has a /0 to miss', () => {
        expect(droppedIntentWrites('[{ "op": "replace", "path": "/Intent/flag", "value": true }]', { flag: '' })).toEqual([]);
    });

    it('still flags the TUPLE in the same reply that carries a legitimate record write', () => {
        const withRecord = { ...intent, newClassmate: {} };
        const mixed = `[{ "op": "replace", "path": "/Intent/newClassmate", "value": { "Mana": {} } },
                        { "op": "replace", "path": "/Intent/eventFire", "value": "leila_1" }]`;
        expect(droppedIntentWrites(mixed, withRecord)).toEqual(['eventFire']);
    });
});

// ── §23/§27.1 relay machinery (GP2) ──────────────────────────────────────────

describe('diffStatOps — §27.1 op collection is a DIFF of the ended event\'s two arguments', () => {
    // WHY A DIFF: the per-op event (`mag_variable_updated`) was measured to NEVER fire on a card
    // with a Zod schema — the zod util applies commands itself, and MVU's verb lanes (which own the
    // emits) never run. The diff works no matter who applied the write.

    it('reports a changed nested leaf with old and new, dotted path', () => {
        const { ops } = diffStatOps(
            { A: { b: { c: 1 } } },
            { A: { b: { c: 2 } } });
        expect(ops).toEqual([{ path: 'A.b.c', old: 1, new: 2 }]);
    });

    it('an added key reports old undefined; a deleted key reports new undefined', () => {
        const { ops } = diffStatOps({ A: { gone: 1 } }, { A: { fresh: 2 } });
        expect(ops).toContainEqual({ path: 'A.gone', old: 1, new: undefined });
        expect(ops).toContainEqual({ path: 'A.fresh', old: undefined, new: 2 });
    });

    it('ARRAYS ARE LEAVES — a changed tuple reports ONCE at the array path with the whole values', () => {
        const { ops } = diffStatOps(
            { World: { Weather: ['Clear', '天氣'] } },
            { World: { Weather: ['Storm(t1)', '天氣'] } });
        expect(ops).toEqual([{ path: 'World.Weather', old: ['Clear', '天氣'], new: ['Storm(t1)', '天氣'] }]);
    });

    it('a spliced list reports at the LIST path, never as shifted index pairs', () => {
        const { ops } = diffStatOps(
            { L: { list: ['a', 'b', 'c'] } },
            { L: { list: ['a', 'c'] } });
        expect(ops).toHaveLength(1);
        expect(ops[0].path).toBe('L.list');
    });

    it('a subtree created whole reports as ONE op at its root (drawer creation reads as one write)', () => {
        const { ops } = diffStatOps({}, { GameLogicPlugin: { LaneProbe: {} } });
        expect(ops).toEqual([{ path: 'GameLogicPlugin', old: undefined, new: { LaneProbe: {} } }]);
    });

    it('no change → no ops, including identical arrays and identical nested objects', () => {
        const same = { A: { t: [1, 'x'], o: { k: true } } };
        expect(diffStatOps(same, structuredClone(same)).ops).toEqual([]);
    });

    it('the cap is SAID, not silent', () => {
        const before = {}, after = {};
        for (let i = 0; i < 10; i++) after['k' + i] = i;
        const r = diffStatOps(before, after, { cap: 3 });
        expect(r.ops).toHaveLength(3);
        expect(r.capped).toBe(true);
    });

    // MVU sets `stat_data.$internal` before the update and unsets it AFTER our listener has run, so
    // at diff time `after` has it and `before` does not. Measured live: ~18 KB of display_data /
    // delta_data copies, reported as a write nobody made and cloned into the buffer every parse.
    it('MVU\'s own $internal scratch is NOT an op — it is transient, not a write', () => {
        const { ops } = diffStatOps(
            { World: { Day: 1 } },
            { World: { Day: 1 }, $internal: { display_data: { huge: 'x' }, delta_data: {} } });
        expect(ops).toEqual([]);
    });

    it('a real write still reports alongside a changed $internal — the exclusion is not a mute button', () => {
        const { ops } = diffStatOps(
            { World: { Day: 1 }, $internal: { a: 1 } },
            { World: { Day: 2 }, $internal: { a: 2 } });
        expect(ops).toEqual([{ path: 'World.Day', old: 1, new: 2 }]);
    });

    it('the exclusion is TOP-LEVEL only — a consumer\'s own nested $internal is its data and reports', () => {
        const { ops } = diffStatOps(
            { Mine: { $internal: 1 } },
            { Mine: { $internal: 2 } });
        expect(ops).toEqual([{ path: 'Mine.$internal', old: 1, new: 2 }]);
    });
});

describe('createTurnOpsCollector — the §27.1 applied-op buffer', () => {
    it('collects ops for the epoch they were noted under, and only that epoch', () => {
        const c = createTurnOpsCollector();
        c.note(1, 'World.Weather', 'Clear', 'Rain', 'message');
        c.note(1, 'Mainchar.Money', 100, 90, 'post');
        expect(c.snapshot(1).ops).toEqual([
            { path: 'World.Weather', old: 'Clear', new: 'Rain', by: 'message' },
            { path: 'Mainchar.Money', old: 100, new: 90, by: 'post' },
        ]);
        expect(c.snapshot(2).ops).toEqual([]);                       // another epoch sees NOTHING stale
    });

    it('a new epoch RESETS the buffer — a regen cannot inherit the dead reply\'s ops', () => {
        const c = createTurnOpsCollector();
        c.note(1, 'a', 0, 1, 'pre-sim');
        c.note(2, 'b', 0, 1, 'plugin:lane-probe');
        expect(c.snapshot(2).ops).toEqual([{ path: 'b', old: 0, new: 1, by: 'plugin:lane-probe' }]);
        expect(c.snapshot(1).ops).toEqual([]);
    });

    // `by` defaults to the SAME sentinel currentWriter() answers for an un-initiated parse — one
    // spelling of "unlabeled", imported, never re-typed (the engine-marker lesson, 2026-08-17).
    it('a note with no `by` reads as \'message\', matching the bridge\'s empty-stack answer', () => {
        const c = createTurnOpsCollector();
        c.note(1, 'World.Time', '07:30', '12:00');
        expect(c.snapshot(1).ops[0].by).toBe('message');
    });

    it('values are snapshotted AT CAPTURE — later mutation of the live object cannot rewrite history', () => {
        const c = createTurnOpsCollector();
        const live = { population: 52000 };
        c.note(1, 'ledger.Tokyo', null, live);
        live.population = 99999;
        expect(c.snapshot(1).ops[0].new).toEqual({ population: 52000 });
    });

    it('the cap is a SAID truncation, never a silent one', () => {
        const c = createTurnOpsCollector({ cap: 2 });
        c.note(1, 'a', 0, 1);
        c.note(1, 'b', 0, 1);
        c.note(1, 'c', 0, 1);
        const s = c.snapshot(1);
        expect(s.ops).toHaveLength(2);
        expect(s.capped).toBe(true);
    });

    it('an unclonable value degrades to its String form rather than throwing', () => {
        const c = createTurnOpsCollector();
        c.note(1, 'fn', () => {}, 'x');
        expect(typeof c.snapshot(1).ops[0].old).toBe('string');
    });
});

describe('planRelayParticipants — the host-side once-guard (V15)', () => {
    const guardOf = (entries) => new Map(entries);

    it('runs everyone on a fresh fire, in the order given (install order)', () => {
        const { run, skipped } = planRelayParticipants(
            [{ id: 'a' }, { id: 'b' }], guardOf([]), '1:5:0');
        expect(run.map((p) => p.id)).toEqual(['a', 'b']);
        expect(skipped).toEqual([]);
    });

    it('a participant already guarded for THIS fire is skipped; the others still run — guards are independent', () => {
        const { run, skipped } = planRelayParticipants(
            [{ id: 'a' }, { id: 'b' }], guardOf([['a', '1:5:0']]), '1:5:0');
        expect(run.map((p) => p.id)).toEqual(['b']);
        expect(skipped).toEqual(['a']);
    });

    it('a guard from an OLDER fire does not block — same turnKey, new epoch (the regen case) runs again', () => {
        const { run } = planRelayParticipants(
            [{ id: 'a' }], guardOf([['a', '1:5:0']]), '2:5:0');
        expect(run.map((p) => p.id)).toEqual(['a']);
    });

    it('nameless or malformed participants are dropped, not run', () => {
        const { run, skipped } = planRelayParticipants(
            [null, { id: '' }, { resolve() {} }, { id: 'ok' }], guardOf([]), 'k');
        expect(run.map((p) => p.id)).toEqual(['ok']);
        expect(skipped).toEqual([]);
    });
});

// ── applyTextReplacements (GP4) — the platform half of engine-authored message text ──────────
// Deliberately tested with STUB vocabulary, never a real engine's: the platform's correctness must
// not depend on what any consumer names its tags (L1). The blindness cases ARE the contract.
describe('applyTextReplacements', () => {
    it('swaps every occurrence of a literal find, and reports the count', () => {
        const r = applyTextReplacements('a <x/> b <x/> c', { '<x/>': 'HELLO' });
        expect(r.text).toBe('a HELLO b HELLO c');
        expect(r.counts['<x/>']).toBe(2);
        expect(r.skipped).toEqual([]);
    });
    it('applies multiple pairs independently', () => {
        const r = applyTextReplacements('<a/>|<b/>', { '<a/>': 'one', '<b/>': 'two' });
        expect(r.text).toBe('one|two');
    });
    it('a find with 0 occurrences changes nothing and reports 0 — never invents text', () => {
        const r = applyTextReplacements('plain prose', { '<missing/>': 'BAR' });
        expect(r.text).toBe('plain prose');
        expect(r.counts['<missing/>']).toBe(0);
    });
    it('treats finds as LITERALS, never regex — pattern syntax in a key must not detonate', () => {
        const r = applyTextReplacements('x .*+? y', { '.*+?': 'safe' });
        expect(r.text).toBe('x safe y');
    });
    it('skips non-string put values loudly (skipped list), touching nothing', () => {
        const r = applyTextReplacements('keep <t/>', { '<t/>': 42 });
        expect(r.text).toBe('keep <t/>');
        expect(r.skipped).toEqual(['<t/>']);
    });
    it('no map / wrong-shaped map → text unchanged, nothing counted (stub-engine blindness)', () => {
        expect(applyTextReplacements('body', null).text).toBe('body');
        expect(applyTextReplacements('body', undefined).text).toBe('body');
        expect(applyTextReplacements('body', ['<a/>']).text).toBe('body');
        expect(Object.keys(applyTextReplacements('body', null).counts)).toEqual([]);
    });
    it('replacement output is NOT rescanned — a put containing another find stays as written', () => {
        const r = applyTextReplacements('<a/>', { '<a/>': '<b/>', '<b/>': 'NO' });
        // pairs apply in key order: <a/> -> <b/> first, then the <b/> pass sees it. Document the
        // actual contract: sequential application over the running text.
        expect(r.text).toBe('NO');
        expect(r.counts['<b/>']).toBe(1);
    });
});

// ── the engine's lead and end text — written into every reply that returns them, whatever the model wrote ──
// Stub text again (L1): what the engine says is opaque; where it lands, and that it lands once, is the contract.
describe('placeLeadAndEndText — the engine\'s own text at the top of the story and above the menu', () => {
    const MENU = '<StatusPlaceHolderImpl/>';
    const STORY = { storyEnvelope: ['<gametxt>', '<maintext>'] };
    const reply = '<maintext>\nstory\n</maintext>\n\n<UpdateVariable>u</UpdateVariable>';
    const withBar = (bar) => `<maintext>\n<LeadText>${bar}</LeadText>\n\nstory\n</maintext>\n\n<UpdateVariable>u</UpdateVariable>`;
    // A preset that writes its thinking into the reply, under a tag of its own, after a commentary block.
    const raw = '<tucao>\nt\n</tucao>\n\n<konatan_planning~>\nplan\n</konatan_planning~>\n\nstory\n\n<combat_log>c</combat_log>';
    // The same reply after galgame-companion opened <maintext> at its first character and wrapped every beat.
    const shaped = '<maintext>\n<p><tucao>\nt\n</tucao></p>\n\n<p><konatan_planning~>\nplan\n</konatan_planning~></p>\n\n<p>story</p>\n</maintext>';

    it('places the lead text at the top of the story, inside the story block, a blank line above the story line', () => {
        const r = placeLeadAndEndText(reply, { leadText: 'BAR' }, STORY);
        expect(r.text).toBe(withBar('BAR'));
        expect(r.actions).toEqual({ leadText: 'placed', endText: 'absent' });
    });
    it('MUTATION TARGET — blocks of the model\'s own above the story are skipped, whatever they are called', () => {
        expect(placeLeadAndEndText(raw, { leadText: 'BAR' }, STORY).text)
            .toBe('<tucao>\nt\n</tucao>\n\n<konatan_planning~>\nplan\n</konatan_planning~>\n\n<LeadText>BAR</LeadText>\n\nstory\n\n<combat_log>c</combat_log>');
    });
    it('MUTATION TARGET — a story block that opens the reply is walked INTO, past the blocks inside it, in front of the story line\'s <p>', () => {
        expect(placeLeadAndEndText(shaped, { leadText: 'BAR' }, STORY).text)
            .toBe('<maintext>\n<p><tucao>\nt\n</tucao></p>\n\n<p><konatan_planning~>\nplan\n</konatan_planning~></p>\n\n<LeadText>BAR</LeadText>\n\n<p>story</p>\n</maintext>');
    });
    it('a story block written after the thinking is walked into too: the lead text opens the story inside it', () => {
        expect(placeLeadAndEndText('<thinking>plan</thinking>\n<gametxt>\nstory\n</gametxt>', { leadText: 'BAR' }, STORY).text)
            .toBe('<thinking>plan</thinking>\n<gametxt>\n<LeadText>BAR</LeadText>\n\nstory\n</gametxt>');
    });
    it('MUTATION TARGET — a display regex that boxes everything from the reply\'s first character through the thinking\'s close never takes the lead text', () => {
        const box = /([\s\S]*)<\/konatan_planning~>/;
        for (const text of [raw, shaped]) {
            expect(placeLeadAndEndText(text, { leadText: 'BAR' }, STORY).text.replace(box, '[box]')).toContain('<LeadText>BAR</LeadText>');
        }
    });
    it('the walk stops at a tag that is no complete block — a <pic> tag, a self-closing tag, a block never closed — and at the story block\'s close', () => {
        const at = (text) => placeLeadAndEndText(text, { leadText: 'B' }, STORY).text;
        expect(at('<pic char="A" prompt="x">\nstory')).toBe('<LeadText>B</LeadText>\n\n<pic char="A" prompt="x">\nstory');
        expect(at('<background scene="x"/>\nstory')).toBe('<LeadText>B</LeadText>\n\n<background scene="x"/>\nstory');
        expect(at('<konatan_planning~>\nplan, never closed\nstory')).toBe('<LeadText>B</LeadText>\n\n<konatan_planning~>\nplan, never closed\nstory');
        expect(at('<tucao>t</tucao><gametxt></gametxt>')).toBe('<tucao>t</tucao><gametxt>\n\n<LeadText>B</LeadText>\n\n</gametxt>');
    });
    it('tag names in any letter case, blanks before a closing tag\'s `>`, comments, and a beat the shaper marked', () => {
        expect(placeLeadAndEndText('<!-- note -->\n<Tucao>t</TUCAO >\n<MainText>\nstory\n</MainText>', { leadText: 'B' }, STORY).text)
            .toBe('<!-- note -->\n<Tucao>t</TUCAO >\n<MainText>\n<LeadText>B</LeadText>\n\nstory\n</MainText>');
        expect(placeLeadAndEndText('<maintext>\n<p><!--gc:unplaced-->roll</p>', { leadText: 'B' }, STORY).text)
            .toBe('<maintext>\n<LeadText>B</LeadText>\n\n<p><!--gc:unplaced-->roll</p>');
    });
    it('MUTATION TARGET — a card that names no story block gets no lead text: the reply untouched, the end text still written', () => {
        const r = placeLeadAndEndText(reply, { leadText: 'BAR', endText: 'END' });
        expect(r.text).toBe(reply + '\n\n<EndText>END</EndText>');
        expect(r.undeclared).toEqual(['leadText']);
        expect(r.actions).toEqual({ leadText: 'undeclared', endText: 'placed' });
        expect(placeLeadAndEndText(reply, { leadText: 'BAR' }, { storyEnvelope: [] }).actions.leadText).toBe('undeclared');
    });
    it('removing a placed lead text gives back the reply it was placed into', () => {
        for (const text of [reply, raw, shaped]) {
            const placed = placeLeadAndEndText(text, { leadText: 'BAR' }, STORY).text;
            expect(placeLeadAndEndText(placed, { leadText: '' }, STORY).text).toBe(text);
        }
    });
    it('places the end text directly above the menu placeholder', () => {
        const withMenu = reply + '\n\n<RES_Variable>r</RES_Variable>\n\n' + MENU;
        const r = placeLeadAndEndText(withMenu, { endText: 'END' });
        expect(r.text).toBe(reply + '\n\n<RES_Variable>r</RES_Variable>\n\n<EndText>END</EndText>\n\n' + MENU);
    });
    it('MUTATION TARGET — before MVU appends the placeholder the end text closes the reply, so the placeholder lands below it', () => {
        const r = placeLeadAndEndText(reply + '\n', { endText: 'END' });
        expect(r.text).toBe(reply + '\n\n<EndText>END</EndText>');
        const afterMvu = r.text + '\n\n' + MENU;   // MVU appends the placeholder after its listeners return
        expect(afterMvu.indexOf('</EndText>')).toBeLessThan(afterMvu.indexOf(MENU));
    });
    it('MUTATION TARGET — a later resolve refreshes the block where it stands, never adds a second one', () => {
        const once = placeLeadAndEndText(reply, { leadText: 'OLD', endText: 'E1' }, STORY).text;
        const r = placeLeadAndEndText(once, { leadText: 'NEW', endText: 'E2' }, STORY);
        expect(r.text).toBe(withBar('NEW') + '\n\n<EndText>E2</EndText>');
        expect(r.actions).toEqual({ leadText: 'refreshed', endText: 'refreshed' });
        // A block another writer moved (galgame's envelope repair wraps it in a paragraph) is refreshed where it is.
        const moved = '<maintext>\n<p><LeadText>OLD</LeadText></p>\n<p>story</p>';
        expect(placeLeadAndEndText(moved, { leadText: 'NEW' }, STORY).text).toBe('<maintext>\n<p><LeadText>NEW</LeadText></p>\n<p>story</p>');
    });
    it('the same text again changes nothing', () => {
        const once = placeLeadAndEndText(reply, { leadText: 'BAR' }, STORY).text;
        const r = placeLeadAndEndText(once, { leadText: 'BAR' }, STORY);
        expect(r.text).toBe(once);
        expect(r.actions.leadText).toBe('unchanged');
    });
    it('a field the resolve did not return leaves its block as it is', () => {
        const once = placeLeadAndEndText(reply, { leadText: 'BAR' }, STORY).text;
        expect(placeLeadAndEndText(once, { endText: null }, STORY).text).toBe(once);
    });
    it('an empty string removes the block and the blank line it brought', () => {
        const both = placeLeadAndEndText(reply + '\n\n' + MENU, { leadText: 'BAR', endText: 'END' }, STORY).text;
        const r = placeLeadAndEndText(both, { leadText: '', endText: '  ' }, STORY);
        expect(r.text).toBe(reply + '\n\n' + MENU);
        expect(r.actions).toEqual({ leadText: 'removed', endText: 'removed' });
    });
    it('a value that is not a string is skipped, the reply untouched', () => {
        const r = placeLeadAndEndText(reply, { leadText: 42 }, STORY);
        expect(r.text).toBe(reply);
        expect(r.skipped).toEqual(['leadText']);
    });
    it('MUTATION TARGET — text carrying a page-code token is refused, the reply untouched', () => {
        const r = placeLeadAndEndText(reply, { endText: 'x <% run %>' });
        expect(r.text).toBe(reply);
        expect(r.refused).toEqual([{ field: 'endText', token: '<%', isOwnTag: false }]);
    });
    it('text carrying one of the two tags is refused: the block would no longer be found again', () => {
        const r = placeLeadAndEndText(reply, { leadText: 'a </EndText> b' }, STORY);
        expect(r.text).toBe(reply);
        expect(r.refused).toEqual([{ field: 'leadText', token: '</EndText>', isOwnTag: true }]);
    });
    it('a reply carrying an opening tag without its close is not written, never guessed at', () => {
        const cut = '<LeadText>[ bar\n' + reply;
        const r = placeLeadAndEndText(cut, { leadText: 'BAR' }, STORY);
        expect(r.text).toBe(cut);
        expect(r.unpaired).toEqual([{ field: 'leadText', tag: 'LeadText' }]);
        expect(r.actions.leadText).toBe('unpaired');
    });
    it('MUTATION TARGET — an opening tag quoted earlier never widens the block: the pair is the nearest opener', () => {
        const quoted = '<think>the game writes <LeadText> itself</think>\n<LeadText>OLD</LeadText>\n\n' + reply;
        expect(placeLeadAndEndText(quoted, { leadText: 'NEW' }, STORY).text)
            .toBe('<think>the game writes <LeadText> itself</think>\n<LeadText>NEW</LeadText>\n\n' + reply);
    });
    it('the engine\'s text is written literally — `$&` is no replacement pattern', () => {
        const r = placeLeadAndEndText(reply + '\n\n' + MENU, { endText: 'costs $& and $1' });
        expect(r.text).toContain('<EndText>costs $& and $1</EndText>\n\n' + MENU);
    });
});

describe('REPLY_TAIL_ANCHORS — a block another writer puts above the menu goes above the end text', () => {
    it('MUTATION TARGET — above the end text when the reply has one, so that text stays directly above the menu', () => {
        const text = 'story\n\n<EndText>END</EndText>\n\n<StatusPlaceHolderImpl/>';
        expect(placeAboveFirstAnchor(text, '<POSTUpdateVariable>p</POSTUpdateVariable>', REPLY_TAIL_ANCHORS))
            .toBe('story\n\n<POSTUpdateVariable>p</POSTUpdateVariable>\n\n<EndText>END</EndText>\n\n<StatusPlaceHolderImpl/>');
    });
    it('above the menu placeholder when the reply has no end text', () => {
        expect(placeAboveFirstAnchor('story\n\n<StatusPlaceHolderImpl/>', 'B', REPLY_TAIL_ANCHORS)).toBe('story\n\nB\n\n<StatusPlaceHolderImpl/>');
    });
});

describe('stripLeadAndEndText — the reply without the engine\'s text, for a reader that must not take it for the narrator\'s', () => {
    it('removes both blocks and leaves everything else', () => {
        expect(stripLeadAndEndText('<LeadText>BAR</LeadText>\n\nShe smiled.\n\n<EndText>END</EndText>\n\n<StatusPlaceHolderImpl/>'))
            .toBe('\n\nShe smiled.\n\n\n\n<StatusPlaceHolderImpl/>');
    });
    it('a text with neither block, or a tag without its partner, is returned as it is', () => {
        expect(stripLeadAndEndText('plain')).toBe('plain');
        expect(stripLeadAndEndText('<LeadText>cut off')).toBe('<LeadText>cut off');
    });
});

describe('the card\'s leadText section — normalize / serialize / configured / read', () => {
    const newReport = () => ({ retired: [], unknown: [], blocked: [] });

    it('a valid section keeps its tags, trimmed, and reports nothing', () => {
        const report = newReport();
        expect(normalizeLeadTextSection({ storyEnvelope: [' <gametxt> ', '<maintext>'] }, report)).toEqual({ storyEnvelope: ['<gametxt>', '<maintext>'] });
        expect(report).toEqual(newReport());
    });
    it('absent is null and says nothing; a section that is no object is ignored, said so', () => {
        const report = newReport();
        expect(normalizeLeadTextSection(undefined, report)).toBe(null);
        expect(report).toEqual(newReport());
        expect(normalizeLeadTextSection(['<gametxt>'], report)).toBe(null);
        expect(report.blocked.map((b) => b.path)).toEqual(['leadText']);
    });
    it('MUTATION TARGET — an entry that is no bare opening tag is dropped and named; no usable tag left drops the section', () => {
        const report = newReport();
        expect(normalizeLeadTextSection({ storyEnvelope: ['gametxt', '<maintext class="x">', '', 3, '</gametxt>', '<maintext>'], extra: 1 }, report))
            .toEqual({ storyEnvelope: ['<maintext>'] });
        expect(report.blocked.map((b) => b.path)).toEqual([0, 1, 2, 3, 4].map((i) => `leadText.storyEnvelope[${i}]`));
        expect(report.unknown).toEqual([{ path: 'leadText.extra', key: 'extra' }]);
        const none = newReport();
        expect(normalizeLeadTextSection({ storyEnvelope: ['gametxt'] }, none)).toBe(null);
        expect(none.blocked.map((b) => b.path)).toEqual(['leadText.storyEnvelope[0]', 'leadText.storyEnvelope']);
        const notList = newReport();
        expect(normalizeLeadTextSection({ storyEnvelope: '<gametxt>' }, notList)).toBe(null);
        expect(notList.blocked.map((b) => b.path)).toEqual(['leadText.storyEnvelope']);
    });
    it('serialize round-trips through normalize; an unconfigured section serializes to nothing', () => {
        const section = { storyEnvelope: ['<gametxt>', '<maintext>'] };
        const report = newReport();
        expect(normalizeLeadTextSection(JSON.parse(JSON.stringify(serializeLeadTextSection(section))), report)).toEqual(section);
        expect(report).toEqual(newReport());
        expect(serializeLeadTextSection(null)).toBe(undefined);
    });
    it('configured = at least one tag; storyEnvelopeOf reads the profile, null while it names none', () => {
        expect(isLeadTextConfigured({ storyEnvelope: ['<gametxt>'] })).toBe(true);
        expect(isLeadTextConfigured({ storyEnvelope: [] })).toBe(false);
        expect(isLeadTextConfigured(null)).toBe(false);
        expect(storyEnvelopeOf({ leadText: { storyEnvelope: ['<gametxt>'] } })).toEqual(['<gametxt>']);
        expect(storyEnvelopeOf({ leadText: null })).toBe(null);
        expect(storyEnvelopeOf(undefined)).toBe(null);
    });
});

describe('resolverWritesReplyText — does a resolve carry text for the reply?', () => {
    it('any one of the three fields is enough; none, or no result, is not', () => {
        expect(resolverWritesReplyText({ textReplacements: {} })).toBe(true);
        expect(resolverWritesReplyText({ leadText: '' })).toBe(true);
        expect(resolverWritesReplyText({ endText: 'E' })).toBe(true);
        expect(resolverWritesReplyText({ statData: {}, applied: true })).toBe(false);
        expect(resolverWritesReplyText(null)).toBe(false);
    });
});

describe('isStagedBlockStale — the staged <RES_Variable> must not outlive its generation', () => {
    // THE LIVE BUG (2026-08-22). Message 2 was generated twice: a Flirt roll, then a regenerated
    // Support roll. POST reads the staged marker by {mid,swipe} only, and a REGEN preserves both, so
    // the second generation's POST gate hit the FIRST generation's marker — still `done`, still
    // holding its block — resolved on it instantly, and decideResCarry preferred that gate hit over
    // the fresh block. The reply shipped its real prose under the dead take's audit: Affection 19,
    // Mood "Playful", from a check that existed in no surviving generation. stat_data was right the
    // whole time, which is exactly why a wrong audit is worse than none — it reads authoritative.
    const marker = (epoch) => ({ mid: 2, swipe: 0, done: true, block: '<RES_Variable>[]</RES_Variable>', epoch });

    it('drops a marker staged by an EARLIER generation — the regen case itself', () => {
        expect(isStagedBlockStale(marker(3), 4)).toBe(true);
    });

    it('keeps a marker stamped with the generation now starting', () => {
        expect(isStagedBlockStale(marker(4), 4)).toBe(false);
    });

    it('is a no-op when nothing is staged', () => {
        expect(isStagedBlockStale(undefined, 4)).toBe(false);
        expect(isStagedBlockStale(null, 4)).toBe(false);
    });

    // An epoch-less marker means a BAKED card resolver staged it — that path is deleted (R5), and
    // turn-runner already refuses to let one block a resolve. It must not be trusted for display
    // either: unstamped means unattributable, and an unattributable audit is the failure this fixes.
    it('drops an epoch-less marker (a baked resolver staged it — unattributable)', () => {
        expect(isStagedBlockStale({ mid: 2, swipe: 0, done: true, block: 'x' }, 4)).toBe(true);
    });

    // Epoch 0 is a real generation number, not "absent" — a falsy-check here would keep the very
    // first generation's corpse alive across the second.
    it('treats epoch 0 as a real generation, not as missing', () => {
        expect(isStagedBlockStale(marker(0), 1)).toBe(true);
        expect(isStagedBlockStale(marker(0), 0)).toBe(false);
    });

    // The identity POST keys on is deliberately NOT consulted: a regen keeps mid and swipe, so
    // matching on them is what let the corpse through. Staleness is the epoch's question alone.
    it('ignores mid/swipe — a regen keeps both, which is the whole reason they cannot decide this', () => {
        expect(isStagedBlockStale({ mid: 99, swipe: 7, done: true, block: 'x', epoch: 3 }, 4)).toBe(true);
        expect(isStagedBlockStale({ mid: 99, swipe: 7, done: true, block: 'x', epoch: 4 }, 4)).toBe(false);
    });
});


// THE POST RELAY — one plan for every card kind. A parse that is not narrate's turn to resolve takes the
// one relay executor; which halves run differs by card, the save of POST's parse never does.
describe('postRelayPlan — what a parse that is not narrate\'s turn does', () => {
    const engine = { resolveTurn: () => {}, resolvePostRelay: () => {} };
    const decliner = { resolveTurn: () => {} };
    const on = { isProfileEnabled: true };

    it('a re-fire on an engine that offers the relay runs the game half, then the plugins', () => {
        expect(postRelayPlan({ ...on, isRefire: true, writer: 'post', gameStatus: 'loaded', engineApi: engine }))
            .toEqual({ runsGameHalf: true, runsPluginHalf: true, mode: '' });
    });

    it('MUTATION TARGET — a re-fire on an engine WITHOUT resolvePostRelay still runs the relay (plugins + the save)', () => {
        const plan = postRelayPlan({ ...on, isRefire: true, writer: 'post', gameStatus: 'loaded', engineApi: decliner });
        expect(plan).toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: 'alone (the game declines the relay)' });
    });

    it('NEVER calls a non-function resolvePostRelay — a card that puts a string there runs without the game half', () => {
        for (const resolvePostRelay of ['yes please', null, 1, {}]) {
            const plan = postRelayPlan({ ...on, isRefire: true, writer: 'post', gameStatus: 'loaded', engineApi: { resolveTurn: () => {}, resolvePostRelay } });
            expect(plan.runsGameHalf).toBe(false);
        }
    });

    it('a re-fire whose engine is gone says so instead of "declines"', () => {
        expect(postRelayPlan({ ...on, isRefire: true, writer: 'post', gameStatus: 'no-engine', engineApi: null }).mode).toBe('alone (no game engine loaded)');
    });

    it('MUTATION TARGET — POST\'s parse on a card with no game engine runs the plugins alone', () => {
        expect(postRelayPlan({ ...on, isRefire: false, writer: 'post', gameStatus: 'no-engine', engineApi: null }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: 'alone (no game engine)' });
    });

    it('MUTATION TARGET — POST\'s parse on a card whose engine cannot resolve is still a relay: no halves, the save only', () => {
        for (const gameStatus of ['error', 'book-not-ready', 'disabled']) {
            const plan = postRelayPlan({ ...on, isRefire: false, writer: 'post', gameStatus, engineApi: null });
            expect(plan).toEqual({ runsGameHalf: false, runsPluginHalf: false, mode: `the game engine is ${gameStatus}, nothing resolves` });
        }
    });

    it('MUTATION TARGET — with the logic engine OFF, POST\'s parse is still a relay (the save), and nothing else is', () => {
        expect(postRelayPlan({ isProfileEnabled: false, isRefire: false, writer: 'post', gameStatus: 'loaded', engineApi: engine }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: false, mode: 'logic engine off, nothing resolves' });
        expect(postRelayPlan({ isProfileEnabled: false, isRefire: true, writer: 'message', gameStatus: 'loaded', engineApi: engine })).toBeNull();
    });

    it('POST\'s parse on a loaded engine that has NOT resolved this turn is not a relay — RES1 resolves it', () => {
        expect(postRelayPlan({ ...on, isRefire: false, writer: 'post', gameStatus: 'loaded', engineApi: engine })).toBeNull();
    });

    it('narrate\'s own parse is never a relay, on any card', () => {
        for (const gameStatus of ['loaded', 'no-engine', 'error', 'book-not-ready']) {
            expect(postRelayPlan({ ...on, isRefire: false, writer: 'message', gameStatus, engineApi: engine })).toBeNull();
        }
    });

    it('a pre-sim echo, a plugin relay echo, a menu action and a host lane are not relays either', () => {
        for (const writer of ['pre-sim', 'plugin:lane-probe', 'statusmenu:menu', 'host', '', undefined]) {
            expect(postRelayPlan({ ...on, isRefire: false, writer, gameStatus: 'no-engine', engineApi: null })).toBeNull();
        }
    });

    it('survives being called with nothing at all', () => {
        expect(postRelayPlan()).toBeNull();
        expect(postRelayPlan({})).toBeNull();
    });
});

// ONE save rule for RES1 and every relay fire. POST's parse applies onto a copy, and this save is the only
// thing that persists it — so a fire carrying it saves whatever the resolvers did.
describe('turnSavePlan — does this fire save, and what does the saved line name?', () => {
    it('MUTATION TARGET — a fire carrying POST\'s parse ALWAYS saves, even when no resolver wrote', () => {
        expect(turnSavePlan({ isPostParse: true })).toEqual({ shouldSave: true, label: "POST's ops" });
    });

    it('MUTATION TARGET — an engine that applied saves, with no POST parse in the fire', () => {
        expect(turnSavePlan({ didGameApply: true })).toEqual({ shouldSave: true, label: 'engine' });
    });

    it('MUTATION TARGET — plugin writes alone save (the POST-done trigger)', () => {
        expect(turnSavePlan({ didPluginsApply: true })).toEqual({ shouldSave: true, label: 'plugins' });
    });

    it('nothing carried and nothing applied saves nothing — narrate\'s own parse is MVU\'s to save', () => {
        expect(turnSavePlan({})).toEqual({ shouldSave: false, label: '' });
        expect(turnSavePlan()).toEqual({ shouldSave: false, label: '' });
    });

    it('the label lists everything the save carries, in one order', () => {
        expect(turnSavePlan({ isPostParse: true, didGameApply: true, didPluginsApply: true }).label).toBe("POST's ops + engine + plugins");
    });

    it('only a real true counts', () => {
        expect(turnSavePlan({ isPostParse: 'yes', didGameApply: 1, didPluginsApply: {} }).shouldSave).toBe(false);
    });
});

// The plugin half for every reply no POST parse fired the relay for.
describe('postSilentRelayPlan — the relay for a reply POST parsed nothing for', () => {
    const ENGINE = { resolveTurn() {} };
    const run = (fields) => postSilentRelayPlan({ lastFiredKey: '', turnFireKey: '7:48:0', ...fields });

    it('a card with no game engine runs the plugin half, and the mode says what POST did', () => {
        expect(run({ gameStatus: 'no-engine', postOutcome: 'no-block' }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: 'alone (no game engine, POST wrote nothing)' });
        expect(run({ gameStatus: 'no-engine', postOutcome: 'no-calls' }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: 'alone (no game engine, no POST call this reply)' });
    });

    it('MUTATION TARGET — a card whose engine resolves turns runs the plugin half too', () => {
        expect(run({ gameStatus: 'loaded', engineApi: ENGINE, postOutcome: 'no-calls' }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: 'alone (no POST call this reply)' });
        expect(run({ gameStatus: 'loaded', engineApi: ENGINE, postOutcome: 'no-block' }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: 'alone (POST wrote nothing)' });
        expect(run({ gameStatus: 'loaded', engineApi: ENGINE, postOutcome: 'resolved-by-res1' }))
            .toEqual({ runsGameHalf: false, runsPluginHalf: true, mode: "alone (RES1 resolved POST's parse)" });
    });

    it('MUTATION TARGET — an engine that cannot resolve runs nothing, as on POST\'s parse', () => {
        for (const gameStatus of ['loaded', 'error', 'book-not-ready', 'disabled', '', undefined]) {
            expect(run({ gameStatus, engineApi: { resolvePostRelay() {} }, postOutcome: 'no-block' })).toBeNull();
            expect(run({ gameStatus, engineApi: null, postOutcome: 'no-block' })).toBeNull();
        }
    });

    it('MUTATION TARGET — the SAME turn already fired is never fired twice, so the two triggers cannot both write', () => {
        expect(run({ gameStatus: 'no-engine', postOutcome: 'no-block', lastFiredKey: '7:48:0' })).toBeNull();
        expect(run({ gameStatus: 'loaded', engineApi: ENGINE, postOutcome: 'no-calls', lastFiredKey: '7:48:0' })).toBeNull();
    });

    it('the same message in a new generation, or another swipe, is a new turn', () => {
        expect(run({ gameStatus: 'no-engine', postOutcome: 'no-block', lastFiredKey: '7:48:0', turnFireKey: '8:48:0' })).not.toBeNull();
        expect(run({ gameStatus: 'no-engine', postOutcome: 'no-block', lastFiredKey: '7:48:0', turnFireKey: '7:48:1' })).not.toBeNull();
    });

    it('no turn identity means nothing to fire for — never a guess', () => {
        for (const turnFireKey of ['', undefined, null, 0, {}]) {
            expect(run({ gameStatus: 'no-engine', postOutcome: 'no-block', turnFireKey })).toBeNull();
        }
    });

    it('MUTATION TARGET — an unknown outcome is a caller bug and throws, never a silent skip', () => {
        expect(() => run({ gameStatus: 'no-engine', postOutcome: 'nothing' })).toThrow(/unknown postOutcome/);
        expect(() => postSilentRelayPlan()).toThrow(/unknown postOutcome/);
    });
});

// The settle record: narrate's parse and the post-reply phase arrive in either order.
describe('noteReplySettled — both halves of a reply, in either order', () => {
    it('MUTATION TARGET — parse first, then POST-done: ready on the second note only', () => {
        const a = noteReplySettled(null, { fireKey: '3:12:0', isParsed: true });
        expect(a.isReady).toBe(false);
        const b = noteReplySettled(a.record, { fireKey: '3:12:0', postOutcome: 'no-calls' });
        expect(b.isReady).toBe(true);
        expect(b.record).toEqual({ fireKey: '3:12:0', isParsed: true, postOutcome: 'no-calls' });
    });

    it('MUTATION TARGET — POST-done first, then the parse: ready on the parse', () => {
        const a = noteReplySettled(null, { fireKey: '3:12:0', postOutcome: 'no-block' });
        expect(a.isReady).toBe(false);
        expect(noteReplySettled(a.record, { fireKey: '3:12:0', isParsed: true }).isReady).toBe(true);
    });

    it('MUTATION TARGET — a note for another reply starts over: a stale half never completes a new reply', () => {
        const a = noteReplySettled(null, { fireKey: '3:12:0', isParsed: true });
        const b = noteReplySettled(a.record, { fireKey: '4:12:0', postOutcome: 'no-calls' });
        expect(b.isReady).toBe(false);
        expect(b.record).toEqual({ fireKey: '4:12:0', isParsed: false, postOutcome: 'no-calls' });
    });

    it('one note can carry both halves (RES1 resolved POST\'s parse)', () => {
        expect(noteReplySettled(null, { fireKey: '3:12:0', isParsed: true, postOutcome: 'resolved-by-res1' }).isReady).toBe(true);
    });

    it('MUTATION TARGET — a late duplicate note after completion never asks again', () => {
        const done = noteReplySettled(noteReplySettled(null, { fireKey: '3:12:0', isParsed: true }).record,
            { fireKey: '3:12:0', postOutcome: 'no-calls' });
        expect(done.isReady).toBe(true);
        expect(noteReplySettled(done.record, { fireKey: '3:12:0', isParsed: true }).isReady).toBe(false);
        expect(noteReplySettled(done.record, { fireKey: '3:12:0', postOutcome: 'no-block' }).isReady).toBe(false);
    });

    it('only a real true marks the parse', () => {
        expect(noteReplySettled(null, { fireKey: '3:12:0', isParsed: 'yes', postOutcome: 'no-calls' }).isReady).toBe(false);
    });
});

// The executor lives in the host-coupled turn-runner.js, so "one path" is gated as SOURCE: every relay
// fire reaches runPostRelay, and the only two saves in the file are RES1's and the relay's.
describe('SOURCE GATE — one relay executor, one save per writer', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/logic-engine/turn-runner.js'), 'utf8');
    const calls = (name) => (src.match(new RegExp('(?<!function )\\b' + name + '\\(', 'g')) || []).length;

    it('MUTATION TARGET — fenceAndSaveTurn is called from exactly two places: runLive and runPostRelay', () => {
        expect(calls('fenceAndSaveTurn')).toBe(2);
        const live = src.slice(src.indexOf('async function runLive'), src.indexOf('// ── the event handler'));
        const relay = src.slice(src.indexOf('async function runPostRelay'), src.indexOf('// ── the POST-done trigger'));
        expect(live).toMatch(/fenceAndSaveTurn\(/);
        expect(relay).toMatch(/fenceAndSaveTurn\(/);
    });

    it('MUTATION TARGET — both relay triggers hand their plan to runPostRelay, and nothing else runs a half', () => {
        expect(calls('runPostRelay')).toBe(2);
        expect(calls('runGameRelayHalf')).toBe(1);
        expect(calls('runPluginRelayHalf')).toBe(1);
        const handler = src.slice(src.indexOf('async function onVariableUpdateEnded'), src.indexOf('// ── in-flight handler runs'));
        expect(handler).toMatch(/const plan = postRelayPlan\(/);
        expect(handler).toMatch(/await runPostRelay\(\{ plan,/);
    });
});

// The call site lives in the host-coupled turn-runner.js, so its two load-bearing lines are gated as
// SOURCE: mvu-helper's own suppressed parses are exempt (a menu action on an old message would read as
// foreign), and a foreign parse returns before op collection and the resolve.
describe('SOURCE GATE — the turn runner asks endedEventDisposition first, and a foreign parse stops there', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/logic-engine/turn-runner.js'), 'utf8');
    const handler = src.slice(src.indexOf('async function onVariableUpdateEnded'), src.indexOf('// ── in-flight handler runs'));

    it('MUTATION TARGET — mvu-helper\'s own suppressed parses skip the check', () => {
        expect(handler).toMatch(/if \(!suppressed\) \{\s*const verdict = endedEventDisposition\(/);
    });

    it('MUTATION TARGET — a foreign parse reports and returns before op collection and the resolve', () => {
        expect(handler).toMatch(/if \(verdict\.disposition === 'foreign'\) \{ reportForeignParse\(verdict\); return; \}/);
        expect(handler.indexOf('endedEventDisposition(')).toBeLessThan(handler.indexOf('diffStatOps('));
        expect(handler.indexOf('endedEventDisposition(')).toBeLessThan(handler.indexOf('runLive('));
    });
});

// The turn's saves go through the bridge's save door, which announces every save (tests/mvu-bridge-core.test.js).
describe('SOURCE GATE — the turn runner saves through the save door, and the StatusMenu hears every save', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/logic-engine/turn-runner.js'), 'utf8');
    const save = src.slice(src.indexOf('async function fenceAndSaveTurn'), src.indexOf('// ── ', src.indexOf('async function fenceAndSaveTurn')));

    it('MUTATION TARGET — fenceAndSaveTurn saves through saveMessageMvuData, named by its stage', () => {
        expect(save).toMatch(/if \(!\(await saveMessageMvuData\(mvuData, mid, \{ writer: stage \}\)\)\) return false;/);
        expect(save).not.toMatch(/replaceMvuData\(/);
    });
    it('MUTATION TARGET — the StatusMenu frame pushes the saved state on every save', () => {
        const frame = readFileSync(path.join(process.cwd(), 'src/features/statusmenu-pack/statusmenu-frame.js'), 'utf8');
        expect(frame).toMatch(/eventSource\.on\(MVU_STATE_SAVED_EVENT, \(\) => \{ pushMenuState\('state saved'\)/);
    });
});

// The engine writes an audit's BODY; mvu-helper owns the tag around it, because mvu-helper is what
// must find the block again (POST's already-present check, the relay block's anchor).
describe('the audit blocks — the engine writes the body, mvu-helper owns the tag', () => {
    it('wraps a body in the given tag — the exact shape the reply carried when the engine wrapped it itself', () => {
        const body = '[\n  {"op":"replace","path":"/Stats/Focus/0","value":3}\n]';
        expect(wrapAuditBlock(body, TURN_AUDIT_TAG)).toBe('<RES_Variable>\n' + body + '\n</RES_Variable>');
        expect(wrapAuditBlock('  x  ', RELAY_AUDIT_TAG)).toBe('<RES_POST_Variable>\nx\n</RES_POST_Variable>');
    });
    it('an empty body is no block at all — never an empty pair of tags', () => {
        for (const empty of ['', '   ', null, undefined]) expect(wrapAuditBlock(empty, TURN_AUDIT_TAG)).toBe('');
    });
    it('spots a body that still carries either audit tag (an engine built before mvu-helper owned them)', () => {
        expect(auditBodyCarriesTag('<RES_Variable>\n[]\n</RES_Variable>')).toBe(true);
        expect(auditBodyCarriesTag('[]\n</RES_POST_Variable>')).toBe(true);
        expect(auditBodyCarriesTag('[\n  {"path":"/Notes/RES_Variable_count"}\n]')).toBe(false);
        expect(auditBodyCarriesTag(null)).toBe(false);
    });
});
