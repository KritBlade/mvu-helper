// tests/artifact-dev-loop-core.test.js — the dev loop's decisions (artifact-dev-loop-core.js, W3).
// The host file owns EventSource and the DOM; everything it DECIDES is here, testable (L6). The
// stakes: a dev loop that silently skips an artifact is a developer hunting a bug that is a skip.

import { describe, it, expect } from 'vitest';
import { readWorkspacePayload, planDevApply, devApplyLogLine, isBootOrderRefusal, isBootOrderAction, planSectionApply, isSetupRefusal, devLoopStatus, devApplyOutcome, shouldAskAgainThisBoot, pruneBootScopedDeclines, devLoopAdoptQuestion, capturedRegexOrder, declaredRegexOrderOf, devCardDisposition, devCardAnswer, pruneBootScopedAnswers, devCardQuestion, devCardArtifactLine, DEV_CARD_QUESTION_BUTTONS, cardFencePlan, mergeQueuedChanges } from '../src/features/artifact-dev-loop/artifact-dev-loop-core.js';
import { dialogLineText } from '../src/sillytavern/popup-core.js';

// The dev loop's questions are dialog lines; read as plain English for the assertions.
const asText = (lines) => lines.map(dialogLineText);
import { decideMenuActivation } from '../src/features/statusmenu-pack/statusmenu-pack-core.js';
import { decideActivation } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { decidePluginInstall } from '../src/features/gamelogic-plugin/gamelogic-plugin-core.js';

const LANES = new Set(['gamelogic', 'statusmenu', 'plugin']);
const art = (over = {}) => ({ name: 'gamelogic', pack: { packType: 'gamelogic', id: 'school-v4', version: '5.56' }, errors: [], warnings: [], ...over });

describe('readWorkspacePayload — the server answer, shape-checked', () => {
    it('a real payload passes with its version', () => {
        const r = readWorkspacePayload({ version: 7, artifacts: [art()] });
        expect(r.ok).toBe(true);
        expect(r.version).toBe(7);
        expect(r.artifacts.length).toBe(1);
    });
    it('not-a-payload is named, never iterated', () => {
        for (const bad of [null, 'hi', {}, { artifacts: 'x' }]) {
            const r = readWorkspacePayload(bad);
            expect(r.ok).toBe(false);
            expect(r.error).toContain('dev server');
            expect(r.artifacts).toEqual([]);
        }
    });
});

describe('planDevApply — every skip carries its reason', () => {
    it('clean artifacts with known lanes apply', () => {
        const { apply, skip } = planDevApply([art(), art({ name: 'statusmenu', pack: { packType: 'statusmenu', id: 'artifickoi' } })], LANES);
        expect(apply.length).toBe(2);
        expect(skip.length).toBe(0);
    });
    it('an artifact that did not assemble skips, pointing at the server console', () => {
        const { apply, skip } = planDevApply([art({ pack: null })], LANES);
        expect(apply.length).toBe(0);
        expect(skip[0].reason).toContain('did not assemble');
    });
    it('an artifact with errors skips naming the first error', () => {
        const { skip } = planDevApply([art({ errors: ['engineOrder names "x.cjs", which is not in engine/'] })], LANES);
        expect(skip[0].reason).toContain('engineOrder names "x.cjs"');
    });
    it('an unknown packType skips naming the type, never guesses a lane', () => {
        const { skip } = planDevApply([art({ pack: { packType: 'eventpack', id: 'x' } })], LANES);
        expect(skip[0].reason).toContain('"eventpack"');
    });
});

describe('planDevApply — the change narrows the apply to touched artifacts', () => {
    const two = () => [art(), art({ name: 'statusmenu', pack: { packType: 'statusmenu', id: 'artifickoi' } })];
    it('an engine save in gamelogic/ applies gamelogic ALONE — an untouched artifact re-applied is an extra chat reload', () => {
        const { apply, skip } = planDevApply(two(), LANES, ['gamelogic/engine/globalLogic.cjs']);
        expect(apply.map((a) => a.name)).toEqual(['gamelogic']);
        expect(skip.length).toBe(0);
    });
    it('the initial full apply (no files) takes everything', () => {
        expect(planDevApply(two(), LANES, []).apply.length).toBe(2);
    });
    it('a touched artifact still reports its own errors', () => {
        const { skip } = planDevApply([art({ errors: ['boom'] })], LANES, ['gamelogic/pack.json']);
        expect(skip[0].reason).toContain('boom');
    });
});

describe('devApplyLogLine — the §6 requirement: which artifact, which files, what happened', () => {
    it('names type, id, version, files and the action', () => {
        const line = devApplyLogLine({ packType: 'gamelogic', id: 'school-v4', version: '5.56' }, ['gamelogic/engine/globalLogic.cjs'], 'upgrade');
        expect(line).toContain('gamelogic "school-v4" v5.56');
        expect(line).toContain('gamelogic/engine/globalLogic.cjs');
        expect(line).toContain('upgrade');
    });
    it('the initial full apply says so instead of listing nothing', () => {
        expect(devApplyLogLine({ packType: 'statusmenu', id: 'm' }, [], 'install')).toContain('initial full apply');
    });
    it('a burst truncates with a count, never an unbounded line', () => {
        const line = devApplyLogLine({ packType: 'gamelogic', id: 'g' }, ['a', 'b', 'c', 'd', 'e'], 'ok');
        expect(line).toContain('(+2)');
    });
});

