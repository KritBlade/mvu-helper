EVENT PACKS - adding eventpack.cjs to this engine
=================================================

This engine runs no event packs yet. An event pack (built in MVU Status Menu Builder, installed from
mvu-helper's Event Packs tab) is DATA: rows saying when an event may happen and what it changes.
What RUNS them is eventpack.cjs, one library every game uses unchanged: it checks each row's
conditions, arms the next event, and applies a fired event's writes. Your engine only says where
this game keeps event state, and calls it.

1. GET THE FILE
   eventpack.cjs is MvuGameMaker's maker-app/GameLogic/_engine/eventpack.cjs.
   Download: (link to come: the public repository that will carry it is not published yet)
   Save it as engine/eventpack.cjs and never edit it. To update it, replace the whole file.

2. LOAD IT BEFORE YOUR ENGINE (pack.json)
       "engineOrder": ["eventpack.cjs", "gameLogic.cjs"]
   The files in engineOrder run as ONE script, in that order. eventpack.cjs leaves its functions on
   globalThis.__EVENTPACK__, where gameLogic.cjs picks them up.

3. WIRE gameLogic.cjs
   The bare minimum. This whole file replaces the blank gameLogic.cjs and runs events:

----- gameLogic.cjs, with event packs wired in -----
// test-gam GameLogic Engine, with event packs wired in.
const ENGINE_VERSION = 'v0.2.0';
const ENGINE_NAME = 'test-gam';
const ENGINE_TYPE = 'test-gam';

// eventpack.cjs ran first (pack.json engineOrder) and left its functions here.
const EVENTS = globalThis.__EVENTPACK__ || null;

// A value in MVU state is often a [value, label] pair: read the value, keep the label on a write.
function get(v, d) {
    const x = Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v;
    return x === undefined || x === null ? d : x;
}
function setValue(obj, key, v) {
    obj[key] = Array.isArray(obj[key]) ? [v, obj[key][1]] : [v, key];
}

// The library's warnings, handed back in the turn's log.
const warnings = [];

// WHERE this game keeps event state, and what a fired event may do. mvu-helper reads triggerRoot,
// armedPath, writes, rewards and scopes off the export below, and bodyEntry (where an installed pack's
// entry goes in the prompt) when one is declared.
const EVENT_PACK_ADAPTER = {
    triggerRoot: 'EventPack.triggers',
    armedPath: 'EventPack.armed',
    writes: [],
    scopes: [],
    get,
    getArmed: (sd) => String(get(sd.EventPack && sd.EventPack.armed, '')),
    setArmed: (sd, v) => setValue(sd.EventPack || (sd.EventPack = {}), 'armed', v),
    warn: (message) => { warnings.push('eventpack: ' + message); },
};

function resolveTurn(statData, ctx) {
    const log = [];
    let applied = false;
    if (!EVENTS) {
        log.push('eventpack.cjs is not loaded (see engine/README.txt) - no event can arm or fire');
        return { statData, applied, log };
    }
    // The narrator played the armed event: "<key>" or "<key>:<Outcome>".
    const intent = statData.Intent || {};
    const fired = String(get(intent.eventFire, '')).trim();
    let didFire = false;
    if (fired) {
        didFire = EVENTS.applyEventFire(statData, fired, log, EVENT_PACK_ADAPTER);
        setValue(intent, 'eventFire', '');   // consumed, fired or refused: never applied twice
        applied = true;
    }
    // Arm the next event for the next reply. Not in the reply one fired, so a series' next beat waits.
    if (!didFire && EVENTS.scanEvents(statData, log, EVENT_PACK_ADAPTER)) applied = true;
    log.push(...warnings.splice(0));
    return { statData, applied, log };
}

module.exports = {
    ENGINE_VERSION, ENGINE_NAME, ENGINE_TYPE,
    EVENT_PACK_ADAPTER,
    EVENT_PACK_FORMAT: EVENTS ? EVENTS.FORMAT : null,
    resolveTurn,
};
----- end of gameLogic.cjs -----

   - triggerRoot and armedPath say where the event rows and the armed event live. They must be
     dotted paths. mvu-helper merges every installed pack's rows into triggerRoot.
   - The armed event MUST be a [value, label] pair. MVU Status Menu Builder writes every pack's text
     behind the gate stat_data.<armedPath>[0] === '@key'; on a plain string [0] reads only '@', so
     every event would arm and never show.
   - writes: where a fired event may write, and under which rules. Empty means a pack may arm and
     fire but change nothing: a row's writes are reported at install and refused when it fires,
     and the event itself still fires.
   - scopes: the scope words your game gives a meaning to (for example, what a new playthrough
     clears). A row naming a word not listed here is reported at install.
   - resolveTurn applies a fired event first, otherwise arms the next one. It clears the report
     either way, or the next turn would apply it again.
   Optional, each described in eventpack.cjs's own header: aliases (short spellings for conditions),
   presence (what Present(Name) reads), nowStamp and daysSince (the clock that DaysSince() conditions
   and stamped writes need), rewards (what a fired event may pay). Without them the library warns
   by name instead of guessing.

4. GIVE THE STATE A HOME (schema/)
   Declare both roots in your schema, or MVU strips them on the next write:
       EventPack: z.looseObject({
         triggers: z.record(z.string(), z.any()).prefault({}),
         armed: labeledStr,
       }).prefault({}),
       Intent: z.looseObject({
         eventFire: labeledStr,
       }).prefault({}),
   Keep EventPack open: mvu-helper keeps its install record in EventPack.installed, and the library
   records fired events in EventPack.fired.

5. TELL THE NARRATOR
   A pack's FIRE line asks the narrator to emit /Intent/eventFire "<key>" when it plays the armed
   event. Your card's prompt must say where that lands: here, the value half of the pair,
   /Intent/eventFire/0. That report is the only way the engine learns an event was played.

The full contract is in mvu-helper's devdoc/event-pack-engine.md (this engine's side) and
devdoc/event-pack-format.md (what a pack contains).
