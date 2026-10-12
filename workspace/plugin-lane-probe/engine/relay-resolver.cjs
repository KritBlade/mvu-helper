// lane-probe engine — the plugin's resolveRelay. It runs once per reply, after the reply's last write
// (after POST's block and the game engine's own relay, or after the reply when POST writes nothing),
// on the same rail as the card's own POST bookkeeper: it returns JSON Patch ops with ABSOLUTE pointers,
// the host hands them to Mvu.parseMessage inside an <UpdateVariable> block, and the card's Zod judges
// every one.
// Version: `const ENGINE_VERSION` below — the ONE place it is written. Bump it on every change.
// It is REPORTED, displayed and logged, never COMPARED: mvu-helper reads it off this module when
// the engine is loaded, and off this declaration line when validating an artifact that is not
// running yet. Nothing gates on it.
//
// WHAT THIS IS FOR. The POST window asks a MODEL to record the turn, so the record is only as good
// as the model's compliance. This section answers the same questions from the APPLIED OPS instead,
// with no model in the loop — and the two run side by side on purpose, because a disagreement
// between them is the measurement.
//
// THE PATCH SHAPE. A relay op is an op like any other and rides the rail the game itself rides, so
// a resolver author must plan for two things:
//   · paths are ABSOLUTE JSON Pointers — build them off `ownPointer`, which the host supplies;
//   · an op can be REFUSED. Zod gates these exactly as it gates the POST window's, so a write to a
//     closed root fails here for the same reason it fails there. The host names the refused paths.
const ENGINE_VERSION = 'v2.8';