describe('the boot-order class — retries on CHAT_CHANGED instead of toasting', () => {
    // The LIBRARY half has no action, only error prose, so it is matched by text.
    it('isBootOrderRefusal matches the library write\'s own refusal texts', () => {
        for (const reason of [
            'the library worldbook "MVU_GameLogic_Library" could not be created (lorebook API unavailable — see the warning above)',
            'this pack ships a schema, and the TavernHelper script API is not attached yet — cannot check for a card-owned "Scheme" script or write ours. Retry in a moment.',
            'this card\'s worldbook could not be read yet — it is still loading, or the lorebook API is not attached. Retry in a moment.',
        ]) expect(isBootOrderRefusal([reason])).toBe(true);
    });

    // ▲ THE ACTIVATION HALF, FROM THE LANES THEMSELVES. The retired version of this block asserted
    // `isBootOrderRefusal(['no chat is open'])` — a string NO lane emits, typed by hand. It passed
    // while every real refusal fell through, because each lane actually says "open a chat first — …",
    // which contains none of the words that predicate greps. Live 2026-09-04: closing a chat to the
    // lobby toasted "1 artifact(s) failed to apply".
    //
    // These cases call the REAL decide functions, so a reworded reason cannot un-guard this silently
    // and a renamed action fails here rather than in a toast.
    const ACCESS = { isCardOpen: false, isChatStarted: false, areEntriesReadable: false };
    const lobbyRefusals = () => [
        decideMenuActivation({ ...ACCESS, pack: { packType: 'statusmenu', id: 'm', format: '1.0', name: 'M', description: 'd' } }),
        decideActivation({ ...ACCESS, pack: { packType: 'gamelogic', id: 'g', format: '1.0', name: 'G', description: 'd' } }),
        decidePluginInstall({ ...ACCESS, plugin: { packType: 'plugin', id: 'p', format: '1.0', name: 'P', description: 'd' } }),
    ];

    it('every lane refuses the lobby with a boot-order ACTION the loop retries on', () => {
        for (const refusal of lobbyRefusals()) {
            expect(refusal.action).toBe('no-chat');
            expect(isBootOrderAction(refusal.action)).toBe(true);
        }
    });

    // MUTATION-PINNED: this is the assertion whose absence let the bug ship. It states the thing that
    // was false — the prose alone does not carry the class — so nobody "simplifies" the action check
    // away on the theory that the text check already covers it.
    it('and their PROSE alone does NOT carry the class — the action is load-bearing, not decoration', () => {
        for (const refusal of lobbyRefusals()) {
            expect(refusal.reasons[0]).toMatch(/^open a chat first/);
            expect(isBootOrderRefusal(refusal.reasons)).toBe(false);
        }
    });

    it('an unreadable card is boot-order too — it cures itself when the book answers', () => {
        expect(isBootOrderAction('card-unreadable')).toBe(true);
    });

    it('a real fault is NOT boot-order — it must toast, not silently wait', () => {
        for (const action of ['invalid', 'regex-api-down', '', undefined]) expect(isBootOrderAction(action)).toBe(false);
        for (const reason of [
            'pack.json: engineOrder names "x.cjs", which is not in engine/',
            'regex "RapidFire" has no find_regex',   // "rapid" must not match a bare /api/
            '', undefined,
        ]) expect(isBootOrderRefusal(reason === undefined ? [] : [reason])).toBe(false);
    });
});

describe('planSectionApply — §5: apply ONLY the changed section, or full when narrowing would guess', () => {
    it('an engine-only save plans engine ALONE — the regex sink (and its chat reload) stays untouched', () => {
        const r = planSectionApply(['gamelogic/engine/globalLogic.cjs'], 'gamelogic');
        expect(r).toEqual({ full: false, sections: ['engine'], why: 'engine' });
    });
    it('a burst across two sections plans both, sorted, and nothing else', () => {
        const r = planSectionApply(['gamelogic/regex/a.json', 'gamelogic/entries/windows/x.txt', 'gamelogic/entries/windows/x.json'], 'gamelogic');
        expect(r.full).toBe(false);
        expect(r.sections).toEqual(['entries', 'regex']);
    });
    it('the initial apply (no files) is FULL', () => {
        expect(planSectionApply([], 'gamelogic').full).toBe(true);
    });
    it('pack.json goes FULL — it can retarget every section', () => {
        const r = planSectionApply(['gamelogic/pack.json', 'gamelogic/engine/a.cjs'], 'gamelogic');
        expect(r.full).toBe(true);
        expect(r.why).toContain('pack.json');
    });
    it('an unrecognized path goes FULL — narrowing on a guess would silently not apply it', () => {
        const r = planSectionApply(['gamelogic/Tools/build.cjs'], 'gamelogic');
        expect(r.full).toBe(true);
        expect(r.why).toContain('Tools/build.cjs');
    });
    it("another artifact's files are not this artifact's evidence — FULL, said why", () => {
        const r = planSectionApply(['statusmenu/layout/layout.json'], 'gamelogic');
        expect(r.full).toBe(true);
    });
    it('a directory event and an editor temp file both resolve to their section (live: sedhee9hi)', () => {
        const r = planSectionApply(['gamelogic/engine', 'gamelogic/engine/sedhee9hi', 'gamelogic/engine/globalLogic.cjs'], 'gamelogic');
        expect(r).toEqual({ full: false, sections: ['engine'], why: 'engine' });
    });
    it('a single-artifact workspace (no name) reads sections from the path root', () => {
        const r = planSectionApply(['layout/layout.json'], '');
        expect(r).toEqual({ full: false, sections: ['layout'], why: 'layout' });
    });
    it('a panel/ save is its own section, not an unknown path (plugin-sidepanel.md §3)', () => {
        const r = planSectionApply(['plugin-outfit/panel/panel.json'], 'plugin-outfit');
        expect(r).toEqual({ full: false, sections: ['panel'], why: 'panel' });
    });
});

