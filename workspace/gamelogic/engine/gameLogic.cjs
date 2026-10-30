// test-gam GameLogic Engine
//
// The engine DECLARES its own identity and exports it. mvu-helper reads these off the
// running module, and reads these same lines when checking a pack that is not loaded
// yet — one source, two readers, so nothing can drift. They must be STRING LITERALS:
// a computed value cannot be read back from source. Bump ENGINE_VERSION on every change;
// it is reported and logged, never compared.
const ENGINE_VERSION = 'v0.1.0';
const ENGINE_NAME = 'test-gam';   // WHICH GAME — the one name plugins branch on
const ENGINE_TYPE = 'test-gam';   // WHICH FAMILY it belongs to, beside the game
//
// resolveTurn IS the game: mvu-helper hosts this text in a Worker and calls it once per
// resolved turn. statData is a structured clone of the chat's stat_data — mutate it freely
// and return it; the returned object is the result (mutations never cross the Worker wall
// by reference). ctx carries { mid, swipe, dice, dicePools, ops, sameRoundEventKey }: the
// turn's identity, the dice dealt this turn (flat, and per pool as { pool | hash, sides,
// dice }), the ops already applied this turn, and the event whose body mvu-helper injected
// into this reply ('' when none) — whether that beat fired is this engine's to judge.
// Optional result fields: resBlock (the BODY of a player-visible audit; mvu-helper wraps it
// in its own <RES_Variable> tag), textReplacements ({ find: put } applied to the reply), and
// leadText / endText (text mvu-helper writes at the top of the story and directly above its
// menu, in its own <LeadText> / <EndText> tags, on every reply that returns them; the lead
// text needs the card's [Initmvuhelper] leadText section, which names the story block).
// applied: did this resolve change state? log: one human line per thing it did.
module.exports = {
    ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE,
    resolveTurn(statData, ctx) {
        return { statData, applied: false, log: [] };
    },
};