module.exports = {
    ENGINE_VERSION,
    resolveRelay({ ownState, snapshot, ops, dicePools, exposes, engine, roster, ownRoot, ownPointer, pluginVersion, mid, swipe }) {
        const prev = (ownState && typeof ownState === 'object') ? ownState : {};
        const unwrap = (v) => (Array.isArray(v) ? v[0] : v);
        const turn = (Number(unwrap(prev.RelayTurn)) || 0) + 1;
        const applied = Array.isArray(ops) ? ops : [];

        // THE DETERMINISTIC HALF. `ops` is what the turn ACTUALLY applied (path, old, new), so
        // "did my own POST write land" stops being a model's self-report. Anything under this
        // plugin's root is its own; everything else is the game's, counted but untouched.
        const mine = applied.filter((o) => String((o && o.path) || '').startsWith(ownRoot + '.'));

        // Cross-plugin READS are free — `roster` exists because the user names every root at
        // install, so no plugin can be found by a name this file could have hardcoded.
        const neighbours = Object.keys(roster || {}).filter((id) => id !== 'lane-probe');

        const log = (Array.isArray(prev.RelayLog) ? prev.RelayLog : []).slice();
        log.push('r' + turn + ' @' + mid + ':' + swipe
            + ' ops=' + applied.length + ' mine=' + mine.length
            + ' engine=' + ((engine && engine.name) || 'none')
            + ' neighbours=' + (neighbours.length || 0)
            + ' snapshot=' + (snapshot ? 'yes' : 'no')
            + ' v' + pluginVersion);

        const patches = [
            { op: 'replace', path: ownPointer + '/RelayTurn', value: turn },
            { op: 'replace', path: ownPointer + '/RelayOps', value: applied.length },
            { op: 'replace', path: ownPointer + '/RelayMine', value: mine.map((o) => o.path) },
            { op: 'replace', path: ownPointer + '/RelayLog', value: log.slice(-10) },
        ];

        // THE FOREIGN ARM — a READING, not a write, because the plugin relay runs LAST: after POST's own
        // parse and after the game engine's relay. A write here into a slot the POST window also writes
        // would therefore win every time, silently, and read as the POST window's failure.
        //
        // `ops` answers the same question without touching the slot: it is a diff of what LANDED, so
        // a REFUSED op can never appear in it, and the recorded value names whose write survived.
        const foreign = applied
            .filter((o) => !String((o && o.path) || '').startsWith(ownRoot + '.'))
            .map((o) => String(o.path) + '=' + String(o && o.new === undefined ? '' : o.new).slice(0, 40));
        patches.push({ op: 'replace', path: ownPointer + '/RelayForeign', value: foreign.slice(-12) });

        // THE IDENTITY AND INTERFACE ARM: recorded instead of asserted.
        //   RelayEngine — ctx.engine verbatim ({name, type, version, packId}, null fields when unknown;
        //                 on School, name reads 'School').
        //   RelayBranch — an ACTUAL branch keyed on engine.name, because the rule is behavioural:
        //                 match on NAME, and an unknown engine falls back rather than guessing.
        //   RelayCast   — cast@1 through ctx.exposes: the game DECLARED where its cast lives, so
        //                 this file reads that path off `snapshot` while hardcoding no game
        //                 vocabulary. Not exposed ⇒ the degraded path, recorded as such.
        patches.push({ op: 'replace', path: ownPointer + '/RelayEngine',
            value: { name: (engine && engine.name) || null, type: (engine && engine.type) || null, version: (engine && engine.version) || null, packId: (engine && engine.packId) || null } });
        patches.push({ op: 'replace', path: ownPointer + '/RelayBranch',
            value: (engine && engine.name) === 'School' ? 'School-native' : 'generic-fallback' });
        const castPath = (exposes && typeof exposes === 'object') ? exposes['cast@1'] : undefined;
        let castNote;
        if (!castPath) {
            castNote = 'cast@1 not exposed - degraded as declared';
        } else {
            const node = String(castPath).split('.').reduce((n, seg) => (n && typeof n === 'object') ? n[seg] : undefined, snapshot || {});
            if (!node || typeof node !== 'object') {
                castNote = 'cast@1 -> ' + castPath + ' ABSENT from snapshot';
            } else {
                const ids = Object.keys(node);
                const first = ids[0];
                const hasName = Boolean(first && node[first] && typeof node[first] === 'object' && node[first].Name !== undefined);
                castNote = 'cast@1 -> ' + castPath + ' ids=' + ids.length
                    + (first ? ' first=' + first + ' Name=' + (hasName ? 'present' : 'MISSING') : '');
            }
        }
        patches.push({ op: 'replace', path: ownPointer + '/RelayCast', value: castNote });

        // ── THE DICE ARM ──────────────────────────────────────────────────────────────────────────
        // THIS RESOLVER NEVER ROLLS, and that is the thing being measured. The dice were dealt by
        // this plugin's OWN windows at prompt time (MvuHelper.rollPool, pool 'LANEPROBE', d20) and reach
        // here in `ctx.dicePools` — the verify-only receipt, the same contract the game's RES lives by. A
        // die minted here would be a die no prose ever saw, which is the desync the receipt exists to
        // prevent; `crypto` is reachable in this Worker and is deliberately not used.
        //
        // What POST wrote into `Dice` this turn must appear in THIS PLUGIN'S OWN pool. The flat `ctx.dice`
        // is every pool's dice together, where the game's d20s could vouch for this plugin's; the pool
        // entry cannot. A miss means the two halves disagree about the epoch — the fence broke — not
        // that a die changed.
        //
        // `null` is a READING, not a failure: it means nothing was dealt this generation. It is never
        // permission to roll.
        const pools = Array.isArray(dicePools) ? dicePools : null;
        const ownPool = pools ? pools.find((p) => p && p.pool === 'LANEPROBE' && p.sides === 20) : null;
        const receipt = ownPool && Array.isArray(ownPool.dice) ? ownPool.dice : null;
        // POST writes `Dice` as a plain array of numbers; a Zod tuple would nest it one deeper, so
        // accept both rather than guessing which shape this card's schema produced.
        const rawDice = prev.Dice;
        const ownDice = (Array.isArray(rawDice) && Array.isArray(rawDice[0]) ? rawDice[0] : rawDice);
        const mineDice = Array.isArray(ownDice) ? ownDice.map(Number).filter((n) => Number.isFinite(n)) : [];
        let diceNote;
        if (pools === null) {
            diceNote = 'ctx.dicePools NULL - nothing dealt this generation (verify nothing; never a reason to roll)';
        } else if (receipt === null) {
            diceNote = 'ctx.dicePools has no LANEPROBE d20 pool - this plugin\'s windows dealt nothing this generation';
        } else if (!mineDice.length) {
            diceNote = 'LANEPROBE pool ' + receipt.length + ' die(ce) - but POST recorded no Dice to verify against';
        } else {
            const missing = mineDice.filter((d) => !receipt.includes(d));
            diceNote = 'LANEPROBE pool=' + receipt.length + ' own=' + mineDice.length
                + ' verified=' + (mineDice.length - missing.length) + '/' + mineDice.length
                + (missing.length ? ' MISSING ' + missing.join(',') + ' - the epoch fence broke' : ' all in pool')
                + ' (resolver rolled nothing)';
        }
        patches.push({ op: 'replace', path: ownPointer + '/RelayDice', value: diceNote });
        // The whole receipt, pool by pool, so a reader can see WHAT was dealt rather than only a verdict —
        // and so the hash-seeded pair the POST window deals can be checked by hand: a seeded deal is
        // deterministic, so its two values are known offline and either appear under its hash here or
        // the seeded path is not reaching the receipt.
        patches.push({ op: 'replace', path: ownPointer + '/RelayDicePool',
            value: pools ? pools.map((p) => ({ ...p, dice: Array.isArray(p.dice) ? p.dice.slice(0, 24) : [] })) : [] });

        return {
            patches,
            log: ['lane-probe: relay ' + turn + ' saw ' + applied.length + ' applied op(s), '
                + 'sent ' + patches.length + ' op(s)'],
        };
    },
};