describe('mergeQueuedChanges — saves waiting behind a running apply are merged, never replaced', () => {
    const queue = (...saves) => saves.reduce((q, files) => mergeQueuedChanges(q, files), null);
    it('nothing waiting: the incoming save IS the queue', () => {
        expect(queue(['my-pack/engine/logic.cjs'])).toEqual(['my-pack/engine/logic.cjs']);
    });
    it('an engine save survives a later regex save — the queued apply still writes the engine', () => {
        const q = queue(['my-pack/engine/logic.cjs'], ['my-pack/regex/r.json']);
        expect(planSectionApply(q, 'my-pack').sections).toEqual(['engine', 'regex']);
    });
    it('saves in two artifacts keep BOTH artifacts in the plan', () => {
        const a = art({ name: 'pack-a' });
        const b = art({ name: 'pack-b', pack: { packType: 'gamelogic', id: 'pack-b', version: '1.0' } });
        const q = queue(['pack-a/engine/logic.cjs'], ['pack-b/regex/r.json']);
        expect(planDevApply([a, b], LANES, q).apply.map((x) => x.name)).toEqual(['pack-a', 'pack-b']);
    });
    it('a full apply already waiting absorbs later saves', () => {
        expect(queue([], ['my-pack/regex/r.json'])).toEqual([]);
    });
    it('a full apply arriving absorbs what waits', () => {
        expect(queue(['my-pack/regex/r.json'], [])).toEqual([]);
    });
    it('a file saved twice is listed once, first-seen order kept', () => {
        expect(queue(['my-pack/engine/logic.cjs'], ['my-pack/regex/r.json', 'my-pack/engine/logic.cjs']))
            .toEqual(['my-pack/engine/logic.cjs', 'my-pack/regex/r.json']);
    });
});

// A status line as the panel shows it, in English: a lead-in and its value joined by a colon.
const lineText = (line) => {
    if (!line) return '';
    if (Array.isArray(line.parts)) return line.parts.map((part) => part.text ?? part.code ?? part.name ?? '').join('');
    return line.text !== undefined && line.name !== undefined ? `${line.text}: ${line.name}` : String(line.text ?? line.name ?? '');
};

describe('devLoopStatus — the pill answers CONNECTED, the line answers everything else', () => {
    const on = (over = {}) => devLoopStatus({ enabled: true, connected: true, version: 7, applied: 3, openCardKey: 'card-a', appliedCardKey: 'card-a', ...over });

    it('off is neutral and says so — no connection is opened while the toggle is down', () => {
        expect(devLoopStatus({ enabled: false })).toEqual({ pill: { text: 'Off', status: 'neutral' }, message: null, counts: null });
    });
    it('DANGER is reserved for a server that is not connected — that is the only thing the colour reports', () => {
        const down = devLoopStatus({ enabled: true, transportProblem: 'unreachable' });
        expect(down.pill).toEqual({ text: 'Not connected', status: 'danger' });
        expect(lineText(down.message)).toContain('does not answer');
        expect(lineText(devLoopStatus({ enabled: true, transportProblem: 'no-url' }).message)).toContain('URL');
        expect(devLoopStatus({ enabled: true, connected: false }).pill).toEqual({ text: 'Connecting', status: 'neutral' });
    });
    it('SUCCESS when connected and everything applied, with the counts beside it', () => {
        const r = on();
        expect(r.pill).toEqual({ text: 'Connected', status: 'success' });
        expect(r.message).toBeNull();
        expect(lineText(r.counts)).toBe('Build #7 · 3 applied');
    });

    // THE LIVE BUG, 2026-08-28: gamelogic and statusmenu applied cleanly, the lane probe wanted its
    // one-time bindings click, and the line read "apply failed — see console" with an error toast.
    const setup = (id, hint, source = '') => ({ id, source, hint });
    it('a setup step is a WARNING, never danger — the connection is fine and the loop is working', () => {
        const r = on({ setupNeeded: [setup('lane-probe', 'needs a one-time install from the Pack library')] });
        expect(r.pill).toEqual({ text: 'Setup needed', status: 'warning' });
        expect(lineText(r.message)).not.toMatch(/failed/i);
    });
    it('and it NAMES the artifact and the fix — "one needs setup" sends nobody anywhere', () => {
        const r = on({ setupNeeded: [setup('lane-probe', 'needs a one-time install from the Pack library')] });
        expect(lineText(r.message)).toContain('"lane-probe"');
        expect(lineText(r.message)).toContain('Pack library');
    });
    // The SECOND live half, same day: the developer clicked Remove on the library row instead of
    // Install, and the line went on telling them to install from a row that no longer existed. The
    // instruction is the LANE's to phrase because only the lane can tell those two states apart —
    // this function must not paraphrase it, or one of the two is always wrong.
    it('the hint is printed VERBATIM, as data — the instruction differs by state, and only the lane knows which', () => {
        const gone = 'is not on this card and has no library copy — save any workspace file and the loop puts the copy back, then install it once';
        const r = on({ setupNeeded: [setup('lane-probe', gone)] });
        expect(r.message).toEqual({ parts: [{ name: '"lane-probe"' }, { name: ' ' + gone }] });
    });
    // THE THIRD LIVE ROUND, same day: the developer clicked Remove on the library row a SECOND time,
    // because the line never said where the artifact came from. The library copy is the loop's own
    // write — the workspace folder is the only thing a developer can delete to end this — so a line
    // that asks for an action and hides its subject sends them to the one exit that cannot work.
    it('NAMES the workspace folder — the library copy is the loop’s own write, the folder is the source', () => {
        const r = on({ setupNeeded: [setup('lane-probe', 'wants a click', 'plugin')] });
        expect(lineText(r.message)).toBe('"lane-probe" (workspace plugin/) wants a click');
    });
    it('a single-artifact workspace has no folder to name, and the line does not invent one', () => {
        const r = on({ setupNeeded: [setup('lane-probe', 'wants a click')] });
        expect(lineText(r.message)).toBe('"lane-probe" wants a click');
    });
    it('several setup artifacts each carry their OWN instruction', () => {
        const r = on({ setupNeeded: [setup('a', 'wants X'), setup('b', 'wants Y')] });
        expect(lineText(r.message)).toBe('"a" wants X · "b" wants Y');
    });
    it('a REAL failure outranks a setup step — but stays a warning, because the transport is good', () => {
        const r = on({ failed: 1, setupNeeded: [setup('lane-probe', 'wants a click')] });
        expect(r.pill).toEqual({ text: 'Apply failed', status: 'warning' });
        expect(lineText(r.message)).toContain('failed to apply');
    });
    it('a boot-order wait says it will apply later rather than blaming the developer', () => {
        const r = on({ waitingForCard: true });
        expect(r.pill).toEqual({ text: 'Card not ready', status: 'warning' });
        expect(lineText(r.message)).toContain('applies again once the chat has loaded');
    });
    // W5 live, 2026-08-28: the gate refused the menu (engine export renamed, layout stale), the
    // console said exactly why — and the panel showed GREEN with "1 skipped" in dimmed detail. A
    // gate whose verdict hides in a count defeats the gate.
    it('a REFUSED artifact is a WARNING and the line carries the gate’s reason — not a bare count', () => {
        const r = on({ skipped: [{ name: 'statusmenu', reason: 'the layout names formatter "maincharMoney" but the engine beside it does not export it' }] });
        expect(r.pill).toEqual({ text: 'Not applied', status: 'warning' });
        expect(lineText(r.message)).toContain('"statusmenu" not applied');
        expect(lineText(r.message)).toContain('maincharMoney');
        expect(lineText(r.counts)).toBe('Build #7 · 3 applied · 1 skipped');
    });
    it('a refusal outranks a setup step — the developer’s own save caused it', () => {
        const r = on({ skipped: [{ name: 'a', reason: 'broken' }], setupNeeded: [setup('b', 'wants a click')] });
        expect(lineText(r.message)).toContain('"a" not applied');
        expect(lineText(r.message)).not.toContain('wants a click');
    });
    it('the fixed words are keys and the names data: a translated panel still prints the artifact as written', () => {
        const r = on({ skipped: [{ name: 'statusmenu', reason: 'broken' }] });
        expect(r.message.parts).toEqual([{ name: '"statusmenu" ' }, { text: 'not applied' }, { name: ': broken' }]);
    });
});

describe('isSetupRefusal — one-time setup, not a fault', () => {
    it('not-installed is a setup step', () => {
        expect(isSetupRefusal('not-installed')).toBe(true);
    });
    it('nothing else is — a real refusal must stay a failure', () => {
        for (const a of ['conflict', 'invalid', 'no-chat', 'registry-malformed', '', null, undefined]) {
            expect(isSetupRefusal(a)).toBe(false);
        }
    });
});

describe('adoption — the once-per-server-process question', () => {
    // The whole point of keying on the SERVER's id: the page cannot tell a reload from a deliberate
    // restart (SillyTavern resumes the loop on load exactly the way the toggle starts it), so a
    // session identity invented in the browser would reset on F5 — the one moment it must not.
    it('the same bootId never asks twice — reload, reconnect and toggle all stay quiet', () => {
        expect(shouldAskAgainThisBoot({ declinedBootId: 'boot-1', currentBootId: 'boot-1' })).toBe(false);
    });

    it('a NEW bootId asks again — stopping the server and starting it is the gesture that re-asks', () => {
        expect(shouldAskAgainThisBoot({ declinedBootId: 'boot-1', currentBootId: 'boot-2' })).toBe(true);
    });

    it('never declined ⇒ ask', () => {
        expect(shouldAskAgainThisBoot({ declinedBootId: undefined, currentBootId: 'boot-1' })).toBe(true);
        expect(shouldAskAgainThisBoot({ declinedBootId: '', currentBootId: 'boot-1' })).toBe(true);
    });

    // MUTATION TARGET: return false when there is no live bootId and a server too old to send one
    // suppresses the question forever — the artifact then never applies and nothing ever says why.
    it('no live bootId ⇒ ASK: un-suppressible beats silently-never', () => {
        expect(shouldAskAgainThisBoot({ declinedBootId: 'boot-1', currentBootId: '' })).toBe(true);
        expect(shouldAskAgainThisBoot({ declinedBootId: '', currentBootId: undefined })).toBe(true);
    });

    it('prune keeps only this process\'s declines — the map is per card and would grow forever', () => {
        const kept = pruneBootScopedDeclines({ 'a.png::p': 'boot-1', 'b.png::p': 'boot-0', 'c.png::q': 'boot-1' }, 'boot-1');
        expect(Object.keys(kept).sort()).toEqual(['a.png::p', 'c.png::q']);
    });

    // MUTATION TARGET: return the input unchanged when there is no bootId and dead declines survive
    // a server that can no longer be matched against — every one of them suppressing its question.
    it('prune with no live bootId keeps nothing, and never mutates its input', () => {
        const before = { 'a.png::p': 'boot-1' };
        expect(pruneBootScopedDeclines(before, '')).toEqual({});
        expect(before).toEqual({ 'a.png::p': 'boot-1' });
    });

    it('the payload carries the server id, and an old server reads as no identity', () => {
        expect(readWorkspacePayload({ version: 1, artifacts: [], bootId: 'boot-9' }).bootId).toBe('boot-9');
        expect(readWorkspacePayload({ version: 1, artifacts: [] }).bootId).toBe('');
    });

    // needs-adopt is a SETUP step, not a failure: it must not raise the error toast or the failed
    // count, for the same reason the plugin lane's one-time install must not (live 2026-08-28).
    it('needs-adopt classes with the plugin setup step, not with a broken build', () => {
        expect(isSetupRefusal('needs-adopt')).toBe(true);
        expect(isSetupRefusal('not-installed')).toBe(true);
        expect(isSetupRefusal('conflict')).toBe(false);
        expect(isSetupRefusal('no-chat')).toBe(false);
        expect(isSetupRefusal('')).toBe(false);
    });

    it('the question names what is replaced, what it costs, and that Cancel is free', () => {
        const surface = { text: 'The "Scheme" script, card → pack:', name: '3 B → 5 B' };
        const q = asText(devLoopAdoptQuestion({ id: 'school-v4', version: '5.56' }, [surface]));
        expect(q).toContain('school-v4 v5.56');
        expect(q).toContain('The "Scheme" script, card → pack: 3 B → 5 B');
        expect(q.join('\n')).toMatch(/Replace: .*its uninstall removes them/);
        expect(q.join('\n')).toMatch(/Cancel: nothing changes/);
    });

    it('is compact: a one-line question, the artifact, the surfaces, then one line per answer', () => {
        const q = devLoopAdoptQuestion({ id: 'p', version: '1.0' }, [{ name: 'a' }, { name: 'b' }]);
        expect(q[0]).toEqual({ text: 'Replace this card\'s own copies?' });
        expect(q.slice(1, 4)).toEqual([{ name: 'p v1.0' }, { name: 'a' }, { name: 'b' }]);
        expect(asText(q).filter((l) => /^(Replace|Cancel): /.test(l))).toHaveLength(2);
        expect(q).toHaveLength(6);
    });
});

describe('W9 — capturedRegexOrder: the drag is the signal, the declaration is the baseline (§2.8)', () => {
    it('a rearrangement of the pack\'s own names comes back, foreign names ignored', () => {
        expect(capturedRegexOrder({
            declaredOrder: ['StatusMenu', 'GameStartMenu'],
            cardNames: ['UserOwn', 'GameStartMenu', 'Foreign', 'StatusMenu'],
        })).toEqual(['GameStartMenu', 'StatusMenu']);
    });
    it('TERMINATES — a card already in the declared order captures nothing', () => {
        expect(capturedRegexOrder({
            declaredOrder: ['A', 'B'],
            cardNames: ['UserOwn', 'A', 'B'],
        })).toBe(null);
    });
    it('a pack regex missing from the card cannot be captured — a partial listing would fail rule 14', () => {
        expect(capturedRegexOrder({ declaredOrder: ['A', 'B'], cardNames: ['B'] })).toBe(null);
    });
    it('fewer than two regexes have no order', () => {
        expect(capturedRegexOrder({ declaredOrder: ['A'], cardNames: ['A'] })).toBe(null);
    });
    it('declaredRegexOrderOf: the explicit section wins; pack order is the baseline before the first capture', () => {
        expect(declaredRegexOrderOf({ regexOrder: ['B', 'A'], regex: [{ script_name: 'A' }, { script_name: 'B' }] })).toEqual(['B', 'A']);
        expect(declaredRegexOrderOf({ regex: [{ script_name: 'A' }, { script_name: 'B' }] })).toEqual(['A', 'B']);
    });
});

// ── the dev-card fence (2026-08-31) ─────────────────────────────────────────
//
// Until this existed the loop applied its workspace to whatever card was open, so clicking through
// one's own collection installed a genre pack into every card with a readable worldbook — silently,
// because a clean card returns 'activate' and asks nothing.
describe('devCardDisposition — which cards the loop may write to', () => {
    const boot = 'boot-1';
    const yes = (b) => devCardAnswer({ bootId: b, allowed: true });
    const no = (b) => devCardAnswer({ bootId: b, allowed: false });

    it('a card said yes to THIS boot applies, with no question', () => {
        expect(devCardDisposition({ cardKey: 'a.png', answers: { 'a.png': yes(boot) }, currentBootId: boot })).toBe('apply');
    });

    // The whole point: an empty set is NOT "everywhere".
    it('an unknown card ASKS — never applies on a guess', () => {
        expect(devCardDisposition({ cardKey: 'b.png', answers: {}, currentBootId: boot })).toBe('ask');
        expect(devCardDisposition({ cardKey: 'b.png', answers: { 'a.png': yes(boot) }, currentBootId: boot })).toBe('ask');
        expect(devCardDisposition({ cardKey: 'b.png', currentBootId: boot })).toBe('ask');
    });

    it('a card declined THIS boot is skipped in silence', () => {
        expect(devCardDisposition({ cardKey: 'b.png', answers: { 'b.png': no(boot) }, currentBootId: boot })).toBe('skip');
    });

    // A mistaken no self-heals by restarting the dev server — the one gesture the browser can detect.
    it('a decline from a PREVIOUS boot asks again', () => {
        expect(devCardDisposition({ cardKey: 'b.png', answers: { 'b.png': no('boot-0') }, currentBootId: boot })).toBe('ask');
    });

    // The reason the whole record is boot-scoped (user, 2026-09-01): a yes that outlives the server has
    // no revoke — nothing in the UI clears it, so a card said yes to by accident stays a dev card until
    // somebody hand-edits settings. Restarting the server IS the revoke, so a grant may not survive it.
    it('a GRANT from a previous boot asks again — a yes is not permanent', () => {
        expect(devCardDisposition({ cardKey: 'a.png', answers: { 'a.png': yes('boot-0') }, currentBootId: boot })).toBe('ask');
    });

    // The retired shape stored a bare `true` under a different key. Nothing reads it; if one is handed
    // in anyway it matches no bootId, so the card is asked about rather than silently granted forever.
    it('a record with no bootId is not a grant', () => {
        expect(devCardDisposition({ cardKey: 'a.png', answers: { 'a.png': true }, currentBootId: boot })).toBe('ask');
        expect(devCardDisposition({ cardKey: 'a.png', answers: { 'a.png': { allowed: true } }, currentBootId: boot })).toBe('ask');
    });

    // An answer cannot be scoped to a boot nobody can name.
    it('an unknown server boot asks, whatever is on file', () => {
        expect(devCardDisposition({ cardKey: 'a.png', answers: { 'a.png': yes(boot) }, currentBootId: '' })).toBe('ask');
        expect(devCardDisposition({ cardKey: 'a.png', answers: { 'a.png': no(boot) }, currentBootId: undefined })).toBe('ask');
    });

    // 'no-card' is NOT 'skip', and the split is load-bearing: a decline must not be retried, but the
    // lobby must be — live 2026-08-31, folding them together made the loop fence every card the
    // developer opened after connecting in the lobby, because nothing marked it to retry.
    it('the lobby is no-card, never skip — the two get opposite follow-ups', () => {
        expect(devCardDisposition({ cardKey: '', answers: { 'a.png': yes(boot) }, currentBootId: boot })).toBe('no-card');
        expect(devCardDisposition()).toBe('no-card');
        expect(devCardDisposition({ cardKey: '', answers: { 'b.png': no(boot) }, currentBootId: boot })).toBe('no-card');
    });
});

describe('pruneBootScopedAnswers — the map never outgrows one boot', () => {
    const boot = 'boot-2';

    it('keeps this boot and drops every other, both answers alike', () => {
        const kept = pruneBootScopedAnswers({
            'a.png': devCardAnswer({ bootId: boot, allowed: true }),
            'b.png': devCardAnswer({ bootId: boot, allowed: false }),
            'c.png': devCardAnswer({ bootId: 'boot-1', allowed: true }),
        }, boot);
        expect(Object.keys(kept).sort()).toEqual(['a.png', 'b.png']);
        expect(kept['a.png']).toEqual({ bootId: boot, allowed: true });
        expect(kept['b.png']).toEqual({ bootId: boot, allowed: false });
    });

    it('drops malformed records and everything when the boot is unknown', () => {
        expect(pruneBootScopedAnswers({ 'a.png': true, 'b.png': null }, boot)).toEqual({});
        expect(pruneBootScopedAnswers({ 'a.png': devCardAnswer({ bootId: boot, allowed: true }) }, '')).toEqual({});
        expect(pruneBootScopedAnswers()).toEqual({});
    });

    // THE yes that was filed as a no (live 2026-09-01): SillyTavern's confirm popup resolves to
    // POPUP_RESULT.AFFIRMATIVE — the number 1, never the boolean. Comparing it to `true` stored a
    // decline while the apply itself proceeded on the same truthy value, so the card was written and
    // then skipped on the next apply of that boot.
    it('a truthy popup result is a YES — AFFIRMATIVE is the number 1, not true', () => {
        expect(devCardAnswer({ bootId: boot, allowed: 1 })).toEqual({ bootId: boot, allowed: true });
        expect(devCardDisposition({
            cardKey: 'a.png', answers: { 'a.png': devCardAnswer({ bootId: boot, allowed: 1 }) }, currentBootId: boot,
        })).toBe('apply');
    });

    it('devCardAnswer normalizes — allowed is a boolean, bootId a string', () => {
        expect(devCardAnswer({ bootId: boot, allowed: 0 })).toEqual({ bootId: boot, allowed: false });
        expect(devCardAnswer({ bootId: boot, allowed: undefined })).toEqual({ bootId: boot, allowed: false });
        expect(devCardAnswer()).toEqual({ bootId: '', allowed: false });
    });
});

describe('devCardQuestion — names the card and what would land on it', () => {
    it('lists every artifact and says Not here is free', () => {
        const t = asText(devCardQuestion({
            cardName: 'Your Wives',
            artifacts: [{ name: 'gamelogic', pack: { id: 'school-v4' } }, { name: 'statusmenu', pack: { id: 'testmenu' } }],
            url: 'http://127.0.0.1:6620',
        })).join('\n');
        expect(t).toContain('Card: Your Wives');
        expect(t).toContain('school-v4');
        expect(t).toContain('testmenu');
        expect(t).toContain('Dev server: http://127.0.0.1:6620');
        expect(t).toContain('Not here: nothing new installs');
    });

    it('an empty workspace still asks honestly rather than showing a blank list', () => {
        expect(devCardQuestion({ cardName: 'X', artifacts: [] })).toContainEqual({ text: 'Nothing to apply yet.' });
    });

    it('its answer lines name its buttons', () => {
        const t = asText(devCardQuestion({ cardName: 'X', artifacts: [] })).join('\n');
        expect(t).toContain(DEV_CARD_QUESTION_BUTTONS.okButton + ':');
        expect(t).toContain(DEV_CARD_QUESTION_BUTTONS.cancelButton + ':');
    });
});

describe('devLoopStatus — a fenced card is a warning, never success', () => {
    it('names what was NOT installed, and says the rest still updates', () => {
        const st = devLoopStatus({ enabled: true, connected: true, version: 7, applied: 1, fencedOut: ['school-v4'], openCardKey: 'a.png', appliedCardKey: 'a.png' });
        expect(st.pill).toEqual({ text: 'Updates only', status: 'warning' });
        expect(lineText(st.message)).toContain('"school-v4"');
        expect(lineText(st.message)).toContain('still updates');
        expect(lineText(st.counts)).toContain('1 applied');
    });

    it('an unfenced clean apply is still success', () => {
        const st = devLoopStatus({ enabled: true, connected: true, version: 7, applied: 2, openCardKey: 'a.png', appliedCardKey: 'a.png' });
        expect(st.pill.status).toBe('success');
        expect(st.message).toBeNull();
    });
});

// The last apply's facts are about the card it ran on. Live, for as long as the loop existed: card A answered no, the
// chat was closed, and "not installed on this card" stood over the lobby; any card opened next inherited A's answer.
describe('devLoopStatus — the last apply speaks only for its own card', () => {
    const lastApplyOnA = { enabled: true, connected: true, version: 52, applied: 2, fencedOut: ['lane-probe'], appliedCardKey: 'a.png' };

    // MUTATION TARGET: drop the lobby branch and the closed chat goes on saying "Updates only".
    it('the lobby: no chat open, and nothing about the last card', () => {
        const st = devLoopStatus({ ...lastApplyOnA, openCardKey: '' });
        expect(st.pill).toEqual({ text: 'No chat open', status: 'neutral' });
        expect(st.message).toEqual({ text: 'Saves apply to the card that is open.' });
        expect(lineText(st.counts)).toBe('Build #52');
    });

    it('the lobby with a save waiting: it says the save applies once a chat opens', () => {
        const st = devLoopStatus({ ...lastApplyOnA, openCardKey: '', appliedCardKey: '', waitingForCard: true });
        expect(st.message).toEqual({ text: 'The last save applies once a chat is open.' });
    });

    // MUTATION TARGET: compare nothing and card B reads A's "Updates only", A's failures and A's count.
    it('another card: the last card’s answer, failures and count are not its own', () => {
        const st = devLoopStatus({ ...lastApplyOnA, failed: 1, openCardKey: 'b.png' });
        expect(st.pill).toEqual({ text: 'Connected', status: 'success' });
        expect(st.message).toEqual({ text: 'Nothing applied to this card yet: the next save applies here.' });
        expect(lineText(st.counts)).toBe('Build #52');
    });

    it('back on the card the apply ran on, its facts read again', () => {
        expect(devLoopStatus({ ...lastApplyOnA, openCardKey: 'a.png' }).pill).toEqual({ text: 'Updates only', status: 'warning' });
    });

    // MUTATION TARGET: drop the Applying arm and a chat-open apply reads the lobby's leftover "Card not ready".
    it('while an apply runs on the open card: Applying, and nothing older', () => {
        const st = devLoopStatus({ ...lastApplyOnA, waitingForCard: true, isApplying: true, applied: 0, openCardKey: 'a.png' });
        expect(st.pill).toEqual({ text: 'Applying', status: 'neutral' });
        expect(st.message).toBeNull();
        expect(lineText(st.counts)).toBe('Build #52');
    });

    it('a gate refusal is the workspace’s, and stands on any card', () => {
        const st = devLoopStatus({ ...lastApplyOnA, skipped: [{ name: 'statusmenu', reason: 'broken' }], openCardKey: 'b.png' });
        expect(st.pill).toEqual({ text: 'Not applied', status: 'warning' });
        expect(lineText(st.counts)).toBe('Build #52 · 1 skipped');
    });
});


// THE FENCE ASKS ONE QUESTION: may the loop INSTALL this workspace onto this card. An artifact the
// developer already installed by hand is not what it is about, and gating that froze a card whose
// panel then went stale with no bug to find (live 2026-09-01).
describe('cardFencePlan', () => {
    // MUTATION TARGET — drop the newCount check and the first case starts asking (or skipping) about
    // a card with nothing new; make 'skip' return 'no-card' and the updates case stops applying.
    it('nothing new to install — never asks, whatever the answer was', () => {
        expect(cardFencePlan({ disposition: 'ask', newCount: 0 })).toBe('apply-all');
        expect(cardFencePlan({ disposition: 'skip', newCount: 0 })).toBe('apply-all');
    });
    it('a no applies the updates and withholds only the new installs', () => {
        expect(cardFencePlan({ disposition: 'skip', newCount: 2 })).toBe('updates-only');
    });
    it('a yes applies everything; an unanswered card asks', () => {
        expect(cardFencePlan({ disposition: 'apply', newCount: 2 })).toBe('apply-all');
        expect(cardFencePlan({ disposition: 'ask', newCount: 2 })).toBe('ask');
    });
    it('no card open outranks everything — it is a boot-order state, not an answer', () => {
        expect(cardFencePlan({ disposition: 'no-card', newCount: 0 })).toBe('no-card');
        expect(cardFencePlan({ disposition: 'no-card', newCount: 3 })).toBe('no-card');
    });
});

// The fence question names PACKS, not workspace folders. "gamelogic" reads like a category, so a
// developer said yes to a word and got 50 entries, an engine, a schema and 13 regexes (live
// 2026-08-31). The weights are what make an all-or-nothing answer an informed one.
describe('devCardArtifactLine — what a yes actually costs', () => {
    it('names the pack, its id and version, and everything it writes', () => {
        const line = dialogLineText(devCardArtifactLine('gamelogic', {
            id: 'school-v4', name: 'ArtificKoi — School v4', version: '5.56',
            entries: new Array(50), regex: new Array(13), engine: 'x', schema: 'y',
        }));
        expect(line).toContain('ArtificKoi — School v4');
        expect(line).toContain('school-v4');
        expect(line).toContain('v5.56');
        expect(line).toContain('50 entries');
        expect(line).toContain('13 regexes');
        expect(line).toContain('engine');
        expect(line).toContain('schema');
        expect(line).toContain('[gamelogic/]');
    });

    it('singulars read as singulars', () => {
        const line = dialogLineText(devCardArtifactLine('statusmenu', { id: 'test', version: '0.1.0', entries: [{}], regex: [{}], layout: {} }));
        expect(line).toContain('1 entry');
        expect(line).toContain('1 regex');
        expect(line).not.toContain('1 entries');
        expect(line).not.toContain('1 regexes');
        expect(line).toContain('layout');
    });

    it('a pack that writes nothing SAYS so rather than trailing off', () => {
        expect(dialogLineText(devCardArtifactLine('empty', { id: 'e', version: '1' }))).toContain('nothing to write');
    });

    it('survives a missing pack — the question still has to render', () => {
        expect(dialogLineText(devCardArtifactLine('gamelogic', null))).toContain('gamelogic');
        expect(dialogLineText(devCardArtifactLine())).toContain('?');
    });

    it('keys every word of the pack format and keeps names and counts as values', () => {
        const { parts } = devCardArtifactLine('gamelogic', { id: 'p', version: '1.0', regex: [{}, {}], engine: 'x' });
        expect(parts).toContainEqual({ text: 'regexes' });
        expect(parts).toContainEqual({ text: 'engine' });
        expect(parts).toContainEqual({ name: '2 ' });
    });
});

describe('devCardQuestion — the weights reach the dialog', () => {
    const artifacts = [{ name: 'gamelogic', pack: { id: 'school-v4', name: 'School v4', version: '5.56', entries: new Array(50), regex: new Array(13) } }];

    it('a folder name alone is never what the developer is shown', () => {
        const t = asText(devCardQuestion({ cardName: 'Junk', artifacts, url: 'http://x' })).join('\n');
        expect(t).toContain('School v4');
        expect(t).toContain('50 entries');
        expect(t).toContain('13 regexes');
        expect(t).toContain('Junk');
    });

    it('says the grant is ALL of it — that is the whole shape of the answer', () => {
        expect(asText(devCardQuestion({ cardName: 'Junk', artifacts })).join('\n')).toContain('Install all: everything installs now');
    });

    // A Not here that does not say it is not an undo reads as one: the packs already on the card stay.
    it('says plainly that Not here does not remove what is already installed, and how removal is done', () => {
        const t = asText(devCardQuestion({ cardName: 'Junk', artifacts })).join('\n');
        expect(t).toContain('What the card already has keeps hot-reloading');
        expect(t).toContain('library copy');
        expect(t).toContain('Uninstall');
    });

    // The grant lasts one dev-server process; saying otherwise hides the revoke.
    it('the Install all line scopes the grant to this dev server, and the restart revokes it', () => {
        const t = asText(devCardQuestion({ cardName: 'Junk', artifacts })).join('\n');
        expect(t).toContain('while this dev server runs');
        expect(t).toContain('restarting the dev server asks again');
    });

    it('is compact: the question, the card and server, the artifacts, then three short lines', () => {
        const q = devCardQuestion({ cardName: 'Junk', artifacts, url: 'http://x' });
        expect(q[0]).toEqual({ text: 'Install the dev workspace on this card?' });
        expect(q.slice(1, 3)).toEqual([{ text: 'Card:', name: 'Junk' }, { text: 'Dev server:', name: 'http://x' }]);
        expect(asText(q).filter((l) => /^(Install all|Not here): |^Either way, /.test(l))).toHaveLength(3);
        expect(q.length).toBe(1 + 2 + artifacts.length + 3);
    });

    it('still renders with nothing to apply, and with no card name', () => {
        expect(devCardQuestion({ cardName: 'Junk', artifacts: [] })).toContainEqual({ text: 'Nothing to apply yet.' });
        expect(devCardQuestion()[0]).toEqual({ text: 'Install the dev workspace on this card?' });
    });
});

// What a finished apply reports. Live 2026-10-19: the chat was closed while an apply was writing, the menu's registry
// write found no card, and the loop raised "1 artifact(s) failed to apply" with an error toast for a card that was
// simply leaving.
describe('devApplyOutcome — a wait is never a failure', () => {
    it('a clean apply: nothing to report', () => {
        expect(devApplyOutcome({ failed: 0 })).toEqual({ needsCard: false, waitingForCard: false, failed: 0, shouldToast: false });
    });
    it('a real failure is counted and toasted', () => {
        expect(devApplyOutcome({ failed: 2 })).toEqual({ needsCard: false, waitingForCard: false, failed: 2, shouldToast: true });
    });
    it('a boot-order refusal waits for CHAT_CHANGED, untoasted', () => {
        expect(devApplyOutcome({ failed: 1, needsCard: true })).toEqual({ needsCard: true, waitingForCard: true, failed: 0, shouldToast: false });
    });
    // MUTATION TARGET: count the refusals of a card that changed under the apply and the error toast fires again.
    it('a card that changed under the apply: its refusals are a card leaving, and the apply runs again', () => {
        expect(devApplyOutcome({ failed: 1, isCardChanged: true })).toEqual({ needsCard: true, waitingForCard: true, failed: 0, shouldToast: false });
    });
});
